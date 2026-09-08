# docs-provider-guides Specification

## Purpose

文档站服务商配置指南体系：转写引擎 / 云端听写 / 翻译服务 / 配音服务四大类，每服务商独立成页、统一内容模板（元信息卡 → 场景费用 → 申请步骤 → 应用内配置 → 参数说明 → 常见报错）、各类选型总览页与稳定性风险如实披露。应用内新增服务商时需同步新增对应指南页。

## Requirements

### Requirement: 每个服务商拥有独立配置指南页

配置指南 SHALL 为以下每个服务商/引擎提供独立文档页：转写引擎 7 类（whisper.cpp、faster-whisper、FunASR、Qwen3-ASR、FireRedASR、本地 Whisper CLI、云端听写总览）、云端听写服务商 9 家（OpenAI 兼容、ElevenLabs Scribe、Deepgram、火山引擎豆包、腾讯云、阿里云、讯飞、Gladia、Xiaomi MiMo）、翻译服务商（对照 `types/provider.ts` 的全部内置服务商，含内置免费翻译、百度、阿里云、腾讯、讯飞、火山、豆包、小牛、DeepLX、Azure、Google、Ollama、DeepSeek、Gemini、通义千问、SiliconFlow、Azure OpenAI、DeerAPI 及 OpenAI 兼容模板）、配音服务（本地 Kokoro/VITS/ZipVoice 与云端 Edge TTS、OpenAI 兼容、Azure Speech、火山引擎豆包、ElevenLabs、Xiaomi MiMo）。

#### Scenario: 服务商页可直达

- **WHEN** 用户在侧边栏展开「配置指南」下的转写引擎/翻译服务/配音服务分类
- **THEN** 每个服务商显示为独立可点击条目，进入后为该服务商专属页面

#### Scenario: 覆盖面与代码一致

- **WHEN** 对照 `types/provider.ts` 的服务商清单与配置指南页面清单
- **THEN** 应用内每个内置服务商都有对应文档页，无遗漏

### Requirement: 服务商页遵循统一内容模板

每个服务商页 SHALL 按统一结构编写：元信息卡（官网、凭据类型、免费额度、计费方式、推荐场景）→ 适用场景与费用 → 申请步骤 → 在妙幕中配置（含应用内截图）→ 参数说明 → 常见问题与报错，并在页脚标注信息更新时间与官方文档链接。参数说明中的字段名 MUST 与应用内配置表单一致。

#### Scenario: 小白按页配通服务

- **WHEN** 无经验用户按某服务商页的申请步骤与配置章节逐步操作
- **THEN** 可从零注册、获取凭据并在应用内完成配置（涉及付费开通的页面明确标注费用前提）

#### Scenario: 字段名与应用一致

- **WHEN** 对照服务商页参数说明与应用内该服务商的配置表单
- **THEN** 字段名称、必填项一致

#### Scenario: 时效性标注

- **WHEN** 用户浏览任一服务商页页脚
- **THEN** 可见「信息更新于 YYYY-MM」及官方文档链接

### Requirement: 每类配置指南提供选型总览页

转写引擎、云端听写、翻译服务、配音服务四类 SHALL 各有一个选型总览页，包含对比表（免费额度、是否需要 GPU/联网、中文表现、计费方式等维度）与按需求的推荐路径（如「完全免费」「无显卡」「中文最佳」），并链接到各服务商页。

#### Scenario: 按需求快速选型

- **WHEN** 用户访问「翻译服务选型」总览页
- **THEN** 可见 20 个服务商的对比表与免费/付费推荐路径，点击任一服务商跳转其配置页

### Requirement: 风险与稳定性如实披露

对稳定性受限的服务（如 Edge TTS 逆向接口、DeepLX），对应页面 SHALL 标注「试用档/不承诺可用性」并给出替代建议；云端听写类页面 MUST 说明音频会上传至用户配置的端点。

#### Scenario: Edge TTS 页风险提示

- **WHEN** 用户访问 Edge TTS 配置页
- **THEN** 页面明示其为免费试用性质、不承诺可用性，并推荐断供时的替代引擎
