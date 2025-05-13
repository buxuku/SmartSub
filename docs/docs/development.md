---
sidebar_position: 3
title: 开发说明
---

# 开发说明

本章节面向希望参与妙幕（SmartSub）开发或基于其源码进行定制的开发者。这里提供了项目的开发环境搭建指南、代码结构说明和贡献指南。

## 技术栈

妙幕使用以下技术栈构建：

- **Electron**: 跨平台桌面应用框架
- **Next.js**: React 应用框架，用于构建用户界面
- **TypeScript**: 提供类型安全的 JavaScript 超集
- **Tailwind CSS**: 实用优先的 CSS 框架
- **Node.js**: 后端和文件处理
- **whisper.cpp**: Whisper 模型的 C++ 实现，支持 CUDA 和 Core ML 加速

## 开发环境搭建

### 系统要求

- **Node.js**: 18.0 或更高版本
- **Yarn**: 推荐使用 Yarn 作为包管理器
- **编译环境**:
  - Windows: Visual Studio Build Tools 或完整的 Visual Studio
  - macOS: Xcode Command Line Tools
  - Linux: 标准编译工具链 (gcc, make 等)

### 克隆代码

```bash
git clone https://github.com/buxuku/SmartSub.git
cd SmartSub
```

### 安装依赖

```bash
yarn install
```

#### 特殊情况说明

如果您使用的是 Windows 平台或 Mac Intel 平台，需要额外下载适配的 node 文件：

1. 前往 https://github.com/buxuku/whisper.cpp/releases/tag/latest 下载对应的 node 文件
2. 将文件重命名为 `addon.node`
3. 将文件放置在项目的 `extraResources/addons/` 目录下

### 启动开发服务器

```bash
yarn dev
```

此命令会启动具有热重载功能的开发服务器。您可以在代码修改后立即看到效果。

### 构建应用

```bash
yarn build
```

构建完成后，可以在 `dist` 目录下找到编译好的应用程序。

## 项目结构

妙幕的代码结构如下：

```
SmartSub/
├── app/                  # Electron 编译输出
├── main/                 # Electron 主进程代码
│   ├── background.ts     # 主进程入口
│   ├── helpers/          # 辅助函数
│   ├── service/          # 后端服务
│   └── translate/        # 翻译相关代码
├── renderer/             # 前端代码 (Next.js)
│   ├── components/       # React 组件
│   ├── pages/            # 页面组件
│   ├── styles/           # 样式文件
│   ├── lib/              # 前端辅助库
│   └── hooks/            # React hooks
├── resources/            # 资源文件
└── extraResources/       # 额外资源 (构建时包含)
    └── addons/           # Whisper.cpp Node 绑定
```

### 核心模块说明

- **main/service**: 包含字幕生成和处理的核心逻辑
- **main/translate**: 翻译服务的实现和 API 适配器
- **renderer/components**: UI 组件和交互界面
- **renderer/pages**: 应用的各个页面和路由
- **extraResources/addons**: whisper.cpp 的 Node.js 绑定，负责语音识别功能

## 开发指南

### UI 修改

1. UI 相关代码主要在 `renderer` 目录
2. 使用 Tailwind CSS 进行样式定义
3. 组件位于 `renderer/components` 目录
4. 页面位于 `renderer/pages/[locale]` 目录

### 功能逻辑修改

1. 与字幕生成相关的代码在 `main/service` 目录
2. 与翻译相关的代码在 `main/translate` 目录
3. 主进程和渲染进程通信通过 IPC 进行

### 添加新的翻译服务

如果您想添加新的翻译服务：

1. 在 `main/translate/services` 目录下创建新服务的实现
2. 将服务添加到 `main/translate/index.ts` 中的服务注册表
3. 在 `renderer/components/settings` 下添加对应的设置界面

### 测试修改

虽然项目目前没有自动化测试，但您应该手动测试您的更改：

1. 确保基本功能正常工作
2. 测试边缘情况和错误处理
3. 在不同操作系统上验证功能 (如可能)

## 构建与打包

### 使用默认配置构建

```bash
yarn build
```

### 为特定平台构建

```bash
# Windows
yarn build:win

# macOS
yarn build:mac

# Linux
yarn build:linux
```

### 自定义构建配置

构建配置在 `electron-builder.yml` 文件中定义。您可以修改此文件以自定义构建过程。

## 贡献指南

我们欢迎社区贡献，无论是修复 bug、改进文档还是添加新功能。

### 提交 Pull Request

1. Fork 本仓库
2. 创建您的特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交您的更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启一个 Pull Request

### 代码风格

- 遵循项目现有的代码风格
- 使用 TypeScript 类型
- 保持代码简洁可读
- 添加必要的注释

### Issue 报告

如果您发现 bug 或有功能建议，请提交 Issue：

1. 使用清晰的标题描述问题
2. 提供详细的重现步骤
3. 描述期望行为和实际行为
4. 如可能，附上截图或日志

## 许可证

本项目采用 MIT 许可证。详情请见 [LICENSE](https://github.com/buxuku/SmartSub/blob/master/LICENSE) 文件。通过提交贡献，您同意将您的代码贡献在相同许可证下发布。
