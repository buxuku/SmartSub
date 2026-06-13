# WorkItem 统一任务历史 — 实施计划（P19 / WorkItem Epic）

> 日期：2026-06-13  
> 决策依据：`docs/superpowers/specs/2026-06-13-proofread-history-vs-recent-tasks-analysis.md`（方案 C）  
> 蓝图对齐：`2026-06-11-ux-redesign-blueprint-design.md` §6.3  
> 目标：用单一 `WorkItem` 模型取代 `taskProjects` + `proofreadTasks` 两套存储，启动台 / 任务页 / 校对页共用。

---

## 1. 范围

### In scope

- 新类型 `WorkItem` + `WorkItemType` + 子结构（流水线文件 + 校对项 + artifacts）
- electron-store 键 `workItems`，启动时迁移 `taskProjects` + `proofreadTasks`（保留旧键只读回滚窗口）
- 统一 IPC：`getWorkItems` / `getWorkItem` / `saveWorkItem` / `deleteWorkItem` / `renameWorkItem`
- 启动台最近列表、任务页工程加载、校对批次保存/加载 — 全部走 WorkItem
- 术语：对外统一「工作项」或「最近工作」（i18n 全量）
- 路由：保留现有 URL 形态，内部按 `workItemId` + `kind` 解析

### Out of scope（本 Epic 不做）

- 合成页 WorkItem 类型（可预留 `type: 'merge'` 占位）
- 系统通知（蓝图 §6.5）
- `smartsub://` 深链迁移
- Python 引擎

---

## 2. 目标数据模型（草案）

```ts
export type WorkItemType =
  | 'generateAndTranslate'
  | 'generateOnly'
  | 'translateOnly'
  | 'proofread'; // 批量校对批次

export type WorkItemStatus =
  | 'waiting'
  | 'running'
  | 'done'
  | 'error'
  | 'interrupted'; // 重启后原 running → interrupted

/** 流水线文件 — 从 IFiles 演进，修正 extractAudio 等类型 */
export interface PipelineFile { ... }

/** 校对项 — 从 ProofreadItem 平移 */
export interface ProofreadEntry { ... }

export interface WorkItem {
  id: string;
  name: string;
  type: WorkItemType;
  status: WorkItemStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  /** 流水线类：generate* / translate* */
  pipelineFiles?: PipelineFile[];

  /** 校对类：proofread */
  proofreadEntries?: ProofreadEntry[];
  currentProofreadIndex?: number;

  /** 可选：配置快照、产物索引（后续合成/导出） */
  configSnapshot?: Record<string, unknown>;
  artifacts?: Array<{ kind: string; path: string }>;
}
```

**映射规则**

| 旧数据          | 新 WorkItem                                        |
| --------------- | -------------------------------------------------- |
| `TaskProject`   | `type` = taskType，`pipelineFiles` = files         |
| `ProofreadTask` | `type` = `'proofread'`，`proofreadEntries` = items |

---

## 3. 分阶段交付（建议 4 个 commit 批次）

### 批次 P19-1：类型 + 存储 + 迁移（main only）

**Task**

1. 新增 `types/workItem.ts`
2. `main/helpers/workItemStore.ts`：CRUD + 内存缓存（模式同 taskManager）
3. `main/helpers/migrations/workItemMigration.ts`：
   - 若 `workItems` 为空且存在 `taskProjects` / `proofreadTasks` → 一次性转换
   - 写 `workItemsMigrationVersion: 1`
4. 单元测试：迁移 fixture（各 1 个 TaskProject + ProofreadTask）

**门禁**：main 相关测试通过；旧 IPC 仍可用（未删）

---

### 批次 P19-2：IPC 层 + 兼容 shim

**Task**

1. 注册新 IPC handlers（`workItemHandlers.ts`）
2. 旧 handlers 内部委托到新 store（deprecated 注释）：
   - `getTaskProjects` → filter pipeline types
   - `getProofreadTasks` → filter proofread type
   - `saveTaskProject` / `saveProofreadTask` → `saveWorkItem` 适配
3. `LogEntry.projectId` → 可选 rename 为 `workItemId`（或双写兼容）

**门禁**：现有 renderer 无改动仍跑通

---

### 批次 P19-3：Renderer 消费切换

**Task**

1. `home.tsx`：只调 `getWorkItems`，卡片路由按 `type` 分支
   - pipeline → `/tasks/[slug]?project=id`（query 名可暂保留）
   - proofread → `/proofread?workItem=id`
2. `tasks/[type].tsx`：`getWorkItem` + pipelineFiles
3. `proofread.tsx` + `ProofreadTaskList`：读 proofread WorkItem；**移除「历史任务」Tab**（历史即启动台列表）
4. `ProofreadEditor` 保存 → `saveWorkItem`
5. i18n：`launchpad` / `home` 术语统一

**门禁**：i18n check + renderer TSC 非测试 0

---

### 批次 P19-4：清理 + 文档

**Task**

1. 删除 renderer 对旧 IPC 的直接调用（若 shim 仍留 main 侧一段版本）
2. 更新 `UX_REFACTOR_PROGRESS.md` P19 条目
3. 迁移说明：用户无感；开发文档注明旧键只读保留 1 版本

**可选 follow-up（P19-5）**

- 任务页内嵌校对：写入同一 WorkItem 的 `proofreadEntries` 或 linked 子项（打通路径 2）
- `IFiles` 类型正型（蓝图 §6.3 最后一行）

---

## 4. 路由与 UX

| 用户操作           | 路由                                              |
| ------------------ | ------------------------------------------------- |
| 启动台点流水线工程 | `/[locale]/tasks/generate-translate?project={id}` |
| 启动台点校对批次   | `/[locale]/proofread?workItem={id}`               |
| 校对页新建         | `/proofread`（无 id，保存后得 id）                |
| 返回               | 统一回到启动台或来源 WorkItem 列表                |

校对页 Tab 结构建议：

- **新建**（import → list → edit）
- ~~历史任务~~ → 删除；空态链到启动台「最近工作」

---

## 5. 风险与缓解

| 风险           | 缓解                                                     |
| -------------- | -------------------------------------------------------- |
| 迁移丢数据     | 迁移前只读复制旧键；集成测试 + 手动 QA 清单              |
| 大范围回归     | P19-2 shim 保证渐进；P19-3 前全量手测任务页+校对         |
| 运行中任务重启 | 首版：`running` → `interrupted` + 横幅；一键重跑可 P19-5 |
| IPC Breaking   | preload 类型同步更新；旧 handler 保留一版                |

---

## 6. 预估

| 批次     | 人日      |
| -------- | --------- |
| P19-1    | 3–4       |
| P19-2    | 2–3       |
| P19-3    | 5–7       |
| P19-4    | 1–2       |
| **合计** | **11–16** |

---

## 7. 下一步（需你确认后开干）

1. 审阅本计划 §2 数据模型字段是否够用（尤其 artifacts、内嵌校对）
2. 确认 Epic 编号：**P19** 或并入现有 backlog 命名
3. 确认是否 **P19-1 立即开工**，或先完成未提交的校对 UI 小改再开 WorkItem

---

## 8. 实机验证清单（Epic 完成后）

- [ ] 旧 `taskProjects` 迁移后启动台列表条目数量与名称一致
- [ ] 旧 `proofreadTasks` 迁移后从启动台打开批次，进度/字幕路径正确
- [ ] 新建流水线工程 → 重启 → 仍可继续
- [ ] 校对保存批次 → 启动台出现 → 重启 → 继续编辑
- [ ] 删除/重命名在启动台生效
- [ ] 任务页内嵌校对（若 P19-5）与批次不重复脏写
