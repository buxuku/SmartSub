## ADDED Requirements

### Requirement: sherpa 系引擎原生运行库随应用内置

系统 SHALL 将 sherpa 系引擎（funasr / qwen / fireRedAsr）共用的 sherpa-onnx 原生运行库随应用安装包内置（作为引擎无关的只读资源经 extraResources 发布），而非运行时下载。这些引擎解析原生库路径时 MUST 指向该内置资源；运行库的「已安装 / 就绪」判定 MUST NOT 依赖任何用户下载行为。系统 MUST NOT 为该运行库提供下载 / 升级 / 卸载入口。引擎的就绪 SHALL 仅取决于其是否至少安装了一个 ASR 模型（共享 VAD 亦已随应用内置）。

#### Scenario: 全新安装即可用，无需下载运行库

- **WHEN** 用户首次安装应用并在无网络环境下选择 funasr / qwen / fireRedAsr，且已具备至少一个对应 ASR 模型
- **THEN** sherpa 原生运行库已随应用就位，无需任何下载即视为就绪
- **AND** 该引擎可直接用于转写

#### Scenario: 引擎面不再出现运行库下载入口

- **WHEN** 用户查看 funasr / qwen / fireRedAsr 的引擎面板
- **THEN** 系统不提供 sherpa 运行库的「下载 / 升级 / 卸载」入口（标注为已内置）
- **AND** 仅呈现各 ASR 模型的下载 / 导入 / 删除与引擎专属高级设置

#### Scenario: 运行库随应用版本升级

- **WHEN** sherpa 运行库需要版本更新
- **THEN** 该更新随应用版本发布（升级 App 即升级运行库）
- **AND** 系统不在应用内对运行库做单独的运行时下载升级

### Requirement: faster-whisper 运行时以单一自包含包按需下载

系统 SHALL 以**单个自包含运行时包**（内嵌 Python 解释器 + 依赖 + 入口）按需提供 faster-whisper 运行时，且 MUST NOT 在应用安装包内内置 Python 基座。faster-whisper 的「就绪」判定 MUST 仅以该运行时包是否完整安装为准；系统 MUST NOT 因「缺少内置 Python 基座」而要求用户重装或升级应用。未安装时系统 SHALL 提供单次下载入口（标注合并后的体积）。

#### Scenario: 首次使用触发单包下载

- **WHEN** 用户首次选择 faster-whisper 且运行时未安装
- **THEN** 系统提供一次性下载该自包含运行时包的入口（不区分基座 / 引擎两段）
- **AND** 下载并安装完成后 faster-whisper 视为就绪，可用于转写

#### Scenario: 不内置 Python 基座

- **WHEN** 用户从未使用 faster-whisper
- **THEN** 安装包不包含任何 Python 基座资源，相应安装体积被节省
- **AND** builtin 与 sherpa 系引擎不受影响（其运行时分别内置）

#### Scenario: 运行时缺失按「未安装」处理而非要求重装应用

- **WHEN** faster-whisper 运行时包缺失或损坏
- **THEN** 系统将其呈现为「未安装」并提供重新下载入口
- **AND** 系统不提示「缺少基座，请重装 / 升级应用」
