# Tasks: link-cloud-cloned-voices

- [x] 1.1 utils：`mapElevenClonedVoices`（voices[] → {id,name}，`category==='cloned'` 过滤）+ 单测
- [x] 1.2 service：`listElevenClonedVoices(provider)`（GET /v1/voices，401 权限定向文案）
- [x] 1.3 IPC：`voiceClone:listCloudVoices`（EL 清单 + 本地已存在标记）；`voiceClone:linkCloudVoice`（EL 直接 ready / 火山先 status 校验，入库 + best-effort 样本）；`voiceClone:remove` 增 `removeCloud`（EL 默认不删云端）
- [x] 1.4 UI：「我的音色」组「从平台取回」入口 + `LinkCloudVoiceDialog`（EL 列表点选 / 火山 S\_ id 输入校验 + 命名 + 语言）
- [x] 1.5 `ClonedVoicePanel` 删除对话框 EL 分支「同时删除云端音色」勾选（默认关）
- [x] 1.6 i18n（zh/en）+ 回归：test:voice-clone 159 ✓ / check:i18n ✓ / build ✓；真机（EL 列表拉取、火山 S\_ 接回）待用户验证
