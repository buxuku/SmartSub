## 1. 限速器（基础设施）

- [x] 1.1 新建 `main/translate/utils/rateLimiter.ts`：实现按 `providerId` 维度的限速器，支持 `minIntervalMs` 与可选滑动窗口 `windowMs`/`maxInWindow`
- [x] 1.2 导出 `acquire(providerId, cfg)`（必要时 `await` 到允许时刻）与 `withRateLimit(providerId, cfg, fn)` 包装器，并提供 `resolveRateLimitConfig(proof)`
- [x] 1.3 限速器为主进程内存单例，per-key 互斥串行化；窗口满时等待最早记录过期

## 2. Bing 免费源

- [x] 2.1 新建 `main/service/bingFree.ts`，签名 `(query, proof, src, tgt) => Promise<string | string[]>`
- [x] 2.2 实现匿名 token 模块级缓存（含取得时间戳），`GET edge.microsoft.com/translate/auth`
- [x] 2.3 实现批量翻译 `POST api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=<lang>`，body `[{Text}]`，回 `resp[i].translations[0].text`
- [x] 2.4 token 临近过期或遇 401/403 时自动重取一次并重试；请求前调用限速器
- [x] 2.5 校验返回数组与输入等长，不足/异常时抛带 `(network)` 的可重试错误

## 3. Google 免费源

- [x] 3.1 新建 `main/service/googleFree.ts`，签名同上
- [x] 3.2 用 `translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=<lang>&dt=t&q=<text>` 逐条翻译
- [x] 3.3 将 `data[0]` 多句段拼回单条字符串，保证返回数组与输入等长；请求前调用限速器
- [x] 3.4 对空文本短路、异常抛带 `(network)` 的可重试错误，交回退/批级处理

## 4. 语言码映射

- [x] 4.1 `main/helpers/utils.ts`：在 `TranslateProvider` 联合类型加入 `'bing'`
- [x] 4.2 在 `supportedLanguage` 补 `bing` 语言码（简中 `zh-Hans`、挪威语 `nb`、菲律宾语 `fil`），其余默认用 `value`
- [x] 4.3 `googleFree` 复用现有 `google` 映射

## 5. 回退编排与聚合源

- [x] 5.1 新建 `main/translate/services/fallback.ts`，`createFallbackTranslator(chain)` 返回标准 translator 函数
- [x] 5.2 按链顺序依次尝试底层免费源；成功（等长且非全空）即返回，失败/限流切下一源
- [x] 5.3 跳过不可用源（如缺 `apiUrl` 的 deeplx）；仅全部失败才抛带 `(network)` 的错误；每次尝试前过限速器（在各源内部）
- [x] 5.4 直接引用具体免费源避免与 translationProvider 循环依赖；防止 `autoFree` 自引用递归

## 6. 注册与 Provider 定义

- [x] 6.1 `main/service/index.ts` 导出 `bingFreeTranslator`、`googleFreeTranslator`
- [x] 6.2 `main/translate/services/translationProvider.ts` 的 `TRANSLATOR_MAP` 加入 `bingFree`、`googleFree`、`autoFree`（= `createFallbackTranslator(DEFAULT_FREE_FALLBACK_CHAIN)`）
- [x] 6.3 `types/provider.ts` 的 `PROVIDER_TYPES` 新增 `autoFree`、`bingFree`、`googleFree`：`isAi:false`、`group:'free'`、无必填 apiKey 字段，使用 `apiBatchFields(...)`
- [x] 6.4 `autoFree` 增加 `fallbackChain`（默认 `bingFree,googleFree,deeplx`）与 `windowMaxRequests`、`requestInterval`、`batchSize` 字段
- [x] 6.5 免费源缺 Key 不进入 `isConfigurationError`：对外错误统一带 `(network)` 且不含 401/403/unauthorized 字样（核对 `main/translate/utils/error.ts`）

## 7. 文案与图标

- [x] 7.1 `renderer/public/locales/{zh,en}/common.json` 增加 `autoFree`/`bingFree`/`googleFree` 显示名
- [x] 7.2 `renderer/public/locales/{zh,en}/translateControl.json` 增加 `fallbackChain`/`windowMaxRequests` 标签、tips、placeholder 及各 batchSize 说明
- [x] 7.3 图标：采用 emoji（ProviderIcon 在无 iconImg 时回退到 emoji），无需额外图片

## 8. 验证

- [x] 8.1 `tsc --noEmit` 改动文件无新增错误；`node scripts/check-i18n.mjs` 通过（zh/en key parity OK）
- [ ] 8.2 用一小段多语言字幕跑通：`bingFree` 批量、`googleFree` 逐条、`autoFree` 触发回退三条路径（需运行 App 手测）
- [ ] 8.3 断网/造错验证：单源失败能回退、全失败按批降级为 `[翻译失败: ...]` 且任务不崩（需运行 App 手测）
- [ ] 8.4 验证限速：设置间隔后相邻请求间隔达标；返回数组与字幕条数严格对齐（需运行 App 手测）
