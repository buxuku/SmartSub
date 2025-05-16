---
sidebar_position: 3
title: 自定义构建 whisper 的 addon.node 包
---

## 自己编译 addon.node 文件

addon.node 是这个工具的核心库文件，项目已经尽可能去支持各种环境。但也不可避免出现一些特殊环境无法使用的问题。
如果遇到这种情况，可以尝试自己编译 addon.node 文件。

### 环境

- nodejs 18 及以上版本

### 编译步骤

1. 克隆项目

```bash
git clone git@github.com:ggml-org/whisper.cpp.git
```

2. 进入项目根目录

3. 安装依赖

```bash
choco install cmake -y
npm install -g cmake-js
```

4. 进入到 `addon.node` 目录, 安装依赖

```bash
cd examples/addon.node
npm install
cd ../../
```

5. 在项目的根目录执行编译命令

这里面的具体参数可以根据自己的需求进行修改

```bash
npx cmake-js compile -T addon.node -B Release \
            --CDBUILD_SHARED_LIBS=OFF \
            --CDWHISPER_STATIC=ON \
            --CDGGML_CUDA=ON \
            --runtime=electron \
            --runtime-version=30.1.0 \
            --arch=x64
```

6. 编译完成后，会在 `build/Release` 目录下生成 `addon.node.node` 文件

7. 复制 `addon.node.node` 文件到 `extraResources/addons` 目录下，并重命名为 `addon.node`
