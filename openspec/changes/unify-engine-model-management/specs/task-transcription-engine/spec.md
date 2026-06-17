## ADDED Requirements

### Requirement: 逐任务选择转写引擎

任务配置 SHALL 通过「引擎 ▸ 模型」分组选择器让用户在任务级别选择转写引擎与模型。选中一项 MUST 同时确定 (引擎, 模型) 二元组（消除同名模型在不同引擎间的歧义）。系统 MUST NOT 维护"全局当前引擎"单例来决定任务使用哪个引擎。

#### Scenario: 分组选择确定引擎与模型

- **WHEN** 用户在任务配置的模型选择器中展开下拉
- **THEN** 选项按引擎分组（如 Builtin / FasterWhisper / FunASR），每组下列出该引擎已安装的模型
- **AND** 用户选中某组下的某模型后，任务的引擎与模型被同时确定

#### Scenario: 任务选择器仅列出引擎运行时已安装的模型

- **WHEN** 用户已下载某引擎（如 faster-whisper / funasr）的模型，但尚未安装该引擎的运行时
- **THEN** 任务配置的模型选择器 MUST NOT 列出该引擎的任何模型（因未装运行时不可转写）
- **AND** 内置 whisper.cpp 运行时无需安装，其已下载的 ggml 模型始终可被选择
- **AND** 该模型在「引擎与模型」管理页仍可见、可管理（下载与引擎安装解耦，仅任务选择按运行时是否就绪过滤）

#### Scenario: 不同任务可用不同引擎

- **WHEN** 用户对一批文件选择引擎 A，对另一批文件选择引擎 B
- **THEN** 两批任务各自按所选引擎执行，互不影响，且无需切换任何全局开关

#### Scenario: localCli 可在分组选择器中直接选中

- **WHEN** 用户展开分组下拉并查看 LocalCLI 分组
- **THEN** 该分组列出内置规范模型名（如 tiny…large-v3）供选择
- **AND** 所选模型名可被 localCli 的 `whisperCommand` 模板 `${whisperModel}` 占位符替换

### Requirement: 任务携带引擎并由后端按此执行

任务数据 SHALL 携带 `transcriptionEngine` 字段。后端转写路由 MUST 依据任务所带引擎解析适配器并执行，而非读取全局设置。sidecar / 运行时预热 MUST 针对任务所带引擎进行。

#### Scenario: 后端按任务引擎执行

- **WHEN** 一个携带 `transcriptionEngine = fasterWhisper` 的任务开始执行
- **THEN** 后端选用 faster-whisper 适配器进行转写
- **AND** 若该引擎需要运行时，则在执行前预热 faster-whisper 的 sidecar / 运行时

#### Scenario: 选用未就绪引擎时的处理

- **WHEN** 任务所带引擎的运行时或模型尚未就绪
- **THEN** 后端不静默回退到其它引擎，而是以明确错误结束该任务（提示去安装/下载）

### Requirement: 默认引擎与模型取"上次使用"

新任务的默认引擎与模型 SHALL 取**全局单条**"上次使用"的记忆值，(引擎, 模型) 作为一个整体记录（不按任务类型分别记忆，避免引擎/模型失配）；当不存在记忆值（初次使用）时，默认引擎为 builtin（whisper.cpp）。任务成功配置/执行后，所用 (引擎, 模型) MUST 更新为新的"上次使用"值。

#### Scenario: 初次使用默认 builtin

- **WHEN** 用户初次进入任务页且无历史记忆
- **THEN** 模型选择器默认定位到 builtin 引擎下的某个可用模型

#### Scenario: 记忆上次使用

- **WHEN** 用户上次以 funasr 执行过任务，随后新建任务
- **THEN** 模型选择器默认定位到 funasr 引擎及其上次所用模型（若仍可用）

### Requirement: 混合引擎队列的并发钳制

当任务队列中包含多种引擎时，系统 SHALL 按队列中"最受限引擎"钳制并发：只要存在 faster-whisper 或 funasr 任务，相关并发上限 MUST 被钳制为 1，以避免共享 sidecar / 显存争用。本期 MUST NOT 实现"部分引擎并行、部分串行"的混合调度。

#### Scenario: 队列含受限引擎时钳为 1

- **WHEN** 队列中存在 faster-whisper 或 funasr 任务
- **THEN** 有效并发上限被钳制为 1

#### Scenario: 纯 builtin 队列遵循用户并发设置

- **WHEN** 队列中全部为 builtin 任务
- **THEN** 有效并发上限等于用户配置的 `maxConcurrentTasks`

### Requirement: 跨引擎就绪判断

系统的"是否已就绪可转写"判断（用于新手引导、全景概览、任务页"去下载模型"引导）SHALL 基于**跨引擎**口径："任意引擎装有任意**可运行**模型即视为就绪"，而非仅看某单一引擎；其中"可运行"与任务选择器同口径——faster-whisper / funasr 还需其运行时已安装，builtin 内置运行时始终可运行。

#### Scenario: 任一引擎有可运行模型即就绪

- **WHEN** 用户未在 builtin 装模型，但已在 faster-whisper 装有模型且其运行时已安装
- **THEN** 系统视为已就绪，不再弹出"尚未安装任何模型"的新手引导

#### Scenario: 仅下了模型未装运行时不算就绪

- **WHEN** 用户仅下载了 faster-whisper 模型但未安装其运行时，且无任何 builtin 模型
- **THEN** 系统视为尚未就绪，任务页展示"去下载模型/安装引擎"入口

#### Scenario: 全无模型时引导下载

- **WHEN** 所有引擎均未安装任何模型
- **THEN** 任务页模型选择处展示"去下载模型"入口，链接到引擎与模型管理

### Requirement: 移除全局引擎指示

系统 MUST NOT 在顶栏展示"当前转写引擎"徽章，也 MUST NOT 在模型管理处展示"当前引擎"上下文条。全局 `settings.transcriptionEngine` 字段及"设为当前引擎"的 IPC 语义 SHALL 被移除。

#### Scenario: 顶栏无引擎徽章

- **WHEN** 用户查看应用顶栏
- **THEN** 不存在"当前转写引擎"徽章；加速状态等其它指示器不受影响
