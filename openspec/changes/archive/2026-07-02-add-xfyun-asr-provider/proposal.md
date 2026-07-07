# Proposal: add-xfyun-asr-provider

## Why

SmartSub 云转写现有国内服务商（火山/腾讯/阿里）对中文方言与重口音内容覆盖有限，而讯飞「录音文件转写大模型」以中英 + 202 种方言免切识别为核心能力，是中文字幕场景的重要补充。用户已开通该服务并完成最小连通性实测（鉴权方案、异步轮询、词级时间戳、中英混合识别均验证通过），具备落地条件。

## What Changes

- 新增云 ASR 服务商类型「讯飞 录音文件转写大模型」（品牌型硬单例，端点固定 `office-api-ist-dx.iflyaisol.com`），凭据三件套 APPID / APIKey / APISecret（映射 API 的 `appId` / `accessKeyId` / `accessKeySecret`，实测确认）。
- `models` 作为「语种档位」选择（对齐腾讯 standard/large 的档位模式）：
  - `autodialect`（默认）：中英 + 202 种方言免切识别，开通即用；
  - `autominor`：37 语种免切识别，需联系讯飞人工对接单独开通——UI tips 明确标注支持语种与开通方式。
- 引入云 ASR 体系首个**异步转写 service**（upload 拿 orderId → 轮询 getResult）：轮询完全封装在 service 层的 `transcribeWithXfyun` 内，云引擎适配器（`cloudAsrEngine`）零改动。
- **跨会话订单续查**：upload 成功即持久化 orderId（键 = 音频内容 hash + 服务商实例 + 档位）；应用退出重开后重跑同一任务时命中未过期订单则跳过上传直接续查轮询，不重复计费、不重新排队（切页面/关窗转后台场景主进程本就持续轮询，无需额外机制）。
- 档位 × 任务原语言的上传前守卫：所选档位不支持任务原语言时明确报错（继续上传只会产出乱码还照常计费，语义对齐腾讯守卫）。
- 连通性自测：`getResult` + 假 orderId 探针（实测 `100037`=凭据有效 / `100009`=APISecret 错 / `000002`=APIKey 错），不创建真实订单、不消耗转写时长。
- lattice 结果解析：句级 `bg/ed`（毫秒）→ segments；词级 `wb/we`（10ms 帧，相对句首）→ words 喂现有词级成句管线；标点 token（`wp=p`）内联并入前词。
- i18n 中英文案（凭据获取路径、档位语种说明、autominor 开通提示）。

## Capabilities

### New Capabilities

- `xfyun-cloud-asr`: 讯飞录音文件转写大模型作为云 ASR 服务商——配置（凭据/档位）、异步转写（上传/轮询/解析/重试/取消）、语言守卫与连通性自测。

### Modified Capabilities

无。云引擎适配器、切片管线、成句管线的既有需求不变；本变更是在既有 `AsrTranscriber` 合同下纯新增一个 service 实现与服务商类型注册。

## Impact

- **types**: `types/asrProvider.ts` 新增 `ASR_XFYUN` 常量、服务商类型定义（fields / audioLimits / 档位 options）。
- **main**: 新增 `main/service/asr/xfyunUtils.ts`（签名/参数/lattice 解析/错误分类/语种映射，纯函数）与 `main/service/asr/xfyun.ts`（上传+轮询+重试）；`main/service/asr/index.ts` 注册分发；`main/service/asr/testConnection.ts` 增加探针分支。
- **renderer**: `renderer/public/locales/{zh,en}/resources.json` 增加 tips/placeholder 文案；配置面板复用现有 select 字段渲染，无组件改动；服务商图标复用现有 `spark-color.svg`（讯飞星火）。
- **tests**: `scripts/test-engine-units.ts` 增加 xfyunUtils 纯函数与类型注册单测。
- **依赖**: 无新增（签名用 node:crypto，HTTP 用全局 fetch）。
- **风险**: 异步轮询引入新的超时语义（订单总等待 vs 单请求超时）；getResult 有 ≤100 次硬限制；轮询期间任务进度条停留固定值（与现有大文件单请求行为一致，可后续优化）。
