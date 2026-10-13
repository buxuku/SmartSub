# Tasks: add-youdao-free-translator

## 1. Decisions and provenance

- [x] 1.1 Confirm OQ1 (default chain order and migration scope: A / B / C) with the maintainer; if the answer is not A, update the `free-translation-fallback` default-chain and migration scenarios and design D9 before touching code. (Confirmed A on 2026-10-13; no artifact changes needed.)
- [x] 1.2 Re-derive the protocol (endpoints, form fields, signature recipe, key derivation, response decryption) from the public fanyi.youdao.com web client scripts and record the source URL and date in the PR description. Do not copy Easydict (GPL-3.0) code, comments, structure or naming. (Done 2026-10-13 from `translation-website/1.0.8` `app.8761b8cd.js` + `textTranslate.b07ee3fe.js`; the findings that changed the design — visitor cookie, `code` 50, decoy responses, new parameter set — are recorded in design "协议复核" and spec "会话凭据建立、完整性自检、缓存与自愈". Constants go only into source code with a provenance comment.)

## 2. Text handling (pure functions)

- [x] 2.1 Add `main/service/youdaoFreeText.ts` with line tokenization (leading/trailing HTML tags, ASS blocks, ♪/♫, dialogue dashes, whole-line brackets) and the skip rule for lines without letters.
- [x] 2.2 Implement tag pairing: drop a leading/trailing tag together with its partner when the partner sits mid-line, keep the source shape for cross-cue unbalanced tags, and always restore positioning blocks such as `{\an8}`.
- [x] 2.3 Implement paragraph building (dialogue lines, bracket lines and lines after sentence-final punctuation stay separate; soft-wrapped continuations merge) and restoration (first-line lead plus last-line trail; merged paragraphs collapse to one line).
- [x] 2.4 Implement the echo-comparison normalization (NFKC, strip whitespace and punctuation) and the Chinese-target post-processing (trailing newline, half-width → full-width punctuation next to Han characters, full-width digits → half-width).

## 3. Translator

- [x] 3.1 Add `main/service/youdaoFree.ts`: session credential establishment (home-page `Set-Cookie` → key material → fixed two-paragraph probe) with in-memory cache (30 min cap) and single-flight, signed request and response decryption using Node `crypto` and `axios`; export `__test__` helpers like `bingFree` (`reset` clears the session and the breaker, `breakerState`, `KEY_GETTER_SECRET`).
- [x] 3.2 Implement the call flow: language mapping and validation before any request, paragraph build, chunking at 5,000 characters, newline-joined POST, echo alignment check, per-paragraph downgrade, aggregate failure and order-preserving reassembly.
- [x] 3.3 Implement response validation (nested `translateResult` shape; flat decoy rejected) and self-healing (`code` 50, decoy, decrypt/parse failure or empty result → rebuild credentials and retry once), plus error classification (`Youdao free translate failed (network): …`; `not supported language` for null mappings and codes 21/40 without credential rebuild or breaker counting).
- [x] 3.4 Call `acquire('youdaoFree:<providerId>', resolveRateLimitConfig(proof), signal)` before every translation request, apply a dedicated 15 s timeout and propagate the abort signal.
- [x] 3.5 Implement the module-level circuit breaker (3 consecutive request-level failures → 120 s cooldown → single probe) and export `getYoudaoFreeAvailability()`.
- [x] 3.6 Log only the source id, counts, HTTP status, downgrades, credential rebuilds, decoy rejections, probe results and breaker transitions; never subtitle text, translations, the visitor cookie, keys or signatures.

## 4. Language support

- [x] 4.1 Add `'youdao'` to `TranslateProvider` and a `youdao` column to `supportedLanguage` in `main/helpers/utils.ts` (`zh-CHS`, `zh-CHT`, explicit `null` for unsupported languages).
- [x] 4.2 Probe every `supportedLanguage` entry against the live endpoint once per direction (to and from Simplified Chinese or English, `auto` source; about 100 requests, stop at the first throttle signal), set failures to `null` and record the table in design D6. (Done 2026-10-13: 100 requests, no throttle signal; 17 languages kept, 33 mapped to `null`.)

## 5. Provider registration and migration

- [x] 5.1 Export `youdaoFreeTranslator` from `main/service/index.ts` and register `youdaoFree` in `TRANSLATOR_MAP`.
- [x] 5.2 Add the `youdaoFree` entry to `PROVIDER_TYPES` in `types/provider.ts` (`group: 'free'`, no credentials, batch 30 / concurrency 2 / interval 0.2 / window 0) and extend `apiBatchFields` with an optional concurrency default.
- [x] 5.3 Update `DEFAULT_FREE_FALLBACK_CHAIN`, the `autoFree.fallbackChain` default and `phFallbackChain` to the confirmed order; leave the `autoFree` batch, concurrency and interval defaults unchanged.
- [x] 5.4 Bump `CURRENT_PROVIDER_VERSION` to 26 with a version comment, add `youdaoFree` to `FREE_PROVIDER_IDS`, and migrate `autoFree.fallbackChain` only when it equals the legacy default (whitespace-insensitive).

## 6. autoFree integration and UI

- [x] 6.1 Add `youdaoFree` to `SOURCE_MAP` in `main/translate/services/fallback.ts` and make `isSourceUnavailable` skip it while the breaker is cooling down.
- [x] 6.2 Add `youdaoFree` to `FREE_CHAIN_SOURCES` in `renderer/components/ProviderForm.tsx`, with a jest test (`renderer/components/__tests__/ProviderFormChain.test.tsx`) that the chain editor offers, adds, moves and removes it and lists it first by default.
- [x] 6.3 Add the zh and en strings `provider.youdaoFree`, `chainSource.youdaoFree` and `batchSizeYoudaoFreeTips`, and refresh `batchSizeAutoFreeTips` and `fallbackChainTips`.
- [x] 6.4 Show `youdaoFree` with the Youdao brand icon like the other providers (OQ2 was resolved on 2026-10-13; it started as an emoji placeholder): add `renderer/public/images/providers/youdao.png`, set `iconImg` in `types/provider.ts`, and check in `scripts/test-provider-fallback.ts` that every provider type's icon file exists.

## 7. Tests

- [x] 7.1 Add `scripts/test-youdao-free.cjs` (same mock-`axios` and TypeScript-transpile setup as `test-free-translators.cjs`) and chain it into `test:free-translators`: protocol vectors (a self-encrypted fixture built from fake key material, with both the valid nested and the flat decoy shape), session credentials (cache/TTL/single-flight, cookie pass-through, no cookie fabricated, probe pass / decoy / mismatch, `code` 50 and decoy rebuild-and-retry, failure after rebuild), and batching with alignment (match, count mismatch, echo mismatch, per-paragraph failure, 5,000-character chunking, full-width echo).
- [x] 7.2 Add protection and restoration tests mirroring the design D4 table plus tag pairing, hard-break merge, bracket lines and the all-lines-skipped zero-request case; add Chinese post-processing and language mapping tests (a `null` mapping sends no request; codes 21/40).
- [x] 7.3 Add tests for rate-limit spacing, timeout, cancellation, error classification and the circuit breaker (fake clock for the 120 s cooldown), plus a log-privacy test (no subtitle text, translations, cookie, key material or signature).
- [x] 7.4 Extend `scripts/test-provider-fallback.ts` for the provider definition and migration (legacy default updated, custom chain kept, free sources stable on a second run, performance fields untouched, `youdaoFree` backfilled), and add the chain integration tests (registry, default order, cooldown skip, unsupported-language routing, aggregated error) to `scripts/test-youdao-free.cjs`, where the real `fallback.ts` and provider registry run behind fake sibling sources and the fake Youdao service.
- [x] 7.5 Make sure no CI test touches the network (checked by running the script tests and the new jest test behind a guard that fails the process on any non-loopback connection, DNS lookup or `fetch`), then run `yarn check:i18n`, `yarn typecheck`, `yarn test:free-translators`, `yarn test:provider-fallback`, `yarn test:provider-test-flow`, `yarn test:task-defaults` and `yarn test:renderer`.

## 8. Documentation

- [x] 8.1 Update `docs/docs/guides/translation/free.md` (Youdao row, default chain order, unofficial-interface disclosure, alternatives, footer date) and the free-start path in `overview.md`.
- [x] 8.2 Update `docs/docs/features/subtitle-translation.md`, `docs/docs/intro/introduction.md` (its free-route table repeated the "Bing / Google" wording) and the zh/en/ja READMEs to mention Youdao next to Bing and Google without changing the provider counts.
- [ ] 8.3 Add the release note following the project's changelog process. Deferred until the release version is chosen: `Changelog/<tag>-release-note.md` carries the version in its title and download links, and `docs/docs/changelog.md` is updated per release, so no file is created on this branch. Draft for the maintainer to paste under `## feat` and `## fix` (the repository's format: a Chinese bullet with an indented English line, PR numbers added once a PR exists):

  ```text
  ## feat

  - 新增有道免费翻译源，并作为「自动免费翻译」的首选：整批一次请求，速度明显快于逐条请求的必应与谷歌；失效时自动回退到必应、谷歌，连续失败会暂停使用约 2 分钟。有道为非官方网页接口，不承诺可用性
     Add Youdao as a free translation source and make it the first choice of Auto Free: one request per batch, much faster than Bing and Google, which translate line by line. It falls back to Bing and Google automatically and pauses itself for about 2 minutes after repeated failures. Youdao is an unofficial web endpoint with no availability guarantee
  - 升级后，未自定义的「自动免费翻译」默认回退链会调整为「有道 → 必应 → 谷歌 → DeepLX」，自定义过的回退链保持不变
     After upgrading, an untouched Auto Free default chain becomes "Youdao → Bing → Google → DeepLX"; customized chains are kept as they are

  ## fix

  - 修正免费翻译服务的批量大小提示：必应免费接口为逐条翻译，批量值仅影响进度粒度
     Fix the batch-size tips of the free translation services: the Bing free endpoint translates one line at a time, so the batch size only affects progress granularity
  ```

  Also refresh the screenshot `/img/v3/translation/auto-free.webp` (it still shows the old chain) when the release is cut.

## 9. Verification

- [x] 9.1 Manual live smoke test (at most 200 requests in total, no credentials persisted): the provider test button for `youdaoFree`, then a 50-line sample SRT through `youdaoFree` and through the default `autoFree`, checking alignment, tags and the log lines.
- [x] 9.2 Failure drill: block `dict.youdao.com` and confirm fallback to Bing, breaker entry and exit logs and no per-batch warning spam; run a Turkish-source sample and confirm it routes to Bing.
- [x] 9.3 Confirm the logs and the persisted store contain no subtitle text, key material or signatures; run the CI-equivalent checks (`yarn build`, docs `yarn build`) and `openspec validate add-youdao-free-translator`.
