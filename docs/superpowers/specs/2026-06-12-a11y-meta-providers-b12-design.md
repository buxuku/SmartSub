# 批次 12 设计：可达性兜底、任务行元信息与服务商分组导购

对应报告条目：4.3 键盘可达性（focus-visible 兜底）、P1#36 任务行元信息/ETA、P1#30 服务商分组推荐与测试语向（9.4 线框）、P2 6.5.10 自定义服务术语口语化。

用户已确认方案（回复 A，范围 A）。

## 探索结论（修正两处原判断）

1. P1#19 模型推荐双信源**已单一化**：`getRecommendedCategory`（lib/utils）是唯一信源，OverviewTab / Onboarding / ModelsTab Hero 与档位徽章均引用之。本批次无需改动。
2. 阶段链当前态强调**已存在**（loading=primary+spinner、done=success、error=destructive）。P1#36 剩余部分仅为元信息与 ETA。
3. hover-only 控件 3 处：`TaskRowList` 删除 X（有 aria-label）、`home.tsx` 最近任务重命名/删除（有 aria-label）、`ProvidersTab` 自定义服务商删除（span 非 button、无 aria-label）。
4. `wrapFileObject`（main/helpers/fileUtils）不含 size/duration；`extractAudio` 的 ffmpeg `codecData` 回调已拿到媒体总时长但未持久化；`taskFileChange` 在 taskManager 中 Object.assign 进 project.files 并 scheduleWrite，新字段可自动持久化。
5. `PROVIDER_TYPES` 已有 `isAi` 字段；ProvidersTab 左列分「内置/自定义」两段平铺；测试翻译写死 en→zh，结果仅 5 秒 toast。

## 设计决策

### T1 可达性兜底

- 3 处 hover-only 控件类名追加 `focus-visible:opacity-100`（保持 hover 行为不变）；TaskRowList 的 disabled 态维持不可见。
- ProvidersTab 自定义服务商删除：span 改 button、加 `aria-label`（删除 + 服务商名）、加 focus-visible ring。
- 任务行「校对」「打开文件夹」图标按钮补 `aria-label`（取既有 tooltip 文案）。

### T2 任务行元信息 + ETA

- `wrapFileObject` 增 `fileSize`（`fs.statSync().size`，失败置 0）；行内文件名后灰字显示格式化大小（B/KB/MB/GB，1 位小数）；无字段（历史工程）或 0 不显示。
- `extractAudio` 的 `codecData` 回调将时长写入 `file.duration`（秒），随既有 `taskFileChange`（extractAudio done）持久化；行内在大小后显示 `mm:ss` / `h:mm:ss`，无值不显示。字幕输入任务无此字段。
- ETA：仅渲染层。`TaskRowList` 用 ref 记录 `uuid:stageKey` 首次观察到 loading 的时间与首见进度，按 `(now-start)/(p-p0)*(100-p)` 估算剩余；`p-p0 >= 5` 才显示，文案「剩约 X 分 / 不足 1 分」，置于百分比旁，阶段切换或终态即清除。不追求精确，明示「约」。

### T3 服务商分组导购 + 测试修缮（9.4 线框）

- `ProviderType` 增可选 `group: 'free' | 'ai' | 'mt'`：free=deeplx/ollama/google；ai=isAi 七个；mt=其余。左列按 免费起步 → AI 翻译 → 传统机翻 → 自定义 分段渲染（替换原「内置服务商」单段）。
- 左列顶部「不知道选哪个？」推荐卡：两行（免费起步 DeepLX·谷歌；质量优先 DeepSeek·Gemini），名字可点击直接选中对应服务商。
- 左列搜索框：按显示名 includes 过滤（不分大小写），过滤时分组标题仍显示（空组隐藏）。
- 测试翻译：语向取 `getUserConfig` 的 sourceLanguage/targetLanguage（缺省回退 en→zh）；测试文本按源语言取样本（zh→'你好'，否则 'Hello'）。
- 测试结果常驻卡：表单 Card 下方新增结果区（会话内存，不持久化）：成功=success 边框（语向、译文、耗时、模型），失败=destructive 边框（错误信息）；测试中按钮 loading。保留简短 toast。
- 「添加自定义 OpenAI 服务」改「自定义 AI 服务（OpenAI 兼容）」（translateControl.json zh/en）。

### T4 i18n + 门禁 + 交接

- 新增 key：tasks.json（meta.eta 等）、translateControl.json（分组标题、推荐卡、搜索、测试结果区）。
- `yarn check:i18n` 通过；renderer TSC 0（非测试）；main TSC ≤95 基线；每 task 一 commit；interactive_feedback 交接附实机验证清单。

## 错误处理

- stat 失败 fileSize=0（不显示）；codecData 缺失 duration 不写；ETA 对 0 进度/停滞（速率≤0）不显示。
- 测试翻译失败走常驻卡 destructive 态 + toast.error，不抛未捕获异常。

## 测试与验证

- 门禁三项（i18n/renderer/main）。
- 实机：键盘 Tab 可见三处兜底控件；任务行出现大小与时长；转写中出现「剩约」；服务商左列三组+推荐卡+搜索；测试翻译语向跟随任务配置且结果常驻。
