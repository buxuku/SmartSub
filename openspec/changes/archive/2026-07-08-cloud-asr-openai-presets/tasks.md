> 实现顺序：先纯数据 + 纯函数（可单测），再面板下拉，最后文案与校验。
> 非破坏红线：`main/service/asr/*`、`ASR_TRANSCRIBER_MAP`、任务页下拉、`store.asrProviders` 结构一律不动；预设只改字段值、`type` 恒为 `openaiCompatible`。

## 1. 类型与纯函数（地基）

- [x] 1.1 `types/asrProvider.ts` 新增 `AsrProviderPreset` 接口与 `ASR_PROVIDER_PRESETS`（键=类型 id）；OpenAI 兼容内置 `openai / groq / siliconflow` 三预设（base URL + 模型，取值已核实）
- [x] 1.2 新增 `getAsrPresetsForType(typeId)`（无则 `[]`）与 `buildInstanceFromPreset(type, preset?, idFactory?)`（类型默认铺底 + 预设覆盖；无预设=自定义）

## 2. 面板：协议型「添加实例」预设下拉

- [x] 2.1 `CloudAsrPanel` 计算 `presets = getAsrPresetsForType(type.id)`；协议型 + 有预设时把「添加实例」按钮改为 `DropdownMenu`（各预设项 + 分隔线 + 「自定义」）
- [x] 2.2 `handleAdd(typeId, presetId?)` 经 `buildInstanceFromPreset` 统一构造；选预设按预设值预填、选「自定义」按类型默认；协议型无预设 / 品牌型单例逻辑不变
- [x] 2.3 引入 `DropdownMenu*` 与 `ChevronDown`；复用现有按钮样式与选中/持久化逻辑

## 3. i18n

- [x] 3.1 `renderer/public/locales/{zh,en}/resources.json` 新增 `cloudAsr.customPreset`（自定义 / Custom）
- [x] 3.2 `cloudAsr.intro` 点名预设（OpenAI / Groq / 硅基流动）
- [x] 3.3 `npm run check:i18n` 通过（zh/en 对齐）

## 4. 测试与回归

- [x] 4.1 `scripts/test-engine-units.ts` 新增：`multiInstance` 标记（协议型 true / 品牌型 false）、`getAsrPresetsForType`（清单/空/未知/undefined）、`buildInstanceFromPreset`（预设覆盖 / 自定义回落 / 未填 key 未就绪）
- [x] 4.2 `npm run test:engines` 通过
- [x] 4.3 `ReadLints` 改动文件零告警
- [ ] 4.4 手测：OpenAI 兼容分区「添加实例 ▾」列出 OpenAI/Groq/硅基流动/自定义；选 Groq 后 base URL 与模型已预填、仅需填 Key；品牌型仍为「配置」单例
