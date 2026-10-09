## ADDED Requirements

### Requirement: 新校对数据写入托管目录

系统 SHALL 把新生成的校对 sidecar 写入应用数据目录下的托管目录 `userData/proofread-data/`，文件名为 `<源文件名>.<任务文件 id>.json`，并 MUST NOT 在用户视频所在目录创建 `.smartsub-proofread/`。托管目录 SHALL 固定在 `userData` 下，MUST NOT 跟随 `settings.storageRoot`。托管根目录由宿主在启动时注入；宿主未注入时（脚本与单测环境）SHALL 回落到视频目录下的 `.smartsub-proofread/`。

#### Scenario: 任务完成后 sidecar 落在托管目录

- **WHEN** 用户在视频 `D:\videos\movie.mp4` 上运行一个会写出校对数据的任务
- **THEN** sidecar 写入 `userData/proofread-data/movie.<id>.json`，`D:\videos` 下不出现 `.smartsub-proofread/`，且文件对象的 `proofreadDataFile` 记录该绝对路径

#### Scenario: 更改统一存储目录不影响托管目录

- **WHEN** 用户设置或更改 `storageRoot`
- **THEN** 新 sidecar 仍写入 `userData/proofread-data/`

#### Scenario: 未注入根目录时回落旧路径

- **WHEN** 在宿主未注入根目录的环境（脚本、单测）中解析 sidecar 路径
- **THEN** 路径为 `<视频目录>/.smartsub-proofread/<name>.<id>.json`，与本功能引入前一致

### Requirement: 存量 sidecar 原地保留且继续可用

系统 MUST NOT 自动迁移已存在的 sidecar。任务、校对批次、配音会话与自动化任务中已记录的 `proofreadDataFile` 绝对路径 SHALL 继续按原路径读取与保存，不论其位于旧邻居目录还是托管目录。

#### Scenario: 旧任务继续校对

- **WHEN** 升级前创建的任务，其 `proofreadDataFile` 指向视频目录旁的 `.smartsub-proofread/`
- **THEN** 打开校对页仍读取该文件，保存时仍写回原文件，托管目录不产生副本

#### Scenario: 重跑存量任务

- **WHEN** 用户重跑一个升级前创建的任务
- **THEN** 新 sidecar 写入托管目录，旧文件保留在原处且不被自动删除

### Requirement: 配音自动发现 sidecar 的顺序

配音页为导入的字幕自动发现 sidecar 时，系统 SHALL 按「显式给定的路径 > 托管目录 > 字幕所在目录的 `.smartsub-proofread/`」的顺序查找。匹配依据为 sidecar `meta` 中记录的 `sourceFile`、`targetFile`、`finalTargetFile` 之一与字幕路径相同；同一查找位置有多个命中时 SHALL 选择最近修改的一个。

#### Scenario: 显式路径优先

- **WHEN** 调用方传入一个存在且可解析的 sidecar 路径
- **THEN** 直接使用该文件，不再扫描

#### Scenario: 托管目录优先于旧目录

- **WHEN** 托管目录与字幕旁的旧目录各有一份匹配的 sidecar
- **THEN** 使用托管目录里的那份

#### Scenario: 回落旧邻居目录

- **WHEN** 托管目录没有匹配项，而字幕旁的旧目录有匹配的 sidecar
- **THEN** 使用旧目录里的那份

#### Scenario: 多个命中取最近修改

- **WHEN** 托管目录里有两份 `meta` 路径相同的 sidecar
- **THEN** 返回修改时间更新的那份

### Requirement: 删除工作项时回收托管 sidecar

删除工作项（含「清空全部」）并且工作项列表已成功持久化之后，系统 SHALL 删除被这些工作项引用、位于托管目录内、且不再被任何剩余工作项引用的 sidecar。引用范围 SHALL 包括剩余工作项的 `pipelineFiles[]`、`proofreadEntries[]`、`taskDraft.manuscripts[]` 的 `proofreadDataFile`，以及配音工作项 `configSnapshot.proofreadDataFile`。删除失败 MUST NOT 使工作项删除失败。

#### Scenario: 独占的 sidecar 随任务删除

- **WHEN** 用户删除一个任务，其 sidecar 位于托管目录且没有其他工作项引用
- **THEN** 工作项被删除后该 sidecar 文件被移除

#### Scenario: 仍被引用的 sidecar 保留

- **WHEN** 被删除任务的 sidecar 同时被另一个工作项（含配音工作项的 `configSnapshot`）引用
- **THEN** 该 sidecar 保留

#### Scenario: 清空全部

- **WHEN** 用户清空全部工作项
- **THEN** 所有被引用的托管 sidecar 被移除

#### Scenario: 持久化失败不删除

- **WHEN** 工作项列表写盘失败导致删除回滚
- **THEN** 没有任何 sidecar 被删除

#### Scenario: 删除失败不影响删除工作项

- **WHEN** 某个 sidecar 因权限或占用无法删除
- **THEN** 工作项仍被删除，错误只记入日志

### Requirement: 删除范围限定在托管目录内

系统 MUST 只删除同时满足下列条件的路径：直接位于托管根目录之下（不含根目录本身，也不含其子文件夹里的文件）、扩展名为 `.json`、`lstat` 为普通文件而非符号链接或文件夹。旧邻居目录里的 sidecar、托管根外的路径、含 `..` 穿越的路径 MUST NOT 被删除。路径比较 SHALL 在 Windows 上不区分大小写。

#### Scenario: 旧目录里的文件不被删除

- **WHEN** 被删除任务的 `proofreadDataFile` 指向视频目录旁的 `.smartsub-proofread/`
- **THEN** 该文件保留

#### Scenario: 非法路径被拒绝

- **WHEN** 被删除任务记录的 `proofreadDataFile` 是托管根外路径、`..` 穿越路径、托管根子文件夹里的文件、符号链接、文件夹或非 `.json` 文件
- **THEN** 不删除任何文件，也不抛出错误

#### Scenario: Windows 路径大小写不敏感

- **WHEN** 在 Windows 上，记录的路径与托管根的大小写不同但指向同一目录内的文件
- **THEN** 该文件被视为位于托管根内
