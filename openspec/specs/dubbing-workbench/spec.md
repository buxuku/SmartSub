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
