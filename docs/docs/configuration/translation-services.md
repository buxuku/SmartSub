---
sidebar_position: 2
title: 翻译服务配置
---

# 翻译服务配置

妙幕（SmartSub）支持多种翻译服务，可以将字幕翻译成不同语言。本章节将详细介绍如何配置和使用各种翻译服务。

## 翻译服务设置界面

<div className="img-container">
  <img src="/img/screenshots/translation-settings.png" alt="翻译服务设置界面" />
</div>

## 支持的翻译服务

妙幕目前支持以下翻译服务：

1. **火山引擎翻译**
2. **百度翻译**
3. **微软翻译器**
4. **DeepLX 翻译**
5. **Ollama 本地模型**
6. **DeerAPI 聚合平台**
7. **OpenAI 风格 API**（包括 DeepSeek、Azure OpenAI 等）

每种服务有各自的特点、优势和应用场景，您可以根据需求选择合适的服务。

## 翻译服务详细配置

### 火山引擎翻译

[火山引擎](https://www.volcengine.com/product/translation)提供高质量的机器翻译服务，对中文支持较好。

#### 申请步骤：

1. 访问[火山引擎官网](https://www.volcengine.com/)并注册账号
2. 在控制台中创建机器翻译服务
3. 获取 AccessKey ID 和 AccessKey Secret

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"火山引擎翻译"部分
3. 输入您的 AccessKey ID 和 AccessKey Secret
4. 点击"保存"按钮

<div className="img-container">
  <img src="/img/screenshots/volc-translation-setting.png" alt="火山引擎翻译设置" />
</div>

### 百度翻译

[百度翻译](https://fanyi-api.baidu.com/)提供稳定的翻译API，支持多种语言对。

#### 申请步骤：

1. 访问[百度翻译开放平台](https://fanyi-api.baidu.com/)并注册账号
2. 创建应用，选择"通用翻译API"
3. 获取 APP ID 和密钥

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"百度翻译"部分
3. 输入您的 APP ID 和密钥
4. 点击"保存"按钮

<div className="img-container">
  <img src="/img/screenshots/baidu-translation-setting.png" alt="百度翻译设置" />
</div>

### 微软翻译器

[微软翻译器](https://www.microsoft.com/zh-cn/translator/)提供准确的机器翻译服务，支持多种语言。

#### 申请步骤：

1. 访问[Azure 门户](https://portal.azure.com/)并注册账号
2. At [Azure Translator 页面](https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/TextTranslation)创建翻译资源
3. 获取 API 密钥和区域信息

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"微软翻译器"部分
3. 输入您的 API 密钥和区域
4. 点击"保存"按钮

<div className="img-container">
  <img src="/img/screenshots/microsoft-translation-setting.png" alt="微软翻译器设置" />
</div>

### DeepLX 翻译

DeepLX 是基于 DeepL 翻译引擎的本地代理，提供高质量的翻译结果，特别适合欧洲语言之间的翻译。

#### 设置步骤：

1. 下载并安装 [DeepLX](https://github.com/OwO-Network/DeepLX)
2. 启动 DeepLX 服务并记录 API 端点

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"DeepLX 翻译"部分
3. 输入 DeepLX API 端点地址（默认为 `http://localhost:1188/translate`）
4. 点击"保存"按钮

:::caution 注意事项
DeepLX 在批量翻译时容易受到限流，建议降低并行请求数，或在高负载情况下切换到其他翻译服务。
:::

### Ollama 本地模型

[Ollama](https://ollama.ai/) 允许在本地运行大型语言模型，无需联网，保护隐私。

#### 设置步骤：

1. 从 [Ollama 官网](https://ollama.ai/) 下载并安装 Ollama
2. 拉取您想使用的模型，如 `llama2` 或 `mistral`
3. 启动 Ollama 服务

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"Ollama 本地模型"部分
3. 输入 Ollama API 端点地址（默认为 `http://localhost:11434/api/generate`）
4. 选择要使用的模型名称
5. 点击"保存"按钮

<div className="img-container">
  <img src="/img/screenshots/ollama-setting.png" alt="Ollama 设置" />
</div>

### DeerAPI 聚合平台

[DeerAPI](https://api.deerapi.com/) 是一个 AI 接口聚合平台，支持多种 AI 模型，可根据需求选择不同模型进行翻译。

#### 申请步骤：

1. 访问 [DeerAPI 官网](https://api.deerapi.com/register?aff=QvHM) 并注册账号
2. 获取 API 密钥
3. 充值账户余额

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"DeerAPI"部分
3. 输入您的 API 密钥
4. 选择要使用的模型
5. 点击"保存"按钮

### OpenAI 风格 API

妙幕支持使用兼容 OpenAI API 格式的服务，如 DeepSeek、Azure OpenAI、Claude 等。

#### 配置方法：

1. 在妙幕设置中选择"翻译服务"选项卡
2. 找到"OpenAI 风格 API"部分
3. 输入 API 密钥
4. 输入 API 端点（如 `https://api.deepseek.com`）
5. 选择模型名称（如 `deepseek-chat`）
6. 点击"保存"按钮

<div className="img-container">
  <img src="/img/screenshots/openai-style-setting.png" alt="OpenAI 风格 API 设置" />
</div>

## 翻译提示词设置

对于基于 AI 模型的翻译服务（如 Ollama 和 OpenAI 风格 API），您可以通过自定义提示词来优化翻译结果：

<div className="img-container">
  <img src="/img/screenshots/translation-prompt-setting.png" alt="翻译提示词设置" />
</div>

### 提示词模板

妙幕使用提示词模板来指导 AI 模型进行翻译。模板中可以使用以下变量：

- `{{text}}` - 要翻译的文本
- `{{source_lang}}` - 源语言
- `{{target_lang}}` - 目标语言

### 示例提示词

#### 基础翻译提示词：

```
将以下{{source_lang}}文本翻译成{{target_lang}}，保持原文的语气和风格：

{{text}}
```

#### 字幕优化提示词：

```
你是一位专业的视频字幕翻译专家。请将以下{{source_lang}}字幕翻译成{{target_lang}}，确保翻译简洁、自然且适合显示为字幕。保持原文的语气和风格，但可以适当调整以符合目标语言的表达习惯。

{{text}}
```

#### 专业领域翻译提示词：

```
作为一名专业的技术文档翻译者，请将以下{{source_lang}}技术内容翻译成{{target_lang}}。请确保准确翻译所有专业术语，并保持文本的技术准确性：

{{text}}
```

## 翻译服务选择建议

### 根据语言对选择

- **中文相关翻译**：火山引擎、百度翻译效果较好
- **欧洲语言互译**：DeepLX 通常效果最佳
- **小语种翻译**：微软翻译器覆盖语种较广
- **专业术语**：OpenAI 风格 API 配合适当提示词

### 根据使用场景选择

- **离线环境**：Ollama 本地模型
- **批量处理**：百度翻译、火山引擎、微软翻译器（API 限制较宽松）
- **高质量需求**：DeerAPI 或 OpenAI 风格 API 配合强大模型
- **翻译成本考量**：根据各服务的计费方式和您的使用量选择

## 故障排除

### 常见问题与解决方法

1. **API 密钥无效**：

   - 检查密钥是否正确输入（无多余空格）
   - 确认密钥是否过期或达到使用限制
   - 重新生成新的密钥

2. **翻译请求失败**：

   - 检查网络连接
   - 确认 API 端点地址正确
   - 检查服务余额是否充足

3. **DeepLX 限流**：

   - 减少并行请求数
   - 增加请求间隔
   - 暂时切换到其他翻译服务

4. **Ollama 本地模型问题**：

   - 确认 Ollama 服务正在运行
   - 检查模型是否已正确下载
   - 尝试重启 Ollama 服务

5. **API 余额不足**：
   - 充值相应服务账户
   - 临时切换到其他翻译服务
   - 考虑使用本地模型（如 Ollama）

## 翻译成本参考

不同翻译服务的计费方式各不相同，以下是一般参考：

| 服务       | 计费方式  | 大致成本   | 免费额度   |
| ---------- | --------- | ---------- | ---------- |
| 火山引擎   | 按字符数  | 低         | 有免费额度 |
| 百度翻译   | 按字符数  | 低         | 有免费额度 |
| 微软翻译器 | 按字符数  | 中         | 有免费额度 |
| DeepLX     | 免费/自建 | 无直接成本 | 不适用     |
| Ollama     | 本地模型  | 无直接成本 | 不适用     |
| DeerAPI    | 按token   | 中高       | 根据活动   |
| OpenAI風格 | 按token   | 中高       | 根据服务   |

:::info 提示
具体价格请参考各服务提供商的官方定价页面，价格可能随时变动。
:::

## 扩展阅读

更多关于各翻译服务的API申请方法，可以参考 Bob 翻译插件的文档：
[Bob 翻译插件文档](https://bobtranslate.com/service/)
