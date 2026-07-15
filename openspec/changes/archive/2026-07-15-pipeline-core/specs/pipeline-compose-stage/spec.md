# pipeline-compose-stage Spec Delta

## ADDED Requirements

### Requirement: 任务级合成附加阶段

任务 SHALL 支持可选合成附加阶段（`formData.compose`：`subtitle: 'hard'|'soft'|'none'`，默认 hard；样式与画质/编码方式沿用全局默认样式与合成偏好）：逐文件把配音轨与字幕合成为成品视频，阶段状态以既有字段名约定挂在文件上（`composeVideo`: `''|loading|done|error` + progress/error），产物路径记录于 `finalVideoPath`。仅媒体输入的任务可启用合成阶段。

#### Scenario: 成片阶段状态可见

- **WHEN** 某文件进入合成阶段
- **THEN** 任务列表该文件显示合成进行中与实时百分比，完成后可从行操作/完成横幅打开成品

### Requirement: 矩阵自动推导

合成阶段 SHALL 按上游产物自动推导合成矩阵：存在配音轨 → `audio=replace(配音轨)`；无配音 → `audio=keep`。烧录字幕 SHALL 优先取顺延版字幕（配音发生时移时），否则取交付字幕（译文优先，其次源字幕）；`subtitle='none'` 时仅处理音轨（要求存在配音轨，否则该阶段无事可做判定为配置错误）。

#### Scenario: 配音成片默认矩阵

- **WHEN** 「配音 + 成片」任务的某文件配音发生了时间轴顺延
- **THEN** 合成以「替换音轨 + 硬烧顺延版字幕」单遍完成，音画字同步

#### Scenario: 纯字幕成片

- **WHEN** 任务只勾选成品视频（无配音）且输出方式为硬烧
- **THEN** 合成以「原声 + 烧录交付字幕」执行，行为与合成工作台纯烧录一致

### Requirement: 经统一合成队列执行

合成阶段 SHALL 组装 ComposeConfig 入全局合成队列（作业来源 `pipeline`），与工作台/配音导出作业统一排队（全局单编码槽）；进度经作业事件转发为该文件阶段进度；任务取消 MUST 取消对应作业（排队即出队、运行中中止并清理半成品）。

#### Scenario: 与工作台作业统一排队

- **WHEN** 流水线合成作业执行中用户又在合成工作台提交了一个作业
- **THEN** 两者按提交顺序串行执行，各自面板/任务行显示自己的排队与进度状态

#### Scenario: 取消任务联动取消作业

- **WHEN** 用户取消任务时某文件的合成作业排队中
- **THEN** 该作业直接出队，文件阶段状态按取消语义回退

### Requirement: 成品命名与容器

成品输出 SHALL 命名为 `<原文件名>-final.<ext>`（已存在时防覆盖递增），容器沿用源视频扩展名；软封字幕或双轨参与时 MUST 输出 mkv。

#### Scenario: 防覆盖递增

- **WHEN** 同一文件第二次跑合成阶段且上次成品仍在
- **THEN** 新成品命名为 `<原名>-final-2.<ext>`，不覆盖旧成品
