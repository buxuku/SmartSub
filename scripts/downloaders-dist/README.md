# 下载器分发管线（外部仓）

在线视频下载功能的 yt-dlp / lux 二进制分发管线**维护在独立仓库**
[buxuku/smartsub-downloaders](https://github.com/buxuku/smartsub-downloaders)
（`.github/workflows/build.yml` + `build-manifest.mjs`），CI 每周一自动发布
`latest` rolling release，站点适配失效时可手动 `workflow_dispatch` 触发推新。

主仓不再保留管线文件副本，但存在以下**跨仓契约**，改动任意一侧时需同步检查：

| 契约点    | 分发仓侧                                                           | 主仓侧                                                                         |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 清单结构  | `build-manifest.mjs` 输出 `downloader-versions.json`               | `types/download.ts` 的 `DownloaderVersionsManifest`                            |
| 平台键    | 资产命名 `{engine}-{platform}-{arch}`（macOS 为 universal 单资产） | `downloaderManager.ts` 的 `getPlatformKey()`                                   |
| 仓库 slug | release 所在仓                                                     | `downloaderManager.ts` 的 `DOWNLOADER_REPO_SLUGS`                              |
| 资产清单  | release 上传的文件名集合                                           | `sync-gitcode.sh --target downloaders` 的 `FILES` 数组（GitCode 镜像同步校验） |

国内镜像同步：在国内机器上 `GITCODE_TOKEN=<token> npm run sync:downloaders`
（GitHub → GitCode buxuku1/smartsub-downloaders）。
