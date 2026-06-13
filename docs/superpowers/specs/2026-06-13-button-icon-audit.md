# 操作按钮 Icon 缺失审计

> 日期：2026-06-13  
> 范围：renderer 内用户可见的 `Button` / `AlertDialogAction` / 对话框底部主操作  
> 排除：纯 icon 按钮（`size="icon"`）、分页数字、Tab、主题切换、关闭 X、Select 触发器、Switch/Checkbox  
> 说明：**仅列出当前完全没有 Lucide icon 的按钮**；文字后带 Chevron/Arrow（如「查看全部 ›」）不算缺失。

---

## 统计概览

| 模块                         | 约缺失数量 | 优先级 |
| ---------------------------- | ---------- | ------ |
| 任务页 TaskControls          | 6          | 高     |
| 对话框 Cancel/Confirm/Delete | 20+        | 中     |
| 设置页                       | 12         | 中     |
| GPU 加速卡                   | 6          | 中     |
| 字幕编辑器工具栏/弹窗        | 12         | 中     |
| 启动台 / 全部任务            | 5          | 低     |
| 校对                         | 3          | 低     |
| 资源中心                     | 6          | 低     |
| 引导 Onboarding              | 6          | 低     |
| 合成页                       | 1          | 低     |

---

## 1. 启动台 / 全部任务

| 位置                        | 按钮文案           | 类型        | 建议 Icon                              |
| --------------------------- | ------------------ | ----------- | -------------------------------------- |
| `home.tsx` ~218             | 下载推荐模型       | Primary     | `Download`                             |
| `home.tsx` ~229             | 去配置（翻译服务） | Outline     | `Languages`                            |
| `home.tsx` ~367             | 删除确认           | Destructive | `Trash2`                               |
| `recent-tasks.tsx` ~294     | 删除确认           | Destructive | `Trash2`                               |
| `recent-tasks.tsx` ~311     | 确认清除全部       | Destructive | `Trash2`                               |
| `recent-tasks.tsx` ~252–270 | 上一页 / 下一页    | Outline     | `ChevronLeft` / `ChevronRight`（可选） |

---

## 2. 任务页

| 位置                          | 按钮文案            | 类型         | 建议 Icon    |
| ----------------------------- | ------------------- | ------------ | ------------ |
| `TaskControls.tsx` ~161       | 开始任务 / 重新开始 | Primary      | `Play`       |
| `TaskControls.tsx` ~169       | 暂停                | Default      | `Pause`      |
| `TaskControls.tsx` ~172, ~178 | 取消任务            | Default      | `CircleStop` |
| `TaskControls.tsx` ~177       | 继续                | Primary      | `Play`       |
| `TaskControls.tsx` ~182       | 取消中…             | Disabled     | `Loader2`    |
| `InlineConfigBar.tsx` ~99     | 去下载模型          | Outline link | `Download`   |
| `InlineConfigBar.tsx` ~168    | 去配置服务商        | Outline link | `Languages`  |

**已有 Icon（无需改）**：`tasks/[type].tsx` 工具栏、`CompletionBanner`、`TaskRowList` 行内操作。

---

## 3. 校对

| 位置                             | 按钮文案    | 类型                 | 建议 Icon      |
| -------------------------------- | ----------- | -------------------- | -------------- |
| `ProofreadEditor.tsx` ~413       | 放弃并返回  | Outline              | `Undo2`        |
| `ProofreadEditor.tsx` ~416       | 保存并返回  | Primary              | `Save`         |
| `ProofreadTaskList.tsx` ~186–191 | 取消 / 删除 | Cancel + Destructive | `X` / `Trash2` |

**已有 Icon**：`ProofreadFileList.tsx` 保存、完成、导入等。

---

## 4. 设置

| 位置                                | 按钮文案               | 类型                 | 建议 Icon                            |
| ----------------------------------- | ---------------------- | -------------------- | ------------------------------------ |
| `settings.tsx` ~158                 | 保存（Whisper 命令行） | Primary              | `Save`                               |
| `settings.tsx` ~519                 | 前往资源中心           | Outline              | `ArrowRight`                         |
| `settings.tsx` ~561                 | 选择路径               | Primary              | `FolderOpen`                         |
| `settings.tsx` ~673–682             | VAD 预设三档           | Outline toggle       | `SlidersHorizontal`                  |
| `settings.tsx` ~685                 | 重置 VAD 预设          | Ghost                | `RotateCcw`                          |
| `settings.tsx` 导出/导入/恢复对话框 | 取消 / 确认            | Outline + Primary    | `X` / `Check` 或 `Upload`/`Download` |
| `settings.tsx` ~1088                | 取消 / 恢复默认        | Cancel + Destructive | `X` / `Trash2`                       |

---

## 5. GPU 加速（`GpuAccelerationCard.tsx`）

| 位置 | 按钮文案        | 类型                 | 建议 Icon        |
| ---- | --------------- | -------------------- | ---------------- |
| ~512 | 取消下载        | Ghost                | `X`              |
| ~517 | 关闭提示        | Ghost                | `X`              |
| ~627 | 升级到 CUDA     | Primary              | `Zap`            |
| ~758 | 切换 Lite/Full  | Ghost                | `ArrowLeftRight` |
| ~923 | 取消 / 删除插件 | Cancel + Destructive | `X` / `Trash2`   |

---

## 6. 资源中心

| 位置                             | 按钮文案        | 类型              | 建议 Icon             |
| -------------------------------- | --------------- | ----------------- | --------------------- |
| `OverviewTab.tsx` ~238           | 启用翻译服务    | Primary           | `Plus` 或 `Languages` |
| `ProvidersTab.tsx` ~535          | 测试翻译        | Outline           | `FlaskConical`        |
| `ProvidersTab.tsx` ~631–644      | 取消 / 添加     | Dialog footer     | `X` / `Plus`          |
| `ModelsTab.tsx` ~301             | 删除模型        | Destructive ghost | `Trash2`              |
| `DownModelButton.tsx` ~64        | 下载（默认态）  | Outline           | `Download`            |
| `CustomParameterEditor.tsx` ~473 | 更多菜单        | Outline           | `MoreHorizontal`      |
| `CustomParameterEditor.tsx` ~585 | 取消 / 仍要刷新 | Dialog            | `X` / `RefreshCw`     |

---

## 7. 字幕 / 合成

| 位置                        | 按钮文案                                         | 类型            | 建议 Icon                                          |
| --------------------------- | ------------------------------------------------ | --------------- | -------------------------------------------------- |
| `StylePresets.tsx` ~28      | 各样式预设 chip                                  | Toggle          | `Palette`                                          |
| `SubtitleList.tsx` ~579     | 取消重翻                                         | Ghost           | `CircleStop`                                       |
| `SubtitleList.tsx` ~647     | 清除选择                                         | Ghost           | `X`                                                |
| `SubtitleEditToolbar.tsx`   | 替换当前 / 应用偏移 / 合并·拆分·AI 弹窗 取消确认 | 多种            | `Replace` `Clock` `X` `Combine` `Scissors` `Check` |
| `BatchAiOptimizeDialog.tsx` | 重置 / 取消                                      | Ghost / Outline | `RotateCcw` `X`                                    |

**已有 Icon**：`MergeButton`、`FileSelector`、`VideoPreview` 播放/取消等。

---

## 8. 全局 / 引导

| 位置                   | 按钮文案                                        | 类型   | 建议 Icon                                                        |
| ---------------------- | ----------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `OnboardingDialog.tsx` | 跳过 / 上一步 / 下一步 / 完成 / 去配置 / 去启用 | 多种   | `SkipForward` `ArrowLeft` `ArrowRight` `Check` `Languages` `Zap` |
| `DeleteModel.tsx`      | 取消 / 删除                                     | Dialog | `X` / `Trash2`                                                   |

**已有 Icon**：`LogDialog`、`UpdateDialog` 底部操作。

---

## 9. 建议分批补 Icon 的方案

| 批次  | 范围                                           | 理由           |
| ----- | ---------------------------------------------- | -------------- |
| **A** | TaskControls + InlineConfigBar + 启动台 banner | 主流程最明显   |
| **B** | 全部 AlertDialog 取消/确认/删除                | 统一对话框规范 |
| **C** | 设置 + GPU                                     | 配置页一致性   |
| **D** | 字幕编辑器弹窗 + BatchAi                       | 编辑器内       |
| **E** | 资源中心 + Onboarding + 其余                   | 低频页         |

---

## 10. 实施状态

**2026-06-13 用户确认「全部补」——已按批次 A–E 全部实施。**
