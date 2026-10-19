## ADDED Requirements

### Requirement: 输出内容的出厂默认为仅译文

「输出内容」（`translateContent`）的出厂默认值 SHALL 为「仅译文」（`onlyTranslate`），与 3.8.0 一致。用户保存过的值（包括历史版本写入的值）一律视为用户偏好，系统 MUST NOT 迁移或覆盖。

#### Scenario: 从未保存过偏好

- **WHEN** 用户从未保存过任务偏好，打开「生成并翻译」任务页
- **THEN** 「输出内容」显示「仅译文」，提交后任务配置快照里的 `translateContent` 为 `onlyTranslate`

#### Scenario: 已保存的值不被迁移

- **WHEN** 存储里已有 `translateContent = sourceAndTranslate`（例如 3.9.x 写入的）
- **THEN** 该值原样保留并作为新任务的初值，直到用户自己改掉

### Requirement: 新建任务沿用已保存的输出内容

新建任务（任务页、启动台拖放、内置配方、新建任务向导）SHALL 以用户已保存的任务偏好作为初值，输出内容 MUST NOT 因任务类型或内置配方被改写。用户自己保存的配方里显式写入的配置仍按配方生效。

#### Scenario: 各任务类型沿用保存值

- **WHEN** 用户保存的输出内容为 `translateAndSource`，依次新建「生成并翻译」与「仅翻译」任务
- **THEN** 两个任务的表单初值都是 `translateAndSource`

#### Scenario: 内置配方不改写

- **WHEN** 用户保存的输出内容为 `onlyTranslate`，往「视频 → 双语字幕」内置配方拖入文件进入任务页
- **THEN** 输出内容仍为「仅译文」

#### Scenario: 用户配方的显式配置优先

- **WHEN** 用户自己保存的配方里写明了 `sourceAndTranslate`，应用该配方
- **THEN** 输出内容为 `sourceAndTranslate`

### Requirement: 提交时补全输出内容

任务提交的唯一入口（`persistTaskSubmission`，界面、自动化与下载流水线共用）SHALL 把翻译类任务配置快照里缺失或无法识别的「输出内容」补成默认值；已有的有效值 MUST 原样保留；不翻译的任务（仅生成字幕）MUST NOT 被写入该字段；调用方传入的对象 MUST NOT 被修改。已固定的旧快照在文件重试时 SHALL 按同一规则补全。自动化与下载流水线在生成任务配置时 SHALL 做同样的补全。

#### Scenario: 缺失的值被补全

- **WHEN** 提交一个没有 `translateContent` 的翻译类任务
- **THEN** 存下的快照与实际执行用的配置里 `translateContent` 都是 `onlyTranslate`

#### Scenario: 无法识别的值被替换

- **WHEN** 提交的 `translateContent` 是 `both` 这样的未知值
- **THEN** 快照与执行配置里是 `onlyTranslate`

#### Scenario: 有效值保留

- **WHEN** 提交的 `translateContent` 是 `translateAndSource`
- **THEN** 快照与执行配置里仍是 `translateAndSource`

#### Scenario: 仅生成字幕不写入该字段

- **WHEN** 提交一个仅生成字幕（不翻译）的任务
- **THEN** 快照与表单逐项相同，不出现 `translateContent`

#### Scenario: 旧快照重试时补全

- **WHEN** 重试一个创建时没有 `translateContent` 的已固定快照
- **THEN** 重试使用补全后的值，不是 `undefined`

#### Scenario: 自动化与下载流水线

- **WHEN** 自动化的翻译流水线没有传输出内容，或下载流水线读到的已保存配置里没有这个值
- **THEN** 提交的配置里是 `onlyTranslate`；只转写的自动化配置里不出现该字段

### Requirement: 翻译按输出内容交付且失败可见

翻译阶段 SHALL 按「输出内容」渲染交付字幕（仅译文、译文在上或原文在上），并始终另写一份纯译文的临时文件。输出内容缺失或无法识别时 SHALL 按默认（仅译文）交付，非空的无法识别值 SHALL 写一条警告日志；系统 MUST NOT 因此产生空的交付文件。译文后处理或渲染过程中的错误 SHALL 传给任务并使该文件失败，MUST NOT 被吞掉。

#### Scenario: 三种样式

- **WHEN** 分别以 `onlyTranslate`、`sourceAndTranslate`、`translateAndSource` 翻译同一份字幕
- **THEN** 交付字幕分别是仅译文、原文在上、译文在上；三次的纯译文临时文件都只含译文

#### Scenario: 缺失的值静默回落

- **WHEN** 翻译配置里没有输出内容
- **THEN** 按仅译文交付，不写警告日志

#### Scenario: 未知的值回落并告警

- **WHEN** 输出内容是 `both`（或大小写不对的 `sourceandtranslate`）
- **THEN** 按仅译文交付，并写一条指出该未知值的警告日志

#### Scenario: 渲染出错时任务失败

- **WHEN** 译文后处理在渲染交付字幕的过程中抛出错误
- **THEN** 翻译调用以该错误失败并通知用户，而不是以空的交付字幕「成功」

### Requirement: 目标字幕不得覆盖正在翻译的源字幕

翻译阶段写入前 SHALL 检查目标字幕路径：目标与正在翻译的源字幕为同一个文件（路径相同、符号链接、硬链接，或大小写不敏感文件系统上仅大小写不同）时，系统 SHALL 在清空和写入之前拒绝并给出明确错误，源字幕内容保持不变，且 MUST NOT 调用翻译服务。常规流程（目标按「文件名.语言」命名，如源字幕 `clip.srt`、目标 `clip.fr.srt`）MUST 不受影响。

#### Scenario: 目标与源字幕同名

- **WHEN** 对 `clip.srt` 仅翻译，并把目标命名选为「文件名」
- **THEN** 任务以明确的错误失败，`clip.srt` 内容不变，没有任何翻译请求发出

#### Scenario: 链接指向源字幕

- **WHEN** 目标路径是指向源字幕的符号链接或硬链接
- **THEN** 同样被拒绝，源字幕内容不变

#### Scenario: 大小写不敏感文件系统上的同名

- **WHEN** 目标与源字幕仅大小写不同，且文件系统不区分大小写
- **THEN** 被拒绝，源字幕内容不变

#### Scenario: 常规流程不受影响

- **WHEN** 源字幕是 `clip.srt`，目标按默认命名为 `clip.fr.srt`
- **THEN** 翻译正常进行，交付字幕写入 `clip.fr.srt`，源字幕不变

### Requirement: 界面对缺失的输出内容按默认显示

任务配置栏的「输出内容」摘要、下拉选中值与排版示例 SHALL 基于补全后的值：值缺失时显示「仅译文」，与主进程实际交付的结果一致。

#### Scenario: 未保存值时显示仅译文

- **WHEN** 任务表单里没有 `translateContent`
- **THEN** 摘要显示「仅译文」，排版示例只有译文行
