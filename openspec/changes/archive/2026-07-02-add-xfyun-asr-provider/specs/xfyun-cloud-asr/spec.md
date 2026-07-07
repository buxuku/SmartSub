# Spec: xfyun-cloud-asr

## ADDED Requirements

### Requirement: 讯飞服务商类型注册与配置

系统 SHALL 提供内置云 ASR 服务商类型「讯飞 录音文件转写大模型」（id: `xfyun`，品牌型硬单例，端点固定不开放自定义），配置字段包含 APPID（`appid`）、APIKey（`apiKey`）、APISecret（`apiSecret`）三项必填凭据与语种档位（`models`），并沿用通用的 `requestTimeoutSec` / `concurrency` / `requestInterval` 字段。

#### Scenario: 类型出现在云转写配置面板

- **WHEN** 用户打开云转写服务商配置面板
- **THEN** 「讯飞 录音文件转写大模型」作为单例类型分区展示，可配置且封顶 1 个实例

#### Scenario: 就绪判定

- **WHEN** 实例的 appid、apiKey、apiSecret 均非空且 models 至少一档
- **THEN** `isAsrProviderConfigured` 判定为已配置；任一必填项缺失则判定未配置

### Requirement: 语种档位选择与开通提示

`models` 字段 SHALL 以单选档位承载语种范围：`autodialect`（默认，中英 + 202 种方言免切识别，开通服务即用）与 `autominor`（37 语种免切识别，需联系讯飞人工对接单独开通）。UI tips MUST 说明每档支持的语种范围及 autominor 的开通条件。

#### Scenario: 默认档位

- **WHEN** 用户新建讯飞实例
- **THEN** `models` 默认为 `autodialect`

#### Scenario: 档位说明可见

- **WHEN** 用户在配置面板查看 models 字段提示
- **THEN** 提示文案包含两档的语种覆盖差异与「autominor 需人工对接开通」的说明

### Requirement: 档位与任务原语言的上传前守卫

转写 SHALL 在上传音频前校验「所选档位是否支持任务原语言」：`autodialect` 支持 auto/zh/zh-hant/yue/en；`autominor` 支持 auto 及讯飞公布的 37 语种对应 ISO-639-1 代码。不支持时 MUST 上传前报错且不发起请求，错误信息区分「可切换 autominor 解决」与「讯飞不支持该语言」两种情况。

#### Scenario: autodialect 档转写日语任务被拦截

- **WHEN** 实例档位为 `autodialect` 且任务原语言为 `ja`
- **THEN** 转写在上传前失败，错误信息提示日语属 autominor 档（37 语种），需开通并切换档位

#### Scenario: 自动识别语言放行

- **WHEN** 任务原语言为「自动识别」（auto/空）
- **THEN** 两档均直接放行（档位本身即免切自动识别）

### Requirement: 异步转写生命周期（上传-轮询-解析）

讯飞 service SHALL 在 `AsrTranscriber` 合同内完成完整异步生命周期：以 octet-stream 直传音频到 `/v2/upload` 获得 orderId，随后轮询 `/v2/getResult` 直至订单完成（`status=4`），解析 lattice 返回 `AsrTranscribeResult`；云引擎适配器无需感知异步细节。轮询 MUST 满足：总查询次数 ≤96 次（官方硬限 100 次），采用梯度间隔（先密后疏），单次查询失败不中止订单（连续多次失败才判死）。

#### Scenario: 正常转写

- **WHEN** 上传成功且订单在等待上限内完成
- **THEN** 返回带词级时间戳的转写结果，任务产出字幕

#### Scenario: 订单失败

- **WHEN** getResult 返回 `status=-1` 或 failType 指示上传/转码/识别失败
- **THEN** 转写以包含 failType 语义的可行动错误信息失败

#### Scenario: 等待超限

- **WHEN** 轮询达到总次数或总时长上限订单仍未完成
- **THEN** 转写失败，错误信息提示「音频过长或服务繁忙，可稍后重试」

#### Scenario: 任务取消

- **WHEN** 用户在上传或轮询过程中取消任务
- **THEN** 在途请求与等待立即中断并抛出取消语义（TaskCancelledError）

### Requirement: 鉴权签名

每次 HTTP 请求（含 upload 重试与每次 getResult）SHALL 重新生成 `dateTime`（本地时区 `yyyy-MM-dd'T'HH:mm:ss±HHmm`）并重签：签名 baseString 为「非空参数按名 ASCII 排序、值经 Java URLEncoder 兼容编码后的 `k=v&` 拼接串」，`signature = Base64(HmacSHA1(baseString, APISecret))` 置于请求头；该 baseString MUST 与最终请求 URL 查询串完全一致（零编码歧义）。同一订单的 upload 与后续 getResult MUST 复用同一 `signatureRandom`。

#### Scenario: 重试重签

- **WHEN** upload 因可重试错误退避后重发
- **THEN** 重发请求携带新生成的 dateTime 与对应新签名

### Requirement: lattice 结果解析

解析 SHALL 从 `orderResult.lattice`（顺滑后结果）提取：句级 `st.bg/ed`（毫秒）→ segments（秒）；`wp=n` 词 token 的 `wb/we`（10ms 帧、相对句首）→ words（秒）；`wp=p` 标点内联并入前一词尾；`wp=s`（顺滑词）与 `wp=g`（分段标记）跳过。`json_1best` MUST 兼容字符串与对象两种形态；结构异常的元素逐个跳过不中断整单解析。

#### Scenario: 词级成句

- **WHEN** lattice 含词级 wb/we 时间戳
- **THEN** 结果 `hasWordTimestamps=true`，字幕经内置词级成句管线生成（带标点）

#### Scenario: 词级缺失降级

- **WHEN** lattice 仅句级 bg/ed 可用（词级信息缺失或异常）
- **THEN** 结果回落 segments，字幕按句级时间轴生成

### Requirement: 跨会话订单续查

系统 SHALL 在 upload 成功后持久化订单记录（键 = 压缩音频内容 hash + 服务商实例 id + 语种档位，值含 orderId 与 signatureRandom 及创建时间）；转写入口 MUST 先查有效记录（创建 72 小时内），命中则跳过上传直接轮询续查，订单完结后删除记录；续查发现订单不存在或非法时 MUST 清除记录并回落新上传。轮询达等待上限退出时记录 SHALL 保留，供重跑任务继续续查。应用运行期间（含窗口关闭转后台）轮询由主进程持续执行，不依赖本机制。

#### Scenario: 退出应用后重跑续查

- **WHEN** 转写订单进行中用户彻底退出应用，重开后重跑同一视频任务（同服务商实例与档位）
- **THEN** 转写跳过上传、直接以持久化的 orderId 与 signatureRandom 续查轮询，不产生新订单计费

#### Scenario: 订单已失效回落新单

- **WHEN** 续查时服务端返回订单不存在/非法
- **THEN** 清除持久化记录并正常上传新订单

#### Scenario: 完结清理

- **WHEN** 订单转写成功、失败或判定静音
- **THEN** 对应持久化记录被删除

### Requirement: 错误分类与静音语义

错误处理 SHALL 分类：鉴权/凭据/权限类（`000002`/`100009`/`100008`/`100007`）不重试并给出可行动文案；频率超限（`100012`）、未知异常（`999999`）、HTTP 429/5xx 与网络/超时按指数退避有限重试；订单 `failType=6`（静音文件）MUST 按空结果成功返回（与本地引擎「无人声→空字幕」语义一致）。

#### Scenario: 静音音频

- **WHEN** 订单完成但 failType=6（静音）
- **THEN** 转写返回空结果成功，产出空字幕而非报错

#### Scenario: 签名错误

- **WHEN** 服务端返回 code 100009
- **THEN** 不重试，错误信息提示检查 APISecret

### Requirement: 音频上传约束声明

讯飞类型 SHALL 声明 `maxUploadBytes = 48MB`（以 32kbps mp3 计 ≈3.3 小时，间接钳制官方 5 小时时长上限），使绝大多数视频整文件单订单转写；超限时回落全局切片管线（`maxChunkSeconds` 不声明、用全局默认）。

#### Scenario: 常规视频单订单转写

- **WHEN** 压缩后音频 ≤48MB
- **THEN** 整文件单次上传、单订单完成，不触发切片

### Requirement: 连通性自测

连通性测试 SHALL 以完整签名调用 getResult 携伪造 orderId 实现零成本探测：`100037`（orderId 非法）判定凭据有效；`100009` 提示 APISecret 错误；`000002` 提示 APIKey 错误；`100008` 提示系统时间偏差。测试 MUST NOT 创建真实订单或消耗转写时长。

#### Scenario: 凭据有效

- **WHEN** 用户点击测试且服务端返回 code 100037
- **THEN** 测试通过

#### Scenario: 凭据错误

- **WHEN** 服务端返回 100009 或 000002
- **THEN** 测试失败并给出对应字段（APISecret/APIKey）的可行动提示

### Requirement: 界面文案国际化

新增的配置字段标签、tips、placeholder 与错误提示 SHALL 提供中英双语文案（`renderer/public/locales/{zh,en}/resources.json`），凭据 tips MUST 指引控制台获取路径（讯飞开放平台 → 应用 → 录音文件转写大模型 → 服务接口认证信息）。

#### Scenario: 中英文案齐备

- **WHEN** 运行 `check:i18n` 校验
- **THEN** 新增 key 在 zh/en 资源中均存在且无缺失
