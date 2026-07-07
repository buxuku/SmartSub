# Spec Delta: dubbing-pipeline

## ADDED Requirements

### Requirement: 管线编排

配音管线 SHALL 按序编排:解析字幕(复用现有 cue 解析)→ 逐条 TTS 合成(并发闸:本地串行,云端按服务商 `concurrency`)→ 时间轴对齐 → 按槽位拼接完整配音轨 → 背景音处理 → 输出形态产出;全程发布行级进度事件(行序号、行状态、整体百分比),MUST 支持 AbortSignal 取消且取消时清理半成品文件。

#### Scenario: 全流程跑通

- **WHEN** 提交一份字幕 + 一个视频与有效配音配置
- **THEN** 管线依次完成合成/对齐/拼接/输出,期间行级进度事件持续推送,产物落盘

#### Scenario: 中途取消

- **WHEN** 用户在逐条合成阶段取消
- **THEN** 在途合成中止、后续行不再执行、临时 wav 与半成品输出被清理,任务以取消语义结束

#### Scenario: 单行失败不中断整体

- **WHEN** 某一行合成失败(如云端瞬时错误)
- **THEN** 该行标记为失败可重试,管线继续处理其余行,结束时汇总失败清单

### Requirement: 单行重合成

管线 SHALL 支持对单条 cue 重新合成(可携带新文本、新 voice 或新 speed),重合成结果 MUST 增量更新对齐规划与拼接产物所需的输入,不要求全量重跑其余行。

#### Scenario: 过长行改文案重合成

- **WHEN** 用户修改某过长行文案并触发单行重生成
- **THEN** 仅该行重新合成与复测,其状态与时长信息更新,其余行不受影响

### Requirement: ffmpeg 音频管线封装

系统 SHALL 新增 ffmpeg 音频封装:atempo 变速(倍率超出单级 [0.5, 2.0] 时自动链式串联)、按槽位补静音、分段 concat 拼接、amix 混流(含 ducking 压低原轨)、视频音轨替换与新增(mkv 多音轨);全部封装 MUST 走既有取消模式(AbortSignal + 取消注册表 + 半成品清理)。

#### Scenario: 链式 atempo

- **WHEN** 需要 3.0x 变速
- **THEN** 生成 `atempo=2.0,atempo=1.5` 链式 filter,输出时长为原 1/3

#### Scenario: ducking 混音

- **WHEN** 用户选择「压低原轨」背景音模式
- **THEN** 输出中原音轨在配音时段被压低,配音清晰可闻,非配音时段原轨保持

### Requirement: wav 时长测量

系统 SHALL 通过读取 WAV 文件头测量合成产物时长,MUST NOT 依赖 ffprobe(应用未捆绑)。

#### Scenario: 时长测量

- **WHEN** 对齐引擎需要某条合成 wav 的实测时长
- **THEN** 通过 WAV 头(字节数/采样率/位深/声道)计算得出,误差在毫秒级

### Requirement: 输出形态

管线 SHALL 支持四种输出:仅音频(wav/mp3)、替换音轨的视频、ducking 混音视频、新增音轨(mkv 多音轨,保留原轨);无视频输入时仅允许「仅音频」。SHALL 支持可选导出对齐后的顺延版字幕文件。

#### Scenario: 纯字幕转音频

- **WHEN** 用户只提供字幕文件并选择输出 wav
- **THEN** 产出完整配音音频,视频类输出选项不可选

#### Scenario: mkv 新增音轨

- **WHEN** 用户选择「新增音轨」输出
- **THEN** 产出 mkv 同时含原音轨与配音轨两条可切换音轨

### Requirement: 配音任务持久化

配音任务 SHALL 以新 workItem 类型 `dubbing` 进入「最近任务」体系,阶段状态字段模式与既有任务一致(`''/loading/done/error` + progress/error),`STAGE_KEYS` 同步扩展;工作台表单配置 SHALL 经 userConfig 记忆。

#### Scenario: 任务出现在最近任务

- **WHEN** 一次配音任务开始执行
- **THEN** 「最近任务」出现类型为 dubbing 的条目,状态随进度流转,应用重启后仍可见
