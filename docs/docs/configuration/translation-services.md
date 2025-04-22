---
sidebar_position: 2
---

# 配置翻译服务

SmartSub支持多种翻译服务，可以将生成的字幕或导入的字幕翻译成多种语言。本页面将指导您如何配置这些翻译服务。

## 支持的翻译服务

SmartSub目前支持以下翻译服务：

1. **火山引擎翻译**：字节跳动旗下的翻译服务
2. **百度翻译**：百度AI开放平台提供的翻译服务
3. **微软翻译器**：微软提供的翻译服务
4. **DeepLX翻译**：DeepL的开源实现
5. **Ollama本地模型**：基于本地大语言模型的翻译
6. **AI聚合平台 DeerAPI**：支持多种AI模型的聚合平台
7. **OpenAI风格API**：支持符合OpenAI接口标准的API服务，如DeepSeek、Azure等

## 翻译服务配置步骤

### 通用配置流程

1. 启动SmartSub应用
2. 点击左侧导航栏中的"设置"
3. 在设置页面中，选择"翻译设置"选项卡
4. 选择您想要配置的翻译服务
5. 输入相应的API密钥和配置信息
6. 点击"保存"按钮应用设置

### 火山引擎翻译配置

1. 访问[火山引擎控制台](https://console.volcengine.com/)注册并创建应用
2. 开通"机器翻译"服务
3. 获取AccessKeyId和AccessKeySecret
4. 在SmartSub的翻译设置中，选择"火山引擎翻译"
5. 输入AccessKeyId和AccessKeySecret
6. 设置区域(Region)，一般为"cn-north-1"
7. 保存配置

### 百度翻译配置

1. 访问[百度翻译开放平台](https://fanyi-api.baidu.com/)注册账号
2. 创建应用，选择"通用翻译API"
3. 获取APP ID和密钥
4. 在SmartSub的翻译设置中，选择"百度翻译"
5. 输入APP ID和密钥
6. 保存配置

### 微软翻译器配置

1. 访问[Azure门户](https://portal.azure.com/)创建Microsoft Azure账号
2. 创建"Translator"资源
3. 获取API密钥和区域信息
4. 在SmartSub的翻译设置中，选择"微软翻译器"
5. 输入API密钥和区域
6. 保存配置

### DeepLX翻译配置

DeepLX是DeepL翻译的开源实现，需要自己搭建服务或使用公共服务：

1. 在SmartSub的翻译设置中，选择"DeepLX翻译"
2. 输入DeepLX服务的API地址，例如`http://localhost:1188/translate`
3. 保存配置

:::caution 注意
DeepLX服务的批量翻译容易存在被限流的情况，不推荐用于大批量翻译任务。
:::

### Ollama本地模型配置

Ollama允许您在本地运行大型语言模型：

1. 从[Ollama官网](https://ollama.ai/)下载并安装Ollama
2. 下载支持翻译的模型，如`llama2`或`mistral`
3. 在SmartSub的翻译设置中，选择"Ollama翻译"
4. 输入Ollama服务地址，默认为`http://localhost:11434`
5. 选择已安装的模型名称
6. 自定义提示词(可选)，以优化翻译效果
7. 保存配置

### DeerAPI配置

[DeerAPI](https://api.deerapi.com/register?aff=QvHM)是一个AI聚合平台，支持近500种模型：

1. 注册[DeerAPI账号](https://api.deerapi.com/register?aff=QvHM)
2. 获取API密钥
3. 在SmartSub的翻译设置中，选择"DeerAPI"
4. 输入API密钥
5. 选择模型，如`gpt-4`、`deepseek-chat`等
6. 自定义提示词(可选)
7. 保存配置

### OpenAI风格API配置

适用于所有兼容OpenAI接口的服务，如DeepSeek、Azure OpenAI等：

1. 获取您所选服务的API密钥
2. 在SmartSub的翻译设置中，选择"OpenAI风格API"
3. 输入API密钥
4. 设置API基础URL，例如：
   - DeepSeek: `https://api.deepseek.com/v1`
   - Azure OpenAI: `https://您的资源名称.openai.azure.com/openai/deployments/您的部署名称`
5. 选择模型名称
6. 自定义提示词(可选)
7. 保存配置

## 翻译服务参数说明

### 通用参数

- **并发任务数**：同时处理的翻译任务数量，根据API限制和计算机性能调整
- **重试次数**：翻译失败时的重试次数
- **翻译文本格式**：选择是否保留原文，或仅显示翻译结果

### AI模型参数

使用AI模型(Ollama、DeerAPI、OpenAI风格API)时的特殊参数：

- **模型名称**：使用的AI模型，不同模型翻译质量和速度不同
- **提示词**：指导AI如何翻译的提示，可以定制以改善特定领域的翻译
- **温度**：控制输出的随机性，值越低翻译越稳定，值越高创造性越强
- **最大输出标记数**：控制翻译输出的最大长度

## 提示词优化

对于AI模型翻译，提示词对翻译质量有重要影响。以下是一些建议的提示词模板：

```
你是一位精通{{from}}和{{to}}的专业翻译。请将以下{{from}}文本翻译成地道的{{to}}：

{{text}}

翻译时需要注意：
1. 保持原文的风格和语气
2. 确保专业术语的准确性
3. 翻译应当流畅自然，避免生硬的直译
4. 保留原文的格式和标点
```

您可以根据自己的需求调整提示词，例如针对电影字幕、技术文档或其他特定类型的内容进行优化。

## 故障排除

如果在配置或使用翻译服务时遇到问题：

- **API密钥错误**：检查密钥是否正确输入，没有多余的空格
- **连接失败**：检查网络连接和服务URL是否正确
- **翻译失败**：检查API额度是否用尽或账户余额是否充足
- **翻译质量问题**：尝试调整提示词或使用不同的翻译服务

如需更多帮助，请参考翻译服务提供商的文档或SmartSub的[故障排除](../faq/troubleshooting)章节。 