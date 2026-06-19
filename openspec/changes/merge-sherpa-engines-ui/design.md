## Context

引擎左栏现有 6 条目：builtin / fasterWhisper / **funasr / qwen / fireRedAsr** / localCli。中间三条共享 sherpa 运行库与转写流水线，UI 已共用 `SherpaRuntimePanel` + `useSherpaRuntime`，差异仅在模型与少量参数。三条目各显一张相同运行库卡造成「同物三份」的认知负担。

差异点盘点（决定「按族上下文」的必要性）：

| 配置           | FunASR(SenseVoice/Paraformer) | Qwen3-ASR | FireRedASR-AED |
| -------------- | ----------------------------- | --------- | -------------- |
| ITN 逆文本规整 | ✓ `funasrUseItn`              | ✗         | ✗              |
| language       | ✓（SenseVoice 标签）          | 内部处理  | 内部处理       |
| numThreads     | ✓                             | ✓         | ✓              |
| 段长安全闸     | 通用 VAD                      | 通用 VAD  | ✓ ≤60s 硬钳    |
| VAD 参数       | 共享                          | 共享      | 共享           |

## Goals / Non-Goals

**Goals**

- 引擎面以单一条目表达「同一引擎、不同模型」；运行库卡只出现一次。
- 用户一眼知道该条目覆盖 FunASR / Qwen / FireRed。
- 高级设置按模型族上下文呈现（ITN 仅 SenseVoice）。
- 零后端改动、零任务迁移。

**Non-Goals**

- 不合并后端 adapter，不改引擎 id 或 `formData.transcriptionEngine`。
- 不改运行库获取方式、不改模型 catalog / 下载器。

## Decisions

### D1 — UI-only 合并：引入「展示组」而非新引擎 id

- 在渲染层引入展示组 key（如 `sherpa`）仅用于左栏选中态与右栏路由；不进入 `types/engine.ts` 的 `TranscriptionEngine` 联合、不写入任务 `formData`。
- `EngineModelTab` 的 `ENGINES` 左栏渲染从 `[builtin, fasterWhisper, funasr, qwen, fireRedAsr, localCli]` 调整为 `[builtin, fasterWhisper, <sherpa 组>, localCli]`；组的就绪点 = `funasr || qwen || fireRedAsr` 任一就绪。
- **理由**：满足合并诉求的同时，完全规避 adapter / id / 任务迁移风险。

### D2 — 右栏布局：运行库卡一次 + 模型族分区

```
本地多模型引擎                       [就绪/需要模型]
FunASR · Qwen · FireRed
┌ 运行库（共享，只此一处） ───────────────────────┐
│  已内置/就绪（或运行库管理，取决于 packaging 变更）│
└──────────────────────────────────────────────────┘
▸ FunASR（SenseVoice / Paraformer）
    模型行：下载/导入/删除/换路径 · 高级：ITN、numThreads
▸ Qwen3-ASR
    模型行… · 高级：numThreads、providerNote
▸ FireRedASR-AED
    模型行… · 高级：numThreads、providerNote、段长说明
```

- 运行库卡复用单个 `SherpaRuntimePanel`（其 `engineKey` 仅用于文案；合并后统一文案）。
- 各族高级设置内联在各族分区（沿用 `FunasrPanel` / `QwenPanel` / `FireRedPanel` 现有的设置控件，但不再各自包一张运行库卡）。
- 模型清单：复用 `FunasrModelSection` / `QwenModelSection` / `FireRedModelSection`（或经 `ModelLibrarySection` 分组），保持下载/导入/删除/换路径能力不减。

### D3 — 命名（Q4：中性名 + 副标题）

- 主标题：中性、能力向（不暴露 "sherpa-onnx"），如「本地多模型引擎」/「Local multi-model ASR」。
- 副标题：固定列出族名 `FunASR · Qwen · FireRed`，作为发现性的主载体。
- 发现性第二载体：**任务页模型下拉**按族分组（`FunASR ▸ / Qwen ▸ / FireRed ▸`），这是用户真正选择模型处。
- 具体措辞交由 i18n（zh/en），本设计只固定「中性主名 + 列族副标题」模式。

### D4 — 状态与徽章

- 合并条目左栏 `StatusDot`：任一族就绪 → ready；否则 pending。
- 右栏顶部徽章：综合三族（如「3 族中已就绪 N」或沿用「就绪/需要模型」）。
- 各族分区内仍可显示该族自身的就绪/需要模型微标。

## Risks / Trade-offs

- **右栏信息变长**：三族分区纵向堆叠。缓解：未安装任何模型的族可折叠/弱化；运行库卡精简（尤其配合 packaging 变更后只剩「已内置」一行）。
- **展示组与任务 id 的映射**：选择器需把族分组映射回三个 id。缓解：映射表集中在一处（如 `lib/engineModels` 或新建常量），单测覆盖。
- **i18n 命名分歧**：中性名可能反复。缓解：先定占位键，措辞可后续微调，不阻塞结构。

## Migration Plan

1. 渲染层引入展示组 + 右栏分组容器，复用现有族面板的设置控件与模型 Section。
2. 左栏 `ENGINES` 折叠；就绪点聚合。
3. 任务页模型选择器分组（映射回三 id）。
4. i18n 加中性名 + 副标题 + 分组标题。
5. 冒烟：三族下载/导入/删除/换路径与转写均不受影响；ITN 仅在 FunASR 组出现；任务页能选到三族模型并正确转写。

## Open Questions

- 合并条目主名最终措辞（占位先行）。
- 未安装族是否默认折叠（倾向：是，减少纵向长度）。
