## ADDED Requirements

### Requirement: 统一的引擎与模型管理面

系统 SHALL 在资源中心提供单一的「引擎与模型」入口，采用主从双栏布局：左栏列出全部转写引擎，右栏展示**当前选中引擎**的运行时管理与模型清单。引擎与模型 MUST 在同一视图内管理，不再使用独立的卡片 + 弹窗（Drawer）模式。资源中心顶层 Tab SHALL 由 5 个收敛为 4 个（全景 / 引擎与模型 / 翻译服务 / 加速）。

#### Scenario: 进入引擎与模型 Tab

- **WHEN** 用户打开资源中心并切换到「引擎与模型」
- **THEN** 左栏显示引擎列表（builtin / fasterWhisper / funasr / localCli），右栏显示左栏当前选中引擎的运行时状态、参数与模型清单
- **AND** 不弹出任何 Drawer 或对话框即可完成浏览

#### Scenario: 旧深链接归一

- **WHEN** 外部链接指向 `resources?tab=engines` 或 `resources?tab=models`
- **THEN** 两者都落到统一的「引擎与模型」Tab，不出现 404 或空白 Tab

### Requirement: 引擎不再有"启用 / 设为当前"概念

引擎列表 SHALL 仅呈现每个引擎的就绪状态（如：就绪 / 引擎未安装 / 需配置），MUST NOT 提供"启用开关"或"设为当前引擎"按钮。左栏选中某引擎仅表示"正在管理该引擎"，与任务实际使用哪个引擎无关。

#### Scenario: 选中引擎不改变任何全局状态

- **WHEN** 用户在左栏点选某个引擎
- **THEN** 右栏切换为该引擎的管理内容
- **AND** 系统不写入任何"当前引擎"全局设置，也不触发引擎切换的副作用

### Requirement: 引擎运行时生命周期管理

对于需要运行时的引擎（如 faster-whisper、funasr），系统 SHALL 在该引擎的右栏内提供安装、修复、升级、卸载操作，并展示下载进度与版本信息。运行时操作 MUST 在任务运行中被阻止以避免文件锁与中断。卸载 MUST 经二次确认后才执行。已安装态下 SHALL 提供"检查更新"，发现新版本时提供"升级"。faster-whisper 与 funasr 的版本/检查更新/升级/卸载（含二次确认）交互 SHALL 保持一致呈现。

#### Scenario: 安装引擎运行时

- **WHEN** 用户在某未安装引擎的右栏点击"下载/安装"并确认下载源
- **THEN** 系统开始下载该引擎运行时并展示进度
- **AND** 安装完成且校验通过后，该引擎在左栏的状态更新为"就绪"

#### Scenario: 卸载引擎运行时需二次确认

- **WHEN** 用户在已安装引擎（faster-whisper / funasr）右栏点击"卸载"
- **THEN** 系统弹出二次确认对话框，说明卸载后需重新下载方可再用
- **AND** 仅在用户确认后才执行卸载；取消则不变更任何状态

#### Scenario: 检查引擎运行时更新

- **WHEN** 用户在已安装引擎右栏点击"检查更新"
- **THEN** 系统比较已安装版本与应用预期版本：一致则提示"已是最新版本"，不一致则标记"有新版本可用"并提供"升级"
- **AND** funasr 的版本对比基于已装运行库版本与应用内置 `SHERPA_VERSION`（无远端清单），升级即按应用预期版本重新下载覆盖

#### Scenario: 任务运行中禁止运行时变更

- **WHEN** 存在运行中的转写任务，用户尝试卸载或升级某引擎运行时
- **THEN** 系统拒绝该操作并提示引擎忙碌

### Requirement: 引擎参数配置

系统 SHALL 在引擎右栏内提供该引擎特有的参数配置，包括但不限于：faster-whisper 的设备（auto/cpu/cuda，macOS 仅 auto/cpu）与计算类型；localCli 的启用开关与自备命令（多行）。参数变更 MUST 即时持久化。

#### Scenario: 配置 faster-whisper 设备

- **WHEN** 用户在 faster-whisper 右栏将设备从 auto 改为 cpu
- **THEN** 设置即时保存，后续使用该引擎的任务按新设备执行

#### Scenario: 配置 localCli 命令

- **WHEN** 用户在 localCli 右栏的多行命令框填写自备 whisper 命令并保存
- **THEN** 命令被持久化，且该引擎不展示模型下载清单（自备模型）

#### Scenario: 启用 localCli 以供任务选择

- **WHEN** 用户在 localCli 右栏开启"启用本地命令行"开关
- **THEN** 系统持久化 `useLocalWhisper=true`
- **AND** 任务页「引擎 ▸ 模型」选择器随后列出 localCli 分组；关闭开关则不列出

### Requirement: 模型管理独立于引擎安装状态

系统 SHALL 允许在任意引擎的右栏直接下载 / 删除 / 导入模型，并提供打开模型目录、切换模型目录、切换下载源、搜索、仅看已安装等操作。模型下载 MUST NOT 要求该引擎的运行时包已安装——未安装引擎时仍可先下载其模型。

#### Scenario: 引擎未安装也能下载其模型

- **WHEN** 用户选中一个运行时尚未安装的引擎，并点击其某个模型的"下载"
- **THEN** 系统开始下载该模型并展示进度
- **AND** 下载过程与结果不依赖该引擎运行时是否已安装

#### Scenario: 模型按引擎分清单展示

- **WHEN** 用户在左栏切换引擎
- **THEN** 右栏的模型清单切换为该引擎对应格式的模型（如 builtin→ggml，fasterWhisper→ct2，funasr→funasr 模型），各引擎已安装模型分别统计

### Requirement: Python 基座管理迁出引擎视图

共享 Python 基座（运行时基座）MUST NOT 作为一个引擎条目出现在「引擎与模型」视图中。基座的"检查更新"功能 SHALL 迁移到设置页。

#### Scenario: 引擎列表不含基座

- **WHEN** 用户查看「引擎与模型」左栏
- **THEN** 列表只含真实转写引擎，不含"Python 基座"条目

#### Scenario: 设置页提供基座更新

- **WHEN** 用户进入设置页
- **THEN** 可看到 Python 基座的更新入口并执行检查/更新
