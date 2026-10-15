# Tasks: add-google-chrome-client-lane

## 1. Decisions and provenance

- [x] 1.1 Confirm the scope (two lanes inside `googleFree`, option B) and the lane order (chrome first) with the maintainer. (Confirmed 2026-10-15; recorded in design OQ1 and OQ2.)
- [x] 1.2 Before coding, re-probe the chrome lane live with a handful of requests (one canary per client, a 5-line batch with both `sl` forms, a request near the 6,000-byte budget) and note the date in the PR description. Write the implementation from the facts in design "证据"; do not read or copy third-party implementation code. (Done 2026-10-15, 9 requests: gtx canary 429 + Sorry page; chrome canary 200; 5-line batch 200 in both `sl` forms, aligned; a single `q` with `sl=auto` returns `[["译文","en"]]`, the same pair shape as a batch; 14 `q` / 4,017 B and 20 `q` / 5,727 B both 200 and aligned.)

## 2. Protocol module (pure functions)

- [x] 2.1 Add `main/service/googleFreeProtocol.ts` with `buildChromeQuery`: a hand-built query string with a repeated `q` (never `q[]`), percent-encoded text and per-line truncation to 5,000 characters.
- [x] 2.2 Add chunk planning: at most 50 `q` and 6,000 encoded bytes per request (counting `client`, `sl` and `tl`), an oversize single line alone in its chunk, blank lines left out of the request and restored by position.
- [x] 2.3 Add response parsing for both shapes (string items and `[text, language]` items) that validates the count, the item shape and the all-empty case, and returns a typed protocol failure instead of partial results.
- [x] 2.4 Add abuse-page classification: 429 or 403 plus `unusual traffic`, `automated queries` or `/sorry/` (case-insensitive; string or already-parsed object bodies); everything else is an ordinary failure.

## 3. Translator

- [x] 3.1 Refactor `main/service/googleFree.ts` to run each chunk through a lane selector: chrome first, gtx per chunk as the fallback. The gtx lane keeps today's request, 5,000-character truncation and 60 s timeout. Call `axios.get(url, config)` with the query already in the URL so the mock-`axios` tests see the exact request.
- [x] 3.2 Add the per-lane health state: blocked backoff 10 → 20 → 40 → 60 min (cap), 3 consecutive other failures → 120 s, one probe after the cooldown, success clears, cancellation and unsupported language excluded, probe flag released in `finally`; take time from `Date.now()`.
- [x] 3.3 Call `acquire('googleFree:<providerId>', resolveRateLimitConfig(proof), signal)` before every HTTP request on both lanes (including probes and switched resends), give the chrome lane its own 15 s timeout and pass the abort signal through.
- [x] 3.4 When both lanes are unavailable send nothing and throw `Google free translate failed (network): temporarily unavailable (both lanes cooling down, retry in N s)`; export `getGoogleFreeAvailability()` with the same shape as `getYoudaoFreeAvailability()`.
- [x] 3.5 Keep every runtime error prefixed with `Google free translate failed (network): `, throw `not supported language` only before any request, and never put subtitle text or response bodies into an error message.
- [x] 3.6 Log only the lane id, status class, cooldown seconds, recovery and counts, one line per state change (cooldown entry as warning, recovery as info); never URLs, text, translations or bodies. Export `__test__` helpers (`reset`, `laneState`) like `youdaoFree`.

## 4. autoFree integration

- [x] 4.1 In `main/translate/services/fallback.ts`, make `isSourceUnavailable('googleFree')` skip the source while `getGoogleFreeAvailability()` reports it unavailable (info log, `cooling down (retry in N s)`), the same way `youdaoFree` is skipped.

## 5. UI copy and documentation

- [x] 5.1 Update the zh and en strings `batchSizeGoogleFreeTips` (batch lane first, per-line fallback when limited), `batchSizeAutoFreeTips` (Youdao and Google can batch, Bing translates line by line) and `fallbackChainTips` (Google is skipped for a while when both lanes are limited); run `yarn check:i18n`.
- [x] 5.2 Update `docs/docs/guides/translation/free.md`: the Google rows (batch lane first, per-line fallback, the request interval applies per request), the unofficial-interface disclosure for both lanes and the footer date. (Done 2026-10-15; the footer already reads 2026-10, so the date needed no change.)
- [ ] 5.3 Add the release note following the project's changelog process. Deferred until the release version is chosen: `Changelog/<tag>-release-note.md` carries the version in its title and download links, and `docs/docs/changelog.md` is updated per release, so no file is created on this branch. Draft for the maintainer to paste under `## feat` (the repository's format: a Chinese bullet with an indented English line, PR numbers added once a PR exists):

  ```text
  ## feat

  - 谷歌免费翻译新增整批通道：一次请求翻译多条字幕；原有的逐条通道被谷歌限流（429）时自动切换，约 10 分钟后再试。两条通道都是非官方接口，不承诺可用性
     Add a batch lane to the Google free translator: one request translates several subtitle lines, and it switches automatically when the original per-line lane is rate limited by Google (HTTP 429), trying that lane again after about 10 minutes. Both lanes are unofficial endpoints with no availability guarantee
  ```

## 6. Tests

- [x] 6.1 Add `scripts/test-google-free.cjs` (same mock-`axios` and TypeScript-transpile setup as `test-free-translators.cjs`) and chain it into `test:free-translators` in `package.json`. First cover the pure functions: the query string (repeated `q`, no `q[]`, encoding of `&`, `#`, `+`, `%`, newline and emoji), chunking (50 lines, 6,000 bytes, oversize single line, blank positions), parsing (both shapes and every malformed shape) and abuse classification.
- [x] 6.2 Add translator tests: chrome-only success with zero gtx requests; chrome blocked → gtx, with later chunks skipping chrome; the reverse direction (gtx blocked, chrome healthy); mixed lanes inside one call with the order preserved; count mismatch, bad shape and all-empty → gtx; the `sl=auto` shape; blank-line restoration; both lanes failing; both lanes cooling → zero requests.
- [x] 6.3 Add health tests with a fake clock (stub `Date.now`): 10/20/40/60/60-minute backoff, 3 strikes → 120 s, a single probe with concurrent callers, success reset, cancellation not counted and the probe flag released, a plain 429/403 without a marker, and the `getGoogleFreeAvailability()` values.
- [x] 6.4 Add tests for the shared rate-limit key, the 15 s chrome timeout, cancellation, error classification (`(network)` prefix, `isConfigurationError` false, `not supported language` with zero requests) and log privacy (no subtitle text, URL, translation or body in logs or errors).
- [x] 6.5 Add chain integration tests with the real `fallback.ts` and fake sibling sources: `googleFree` is skipped while both lanes cool down and is used again after recovery. (Done 2026-10-15: `scripts/test-google-free.cjs` has 65 tests, all green; 31 hand-made mutations of `googleFree.ts` and `fallback.ts` were all caught.)
- [x] 6.6 Make sure no CI test touches the network (run the script tests behind a guard that fails the process on any non-loopback connection, DNS lookup or `fetch`), then run `yarn check:i18n`, `yarn typecheck`, `yarn test:free-translators`, `yarn test:provider-fallback`, `yarn test:provider-test-flow`, `yarn test:task-defaults` and `yarn test:renderer`. (Done 2026-10-15: the guarded run of `test:free-translators`, `test:provider-fallback`, `test:provider-test-flow`, `test:task-defaults`, `test:translation-cancel`, `test:translation-proxy`, `test:provider-health` and `test:untranslated-flow` exited 0 with zero guard violations, and the guard itself was proven by a self-test that forces exit code 99 on a public lookup; `check:i18n`, `typecheck` and `test:renderer` (81 suites, 795 tests) pass; `scripts/test-google-free.cjs` also carries its own in-process guard.)

## 7. Verification

- [ ] 7.1 Manual live smoke (at most 100 requests, stop at the first 429): the provider test button for `googleFree`, then a 50-line sample SRT through `googleFree` and through `autoFree` with the chain reduced to `googleFree`, checking alignment, tags and the log lines.
- [ ] 7.2 Failure drill: point `translate.googleapis.com` at a closed local port (hosts entry) to take both lanes down, and confirm three failures per lane, one cooldown-entry log per lane, no per-batch warning spam, an info-level skip of Google in `autoFree`, and recovery after the entry is removed and the cooldown has passed. A chrome-only block cannot be reproduced live because both lanes share the host; it is covered by the fake-service tests in 6.2 and by 7.3.
- [ ] 7.3 On a network where `client=gtx` is not blocked (the development egress IP was blocked on 2026-10-13, 10-14 and 10-15), run the gtx lane and the chrome → gtx failover live, and compare a sample of gtx and chrome translations. If no such network is available, record it as a known gap in the PR description.
- [ ] 7.4 Confirm the logs and the persisted store contain no subtitle text or URLs; run the CI-equivalent checks (`yarn build`, docs `yarn build`) and `openspec validate add-google-chrome-client-lane --strict`.
