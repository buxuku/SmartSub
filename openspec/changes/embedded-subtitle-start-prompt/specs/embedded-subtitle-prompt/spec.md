## ADDED Requirements

### Requirement: 开始任务前探测内封字幕

「生成字幕」「生成并翻译」这类需要语音转写的任务，用户点击「开始」时（任务页、新建任务向导，以及 `?autostart=1` 自动开始），若「优先使用内封字幕」处于开启（含从未设置）且「开始前提示」未被关闭，系统 SHALL 在提交之前探测本次要处理的视频里是否有可直接提取的文本字幕轨。探测对象 SHALL 仅限同时满足以下条件的文件：不是字幕文件、没有配对字幕、容器格式可能内封字幕（`mkv`、`webm`、`mp4`、`m4v`、`mov`、`ts`、`m2ts`、`mts`、`ogm`、`ogv`）。只要任意一个文件含文本字幕轨，系统 SHALL 立即弹出确认对话框，不等其余文件探测完。仅含位图字幕轨（如 PGS、DVD 字幕）的文件 MUST NOT 算命中，因为它们无法被直接提取。

#### Scenario: 列表里靠后的视频有内封字幕

- **WHEN** 用户开始一个有 20 个视频的任务，前 2 个没有字幕轨，第 3 个有一条 SubRip 字幕轨
- **THEN** 探测到第 3 个就立即弹出对话框，不等其余 17 个

#### Scenario: 列表里没有内封字幕

- **WHEN** 用户开始任务，所有视频都没有文本字幕轨
- **THEN** 不弹窗，任务照常开始

#### Scenario: 只有位图字幕轨

- **WHEN** 视频里只有 PGS 或 DVD 位图字幕轨
- **THEN** 不算命中，不弹窗

#### Scenario: 不探测的文件

- **WHEN** 列表里有字幕文件、已配对字幕的视频，以及 `avi`、`mp3` 等不可能内封字幕的文件
- **THEN** 这些文件不会被探测

#### Scenario: 不转写的任务

- **WHEN** 用户开始「翻译字幕」任务
- **THEN** 不探测，不弹窗

### Requirement: 探测不得让用户感到卡顿

探测 SHALL 与开始前的就绪校验并行；同时探测的文件数 SHALL 不超过 4；探测到命中后 SHALL 立即中止其余探测；整体耗时 SHALL 有 1 秒的预算，超出即视为「无结果」。探测失败（进程无法启动、文件不可读、主进程没有及时响应）MUST NOT 阻塞或终止任务，也 MUST NOT 弹窗，任务 SHALL 按原有行为继续（开关开启时仍直接使用内封字幕）。就绪校验未通过时 SHALL 只报告校验错误，MUST NOT 为一个无法开始的任务弹窗。探测期间「开始」按钮 SHALL 与校验阶段一样处于「开始中」状态，防止重复点击。探测子进程在 Windows 上 MUST NOT 弹出控制台窗口。

#### Scenario: 慢速存储超出预算

- **WHEN** 视频在慢速网络盘上，1 秒内没有探测出任何命中
- **THEN** 放弃探测，不弹窗，任务照常开始

#### Scenario: 命中后中止其余探测

- **WHEN** 4 个文件同时在探测，其中一个命中
- **THEN** 其余探测进程被终止，对话框立即弹出

#### Scenario: 校验不通过

- **WHEN** 用户没有安装可用的语音模型，点击「开始」
- **THEN** 只报告校验错误，即使列表里的视频有内封字幕也不弹窗

#### Scenario: 探测出错

- **WHEN** 探测的 IPC 抛错或探测进程无法启动
- **THEN** 不弹窗，不报错，任务照常开始

### Requirement: 确认对话框

对话框 SHALL 展示命中的文件名及其文本字幕轨（语言 · 编码），说明「使用内封字幕」与「改用语音识别」各自的结果，并提示用户之后可在「高级设置」的「转写」里调整。对话框 SHALL 提供三个出口：「使用内封字幕」「改用语音识别」「取消」。「取消」、Esc 与点击遮罩 SHALL 终止这次开始：不提交任务、不写任何设置，表单保持不变。

选择只对本次提交生效，并按整个任务生效：「使用内封字幕」SHALL 把本次提交的 `useEmbeddedSubtitles` 置为 `true`（没有字幕轨的文件仍走语音识别），「改用语音识别」SHALL 置为 `false`。仅凭这次选择 MUST NOT 修改任务页的表单或默认配置。

#### Scenario: 使用内封字幕

- **WHEN** 对话框弹出，用户点「使用内封字幕」且没有勾选「记住」
- **THEN** 本次提交的 `useEmbeddedSubtitles` 为 `true`，任务被提交，表单与默认配置不变

#### Scenario: 改用语音识别

- **WHEN** 用户点「改用语音识别」且没有勾选「记住」
- **THEN** 本次提交的 `useEmbeddedSubtitles` 为 `false`，所有文件都走语音识别；表单与默认配置不变，下一个新任务仍会询问

#### Scenario: 取消

- **WHEN** 用户点「取消」、按 Esc 或点击遮罩
- **THEN** 任务没有提交，没有任何设置被写入，「开始」按钮恢复可用

#### Scenario: 对话框说明命中的轨道

- **WHEN** 命中的文件内封了英文 SubRip 与中文 ASS 两条文本字幕轨
- **THEN** 对话框显示文件名与这两条轨道，并说明有多条时取第一条

### Requirement: 记住我的选择

对话框 SHALL 提供复选框「记住我的选择，不再提示」，默认不勾选。勾选后点击「使用内封字幕」或「改用语音识别」，系统 SHALL 同时：把设置 `embeddedSubtitlePrompt` 置为 `false`（之后不再弹出对话框），并把所选值写为默认配置里 `useEmbeddedSubtitles` 的值（只写这一个键），使之成为下一个新任务的初值。未勾选时 MUST NOT 写入任何设置或默认配置。点击「取消」时无论是否勾选，都 MUST NOT 记住。写入失败 SHALL NOT 影响本次提交：本次选择仍然生效。

这是用户显式勾选的指令，是 `task-defaults-memory`「记忆只来自可编辑的任务页」（向导与开始任务不写默认配置）的唯一例外，范围限于 `useEmbeddedSubtitles` 这一个键；开始任务本身仍然不写默认配置。

#### Scenario: 记住「使用内封字幕」

- **WHEN** 用户勾选「记住我的选择，不再提示」后点「使用内封字幕」
- **THEN** `embeddedSubtitlePrompt` 为 `false`，默认配置里的 `useEmbeddedSubtitles` 为 `true`；之后开始任务不再弹窗，内封字幕被直接使用

#### Scenario: 记住「改用语音识别」

- **WHEN** 用户勾选「记住」后点「改用语音识别」
- **THEN** `embeddedSubtitlePrompt` 为 `false`，默认配置里的 `useEmbeddedSubtitles` 为 `false`；新任务的「优先使用内封字幕」开关为关，之后开始任务不探测、不弹窗，直接语音识别

#### Scenario: 勾选后取消

- **WHEN** 用户勾选「记住」后点「取消」
- **THEN** 没有任何设置被写入，下次开始仍会询问

#### Scenario: 在新建任务向导里记住

- **WHEN** 用户在新建任务向导里勾选「记住」并选择
- **THEN** 只有 `embeddedSubtitlePrompt` 与默认配置里的 `useEmbeddedSubtitles` 这两项被写入，向导里的其它参数不写入默认配置

#### Scenario: 记住时写入失败

- **WHEN** 存储不可写，用户勾选「记住」后点「使用内封字幕」
- **THEN** 任务照常提交且按所选值运行，写入失败不弹错误

### Requirement: 不弹窗的情形

下列情形 SHALL NOT 探测，也 SHALL NOT 弹窗，任务按其配置运行：`useEmbeddedSubtitles` 显式为 `false`（用户已经选择语音识别）；设置 `embeddedSubtitlePrompt` 为 `false`；重试（沿用任务快照里的配置）；自动化 / CLI / MCP 提交与在线下载的自动衔接（它们不经过界面）。

#### Scenario: 已选择强制语音识别

- **WHEN** 表单里的「优先使用内封字幕」为关，用户点击「开始」
- **THEN** 不探测，不弹窗，所有文件走语音识别

#### Scenario: 已关闭提示

- **WHEN** 设置里的 `embeddedSubtitlePrompt` 为 `false`，列表里的视频有内封字幕
- **THEN** 不探测，不弹窗；开关开启则直接使用内封字幕

#### Scenario: 重试

- **WHEN** 用户重试某个失败的文件
- **THEN** 不探测、不弹窗，沿用该任务快照里的 `useEmbeddedSubtitles`

#### Scenario: 自动化提交

- **WHEN** 任务经 CLI / MCP 或在线下载的自动衔接提交
- **THEN** 不弹窗，按提交里的 `useEmbeddedSubtitles`（缺省为使用）运行

### Requirement: 高级设置里的开关与提示选项

「优先使用内封字幕」开关 SHALL 位于「高级设置」的「转写」分区顶部（需要转写的媒体任务；任务页与新建任务向导里的高级设置相同），其下 SHALL 有「开始前提示我选择」选项：它反映并即时修改设置 `embeddedSubtitlePrompt`（缺省为开），开关关闭时该选项 SHALL 置灰。开关本身仍是任务级的 `useEmbeddedSubtitles`，语义不变——只有显式 `false` 才强制语音识别。工具栏「字幕格式」气泡里 MUST NOT 再有该开关。开关的说明文案 SHALL 描述真实行为：直接提取视频自带的文本字幕轨、跳过语音识别。

#### Scenario: 在高级设置里关闭

- **WHEN** 用户打开「高级设置」，把「优先使用内封字幕」关掉
- **THEN** 表单里的 `useEmbeddedSubtitles` 为 `false`（任务页上随其它参数一并被记为默认值），「开始前提示我选择」置灰

#### Scenario: 重新打开提示

- **WHEN** 用户曾勾选「记住」，随后在「高级设置」里把「开始前提示我选择」勾上
- **THEN** `embeddedSubtitlePrompt` 立即变为 `true`，下一次开始带内封字幕的任务会再次询问

#### Scenario: 字幕格式气泡不再含该开关

- **WHEN** 用户打开工具栏的「字幕格式」气泡
- **THEN** 气泡里只有输出格式与双语排版，没有内封字幕开关

#### Scenario: 翻译字幕类任务

- **WHEN** 用户打开「翻译字幕」任务的高级设置
- **THEN** 没有「优先使用内封字幕」开关（该类任务不转写）
