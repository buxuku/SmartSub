## Why

校对用的无损中间态 sidecar（`.smartsub-proofread/*.json`）目前写在用户视频所在目录。它并不是可丢弃的缓存，而是应用私有、持久、不可再生的权威数据：校对台读到 sidecar 就只读它；保存校对时先写回 sidecar，再据此重新渲染 SRT/VTT/ASS；角色名称与归属、本集摘要、任务词库 ID 默认只存在其中；配音阶段在纯译文临时文件缺失时用它重建文本。

把它放在用户目录有三个问题：

- **没人清理，只增不减。** 文件名带随机 id，同一视频每新建一次任务就多一份，代码里没有任何删除 sidecar 的路径。开发机样本中 93 份 sidecar 有 84 份已没有任何应用数据引用。
- **与用户设置矛盾。** 默认"保存源字幕文件：不保存"会删掉中间源字幕，但 sidecar 仍写入完整转写与本机绝对路径，并随用户目录被打包、同步或分享。
- **与项目分层不一致。** 草稿、质量审阅、配音会话都在 `userData`，词级时间轴 sidecar 放在临时目录且明确"不污染用户输出目录"；唯独校对 sidecar 是应用私有的持久数据却落在用户目录。

迁入系统临时目录不可取（会削弱配音兜底与角色信息的持久性），目标应是应用数据目录。

## What Changes

- 新生成的校对 sidecar 写入 `userData/proofread-data/`，不再在视频目录旁创建 `.smartsub-proofread/`；该位置不跟随 `storageRoot`
- 存量 sidecar 原地保留，继续可读写，不做自动迁移（其路径已写入工作项、配音会话、自动化任务，并参与草稿键的计算）
- 配音页自动发现 sidecar 的顺序改为：显式路径 → 托管目录 → 旧邻居目录；多个命中时取最近修改者
- 删除工作项（含清空全部）时，按引用计数一并删除其独占的托管 sidecar；只处理托管目录内的普通 `.json` 文件，旧邻居目录里的文件永不删除
- 文档补充「校对数据保存在哪里」
- 不在本次范围：旧目录清理工具、设置页占用展示与手动清理、启动期孤儿清扫

## Capabilities

### New Capabilities

- `proofread-data-storage`: 校对 sidecar 的托管存储位置、存量兼容、配音发现顺序，以及随工作项删除的生命周期与安全护栏

### Modified Capabilities

（无——`pipeline-dub-stage` 对 sidecar 的使用与其存放位置无关，行为不变）

## Impact

- 主进程：`main/helpers/proofreadData.ts`（路径解析）、新增 `main/helpers/proofreadDataStorage.ts`、`main/helpers/ipcProofreadHandlers.ts`（注入根目录）、`main/helpers/dubbing/speakerMetadata.ts`（发现顺序）、`main/helpers/workItemHandlers.ts`（删除联动）
- 渲染层与 IPC 通道：无变化（`proofreadDataFile` 在各处都按不透明绝对路径使用）
- 测试：新增 `scripts/test-proofread-storage.cjs`（`test:proofread-storage`，并入 pro baseline）；扩展 `scripts/dubbing/test-dubbing-units.ts`
- 文档：`docs/docs/features/proofreading.md`
- 无新增第三方依赖
