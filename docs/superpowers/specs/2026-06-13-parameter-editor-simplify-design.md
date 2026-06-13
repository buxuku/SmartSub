# 参数编辑器简化（方案 A）设计

> 日期：2026-06-13 · 分支 `feat/resource-hub` · 对应 UX 报告 **6.5.12**
> 指导原则：**功能满足前提下，用户操作最简**

## 1. 目标与范围

### 目标

将「添加一个 body 参数（如 `temperature=0.3`）」从 **7 步** 降到 **≤3 步**，且不破坏现有保存/校验/翻译请求合并行为。

### 在范围内

- 保留 `ProviderForm` → Dialog → 参数编辑器的入口（低频进阶能力不 inline 到主表单）
- 重写 **仅** `CustomParameterEditor.tsx` 的 UI 层；**复用** `useParameterConfig` hook 与 main 侧 `parameterProcessor` / IPC
- Header / Body 双 Tab + **Postman 式行内表格**
- 自动保存、校验错误展示、删除行
- 进阶能力收进「更多操作」下拉：导入 / 导出 / 刷新 / 搜索

### 范围外（YAGNI）

- 去掉 Dialog 改为表单 inline（方案 B）
- 三件套全删重写（方案 C）
- 改 `CustomParameterConfig` 数据结构或 IPC 协议
- 参数模板市场、可视化 schema 编辑器

## 2. 交互设计

### 2.1 主路径（80% 用户）

| 步骤 | 操作                                                                |
| ---- | ------------------------------------------------------------------- |
| 1    | 服务商表单 → 点击「配置自定义参数」打开 Dialog                      |
| 2    | 默认在 **请求体** Tab；表格底部空行填写 **键** / **值**             |
| 3    | 失焦或按 Enter → 写入配置 → **自动保存**（沿用 hook 现有 debounce） |

示例：键 `temperature`，值 `0.3` → 完成。

### 2.2 表格结构（每个 Tab 一张）

| 列       | 说明                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| **键**   | `<Input>`，新增行 placeholder「例如 temperature」                                |
| **值**   | 默认单行 `<Input>`；类型为 boolean 时 `<Switch>`；array 时折叠 JSON `<Textarea>` |
| **类型** | 默认隐藏；行尾「⋯」→ 下拉：string / integer / float / boolean / array            |
| **操作** | 删除（Trash）；仅已有行显示                                                      |

- 表格 **最后一行始终为空行**（draft row），填完键+值后自动追加新空行
- **键不可重复**：同 Tab 内 duplicate key 行内红框 + 底部校验摘要（沿用 `validationErrors`）
- **Rename**：改键 = 删旧键 + 写新键（简单实现；高级 rename 不做）

### 2.3 智能类型提示（不增加步骤）

- 键名命中 `PARAMETER_REGISTRY`（如 `temperature`、`max_tokens`）时：
  - 值列 placeholder 显示 registry 说明（可选 tooltip）
  - 保存前按 registry 类型 **coerce**（与 main `parameterProcessor` 一致：字符串 `"0.3"` → number）
- 用户未改类型时仍按 registry 推断；未知键默认 **string**

### 2.4 进阶能力（折叠，不挡主路径）

Dialog 右上角 **「更多」`DropdownMenu`**：

- 搜索参数（过滤当前 Tab 行，参数 >5 条时显示搜索框；≤5 条隐藏搜索）
- 导入 JSON / 导出 JSON
- 从服务端刷新（保留未保存警告 Dialog）

**移除或降级：**

- ~~「添加参数」大按钮 + Add AlertDialog~~（由空行替代）
- ~~每行「复制」按钮~~（移入行 ⋯ 菜单，低频）
- ~~配置摘要 Card~~（参数计数保留在 Tab Badge）
- ~~每参数独立 Card + Separator 堆叠~~（改为紧凑表格）

### 2.5 校验与保存

- **不改** `useParameterConfig.saveConfig` / `validateConfiguration` 调用时机
- 行内错误：键为空、JSON 无效、registry 校验失败 → 值列下红色 helper text
- 保存态：Dialog 顶栏保留「保存中 / 已保存 / 失败」指示（与现有一致）
- 失败大声：toast + 行内错误；成功安静

## 3. 组件架构

```
ProviderForm (不变)
  └ Dialog (不变)
       └ CustomParameterEditor (重写 UI)
            ├ ParameterTable (新，内联于同文件或拆 ParameterKvTable.tsx)
            │    └ 行渲染：string | number | boolean | array 分支（精简版，不整页 DynamicParameterInput Card）
            ├ useParameterConfig (不变)
            └ 更多菜单 → import/export/refresh/search
```

### DynamicParameterInput 处置

- **不删除文件**（避免大范围测试 churn）
- 新表格 **不再引用** `DynamicParameterInput` 的 Card 布局
- array/boolean 的 JSON 校验逻辑 **抽取** 到 `renderer/lib/parameterValueUtils.ts`（~40 行），表格与旧组件可共用；或表格内联最小实现，array 仍用 Textarea + JSON.parse 校验

### 预估改动量

| 文件                             | 动作                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `CustomParameterEditor.tsx`      | 重写 ~350 行（现 894 → 目标 <400）                     |
| `ParameterKvTable.tsx`           | 新增 ~200 行（可选拆分）                               |
| `parameterValueUtils.ts`         | 新增 ~60 行                                            |
| `DynamicParameterInput.tsx`      | 暂不删；标记 deprecated 注释                           |
| `useParameterConfig.tsx`         | 仅必要时加 `renameParameter` helper；优先用 remove+add |
| `parameters.json` zh/en          | 新增表格相关 keys；废弃 addDialog keys 可保留不引用    |
| `CustomParameterEditor.test.tsx` | 更新：空行添加、registry coerce、删除、import 菜单     |

**不动：** `main/helpers/parameterProcessor.ts`、`ipcParameterHandlers.ts`、`types/*`

## 4. 数据流

1. `loadConfig(providerId)` on mount（不变）
2. 用户编辑表格 → 调 `addBodyParameter` / `updateBodyParameter` / `remove*`（不变）
3. hook 内部 debounce → `saveConfig` → IPC → 磁盘（不变）
4. 翻译/AI 请求时 main 侧 merge customParameters（不变）

## 5. 验收标准

1. 添加 `temperature=0.3`（body）：**≤3 次点击/键盘操作**，无嵌套 Add Dialog
2. 添加 `Authorization` header：**切换 Tab + 填表**，同样 ≤3 步
3. 已有配置加载后表格正确展示；删除行后自动保存生效
4. import/export 仍可用（从更多菜单）
5. array/boolean 类型可通过行 ⋯ 切换并正确保存
6. 已知键 `temperature` 存字符串 `"0.3"` 时，翻译请求体中为数字 `0.3`（registry 校验通过）
7. i18n zh/en 对等；renderer 非测试 TSC 0；更新后的组件测试通过

## 6. 风险与对策

| 风险                | 对策                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| 改键名丢值          | 首版不支持 inline 改键，仅删+新建；或改键走 rename helper             |
| array JSON 行内难用 | array 类型仍用 Textarea + 校验；占比极低                              |
| 测试量大            | 聚焦 5–8 条行为测试，不全量复制旧 894 行 UI 测试                      |
| 与旧 UI 行为差      | 保留 import/export/refresh；E2E 手动：配 temperature 后跑一次翻译测试 |

## 7. 批次建议（B18）

- 单批次、3–4 个 task commit：① 表格组件 + body tab ② header tab + 更多菜单 ③ i18n + 测试 ④ 删 dead UI / 进度文档
- 排在 B16（截图）之后或并行，不影响对外形象

## 8. 决策记录

| #   | 问题     | 采用                    | 备选                  |
| --- | -------- | ----------------------- | --------------------- |
| 1   | 范围     | 方案 A 轻量简化         | B inline / C 全量重写 |
| 2   | 添加入口 | 表格永久空行            | 保留 Add Dialog       |
| 3   | 类型选择 | 默认 string + 行 ⋯ 高级 | 每行强制选类型        |
| 4   | 已知参数 | registry 自动 coerce    | 用户手动选 float      |
| 5   | 低频功能 | 更多菜单                | 顶栏全展示            |
