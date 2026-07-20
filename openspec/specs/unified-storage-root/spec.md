# unified-storage-root Specification

## Purpose

统一存储根目录（Issue #388）：6 个模型目录与临时目录此前是 7 个互相独立的 settings 键，换盘需逐个修改且 TTS 无 UI 入口。提供 `settings.storageRoot` 一处设置全部跟随，解析链为「引擎单独设置 > 统一目录/既有默认子目录名 > userData 默认」；同时把中文（CJK）路径校验收口到所有目录选择入口（Windows 非 UTF-8 locale 下本地引擎打不开中文路径模型文件），并为中文用户名的默认路径提供主动引导。产品语义保持「改路径不迁移文件」，以新旧位置对照对话框与首次引导前置决策降低迁移摩擦（详见 archive/2026-07-20-unified-storage-root）。

## Requirements

### Requirement: 统一存储根目录与解析优先级

系统 SHALL 提供统一存储根目录设置 `settings.storageRoot`（未设置 = undefined 或空白串）。6 个模型目录（whisper.cpp、faster-whisper、FunASR、Qwen、FireRed、TTS）的有效路径 SHALL 按「引擎单独设置 > `storageRoot/<既有默认子目录名>` > `userData/<既有默认子目录名>`」解析；子目录名 MUST 与既有默认布局一致（`whisper-models`、`faster-whisper-models`、`models/funasr`、`models/qwen`、`models/firered`、`models/tts`）。模型下载、模型清单扫描、打开目录、HF 缓存注入等所有消费方 MUST 使用同一解析结果。

#### Scenario: 设置统一目录后全部引擎跟随

- **WHEN** 用户无任何引擎单独路径设置，将统一存储目录设为 `D:\SmartSub`
- **THEN** whisper.cpp 模型路径解析为 `D:\SmartSub\whisper-models`，faster-whisper 为 `D:\SmartSub\faster-whisper-models`，FunASR/Qwen/FireRed/TTS 为 `D:\SmartSub\models\{funasr,qwen,firered,tts}`，新模型下载与清单扫描均作用于新路径

#### Scenario: 单独设置优先于统一目录

- **WHEN** 用户已将 FunASR 模型目录单独设为 `E:\funasr-models`，随后设置统一存储目录 `D:\SmartSub`
- **THEN** FunASR 有效路径仍为 `E:\funasr-models`，其余未单独设置的引擎跟随 `D:\SmartSub`

#### Scenario: 未设置统一目录行为不变

- **WHEN** `storageRoot` 未设置且引擎无单独设置
- **THEN** 各引擎有效路径与本功能引入前完全一致（userData 下既有默认子目录）

### Requirement: 临时目录纳入统一根

临时目录解析 SHALL 为「`useCustomTempDir && customTempDir` > `storageRoot/temp` > 系统 temp/whisper-subtitles」三级。`storageRoot/temp` 创建失败时 MUST 记录日志并回退系统默认（与既有自定义临时目录失败行为一致）。

#### Scenario: 统一目录提供临时目录默认值

- **WHEN** 用户设置统一存储目录 `D:\SmartSub` 且未启用自定义临时目录
- **THEN** 临时文件写入 `D:\SmartSub\temp`

#### Scenario: 显式自定义临时目录仍优先

- **WHEN** 用户启用自定义临时目录 `E:\tmp` 且设置了统一存储目录
- **THEN** 临时文件写入 `E:\tmp`

### Requirement: 中文路径硬阻止

系统 SHALL 提供主进程与渲染层共享的路径校验（检测 CJK 统一表意文字、CJK 标点及全角形式）。所有目录选择入口（统一存储目录、各引擎模型路径「更改」、自定义临时目录）在用户选中含 CJK 字符的目录时 MUST 拒绝保存并以 toast 说明原因（本地引擎无法读取中文路径）。主进程 `setSettings` 对路径键（`storageRoot`、6 个模型路径键、`customTempDir`）MUST 拒绝持久化含 CJK 的值（从写入 patch 中剔除并记录警告日志）。纯英文及西文变音符路径 MUST 不被拦截。

#### Scenario: 选中含中文目录被拒绝

- **WHEN** 用户在统一存储目录选择器中选中 `D:\模型`
- **THEN** 设置不被保存，界面提示中文路径不可用及原因，`storageRoot` 保持原值

#### Scenario: 配置导入旁路被兜底

- **WHEN** 导入的配置文件中 `funasrModelsPath` 为含中文的路径
- **THEN** 该键不被持久化，其余配置正常导入，日志记录警告

#### Scenario: 非中文路径正常通过

- **WHEN** 用户选中 `D:\Média\models`（含西文变音符）
- **THEN** 路径正常保存

### Requirement: 默认路径含中文的主动引导

`storageRoot` 未设置且解析出的默认存储位置含 CJK 字符（如 Windows 中文用户名的 userData）时，设置页存储区块 SHALL 展示警示，建议用户将统一存储目录设置到纯英文路径。设置有效的 `storageRoot` 后警示 MUST 消失。

#### Scenario: 中文用户名用户看到引导

- **WHEN** Windows 用户名为中文导致 userData 路径含中文，且未设置统一存储目录
- **THEN** 设置页存储区块展示「当前默认存储位置含中文，可能导致模型加载失败，建议设置纯英文统一存储目录」类警示

### Requirement: 首次引导的存储位置前置决策

首次引导的「下载模型」步骤 SHALL 在无任何已安装模型时内联展示当前存储基座（`storageRoot` 或 userData 默认）及「更改」操作；更改走与设置页相同的目录选择与中文路径硬校验，保存后立即对后续下载生效。默认基座含 CJK 字符且未设置统一目录时，该步骤 MUST 就地展示警示建议先更换纯英文目录再下载。已有已安装模型时 MUST 不展示该行（避免用户误改导致已装模型不再被识别）。

#### Scenario: 新装用户在下载前改目录

- **WHEN** 新装用户（无已安装模型）在首次引导第 2 步点击「更改」并选择 `D:\SmartSub`
- **THEN** `storageRoot` 被保存，展示的存储基座更新为 `D:\SmartSub`，该步骤随后发起的模型下载落到 `D:\SmartSub` 下对应子目录

#### Scenario: 中文用户名新用户在下载前被警示

- **WHEN** Windows 中文用户名用户（userData 含中文）首次进入引导第 2 步且未设置统一目录
- **THEN** 步骤内展示「先更换纯英文目录再下载」的警示，设置有效统一目录后警示消失

#### Scenario: 已有模型的用户不展示该行

- **WHEN** 用户已安装至少一个模型后重新打开引导
- **THEN** 第 2 步不展示存储位置行

### Requirement: 存量 modelsPath 归一化

`modelsPath` MUST 从 store defaults 中移除；应用启动时若持久化的 `settings.modelsPath` 等于出厂默认路径（`userData/whisper-models`），系统 SHALL 删除该键，使 whisper.cpp 参与统一目录跟随。非默认值 MUST 原样保留（视为用户单独设置）。

#### Scenario: 存量用户设置统一目录后 whisper.cpp 跟随

- **WHEN** 存量用户（config.json 中 `modelsPath` 为被动持久化的默认路径）升级后设置统一存储目录
- **THEN** 启动归一化已删除该键，whisper.cpp 模型路径跟随统一目录

#### Scenario: 真实自定义不受归一化影响

- **WHEN** 存量用户曾把 whisper.cpp 模型目录改为 `E:\ggml`
- **THEN** 升级后该值保留，来源仍为「单独设置」

### Requirement: 路径来源可视化与恢复跟随

`getSystemInfo` SHALL 返回 `storageRoot` 原始值及各引擎路径来源（`default` / `storageRoot` / `override`）。引擎页模型路径行 SHALL 以标识展示来源；来源为「单独设置」且统一目录已设置时 SHALL 提供「恢复跟随统一目录」操作，执行后该引擎单独设置被清除、路径按统一目录解析。

#### Scenario: 来源标识正确展示

- **WHEN** 统一目录已设置，FunASR 有单独设置而 Qwen 没有
- **THEN** FunASR 路径行标识「单独设置」并展示恢复操作，Qwen 路径行标识「统一目录」

#### Scenario: 恢复跟随生效

- **WHEN** 用户对 FunASR 点击「恢复跟随统一目录」
- **THEN** `funasrModelsPath` 被清除，路径行更新为统一目录下的解析路径，标识变为「统一目录」

### Requirement: CT2 有效路径变化驱动 Python 运行时重启

Python 运行时重启判定 SHALL 基于 faster-whisper **有效根目录**（完整解析链结果）在设置写入前后的变化，而非 `fasterWhisperModelsPath` 键的字面变化。设置/清除统一目录导致 CT2 有效路径变化、清空单独设置恢复跟随，均 MUST 触发重启；CT2 存在单独设置时仅变更统一目录 MUST 不触发。

#### Scenario: 设置统一目录触发重启

- **WHEN** CT2 无单独设置，用户设置统一存储目录
- **THEN** Python 运行时被重启，后续以新路径注入 HF 缓存环境变量

#### Scenario: 清空单独设置触发重启

- **WHEN** 用户清除 `fasterWhisperModelsPath`（恢复跟随）且有效路径因此变化
- **THEN** Python 运行时被重启

#### Scenario: 有效路径未变不重启

- **WHEN** CT2 已有单独设置 `E:\ct2`，用户变更统一存储目录
- **THEN** Python 运行时不重启

### Requirement: 不迁移语义与手动迁移引导

设置、变更或清除统一存储目录 MUST 不移动任何已有模型与临时文件；旧目录内容原样保留，新目录按需创建。变更成功且新旧基座不同时，系统 SHALL 展示「新旧位置对照」对话框：包含旧位置与新位置路径、「打开旧目录」与「打开新目录」操作、子目录同名可整体复制的迁移说明、以及单独设置引擎不受影响的注记；「打开旧目录」在旧目录已不存在时 MUST 报错且不创建目录。

#### Scenario: 换根目录不动旧文件并展示对照引导

- **WHEN** 用户把统一存储目录从未设置改为 `D:\SmartSub`，userData 下已有已下载模型
- **THEN** userData 下文件原样保留，引擎页按新路径重扫模型清单（新路径下未搬移的模型显示为未安装），并弹出新旧位置对照对话框（旧位置为 userData，新位置为 `D:\SmartSub`），两个打开目录按钮分别定位到对应位置
