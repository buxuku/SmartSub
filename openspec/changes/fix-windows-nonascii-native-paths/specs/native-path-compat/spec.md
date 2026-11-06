## ADDED Requirements

### Requirement: 随包模型暂存到 ASCII 路径

在 Windows 上，系统 SHALL 在把随包的 VAD（Silero）与降噪（gtcrn）模型交给 sherpa-onnx 之前，检查其路径是否含非 ASCII 字符；含则复制到纯 ASCII 的暂存目录并改用副本路径。暂存目录候选按 `<userData>/native-models`、`%ProgramData%\SmartSub\native-models`、`%PUBLIC%\SmartSub\native-models`、`%SystemDrive%\SmartSub\native-models` 的顺序尝试，自身含非 ASCII 的候选 MUST 被剔除。副本路径 MUST 为 `<候选目录>/<内容 sha1 前 16 位>/<ASCII 文件名>`；已存在的副本 MUST 先逐字节校验，一致才复用，同一进程内重复请求 MUST 不重复复制。暂存失败（源文件读不了、超过 64 MiB、所有候选目录都写不了）时 MUST 回退为原路径并记录 warning，不得抛错中断请求。非 Windows 平台或路径全为 ASCII 时 MUST 原样返回路径，且不创建任何文件。

#### Scenario: 中文安装目录下 VAD 可用

- **WHEN** Windows 用户的安装目录含中文，应用启动语音检测，随包 `silero_vad.onnx` 的路径含非 ASCII 字符
- **THEN** 原生库打开的是 `…\native-models\<hash>\silero_vad.onnx` 这一 ASCII 副本，副本与源文件逐字节相同，语音检测得到与 ASCII 路径下相同的语音段，且 worker 的 stderr 没有 `vad is nullptr`

#### Scenario: 副本已存在且完好时直接复用

- **WHEN** 同一模型在稍后一次启动中再次需要暂存，且目标目录里的副本与源文件逐字节一致
- **THEN** 不重写副本，直接返回其路径

#### Scenario: 副本损坏时重建

- **WHEN** 目标目录里的同名文件被截断或被改写
- **THEN** 逐字节校验不通过，系统重新写入正确的副本后再使用

#### Scenario: 候选目录不可写时换下一个

- **WHEN** 第一个候选目录无法写入（只读、权限不足）
- **THEN** 系统依次尝试后续候选目录；全部失败时回退为原路径并记录列出每个候选失败原因的 warning

#### Scenario: ASCII 路径与非 Windows 平台不受影响

- **WHEN** 模型路径全为 ASCII，或平台不是 Windows
- **THEN** 路径原样返回，不复制文件，不创建暂存目录

### Requirement: sherpa worker 的 wav 读写不依赖原生窄字符路径

sherpa、TTS、说话人分离三个 worker 在 Windows 上遇到含非 ASCII 字符的 wav 路径时，SHALL 由 JS 读写 wav，而不是调用 sherpa-onnx 原生的 `readWave` / `writeWave`。JS 实现 MUST 与原生口径一致：读取第一声道，支持 8 位无符号、16 位、32 位整数与 32 位浮点，归一化到 [-1, 1)；写入单声道 16 位 PCM，量化方式与原生相同，写出的文件 MUST 与原生写出的逐字节相同。读取 MAY 额外接受子格式为 PCM 或浮点的 `WAVE_FORMAT_EXTENSIBLE`。写 wav 失败 MUST 以异常结束请求，不得再把返回 `false` 当作成功。路径全为 ASCII 或非 Windows 平台时 MUST 仍走原生实现，行为与产物不变。

#### Scenario: 中文目录下读写 wav

- **WHEN** 降噪或语音检测请求的输入、输出 wav 位于含中文的目录（例如 `…\中文用户-测试\`）
- **THEN** 请求完成，写出的文件与原生写入器对同一数据写出的逐字节相同，读取结果与原生读取器读 ASCII 副本时的样本一致

#### Scenario: 写入失败是异常

- **WHEN** 输出 wav 无法创建（目录不存在或不可写）
- **THEN** 请求以带路径的错误结束，不会返回「成功」后留下缺失的产物

#### Scenario: ASCII 路径行为不变

- **WHEN** wav 路径全为 ASCII
- **THEN** 仍由原生 `readWave` / `writeWave` 处理

### Requirement: 内置 whisper 对非 ASCII 音频路径使用 PCM 缓冲输入

在 Windows 上，调用内置 whisper.cpp addon 时若音频文件路径含非 ASCII 字符，系统 SHALL 在 JS 中解码该 16 kHz、16 位 PCM wav，以 `pcmf32`（`Float32Array`）作为输入，并把 `fname_inp` 置为空串，其余参数 MUST 原样保留。该适配 MUST 位于 addon 加载层，使内置转写（单次与分块）与声音克隆的参考音频转写都被覆盖。采样率不是 16 kHz、不是 16 位 PCM、读不到文件或没有样本时，MUST 原样透传原路径并记录 warning，不得抛错中断。采用 PCM 输入的路径 MUST 使用收紧的分块计划（总时长超过 1 小时才分片，每片不超过 30 分钟）以限制内存；ASCII 路径 MUST 沿用默认分块计划。用户音频 MUST 不被复制到任何共享目录。

#### Scenario: 中文临时目录下转写结果与 ASCII 一致

- **WHEN** 抽出的 16 kHz wav 位于含中文的目录，用内置 whisper 转写
- **THEN** addon 收到 PCM 缓冲而不是路径，不报告 `failed to read audio file`，得到的分段数与文本和同一音频在 ASCII 路径下的结果一致

#### Scenario: 无法解码时透传

- **WHEN** 含非 ASCII 的音频路径指向的文件不是 16 kHz 16 位 PCM wav
- **THEN** 参数原样透传给 addon，并记录说明原因的 warning

#### Scenario: 超过 1 小时的音频分片

- **WHEN** 含非 ASCII 路径、时长 2.5 小时的音频用内置 whisper 转写
- **THEN** 按每片不超过 30 分钟分片后逐片以 PCM 缓冲输入；同样时长的 ASCII 路径音频仍按默认计划处理

#### Scenario: ASCII 路径与非 Windows 平台不受影响

- **WHEN** 音频路径全为 ASCII，或平台不是 Windows
- **THEN** 参数原样交给 addon，行为与此前一致

### Requirement: 原生库的静默失败必须对用户可见

系统 SHALL 把 sherpa 原生库的静默失败转成带原因的错误，并让日志可以查到。VAD 构造失败只在 stderr 输出 `vad is nullptr` 并返回零个语音段时：转写或语音检测请求以零个分段结束、且请求期间 worker 的 stderr 出现过 `vad is nullptr`，系统 MUST 在短暂等待 stderr 排空后以错误结束该请求，错误信息 MUST 带有原生给出的原因，并 MUST 释放持有空 VAD 的 worker，使下一次请求在新 worker 上重建；仅当该 worker 仍是当前 worker 时才释放。零个分段但 stderr 没有 `vad is nullptr`（例如真正的静音）MUST 仍按成功返回。识别器、降噪、TTS、说话人分离因打不开文件而抛出 `Please check your config!` 等错误，且 Windows 上请求涉及含非 ASCII 的路径时，错误信息 MUST 追加建议：在设置的统一存储目录中选择纯英文路径并重新下载或导入模型，应用安装在含中文的目录时重装；取消、忙碌等其他错误 MUST 原样返回。声音克隆分析在 Silero VAD 失败而回退到能量法时 MUST 记录 warning 日志。

#### Scenario: 空 VAD 的零结果变成错误

- **WHEN** VAD 模型路径原生库打不开，语音检测请求以 0 个语音段结束，期间 stderr 出现 `vad is nullptr`
- **THEN** 请求以错误结束，错误里包含 `Silero vad model file '…' does not exist` 这类原生原因；持有空 VAD 的 worker 被释放

#### Scenario: 下一次请求重建 worker

- **WHEN** 空 VAD 的请求已报错，用户修正路径后再次发起请求
- **THEN** 请求在新建的 worker 上执行，不再受已缓存的空 VAD 影响

#### Scenario: 真正的静音不算失败

- **WHEN** 一段静音文件经检测得到 0 个语音段，stderr 没有 `vad is nullptr`
- **THEN** 请求成功返回，分段为空

#### Scenario: 不误伤已重建的 worker

- **WHEN** 旧 worker 的空 VAD 请求在新 worker 已经建好之后才报错
- **THEN** 新 worker 保持运行，不被释放

#### Scenario: 非 ASCII 路径给出可操作的建议

- **WHEN** Windows 上降噪构造抛出 `Please check your config!`，且请求里的模型路径含中文
- **THEN** 错误信息保留原始内容，并追加（按界面语言）改用纯英文统一存储目录的建议；同一错误发生在 ASCII 路径或非 Windows 平台时不追加

#### Scenario: 声音克隆回退能量法有日志

- **WHEN** 声音克隆分析中 Silero VAD 请求失败
- **THEN** 分析回退到能量法继续，日志里有一条说明失败原因的 warning

### Requirement: 诊断包标明运行时路径是否含非 ASCII 或空格

诊断包的应用信息 SHALL 包含 `userDataPath`、`installPath`、`tempPath` 三项，每项只含 `nonAscii` 与 `hasSpace` 两个布尔标志。诊断包 MUST NOT 导出这三个路径的文本，也不得因为路径缺失（`undefined` 或非字符串）而失败，缺失时两个标志 MUST 为 `false`。

#### Scenario: 中文用户名的诊断包

- **WHEN** Windows 用户名含中文，用户导出诊断包
- **THEN** 应用信息里 `userDataPath.nonAscii`、`tempPath.nonAscii` 为 `true`，不出现用户名或任何路径文本

#### Scenario: 路径缺失不影响导出

- **WHEN** 某个运行时路径取不到
- **THEN** 对应项的两个标志为 `false`，诊断包仍正常导出
