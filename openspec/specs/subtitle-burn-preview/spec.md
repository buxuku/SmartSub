# Spec: subtitle-burn-preview

## Purpose

字幕合成页的所见即所得预览：libass WASM 引擎（JASSUB）渲染主进程生成的同一份 ASS 内容、供给真实系统字体文件，引擎初始化失败时自动降级 CSS 模拟。

## Requirements

### Requirement: Preview renders with libass engine using the same ASS content

字幕合成页面的预览 SHALL 使用 libass 的 WASM 渲染引擎（JASSUB）渲染，且渲染内容为主进程按当前样式生成的 ASS 文档（与烧录使用同一生成逻辑），叠加在视频预览之上。预览与烧录同引擎、同输入，字号、换行、背景框、描边、阴影所见即所得。

#### Scenario: 预览与烧录效果一致

- **WHEN** 用户调整字号、背景色、不透明度、对齐或边距
- **THEN** 预览由 libass 引擎按更新后的 ASS 内容重新渲染，与随后烧录输出的对应画面观感一致

#### Scenario: 样式变更实时反映

- **WHEN** 用户在样式面板修改任一样式项
- **THEN** 预览在可感知的短延迟内更新（ASS 内容重新生成并重新加载渲染器）

### Requirement: System fonts are supplied to the preview renderer

系统 SHALL 向 WASM 渲染引擎供给实际字体文件：主进程解析所选字体（及 CJK 兜底字体）对应的本机字体文件路径，通过 IPC 将字体数据提供给渲染层加载；无法解析时加载平台默认 CJK 字体作为渲染兜底，保证预览字形与烧录时 libass/fontconfig 解析结果一致。

#### Scenario: 预览使用与烧录相同的字体

- **WHEN** 用户选择 macOS 上可用的「Hiragino Sans GB」并预览中文字幕
- **THEN** 预览引擎加载该字体的本机字体文件渲染，与烧录输出字形一致

#### Scenario: 所选字体文件无法定位

- **WHEN** 所选字体在本机无法解析出字体文件
- **THEN** 预览引擎回退加载平台默认 CJK 字体，预览仍可正常渲染（与烧录端字体兜底行为对应）

### Requirement: Graceful fallback to CSS simulation

当 WASM 渲染引擎初始化失败（资源加载失败、环境不支持等）时，预览 SHALL 自动降级为现有 CSS 模拟方案，功能可用性不受影响，并在日志中记录降级原因。CSS 降级方案的背景色与透明度取值 SHALL 与烧录逻辑一致（用户背景色 + 用户不透明度，无圆角）。

#### Scenario: WASM 加载失败自动降级

- **WHEN** JASSUB 的 WASM 资源加载失败
- **THEN** 预览无缝切换为 CSS 模拟渲染，页面不报错，日志记录降级原因

#### Scenario: 降级方案背景样式对齐

- **WHEN** 处于 CSS 降级模式且用户使用背景框模式、不透明度 80%
- **THEN** CSS 预览以用户背景色 + 80% 不透明度渲染直角背景框
