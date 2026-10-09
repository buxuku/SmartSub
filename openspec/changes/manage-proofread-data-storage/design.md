## Context

校对 sidecar 的现状：

- 写入点：`main/helpers/proofreadData.ts` 的 `getProofreadDataPath(file)` 返回 `<视频目录>/.smartsub-proofread/<name>.<uuid>.json`。`writeProofreadDataFromFiles` 在流水线末尾写入；`updateProofreadDataFromSubtitles` / `updateProofreadDataOutputs` 按已记录的路径更新。返回的绝对路径保存在 `IFiles.proofreadDataFile`，随后被写进工作项（`pipelineFiles[]`、`proofreadEntries[]`、配音工作项的 `configSnapshot`）、配音会话 `session.json`、自动化任务记录，并参与 `proofreadDraftKey` 的计算。
- 读取点：校对页、自动化 `proofread.read` / `proofread.save`、配音阶段都把 `proofreadDataFile` 当作不透明的绝对路径。真正依赖位置的只有两处：上面的写入点，以及 `main/helpers/dubbing/speakerMetadata.ts` 的 `findDubbingProofreadDataFile`（扫描字幕所在目录的邻居 `.smartsub-proofread/`，用 `meta.sourceFile` / `targetFile` / `finalTargetFile` 匹配字幕路径）。
- 生命周期：没有。工作项删除只经 `setWorkItemDeletionHandler`（目前仅暂存删除配音会话），全仓没有任何删除 sidecar 的代码。
- 先例：`setDubbingSessionsRoot` 由宿主注入根目录，使模块保持零 Electron 依赖、可在纯 node 下测试；配音会话、草稿、质量审阅都在 `userData`。

## Goals / Non-Goals

**Goals:**

- 新生成的 sidecar 不再写入用户目录
- 删除工作项时回收其独占的托管 sidecar
- 存量任务零中断：旧路径继续可读写，配音发现对新旧位置都有效
- 新模块零 Electron 依赖，现有脚本与单测的既有用例不用改

**Non-Goals:**

- 不迁移存量 sidecar（路径引用与草稿键耦合）
- 不做旧目录清理工具、设置页占用与手动清理、启动期孤儿清扫
- 不处理 `taskManager.saveTaskProject` 直接替换 `pipelineFiles` 时留下的孤儿
- 不清理以 sidecar 路径为键的草稿与质量审阅记录（既有行为）
- 不引入索引文件或新依赖

## Decisions

### D1: 位置固定为 `userData/proofread-data/`，不跟随 `storageRoot`

- 为什么不跟随 `storageRoot`：`unified-storage-root` 的语义是"大文件换盘且不迁移"，更改根目录不会移动旧文件。若 sidecar 跟随，每换一次根目录托管目录就多出一处，删除护栏与发现扫描都得同时认识多个根；而 sidecar 很小（样本均值约 10 KB），没有"占系统盘"的诉求。
- 为什么不放系统临时目录：它是权威数据（见 proposal），不能被系统或清理工具回收；`getTempDir()` 还可能被用户指到任意目录。
- 与 `proofread-drafts`、`quality-reviews`、`dubbing-sessions` 同属 `userData` 的持久应用状态。

### D2: 根目录由宿主注入，未注入时回落旧路径

- `setupProofreadHandlers()` 内用 `path.join(app.getPath('userData'), 'proofread-data')` 调用 `setProofreadDataRoot`；该函数在 `background.ts` 中早于所有任务入口执行。
- `getProofreadDataPath` 在根目录未注入时回落到旧的邻居路径，所以 `test-proofread-cue-timing.cjs`、`test-missed-speech-data.cjs`、`test-dubbing-units.ts` 的既有用例保持不变。
- 为什么不在 `proofreadData.ts` 里直接读 `app.getPath`：该模块靠 stub 在纯 node 下测试，直接依赖 Electron 会破坏这一点。

### D3: 新增零 Electron 依赖的 `main/helpers/proofreadDataStorage.ts`

- 内容：旧目录名常量、根目录注册（set / get）、托管路径判定、引用收集、删除计划与执行。
- 为什么不放进 `proofreadData.ts`：它依赖 `storeManager`。`speakerMetadata.ts` 需要知道根目录，而 `test:dubbing` 以纯 node 编译运行它，直接引用 `proofreadData.ts` 会把 Electron 依赖带进去。

### D4: 配音发现顺序为 显式路径 → 托管目录 → 旧邻居目录，多个命中取 mtime 最新

- 托管目录是全局的，同一视频可能留有多份历史 sidecar；旧逻辑"取目录遍历的第一个"并不确定。
- 托管目录扫描用按 `(路径, mtimeMs, size)` 缓存的 meta 路径摘要，避免每次重解析全部 JSON；每次扫描后清掉已不存在的条目。
- 为什么不建 index.json：数量受"随工作项删除而回收"约束，列目录加 `stat` 的成本可忽略；索引文件只会引入新的一致性问题。

### D5: 删除联动挂在现有工作项删除处理器，`commit()` 之后才删文件，不做暂存与回滚

- `deleteWorkItem` 与 `clearAllWorkItems` 都经 `commitDeletion`（含 `taskManager`、`proofreadStore`、`automation` 的调用），一处接入即全覆盖。
- 为什么与配音会话不同：配音会话目录要在工作项列表落盘之前先移走，失败时按原字节还原，所以需要 stage / rollback。sidecar 只在列表已持久化之后才删，失败只记日志并留作孤儿，`rollback` 因此是空操作。
- 引用计数：剩余工作项的 `pipelineFiles[]`、`proofreadEntries[]`、`taskDraft.manuscripts[]` 的 `proofreadDataFile`，加上配音工作项的 `configSnapshot.proofreadDataFile`；仍被引用的保留。

### D6: 删除护栏

- 只删位于托管根内、扩展名为 `.json`、`lstat` 为普通文件（非符号链接）的路径；根目录本身、`..` 穿越与根外路径一律拒绝。
- 旧邻居目录里的文件永不删除（存量保留，清理留给后续工具）。
- 路径比较走 `path.relative`，Windows 上由 Node 保证不区分大小写；判定函数接受可注入的 `path` 实现，便于在任意平台测试 win32 行为。
- 为什么要护栏：`proofreadDataFile` 来自持久化的 `config.json`，视为不可信输入。

### D7: 不迁移存量文件

- 绝对路径已写入工作项、配音会话、自动化任务；`proofreadDraftKey` 把它拼进草稿键，搬迁会让未保存草稿与质量审阅记录失联。
- 代价：重跑存量任务会在新位置另写一份，旧文件留在原处。

## Risks / Trade-offs

- [重跑存量任务留下旧文件] → 属于已有存量，不比今天更差，留给后续清理工具
- [模块级根目录状态污染测试] → 用例在 `finally` 中复位
- [托管目录扫描变慢] → mtime 摘要缓存；目录规模受工作项删除回收约束
- [userData 被重置时 sidecar 一并丢失] → 今天 userData 丢失后旧 sidecar 虽在，却已无引用可达（样本里 84/93 即如此），实际差别很小；备份导出不在本次范围
- [`commit` 阶段删除失败留下孤儿] → 只记日志，不影响删除工作项；孤儿留给后续清扫
- [外部脚本硬编码旧路径] → 应通过 `proofread.read` / `proofread.save` 访问，API 契约不变

## Migration Plan

- 无数据迁移。升级后新生成的 sidecar 进入托管目录，存量任务继续读写旧路径。
- 回滚：直接 revert。已写入 `userData/proofread-data/` 的 sidecar 靠绝对路径引用，旧版本也能读取，但旧版配音页的邻居发现找不到它们。
