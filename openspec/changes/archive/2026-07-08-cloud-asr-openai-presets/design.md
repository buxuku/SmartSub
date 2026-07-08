## Context

`cloud-asr-provider-grouping`（D7）已把服务商类型分成**协议型**（`multiInstance:true`，如 OpenAI 兼容）与**品牌型**（硬单例，如 ElevenLabs / Deepgram）。协议型的价值在于「一个 `transcribe` 实现对接多家兼容 vendor」，但新建实例目前是空表单，用户需自备各家 base URL / 模型名。本变更为协议型补「命名预设」，把常见 vendor 的连接参数内置成一键预填。

约束：Electron + Next(nextron)；`check:i18n`、`test:engines` 守卫；须**非破坏**——预设只改字段值，`type` 恒为 `openaiCompatible`，后端分发零改动。

## Goals / Non-Goals

**Goals:**

- 新建 OpenAI 兼容实例时可从 `OpenAI / Groq / 硅基流动` 等预设一键预填 base URL + 模型。
- 让协议型「支持哪些常见 vendor」在添加入口自解释，降低手填错误。
- 预设为**声明式数据 + 纯函数**，可单测、可低成本增补。

**Non-Goals:**

- **不**新增服务商类型（预设不是类型；共用 `openaiCompatible` 的 `transcribe`）。
- **不**代填 API Key（凭据仍由用户输入）。
- **不**改任务页下拉、分发、存储结构、品牌型面板行为。
- **不**做「预设 = 独立左栏项」或按预设再分子区（避免面板膨胀）。

## Decisions

### D1 — 预设是「类型下的连接参数模板」，不是新类型

**决定**：预设仅承载字段覆盖值（`apiUrl` / `models` …），新建实例 `type` 仍为 `openaiCompatible`。数据形态：

```ts
interface AsrProviderPreset {
  id: string;
  name: string;
  icon?: string;
  values: Record<string, string>;
}
const ASR_PROVIDER_PRESETS: Record<string /*typeId*/, AsrProviderPreset[]>;
```

**理由**：这些 vendor 本就是同一 OpenAI 兼容协议，差异只在 base URL + 模型；升格为类型会重复 `transcribe`、污染分发。用「类型 ▸ 预设 ▸ 实例」三层，预设是纯 UX 便捷层，后端无感。**代价**：预设值需随各家变动手工维护（可接受；已核实初值）。

### D2 — 仅「协议型且有预设」的类型走下拉，其余不变

**决定**：面板新建入口按类型分流——协议型 + `getAsrPresetsForType(id).length>0` → `DropdownMenu`（各预设 + 「自定义」）；协议型无预设 → 原「添加实例」按钮；品牌型 → D7 的「配置」单例逻辑。「自定义」= 无预设构造（类型默认，等价旧行为）。

**理由**：把预设入口精确限定在「能受益」的场景，不给品牌型/无预设类型引入多余交互。**代价**：面板新增一个下拉分支；复用现有按钮样式，风险低。

### D3 — 实例构造收敛到纯函数 `buildInstanceFromPreset`

**决定**：抽 `buildInstanceFromPreset(type, preset?, idFactory?)`：先铺类型字段默认值，再用预设 `values` 覆盖；无预设即类型默认（name 回落 `type.name`）。面板 `handleAdd` 与 `test:engines` 共用；`idFactory` 便于单测注入确定 id。

**理由**：原 `handleAdd` 内联构造实例，抽出后可单测「预设覆盖 / 自定义回落 / 未填 key 仍未就绪」等分支，契合项目「纯逻辑抽模块单测」惯例。**代价**：无（等价重构）。

### D4 — 初始预设集与取值来源

**决定**：首批三个预设，取值以官方 OpenAI 兼容转写端点为准：

| 预设                 | apiUrl                           | models（默认）                             |
| -------------------- | -------------------------------- | ------------------------------------------ |
| OpenAI               | `https://api.openai.com/v1`      | `whisper-1, gpt-4o-transcribe`             |
| Groq                 | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo, whisper-large-v3` |
| SiliconFlow 硅基流动 | `https://api.siliconflow.cn/v1`  | `FunAudioLLM/SenseVoiceSmall`              |

**理由**：Groq（快/省、支持 `verbose_json` 词级时间戳）与硅基流动（中文强）是最具代表性的两家；OpenAI 作为基准。硅基流动仅返回 `text`（无词/段时间戳）→ 自动走既有静音切片降级路径，属已知可接受表现。**备选（弃）**：Fireworks / 各聚合站——首批先收敛三家，后续按需增补（加一条数据即可）。

## Risks / Trade-offs

- **预设值漂移**（各家改 URL/模型）→ 预设是集中数据，改一处即可；README/文档不硬编码具体值。
- **用户误以为预设含 Key** → `intro` 与字段 `required *` 明确仍需自填 Key；`buildInstanceFromPreset` 不写入任何 key。
- **面板交互回归** → 复用现有卡片/表单/单例逻辑，仅协议型有预设时多一层下拉；`test:engines` 覆盖构造纯函数，手测覆盖下拉新建。

## Migration Plan

- **纯增量，无数据迁移**：不改 `store.asrProviders` 结构；老实例照旧。预设仅影响「新建」路径。
- **回滚**：移除预设数据 + 面板下拉分支即可，`buildInstanceFromPreset` 退化为原内联构造，行为等价。

## Open Questions

- 是否把预设扩展到 Fireworks / Azure OpenAI（需不同 auth/url 形态）？本期先三家，留数据位后续增补。
- 预设是否附「文档链接 / Key 申请地址」提升引导？可作为 `AsrProviderPreset` 后续可选字段。
