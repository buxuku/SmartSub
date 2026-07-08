# Add 讯飞（科大讯飞）录音文件转写 ASR Provider

## Why

云端听写已覆盖国内三大云（豆包/腾讯/阿里）与海外三家，但国内用户基数最大的独立语音厂商**科大讯飞**尚缺位。其「录音文件转写」（LFASR raasr v2）满足本项目两条硬性接入标准：**本地文件流直传**（`audioMode=fileStream`，无需公网 URL / 对象存储，单次最大 500MB / 5 小时）且返回**词级时间戳**（`ws.wb/we`，10ms 帧粒度）。新用户礼包最多 50 小时免费时长，试用门槛低于阿里云（仅商用）。

## What Changes

- 新增内置 ASR 服务商类型 `xfyun`（品牌型硬单例，同豆包/腾讯/阿里）：凭据 `appId` + `secretKey`，签名为 `base64(HmacSHA1(MD5(appId+ts), secretKey))`——比腾讯 TC3 / 阿里 POP 都简单，无需两段取号。
- **首个异步轮询型服务商**：`upload`（文件流直传建单，返回 `orderId` 与 `taskEstimateTime`）→ `getResult` 梯度轮询（状态 0 已创建 / 3 处理中 / 4 完成 / -1 失败）。既有五家均为单次同步调用，本次为 `AsrTranscriber` 内部新增「轮询直至终态」模式（对外接口不变，取消信号在轮询间隙即时生效）。
- **识别语种关联任务原语言**（同腾讯映射模式）：`language` 为请求参数（cn/en/ja/ko/ru/fr/es/vi/ar/de/it + 方言），由任务「原语言」自动映射，`auto`/未匹配回落 `cn`（自动中英模式 `languageType=1`）；小语种需用户在讯飞控制台开通授权（未授权报 26607，给可行动提示）。
- **结果解析**：`orderResult`（双层 JSON 字符串）→ `lattice[].json_1best.st`：句级 `bg/ed`（字符串毫秒）；词级 `rt[].ws[]` 的 `wb/we`（相对句首的 10ms 帧）→ 绝对毫秒 = `bg + wb×10`；`cw[].wp` 属性分流——`n` 正常词、`p` 标点（并入前词，同阿里 punc 处理）、`g` 分段标记（跳过）、`s` 顺滑词。
- **大文件策略反转**：500MB/5h 上限远超既有各家，声明宽松 `audioLimits` 让绝大多数音频**整文件直传、不切片**（异步订单排队场景下切片会放大轮询等待与订单数；时间戳天然全局、零拼接误差）。
- 连接自测：优先验证「零消耗探针」——`getResult` 携假 `orderId`：签名有效应答 `26602`（订单不存在）即凭据 OK，签名/appId 错报 `26600/26601`；不可行则回退 1s 静音 WAV 建单探测（`failType=6` 静音文件视为通过）。以 spike 实测定案。
- i18n（zh/en）、README、Changelog、`test:engines` 单测同步增补。

## Capabilities

### New Capabilities

（无——纳入既有 `cloud-asr-transcription` 能力）

### Modified Capabilities

- `cloud-asr-transcription`: 新增 `xfyun` 服务商类型要求——签名与凭据校验、异步 upload→getResult 轮询生命周期（含取消、轮询频控 26603/26604 退避、72h 结果过期), 词级 10ms 帧时间戳换算与 `wp` 属性分流、语种由任务原语言映射、静音/空音频（26606/failType=6）判空成功、时长不足（26625/26633）给购买指引。

## Impact

- **类型**：`types/asrProvider.ts` 新增 `ASR_XFYUN` 常量与类型定义（`appId`/`secretKey` 必填、models 固定 `['lfasr']`、宽松 `audioLimits`、超时/并发/间隔字段同既有语义）。
- **service**：新增 `main/service/asr/xfyunUtils.ts`（纯函数：signa 生成、upload/getResult query 构造、`orderResult` 解析为 `AsrWord/AsrSegment`、状态/错误码分类、语种映射）与 `main/service/asr/xfyun.ts`（`transcribeWithXfyun`：直传建单 + 梯度轮询 + 取消/退避）；`main/service/asr/index.ts` 注册分发；`main/service/asr/testConnection.ts` 新增 xfyun 探测分支。
- **引擎零改动预期**：`cloudAsrEngine` 经 `resolveAudioLimits` 自动读取宽松上限；成句管线复用 `wordCuesFromResult`。
- **UI 零代码预期**：品牌型单例由 `CloudAsrPanel` 数据驱动渲染；语种映射走 `transcribe` 入参 `sourceLanguage`（同腾讯路径）。
- **i18n/文档/测试**：`renderer/public/locales/{zh,en}/resources.json`、README（zh/en）、`Changelog/v3.2.0-release-note.md`、`scripts/test-engine-units.ts`。
- **依赖**：无新增 npm 依赖（Node `crypto` 自带 MD5/HmacSHA1）。
