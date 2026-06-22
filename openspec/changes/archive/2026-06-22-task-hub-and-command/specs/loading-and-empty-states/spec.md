## ADDED Requirements

### Requirement: Skeleton 基元基于现有 token

系统 SHALL 提供一个 `Skeleton` 基元（`renderer/components/ui/skeleton.tsx`），其样式 MUST 基于现有 HSL token（如 `bg-muted`）与既有动画依赖（`tailwindcss-animate` 的脉冲），MUST NOT 引入任何新三方依赖或字体。

#### Scenario: 无新依赖

- **WHEN** 引入 Skeleton 基元
- **THEN** 不新增 npm 依赖，样式仅由现有 token 与动画工具类构成

### Requirement: 数据界面 skeleton 加载

数据驱动界面在「加载中且尚无可显示数据」时 SHALL 呈现与最终布局同构的 skeleton 占位（至少覆盖：引擎模型清单、翻译服务商列表、任务行列表、最近任务、活动面板），替代「居中转圈 + 大片留白」。

#### Scenario: 首次加载呈现骨架

- **WHEN** 进入引擎模型清单且数据尚在加载、无缓存可显示
- **THEN** 呈现与清单同构的 skeleton 行，而非仅一个居中转圈

#### Scenario: 加载到内容无明显跳变

- **WHEN** 数据加载完成、skeleton 被真实内容替换
- **THEN** 布局结构保持稳定，无明显的尺寸跳变 / 闪烁

### Requirement: 统一空态

数据为空（非加载中）的界面 SHALL 使用统一的空态呈现（复用 `EmptyState`：图标 + 标题 + 提示 + 可选操作），命令面板与活动面板的「无内容」情形 SHALL 与之保持一致语言。

#### Scenario: 列表为空走统一空态

- **WHEN** 某数据界面加载完成但无任何条目
- **THEN** 呈现统一 `EmptyState`（含图标、标题、提示），而非裸露空白或转圈

#### Scenario: 加载态与空态不混淆

- **WHEN** 界面处于加载中
- **THEN** 呈现 skeleton 而非空态；仅当确认无数据时才呈现空态
