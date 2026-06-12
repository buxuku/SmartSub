# P2 模型 Tab 重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重设计资源中心模型 Tab：推荐 hero 前置、按用途三档分组（快速/均衡/高精度）、紧凑行式布局、变体折叠、「只看已安装」筛选。

**Architecture:** 仅重写 `renderer/components/resources/ModelsTab.tsx` 一个文件（hero 区 + TierSection 替代 CategoryCard，ModelRow 增加人话描述与评分点）+ `modelsControl.json` zh/en 增加文案。数据源 `modelCategories` 与下载/删除/导入链路（DownModel 注入式 API）零改动。

**Tech Stack:** 同 P1。`DownModel` 通过 cloneElement 注入 `loading/progress/detail/handleDownModel/disabled` 给子按钮。

**上游设计:** 蓝图 §7.1；已确认线框 `.superpowers/brainstorm/72796-1781160747/content/resources-onboarding.html` ①。

**三档映射（presentational，定义在 ModelsTab 内）:**

| 档位        | 分类              | 主模型                                          |
| ----------- | ----------------- | ----------------------------------------------- |
| fast 🚀     | tiny, base        | tiny / base                                     |
| balanced ⚖️ | small, medium     | small / medium                                  |
| accurate 🎯 | largeTurbo, large | large-v3-turbo / large-v3 / large-v2 / large-v1 |

推荐模型 = `getRecommendedCategory(totalMemoryGB)` 所指分类的首个主模型（非量化非纯英文）。推荐依据行在检测到加速可用（darwin 或 active-backend ≠ cpu）时附加「显卡加速可用」。

---

## Task 1: i18n 文案（zh/en modelsControl.json）

**Files:**

- Modify: `renderer/public/locales/zh/modelsControl.json`
- Modify: `renderer/public/locales/en/modelsControl.json`

- [ ] **Step 1.1: zh 顶层追加以下 key**（保留全部既有 key，含暂不再引用的 `category.*` / `recommendedForYou`）

```json
{
  "recommendedHero": "为这台电脑推荐：{{model}}",
  "recommendedBasis": "依据：本机内存 {{memory}}GB",
  "recommendedBasisWithGpu": "依据：本机内存 {{memory}}GB · 显卡加速可用",
  "oneClickDownload": "一键下载（{{size}}）",
  "alreadyInstalled": "已安装，随时可用",
  "tier": {
    "fast": "快速档",
    "balanced": "均衡档",
    "accurate": "高精度档"
  },
  "tierDesc": {
    "fast": "速度优先，适合先快速试试效果",
    "balanced": "日常推荐，准确度与速度兼顾",
    "accurate": "准确度优先，对电脑配置要求高"
  },
  "tierRAM": "内存 ≥ {{ram}}GB",
  "showInstalledOnly": "只看已安装",
  "noInstalledModels": "还没有已安装的模型，关闭筛选查看全部模型",
  "modelDesc": {
    "tiny": "最快出结果，准确度一般",
    "base": "比 tiny 准一些，依然很快",
    "small": "速度与准确度的入门平衡点",
    "medium": "大多数人的最佳选择，中文效果好",
    "large-v3-turbo": "精度接近顶级，速度还不错",
    "large-v3": "顶级精度，速度最慢",
    "large-v2": "上一代顶级模型",
    "large-v1": "最早一代大模型"
  }
}
```

- [ ] **Step 1.2: en 顶层追加对应 key**

```json
{
  "recommendedHero": "Recommended for this computer: {{model}}",
  "recommendedBasis": "Based on {{memory}}GB RAM",
  "recommendedBasisWithGpu": "Based on {{memory}}GB RAM · GPU acceleration available",
  "oneClickDownload": "Download ({{size}})",
  "alreadyInstalled": "Installed and ready",
  "tier": {
    "fast": "Fast",
    "balanced": "Balanced",
    "accurate": "High accuracy"
  },
  "tierDesc": {
    "fast": "Speed first — great for a quick try",
    "balanced": "Recommended for daily use, accuracy and speed in balance",
    "accurate": "Accuracy first, requires a powerful computer"
  },
  "tierRAM": "RAM ≥ {{ram}}GB",
  "showInstalledOnly": "Installed only",
  "noInstalledModels": "No models installed yet — turn off the filter to browse all models",
  "modelDesc": {
    "tiny": "Fastest results, modest accuracy",
    "base": "More accurate than tiny, still fast",
    "small": "Entry-level balance of speed and accuracy",
    "medium": "Best choice for most people",
    "large-v3-turbo": "Near top accuracy at a decent speed",
    "large-v3": "Top accuracy, slowest",
    "large-v2": "Previous-generation flagship",
    "large-v1": "First-generation large model"
  }
}
```

（注意：实际写入时修正上面 `accurate` 行尾多余逗号。）

## Task 2: 重写 ModelsTab

**Files:**

- Rewrite: `renderer/components/resources/ModelsTab.tsx`

要点（完整代码见执行）：

- [ ] `MODEL_TIERS` 三档映射 + `RecommendedHero`（⭐ + 标题 + 依据行 + 模型描述 + 右侧大按钮：未装 → DownModel 包裹的主按钮（loading 时进度条+速度+ETA），已装 → 绿色「已安装，随时可用」）
- [ ] `TierSection` 替代 `CategoryCard`：档位标题行（emoji + 名称 + 说明 + 内存要求），主模型紧凑行，变体跨分类合并折叠（沿用 `showAllVariants`/`hideVariants`/`quantizedTip`）
- [ ] `ModelRow` 增加：描述（`modelDesc.*`）、速度/准确度评分点（沿用分类的 speed/quality + RatingDots）、推荐行高亮（border-primary/40 + ⭐ 徽章）
- [ ] 工具行增加「只看已安装」Switch；筛选时空档位隐藏，全空显示 `noInstalledModels`
- [ ] 推荐依据：mount 时 invoke `get-gpu-environment` + `get-active-backend` 判断加速可用
- [ ] 下载源切换 / 导入模型 / 存储路径 / DownSource enum / IPC 链路全部保留

## Task 3: 验证与提交

- [ ] `npx tsc --noEmit -p renderer/tsconfig.json` 非测试错误 0
- [ ] `yarn build` 成功
- [ ] 单次提交：

```bash
git add renderer/components/resources/ModelsTab.tsx renderer/public/locales/zh/modelsControl.json renderer/public/locales/en/modelsControl.json
git commit -m "feat(resources): redesign models tab with recommendation hero and usage tiers"
```
