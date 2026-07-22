# Tasks: add-downloader-cookie-import

## 1. 类型与纯函数

- [x] 1.1 `types/download.ts`：新增 `CookieProfile` 类型、`COOKIE_SITE_PRESETS` 预设表（bilibili/youtube 的 matchDomains、cookieDomains、关键 cookie 名）、`matchCookieProfile(url, profiles)` 后缀域匹配纯函数（复用 hostMatches 思路，含 b23.tv/youtu.be 别名）
- [x] 1.2 `main/helpers/videoDownload/cookies.ts`：Netscape 纯函数——解析（行→结构，容忍注释/空行/HttpOnly\_ 前缀）、按 cookieDomains 过滤、原始 Cookie 串合成 Netscape 行（`.主域`/expiry=0）、档案状态计算（cookie 条数、关键 cookie 或最早过期时间、是否已过期）

## 2. 档案存储与导入（main）

- [x] 2.1 `main/helpers/videoDownload/cookieProfileStore.ts`：档案元数据 CRUD（electron-store `videoDownloadCookieProfiles`）+ 内容落盘 `userData/downloader-cookies/{profileId}.cookies`（目录名避开与 Electron `userData/Cookies` 撞路径；safeStorage 可用即加密、否则明文，`encrypted` 标记入元数据）；读取侧解密失败落「需重新导入」态不抛出；删除档案同时清文件与元数据
- [x] 2.2 实现文件导入与粘贴导入：读入 → Netscape 解析（粘贴走合成）→ 域过滤 → 落盘；过滤后为空视为导入失败并报明确原因
- [x] 2.3 实现浏览器提取导入：spawn `yt-dlp --cookies-from-browser <browser> --cookies <临时输出> --skip-download http://127.0.0.1:0/`（走 buildChildEnv），以「输出文件存在且含目标域行」为成功判据（不看退出码），成功后过滤落盘、finally 删除中间文件；yt-dlp 未安装时前置报错；失败错误引导改用文件导入
- [x] 2.4 在 macOS 实测验证 2.3 的 dummy URL 行为：确认 dummy URL 必然失败退出（Firefox exit=1 / Chrome 502），但 cookie jar 在退出前已写出文件（Chrome 授权钥匙串后 `Extracted 2404 cookies` 写出 2407 行）；Firefox 缺库→不写文件→按失败处理正确

## 3. 子进程注入链路（main）

- [x] 3.1 `engineAdapter.ts`：`PreflightOptions`/`DownloadJobOptions` 增加可选 `cookieFilePath`；新增 `createCookieTempFile`/`cleanupCookieTempFile` 原语 + `withCookieFile(url, fn)` 封装——匹配档案 → 解密写 OS 临时目录唯一副本（`smartsub-cookies-{uuid}.txt`）→ 用完删除；未命中传 undefined
- [x] 3.2 `ytDlpAdapter.ts`：preflight 与 download 在 `cookieFilePath` 存在时追加 `--cookies <path>`
- [x] 3.3 `luxAdapter.ts`：preflight 与 download 在 `cookieFilePath` 存在时追加 `-c <path>`
- [x] 3.4 `scheduler.ts` `runEntry`（create/cleanup 包住多引擎回退循环）与 `ipcVideoDownloadHandlers.ts` `preflightOne`（withCookieFile 包住引擎循环）统一注入

## 4. 失效提示（main）

- [x] 4.1 `parsers.ts`：新增 `isLikelyAuthError`（403/login/members only/premium/大会员/sign in 等关键词），补关键词时避免与 `isLikelyOutdatedEngineError` 误重叠
- [x] 4.2 `scheduler.ts`：条目失败且本次执行附带了 cookie（`hadCookie`）且命中鉴权特征 → 错误加 `MAYBE_COOKIE_EXPIRED::` 前缀；与 `MAYBE_OUTDATED::` 同时命中时 cookie 前缀优先

## 5. IPC 与渲染层

- [x] 5.1 `ipcVideoDownloadHandlers.ts`：新增 `videoDownload:cookieProfiles:{list,importFile,importPaste,importFromBrowser,delete}` 通道组，文件导入配 `dialog.showOpenDialog` 文件选择
- [x] 5.2 `renderer/components/download/CookieProfilesDialog.tsx`：预设 + 自定义域名档案列表；每档案状态行（来源/导入时间/过期状态/需重新导入态）、三种导入入口（浏览器下拉按平台标注兼容性，youtube 档案附风控提示）、删除
- [x] 5.3 `DownloadPanel.tsx`：配置区新增「站点 Cookie」入口按钮（带已配置档案数徽标）；条目错误处理 `MAYBE_COOKIE_EXPIRED::` 前缀 → 「重新导入 Cookie」动作按 URL 匹配档案并打开对话框聚焦（复用 MAYBE_OUTDATED 动作条模式）
- [x] 5.4 `renderer/public/locales/{zh,en}/download.json`：`cookie.*` 档案管理、导入方式、兼容性标注、风控提示、失效引导文案（check:i18n 通过）

## 6. 测试与验证

- [x] 6.1 `scripts/test-video-download.ts` 增补：`matchCookieProfile`（预设域/别名/自定义/未命中/configured:false）、Netscape 解析与域过滤、原始串合成、状态计算（过期判定）、`isLikelyAuthError` 与前缀优先级（组合信息）
- [x] 6.2 `yarn test:video-download` 78 passed / 0 failed；renderer 与 root `tsc --noEmit` 对本变更文件零报错（预存 jest/alias 报错与本变更无关）
- [ ] 6.3 手动验证矩阵（需真实 B 站登录态 + 联网，留待用户）：B 站已登录 cookie 下载出 1080P+（对照匿名 480P）；b23.tv 短链手动指定 lux 走 `-c` 且重定向后带登录态；同档案两条目并发主档案无损；删除档案后回匿名行为；预检清晰度反映登录态。已机验：yt-dlp `--cookies` 吃 Netscape、lux `-c` flag 存在、浏览器提取 dummy URL 行为（见 2.4）
- [x] 6.4 代码内 `LUX_PREFERRED_DOMAINS` 注释已补「配置 cookie 后 lux 亦可高清、yt-dlp 优先不变」依据；`openspec/specs` 正式合并留待归档
