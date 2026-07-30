---
sidebar_position: 3
title: 开发说明
description: 妙幕（SmartSub）开发者指南：技术栈（Electron + Next.js + TypeScript）、本地开发环境搭建、原生依赖获取、项目结构与贡献流程。
keywords: [SmartSub 开发, Electron, 源码构建, 贡献指南, whisper.cpp addon]
---

# 开发说明

面向希望参与妙幕开发或基于源码定制的开发者。

## 技术栈

- **Electron**（v30）+ **Next.js**（nextron）：跨平台桌面应用与界面
- **TypeScript** + **Tailwind CSS**
- **whisper.cpp**：内置转写引擎的 C++ 实现（Node addon 形式集成，支持 CUDA / Vulkan / CoreML / Metal）
- **sherpa-onnx**：FunASR / Qwen3-ASR / FireRedASR / Parakeet 与本地 TTS 的原生运行库
- **FFmpeg**：音视频处理与字幕烧录

## 本地开发

### 环境要求

- Node.js 18+，Yarn

### 克隆与安装

```bash
git clone https://github.com/buxuku/SmartSub.git
cd SmartSub
yarn install
```

安装钩子会**自动下载**原生依赖（whisper addon 与 sherpa-onnx 原生库）。如因网络受限下载失败，手动重试：

```bash
yarn native:fetch   # 拉取 sherpa-onnx 原生库 + whisper addon
```

### 启动开发环境

```bash
yarn dev
```

带热重载。开发实例使用独立的用户数据目录（`userData-dev`），不会污染正式安装的配置。

### faster-whisper 引擎（独立仓库）

Python sidecar 源码与构建在 [buxuku/smartsub-py-engine](https://github.com/buxuku/smartsub-py-engine)，产物发布于其 `latest` Release，主仓库不包含 `python-engine/` 目录。本地调试 faster-whisper 时任选其一：

1. 在应用内「引擎」页面直接下载安装（写入 `userData/py-engine/current/`）
2. 本地构建 smartsub-py-engine 后，启动前指定：

```bash
export PYTHON_ENGINE_CMD="/path/to/smartsub-py-engine/dist/smartsub-engine/smartsub-engine"
yarn dev
```

### 构建打包

```bash
yarn build        # nextron build --no-pack（CI 构建产物）
yarn build:local  # 本地完整打包（electron-builder）
```

构建配置见 `electron-builder.yml`，产物输出到 `dist/`。

## 项目结构

```
SmartSub/
├── main/                 # Electron 主进程
│   ├── background.ts     # 主进程入口
│   ├── helpers/          # 任务处理、引擎、下载、配音、合成等模块
│   ├── service/          # 后端服务
│   └── translate/        # 翻译服务实现与适配器
├── renderer/             # 前端（Next.js）
│   ├── components/       # React 组件
│   ├── pages/[locale]/   # 页面路由（i18n）
│   ├── lib/ hooks/       # 前端辅助库与 hooks
├── types/                # 共享类型（含服务商定义 provider.ts）
├── extraResources/       # 构建附带资源（whisper addon 等）
├── scripts/              # 构建与测试脚本
└── docs/                 # 本文档站（Docusaurus）
```

- **新增翻译服务**：在 `types/provider.ts` 定义服务商字段，在 `main/translate/services/` 实现调用逻辑并注册
- **单元测试**：`package.json` 中有按模块划分的 `test:*` 脚本（引擎、合成、翻译解析、配音等），提交前跑相关模块

## 自行编译 whisper addon（特殊环境）

`addon.node` 是内置 whisper.cpp 引擎的核心库，项目已提供多平台预编译产物（随 `yarn native:fetch` 获取）。仅当你的环境无法使用预编译产物时才需要自行编译：

<details>
<summary>编译步骤</summary>

1. 克隆 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 仓库
2. 安装 cmake 与 cmake-js（Windows 可 `choco install cmake`；`npm i -g cmake-js`）
3. 进入 `examples/addon.node` 执行 `npm install` 后回到仓库根目录
4. 编译（参数按需调整，如 `GGML_CUDA` / `GGML_VULKAN`）：

```bash
npx cmake-js compile -T addon.node -B Release \
  --CDBUILD_SHARED_LIBS=OFF \
  --CDWHISPER_STATIC=ON \
  --CDGGML_CUDA=ON \
  --runtime=electron \
  --runtime-version=30.1.0 \
  --arch=x64
```

5. 把 `build/Release/addon.node.node` 复制到 SmartSub 的 `extraResources/addons/` 并重命名为 `addon.node`

</details>

## 参与贡献

1. Fork 仓库，创建特性分支（`feature/xxx`）
2. 遵循现有代码风格（TypeScript 类型完整；提交前 prettier 会经 lint-staged 自动格式化）
3. 提交 PR 时说明动机与测试情况；报告 Bug 请附[日志](/advanced/logs)、版本与复现步骤

本项目采用 [MIT 许可证](https://github.com/buxuku/SmartSub/blob/master/LICENSE)，提交贡献即同意以相同许可证发布。
