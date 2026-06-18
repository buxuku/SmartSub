# engine-model-management Specification

## Purpose

本能力定义资源中心「引擎与模型」面的模型管理契约:用户按引擎管理模型的存储位置、来源(运行时下载 / 本地导入)与共享依赖。本规格聚焦以应用托管模型为中心的引擎(builtin / fasterWhisper / funasr / qwen / fireRedAsr)在模型路径自定义、从本地文件夹导入,以及 sherpa 系共享 VAD 内置与解耦上的一致行为,使「自定义模型路径」「本地导入」对齐到所有托管模型的引擎,并让共享 VAD 与各引擎可变的模型根目录彻底解耦。

## Requirements

### Requirement: 每引擎可自定义模型存储路径

系统 SHALL 为每个以应用托管模型为中心的引擎(builtin / fasterWhisper / funasr / qwen / fireRedAsr)提供独立的「自定义模型根目录」能力。每个引擎 MUST 读取自身的路径设置覆盖值,未设置时回退到默认 `userData/models/<engine>`。更换路径 MUST NOT 影响其它引擎的路径设置。该路径变更 MUST 即时持久化,并对该引擎随后的模型下载、导入、读取与「打开模型目录」生效。

#### Scenario: 为 sherpa 引擎设置自定义路径

- **WHEN** 用户在 funasr / qwen / fireRedAsr 的模型面板点击「更换路径」并选择一个目录
- **THEN** 系统持久化该引擎对应的路径设置(`funasrModelsPath` / `qwenModelsPath` / `fireRedModelsPath`)
- **AND** 该引擎随后的模型下载 / 导入 / 已安装判定 / 打开目录都指向新路径

#### Scenario: 未设置自定义路径时回退默认

- **WHEN** 某引擎未设置自定义模型路径
- **THEN** 系统使用默认目录 `userData/models/<engine>` 作为读写位置

#### Scenario: 改路径不迁移旧目录模型

- **WHEN** 用户将某引擎的模型路径切换到新目录
- **THEN** 旧目录下已有的模型不被自动移动,也不再在新路径下被列为已安装
- **AND** 系统通过文案提示用户:如需沿用旧模型,可手动移动或重新下载 / 导入

#### Scenario: 打开模型目录跟随当前生效路径

- **WHEN** 用户在某引擎面板点击「打开模型目录」
- **THEN** 系统打开该引擎当前生效的路径(自定义覆盖值,否则默认目录)

### Requirement: 从本地文件夹导入模型

系统 SHALL 允许将本地文件夹中的模型导入到**指定引擎的指定模型槽**。导入 MUST 携带目标 `(引擎, 模型 id)` 以消除歧义(因部分引擎不同模型的关键文件相同,无法靠扫描判别)。导入前系统 MUST 依据该模型在清单中的 `requiredFiles`(支持嵌套相对路径)校验源文件夹布局;校验通过后 MUST 将源文件夹整体拷入该引擎模型库的正确子目录并保留嵌套结构,随后既有「已安装」判定 SHALL 自动识别该模型。builtin 引擎 SHALL 保留其单文件(`.bin` / `.mlmodelc`)导入方式。本能力 MUST NOT 支持导入压缩包,VAD 模型 MUST NOT 纳入导入范围。

#### Scenario: 导入 sherpa 模型(含嵌套目录)

- **WHEN** 用户对某个 funasr / qwen / fireRedAsr 模型触发「从文件夹导入」并选择一个包含该模型全部 `requiredFiles`(含如 `tokenizer/vocab.json` 的嵌套文件)的目录
- **THEN** 系统将该目录整体拷入 `<引擎根目录>/<模型子目录>` 并保留嵌套结构
- **AND** 该模型随后显示为「已安装」,可在任务中选用

#### Scenario: 布局校验失败则拒绝且不写盘

- **WHEN** 用户选择的文件夹缺少目标模型所需的关键文件
- **THEN** 系统拒绝本次导入,不向模型库写入任何文件
- **AND** 提示缺失了哪些必需文件(布局不匹配)

#### Scenario: 导入 fasterWhisper(CT2)模型

- **WHEN** 用户对某 fasterWhisper 模型触发导入并选择一个符合 CT2 布局(含 `model.bin` 等关键文件)的文件夹
- **THEN** 系统将其落入可被模型解析器命中的快照目录
- **AND** 该模型随后显示为「已安装」

#### Scenario: builtin 维持单文件导入

- **WHEN** 用户在 builtin 引擎触发导入
- **THEN** 系统沿用现有单文件对话框(仅 `.bin` / `.mlmodelc`),将文件拷入 builtin 模型目录

#### Scenario: 取消选择不产生变更

- **WHEN** 用户在文件夹选择对话框点击取消
- **THEN** 系统不修改任何模型文件或设置

### Requirement: 共享 VAD 模型随应用内置

系统 SHALL 将 sherpa 系引擎(funasr / qwen / fireRedAsr)共用的 Silero VAD 模型(`silero_vad.onnx`)随应用安装包内置,作为引擎无关的只读资源,而非运行时下载或导入。这些引擎解析 VAD 路径时 MUST 指向该内置资源,MUST NOT 依赖任何引擎可自定义的模型根目录。因此,任一引擎更换自定义模型路径 MUST NOT 影响 VAD 可用性或其它引擎的就绪状态。VAD 的「就绪」判定 MUST NOT 依赖用户的下载行为。系统 MUST NOT 为 VAD 提供下载或从文件夹导入入口。

#### Scenario: VAD 开箱即用,无需下载

- **WHEN** 用户首次安装应用并选择 funasr / qwen / fireRedAsr 任一引擎
- **THEN** 共享 VAD 已随应用就位,无需任何下载或导入即视为就绪
- **AND** 该引擎「就绪」只取决于其是否至少安装了一个 ASR 模型

#### Scenario: 更换某引擎模型路径不影响 VAD

- **WHEN** 用户将 funasr(或 qwen / fireRedAsr)的模型根目录切换到自定义路径
- **THEN** 共享 VAD 的解析位置不随之改变(仍指向内置只读资源)
- **AND** 其它 sherpa 引擎的就绪状态不因此受影响

#### Scenario: VAD 不出现在可下载 / 可导入列表

- **WHEN** 用户查看 funasr / qwen / fireRedAsr 的模型面板
- **THEN** 系统不再为 VAD 提供「下载」或「从文件夹导入」入口(VAD 标注为已内置或不单独列出)
