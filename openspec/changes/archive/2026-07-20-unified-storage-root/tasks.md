# Tasks: unified-storage-root

## 1. 共享校验与解析核心

- [x] 1.1 新建 `types/pathValidation.ts`：`containsCjk(p)`（CJK 统一表意文字 + 扩展A + 兼容表意 + CJK 标点 `\u3000-\u303f` + 全角形式 `\uff00-\uffef`）与 `validateStoragePath(p)`；纯函数、零 Electron/Node 依赖（先例 `types/provider.ts`）
- [x] 1.2 新建 `main/helpers/storagePaths.ts`：`resolveStorageLocation({override, storageRoot, subpath, defaultBase})` 纯函数（trim 判空语义对齐 `resolveOverridePath`，返回 `{path, source}`，source ∈ `override|storageRoot|default`）+ 各用途子路径常量表（design D2/D3）
- [x] 1.3 `main/helpers/store/types.ts`：`settings` 新增 `storageRoot?: string`（注释说明解析链）；`main/helpers/store/index.ts`：defaults 移除 `modelsPath`（design D4-1）

## 2. 主进程接入

- [x] 2.1 六个模型目录 getter 接入 `resolveStorageLocation`：`whisper.ts getPath()`、`modelCatalog.ts getFasterWhisperModelsPath()`、`funasrModelCatalog.ts` / `qwenModelCatalog.ts` / `fireRedModelCatalog.ts` / `ttsModelCatalog.ts` 的 `get*ModelsRoot()`；mkdir 留在 getter 内（既有行为），并为 `getSystemInfo` 暴露带 source 的取值口
- [x] 2.2 `fileUtils.ts getTempDir()`：插入 `storageRoot/temp` 中间级（三级优先级，mkdir 失败日志 + 回退系统默认，design D5）
- [x] 2.3 `ipcStoreHandlers.ts setupStoreHandlers()`：启动归一化迁移——持久化 `modelsPath === path.join(userData, 'whisper-models')` 时删除该键（与 gpuMode 迁移并列，design D4-2）
- [x] 2.4 `ipcStoreHandlers.ts setSettings`：对 8 个路径键（`storageRoot`、`modelsPath`、`fasterWhisperModelsPath`、`funasrModelsPath`、`qwenModelsPath`、`fireRedModelsPath`、`ttsModelsPath`、`customTempDir`）执行 CJK 兜底——含 CJK 的键从 patch 剔除 + `logMessage` warn（design D6-2）
- [x] 2.5 `ipcStoreHandlers.ts setSettings`：Python 运行时重启判定改为「CT2 有效根目录 pre/post 变化」（用 1.2 纯函数分别解析写入前后 settings，design D7；顺带修复清空覆盖不重启的既有缺陷）
- [x] 2.6 `systemInfoManager.ts getSystemInfo`：返回值新增 `storageRoot`（原始设置值）与 `modelPathSources: {ggml, ct2, funasr, qwen, firered}`（design D8）

## 3. 设置页「存储位置」区块

- [x] 3.1 `renderer/pages/[locale]/settings.tsx`：新增统一存储目录控件（当前值/「跟随系统默认」占位、浏览、打开目录、清除），与既有临时目录控件归入同一「存储位置」分组；浏览选路后先过 `validateStoragePath`，失败 destructive toast 不保存；保存/清除成功 toast 带不迁移提示（design D8/D9）
- [x] 3.2 同页：自定义临时目录选路接入同一校验；临时目录 hint 文案补充与统一目录的优先级说明
- [x] 3.3 同页：`storageRoot` 未设置且默认存储位置含 CJK 时展示常驻警示（渲染层用 `containsCjk` 对 systemInfo 路径判定，design D6-3）
- [x] 3.4 同页：变更成功后弹「新旧位置对照」对话框（旧/新路径 + 打开旧目录/新目录 + 子目录同名整体复制说明，取代单条 toast）；主进程新增 `openDirectoryPath` IPC（design D9）
- [x] 3.5 `renderer/components/onboarding/OnboardingDialog.tsx`：首次引导第 2 步（模型下载）顶部内联存储位置行（当前解析基座 + 「更改」，仅无已装模型时展示）+ 默认路径含 CJK 的黄色警示；选路复用 `validateStoragePath` 硬校验；文案入 `common.json onboarding.*`（design D10）
- [x] 3.5 `renderer/components/onboarding/OnboardingDialog.tsx`：首次引导第 2 步（模型下载）顶部内联「存储位置」行（当前解析基座 + 更改按钮，仅无已装模型时展示）+ 默认路径含 CJK 的黄色警示；选路走同一 `validateStoragePath` 硬校验；文案入 `common.json onboarding.*`（design D10）
- [x] 3.4 同页：变更成功后弹「新旧位置对照」对话框（旧/新路径 + 打开旧目录/打开新目录 + 子目录同名整体复制说明 + 单独设置不受影响注记；旧位置无变化退回 toast）；主进程新增 `openDirectoryPath` IPC（design D9）

## 4. 引擎页来源标识与恢复跟随

- [x] 4.1 `renderer/components/resources/ModelLibrarySection.tsx`：路径行新增来源 Badge（默认 / 统一目录 / 单独设置，数据来自 `modelPathSources`）；source 为 override 且 storageRoot 已设置时渲染「恢复跟随统一目录」按钮（`setSettings({[pathKey]: ''})` 后刷新 systemInfo）
- [x] 4.2 同组件 `handleChangeModelsPath`：选路后接入 `validateStoragePath`，失败 toast 不保存

## 5. i18n 文案

- [x] 5.1 `renderer/public/locales/{zh,en}/settings.json`：新增存储分组标题、统一目录 label/占位/清除、不迁移提示、中文路径被拒 toast、默认路径含中文警示、临时目录优先级说明等键
- [x] 5.2 `renderer/public/locales/{zh,en}/modelsControl.json`：新增来源 Badge 三态、恢复跟随按钮及成功提示、中文路径被拒 toast（如与 settings 复用则收敛为一处）；`npm run check:i18n` 通过

## 6. 测试与验证

- [x] 6.1 新增 `scripts/test-storage-paths.ts` + package.json `test:storage-paths` 脚本（仿 `test:thinking-control` 编译运行模式）：`resolveStorageLocation` 全分支与 source 判定、逐引擎子路径映射、temp 三级优先级、`containsCjk` 正反例（中文/CJK 标点/全角/纯英文/西文变音符/空串）、modelsPath 归一化判定
- [x] 6.2 手工验证清单（真机）：设置 root 后 6 引擎路径 + temp 跟随且下载落位新目录；CT2 三场景重启判定（设 root 重启 / 有覆盖不重启 / 清覆盖重启）；单独设置优先与恢复跟随；三类入口选中文路径均被拒；配置导入含中文路径键被剔除；Windows 中文用户名警示展示与消失（设置页 + 引导第 2 步）；存量 modelsPath 归一化后跟随 root；换目录后对照对话框两个打开按钮定位正确；首次引导改目录后下载落位新目录、有已装模型时不展示该行
