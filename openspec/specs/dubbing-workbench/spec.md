# Spec: dubbing-workbench

## Purpose

配音工作台 UI 与应用集成:字幕+可选视频输入(query 预填/拖放/最近任务导入)、全局配音配置、虚拟滚动行级列表(行级 voice/试听/重生成/过长兜底)、播放器联动;独立「配音服务」配置页、导航登记与主流程完成横幅衔接、dubbing: IPC 命名空间。

## Requirements

### Requirement: 配音工作台页面与输入

系统 SHALL 提供独立「配音工作台」页面(`dubbing.tsx`,工具页范式:薄页面壳 + Panel + 单一状态 hook):输入为一份字幕文件 + 可选视频文件,SHALL 支持 URL query(`?subtitle=&video=`)预填以承接外部跳转,并提供「从最近任务导入」入口。

#### Scenario: 仅字幕进入

- **WHEN** 用户只选择一份 srt 文件
- **THEN** 工作台正常加载行列表,输出形态仅开放「仅音频」

#### Scenario: query 预填

- **WHEN** 以 `?subtitle=<路径>&video=<路径>` 打开工作台
- **THEN** 文件条自动填入对应字幕与视频,无需再次选择

### Requirement: 全局配音配置

工作台 SHALL 提供全局配置:引擎(本地模型 / 云端服务商实例)、voice(含试听)、整体语速、背景音模式(静音原轨 / 压低原轨)、输出形态(仅音频 / 替换音轨 / 混音 / 新增音轨);配置 SHALL 被记忆,下次进入自动恢复。

#### Scenario: voice 试听

- **WHEN** 用户在配置栏选择 voice 并点击试听
- **THEN** 以该 voice 合成一句示例文本并播放,不影响行列表状态

### Requirement: 行级列表与行级操作

工作台 SHALL 以虚拟滚动列表展示全部字幕行(时间轴、文本、voice、状态),支持:行级 voice 覆盖(默认全局 voice,数据结构 `cue.voiceId`)、行级试听(合成前预听 voice / 合成后回放该行结果)、行级重生成、行文本编辑;行状态 MUST 覆盖:待合成 / 合成中 / 完成 / 过长警告 / 重叠告警 / 失败可重试。

#### Scenario: 行级 voice 覆盖

- **WHEN** 用户将第 5 行 voice 从默认改为「角色A」并重生成
- **THEN** 仅该行以新 voice 重新合成,其余行不变

#### Scenario: 行级状态可视

- **WHEN** 批量合成进行中
- **THEN** 每行实时显示各自状态,完成行可单独回放

### Requirement: 过长行人工兜底

合成完成后,所有过长行(所需倍率 > 1.5x)SHALL 以显著告警样式呈现并可筛选;每条过长行 MUST 提供三个修复动作:改文案(编辑后重合成该行)、单行重生成、接受变速(放行超红线变速)。

#### Scenario: 过长行清单

- **WHEN** 合成完成且存在 ratio > 1.5 的行
- **THEN** 这些行全部带黄色警告标识,可一键筛出逐条处理

#### Scenario: 接受变速

- **WHEN** 用户对某过长行选择「接受变速」
- **THEN** 该行按所需倍率变速对齐,警告状态转为已确认,不再阻塞导出提示

### Requirement: 播放器预览

工作台 SHALL 集成播放器(复用 `media://` 协议的本地播放能力):有视频时预览视频 + 配音效果,无视频时播放合成音轨;播放进度与行列表 SHALL 双向联动(点行跳转 / 播放到某行高亮)。

#### Scenario: 行与播放联动

- **WHEN** 用户点击第 12 行
- **THEN** 播放器跳转到该行 start 时间;播放经过某行时该行高亮

### Requirement: 配音服务独立页面

系统 SHALL 提供独立「配音服务」导航页(形制「引擎与模型」的主从双栏),统一管理:本地 TTS 模型(每个模型一个左栏条目:下载/进度/删除/导入/打开目录)与在线配音服务商(**每个服务商一个平级左栏条目逐条外显**——OpenAI、硅基流动、Edge TTS 等,新服务商可扩展追加);服务商条目 = 配置表单 + 测试连接 + 已配置状态点(形制同云 ASR 的 CloudProviderPanel),协议型(OpenAI 兼容)MUST 支持「添加自定义」接入任意兼容端点(多实例)。

#### Scenario: 页面入口与条目外显

- **WHEN** 用户打开「配音服务」页
- **THEN** 左栏分「本地模型」(kokoro、vits-zh 逐条)与「在线服务」(OpenAI、硅基流动、Edge TTS 逐条 + 添加自定义)两组,选中任一条目右栏即为其管理面板

#### Scenario: 自定义端点扩展

- **WHEN** 用户点击「添加自定义」并命名新实例
- **THEN** 生成新的 OpenAI 兼容实例条目,可独立配置 Base URL / Key / 音色并测试连接

### Requirement: 导航登记与主流程衔接

新功能 SHALL 完成四处登记:侧边导航 `NAV_ITEMS` 新增「配音」、i18n namespace `dubbing.json`(zh/en 齐备,`check:i18n` 通过)、启动台 `CARDS` 卡片、`CommandPalette` 命令;主任务流完成横幅(CompletionBanner)SHALL 新增「去配音」动作,携带产出字幕与视频路径跳转到工作台。

#### Scenario: 横幅衔接

- **WHEN** 一个含翻译的主流程任务完成,用户点击横幅「去配音」
- **THEN** 跳转配音工作台且字幕/视频已预填

#### Scenario: i18n 齐备

- **WHEN** 运行 `check:i18n`
- **THEN** dubbing namespace 的 zh/en key 无缺失

### Requirement: IPC 命名空间

配音相关 IPC SHALL 使用 `dubbing:` 命名空间,invoke 统一返回 `{success, data?, error?, cancelled?}`,进度以事件推送(形制同 subtitleMerge)。

#### Scenario: 统一返回结构

- **WHEN** 渲染进程调用任一 `dubbing:` invoke 接口
- **THEN** 成功与失败均以 `{success, …}` 结构返回,异常不以未捕获 reject 形式泄漏

### Requirement: 合成字符量预估展示

工作台 SHALL 在合成发起入口旁展示「下次运行将合成的行数与字符量」:口径为待合成行(非完成/非已确认)的正文字符合计,全量重跑入口按全部行合计;数值 MUST 随行编辑、行状态流转实时更新。选中云端引擎时 SHALL 叠加计费口径提示(按字符计费;Azure 实际计费含 SSML 标记字符、略高于展示值;ElevenLabs 中文按字节膨胀计费;试听与单行重生成产生额外消耗);本地引擎仅展示行数与字符量,不带计费提示。

#### Scenario: 合成前可见字符量

- **WHEN** 用户加载 200 行字幕并选中云端引擎
- **THEN** 开始按钮旁展示「200 行 · N 字符」及计费口径提示,N 等于全部行正文字符合计

#### Scenario: 部分完成后口径切换

- **WHEN** 批量合成完成 150 行后剩余 50 行待合成
- **THEN** 「继续配音」入口旁的字符量仅统计剩余 50 行;「全部重跑」入口按 200 行全量口径

### Requirement: 重叠处理模式选项

工作台配置 SHALL 提供重叠处理模式选项(顺延/多轨混合,默认顺延),该选项 MUST 仅在当前会话存在重叠行时展示;选项值 SHALL 与其余全局配置一同被记忆。

#### Scenario: 无重叠时选项隐藏

- **WHEN** 加载的字幕无任何时间交叠行
- **THEN** 配置栏不出现重叠处理模式选项,导出按默认单轨路径进行

#### Scenario: 选择多轨混合

- **WHEN** 会话存在重叠行且用户将重叠处理切为「多轨混合」后导出
- **THEN** 产物中重叠行同时发声、锚定原时间轴,行列表的重叠告警标记照常展示

### Requirement: 云端引擎就绪判定

工作台引擎下拉的云端服务商实例 SHALL 以 `isTtsProviderConfigured`(全部必填字段就绪)判定可用性,未就绪实例 MUST 禁用并提示前往「配音服务」页完成配置;仅音色清单非空但必填凭据缺失的实例 MUST NOT 可选。

#### Scenario: 半配置实例不可选

- **WHEN** 用户新建 Azure Speech 实例仅填音色未填 subscription key
- **THEN** 工作台引擎下拉中该实例呈禁用态并提示未就绪,不可发起合成
