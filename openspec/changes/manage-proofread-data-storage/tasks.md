# Tasks: manage-proofread-data-storage

## 1. 托管目录与写入路径（P1）

- [x] 1.1 新建 `main/helpers/proofreadDataStorage.ts`（零 Electron 依赖）：导出 `LEGACY_PROOFREAD_DIR`（`.smartsub-proofread`）、`setProofreadDataRoot` / `getProofreadDataRoot`
- [x] 1.2 改造 `main/helpers/proofreadData.ts` 的 `getProofreadDataPath`：已注入根目录时返回 `<根>/<name>.<id>.json`，未注入时回落旧邻居路径，其余命名规则不变
- [x] 1.3 在 `main/helpers/ipcProofreadHandlers.ts` 的 `setupProofreadHandlers()` 内注入 `path.join(app.getPath('userData'), 'proofread-data')`
- [x] 1.4 新增 `scripts/test-proofread-storage.cjs`，在 `package.json` 登记 `test:proofread-storage`，并加入 `scripts/test-pro-baseline.mjs`；覆盖：注入后路径落在托管根、未注入回落旧路径、命名规则不变、真实写入后视频目录旁不出现 `.smartsub-proofread/`

## 2. 配音发现顺序（P2）

- [x] 2.1 改造 `main/helpers/dubbing/speakerMetadata.ts` 的 `findDubbingProofreadDataFile`：显式路径 → 托管根 → 字幕旁旧邻居目录，同一位置多个命中取 mtime 最新
- [x] 2.2 托管目录扫描按 `(路径, mtimeMs, size)` 缓存 meta 路径摘要，并在每次扫描后清理已不存在的条目
- [x] 2.3 扩展 `scripts/dubbing/test-dubbing-units.ts`：覆盖托管优先、回落旧目录、多命中取最新、显式路径优先，既有邻居目录用例保持通过

## 3. 随工作项删除回收（P3）

- [ ] 3.1 在 `proofreadDataStorage.ts` 新增 `isManagedProofreadPath`（可注入 `path` 实现，覆盖 win32 大小写）、`collectProofreadDataFiles`（引用收集）、`planManagedDeletion`（引用计数）、`removeManagedProofreadData`（护栏 + 失败只记日志）
- [ ] 3.2 在 `main/helpers/workItemHandlers.ts` 的删除处理器接入：只在 `commit()` 里删除，`rollback()` 不动文件
- [ ] 3.3 在 `scripts/test-proofread-storage.cjs` 补单测：独占删除、共享保留、配音 `configSnapshot` 引用保留、旧目录不删、越界 / 符号链接 / 非 `.json` 拒绝、清空全部、持久化失败不删除、删除失败不抛；`npm run test:work-item-durability` 保持通过

## 4. 文档与验证（P5）

- [ ] 4.1 在 `docs/docs/features/proofreading.md` 新增「校对数据保存在哪里」一节：新位置 `userData/proofread-data`、随任务删除、升级前的旧文件原地保留
- [ ] 4.2 `npm run typecheck` 通过
- [ ] 4.3 相关测试通过：`test:proofread-storage`、`test:proofread-cue-timing`、`test:proofread-data`、`test:missed-speech`、`test:dubbing`、`test:dubbing-speakers`、`test:pipeline`、`test:work-item-durability`
- [ ] 4.4 `npm run test:pro-baseline` 通过
- [ ] 4.5 冒烟验证：跑一个短任务后文件出现在 `userData/proofread-data/` 且视频旁没有 `.smartsub-proofread/`；删除任务后文件消失；升级前任务的旧 sidecar 仍能打开
