# P1 资源中心（Resource Hub）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型管理、翻译服务管理、GPU 加速管理合并为统一的 `/resources` 资源中心（全景/模型/翻译服务/加速 四 Tab），侧边栏 6→5 项，旧路由薄重定向。

**Architecture:** 新建 `pages/[locale]/resources.tsx` hub 页（shadcn Tabs + URL query 同步），三个旧页面主体平移为 `components/resources/*Tab.tsx` 组件，旧页面改为薄重定向；新增全景 Tab 用三张状态卡汇总现有 IPC 数据（零后端改动）。

**Tech Stack:** Nextron（Next.js 14 Pages Router 静态导出 + `[locale]` 动态路由 i18n）、shadcn/ui（Tabs/Card/Badge）、next-i18next、现有 IPC（`getSystemInfo` / `getTranslationProviders` / `get-gpu-environment` / `get-active-backend` / `getSettings`）。

**上游文档:**

- 设计蓝图：`docs/superpowers/specs/2026-06-11-ux-redesign-blueprint-design.md` §7、§12-P1
- 详细方案：`RESOURCE_HUB_REDESIGN_PLAN.md`（T0-T7）

**对详细方案的两处有意偏离:**

1. 原 T1 计划把 `CategoryCard`/`ModelRow` 拆到 `components/models/` 独立文件——本期不拆（P2 模型 Tab 重设计会整体重写这些组件，现在拆是无用功），整体平移进 `ModelsTab.tsx` 即可。
2. 原 T6（任务页空下拉跳资源中心）延后到 P3 任务页重构（届时下拉组件会重写，避免做两遍）。

**验证方式说明:** 本仓库无测试框架（无 test script / jest / vitest），不引入。每个任务用 `npx tsc --noEmit -p renderer/tsconfig.json` 做类型检查 + `yarn dev` 手工冒烟，最后一个任务跑完整 `yarn build`。

**提交说明:** 用户工作区有无关的未提交改动（`extraResources/addons/*.node`、`*.tsbuildinfo`、`RESOURCE_HUB_REDESIGN_PLAN.md`），每次提交只 `git add` 本计划明确列出的文件，**绝不使用 `git add .` 或 `git add -A`**。

---

## Task 0: 记录类型检查基线

**Files:** 无改动

- [ ] **Step 0.1: 跑一次类型检查，记录已存在的错误数**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

预期：记下输出（可能存在历史错误）。后续每个任务的类型检查以"不新增错误"为通过标准。

---

## Task 1: hub 骨架（T0）——resources 页面 + i18n + 侧边栏新增入口

**Files:**

- Create: `renderer/pages/[locale]/resources.tsx`
- Create: `renderer/public/locales/zh/resources.json`
- Create: `renderer/public/locales/en/resources.json`
- Modify: `renderer/public/locales/zh/common.json`（+1 key）
- Modify: `renderer/public/locales/en/common.json`（+1 key）
- Modify: `renderer/components/Layout.tsx`（新增资源中心入口，旧入口暂留）

- [ ] **Step 1.1: 创建 zh 文案** `renderer/public/locales/zh/resources.json`

```json
{
  "title": "资源中心",
  "description": "转写与翻译所需的模型、翻译服务与显卡加速，都在这里管理",
  "tab": {
    "overview": "全景",
    "models": "模型",
    "providers": "翻译服务",
    "acceleration": "加速"
  },
  "overview": {
    "modelsTitle": "语音模型",
    "providersTitle": "翻译服务",
    "accelerationTitle": "显卡加速",
    "installedCount": "已安装 {{count}} 个",
    "downloadingCount": "{{count}} 个下载中…",
    "noModels": "尚未安装模型，无法开始转写任务",
    "recommendedModel": "推荐：{{model}}（{{memory}}GB 内存）",
    "configuredCount": "已配置 {{count}} 项",
    "noProviders": "尚未配置翻译服务，翻译任务需要先配置",
    "enableProviders": "去启用翻译服务",
    "gpuRunning": "{{backend}} 运行中",
    "gpuNotEnabled": "未启用（CPU 模式）",
    "gpuModeLabel": "模式：{{mode}}",
    "gpuMode": {
      "auto": "自动",
      "cpu-only": "仅 CPU",
      "custom": "自定义"
    },
    "appleAcceleration": "Apple 芯片加速（CoreML / Metal）",
    "manage": "管理"
  }
}
```

- [ ] **Step 1.2: 创建 en 文案** `renderer/public/locales/en/resources.json`

```json
{
  "title": "Resources",
  "description": "Manage the models, translation services and GPU acceleration used by your tasks",
  "tab": {
    "overview": "Overview",
    "models": "Models",
    "providers": "Translation",
    "acceleration": "Acceleration"
  },
  "overview": {
    "modelsTitle": "Speech Models",
    "providersTitle": "Translation Services",
    "accelerationTitle": "GPU Acceleration",
    "installedCount": "{{count}} installed",
    "downloadingCount": "{{count}} downloading…",
    "noModels": "No model installed yet — transcription tasks cannot start",
    "recommendedModel": "Recommended: {{model}} ({{memory}}GB RAM)",
    "configuredCount": "{{count}} configured",
    "noProviders": "No translation service configured yet — required for translation tasks",
    "enableProviders": "Enable a service",
    "gpuRunning": "{{backend}} active",
    "gpuNotEnabled": "Not enabled (CPU mode)",
    "gpuModeLabel": "Mode: {{mode}}",
    "gpuMode": {
      "auto": "Auto",
      "cpu-only": "CPU only",
      "custom": "Custom"
    },
    "appleAcceleration": "Apple Silicon acceleration (CoreML / Metal)",
    "manage": "Manage"
  }
}
```

- [ ] **Step 1.3: 侧边栏文案** —— `renderer/public/locales/zh/common.json` 第 6 行 `"settings": "设置",` 后插入：

```json
  "resourceCenter": "资源中心",
```

`renderer/public/locales/en/common.json` 在对应 `"settings"` key 后插入：

```json
  "resourceCenter": "Resources",
```

（两个文件均为平铺 JSON，注意逗号合法性。）

- [ ] **Step 1.4: 创建 hub 页面** `renderer/pages/[locale]/resources.tsx`（完整内容）

```tsx
import React from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

export const RESOURCE_TABS = [
  'overview',
  'models',
  'providers',
  'acceleration',
] as const;
export type ResourceTab = (typeof RESOURCE_TABS)[number];

const Resources = () => {
  const { t } = useTranslation('resources');
  const router = useRouter();
  const queryTab = router.query.tab as string | undefined;
  const activeTab: ResourceTab = (RESOURCE_TABS as readonly string[]).includes(
    queryTab ?? '',
  )
    ? (queryTab as ResourceTab)
    : 'overview';

  const handleTabChange = (value: string) => {
    router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: value } },
      undefined,
      { shallow: true },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-fit">
          {RESOURCE_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`tab.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
          <p className="text-sm text-muted-foreground">{t('title')}</p>
        </TabsContent>
        <TabsContent value="models" className="min-h-0 flex-1 overflow-auto">
          <p className="text-sm text-muted-foreground">{t('tab.models')}</p>
        </TabsContent>
        <TabsContent value="providers" className="min-h-0 flex-1">
          <p className="text-sm text-muted-foreground">{t('tab.providers')}</p>
        </TabsContent>
        <TabsContent
          value="acceleration"
          className="min-h-0 flex-1 overflow-auto"
        >
          <p className="text-sm text-muted-foreground">
            {t('tab.acceleration')}
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Resources;

export const getStaticProps = makeStaticProperties([
  'common',
  'resources',
  'modelsControl',
  'translateControl',
  'settings',
  'parameters',
]);
export { getStaticPaths };
```

说明：四个 TabsContent 当前是占位文本，Task 2/3/4/5 逐个替换为真实组件。Radix TabsContent 默认只挂载激活 Tab（满足惰性挂载要求）。namespaces 一次配齐（后续 Tab 组件内部分别使用 `modelsControl` / `translateControl` / `settings`，文案 key 零迁移）。

- [ ] **Step 1.5: 侧边栏新增入口** —— `renderer/components/Layout.tsx`

(a) 第 10-22 行 lucide 导入块中，在 `Settings,` 之前加一行 `Package,`：

```tsx
import {
  BotIcon,
  FileVideo2,
  Github,
  MonitorPlay,
  Languages,
  Package,
  Settings,
  Rocket,
  Edit3,
  Film,
  Zap,
  ZapOff,
} from 'lucide-react';
```

(b) 在 subtitleMerge 的 `</Tooltip>`（原第 279 行）与 settings 的 `<Tooltip>`（原第 280 行）之间插入：

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Link href={`/${locale}/resources`}>
      <Button
        variant="ghost"
        size="icon"
        className={`rounded-lg ${
          asPath.includes('resources') ? 'bg-muted' : ''
        }`}
        aria-label="Resources"
      >
        <Package className="size-5" />
      </Button>
    </Link>
  </TooltipTrigger>
  <TooltipContent side="right" sideOffset={5}>
    {t('resourceCenter')}
  </TooltipContent>
</Tooltip>
```

- [ ] **Step 1.6: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

预期：错误数不多于 Task 0 基线。

- [ ] **Step 1.7: 冒烟**：`yarn dev` 启动后，点侧边栏新图标进入资源中心；切换四个 Tab，确认 URL query 变化（`?tab=models` 等）；刷新页面 Tab 状态保持；中英文切换文案正常。

- [ ] **Step 1.8: Commit**

```bash
git add renderer/pages/\[locale\]/resources.tsx renderer/public/locales/zh/resources.json renderer/public/locales/en/resources.json renderer/public/locales/zh/common.json renderer/public/locales/en/common.json renderer/components/Layout.tsx
git commit -m "feat(resources): add resource hub page skeleton with tabs and sidebar entry"
```

---

## Task 2: 模型 Tab（T1）——页面主体平移 + 旧页重定向

**Files:**

- Create: `renderer/components/resources/ModelsTab.tsx`（由 `modelsControl.tsx` 主体平移）
- Rewrite: `renderer/pages/[locale]/modelsControl.tsx`（改为薄重定向）
- Modify: `renderer/pages/[locale]/resources.tsx`（接入 ModelsTab）

- [ ] **Step 2.1: 创建 `renderer/components/resources/ModelsTab.tsx`**

把现有 `renderer/pages/[locale]/modelsControl.tsx`（450 行）整体复制过来，然后做且仅做以下 6 处修改（其余 `RatingDots` / `ModelRow` / `CategoryCard` 及全部逻辑原样保留）：

(1) 删除这两行导入（页面专用）：

```tsx
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
```

(2) `ISystemInfo` 导入路径不变（`'../../../types/types'` 从 `components/resources/` 出发同样指向仓库根 `types/types.ts`，无需改动）。

(3) 主组件重命名（原第 306 行）：

```tsx
// 原: const ModelsControl = () => {
const ModelsTab = () => {
```

(4) 外层容器去掉页面级 padding（hub 已提供），页头降级为 h2（原第 374-377 行）：

```tsx
// 原: <div className="container mx-auto p-4 space-y-4">
//       <div className="flex items-start justify-between">
//         <div>
//           <h1 className="text-2xl font-bold">{t('modelManagement')}</h1>
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('modelManagement')}</h2>
```

(5) 文件尾部导出替换（原第 446-450 行）：

```tsx
// 原:
// export default ModelsControl;
// export const getStaticProps = makeStaticProperties(['common', 'modelsControl']);
// export { getStaticPaths };
export default ModelsTab;
```

(6) `export enum DownSource` 保留在本文件顶部不动（Task 5 的 OverviewTab 会从这里导入）。

- [ ] **Step 2.2: 旧页改为薄重定向** —— 用以下完整内容覆盖 `renderer/pages/[locale]/modelsControl.tsx`：

```tsx
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

const ModelsControlRedirect = () => {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    const locale = router.query.locale as string;
    router.replace(`/${locale}/resources?tab=models`);
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
};

export default ModelsControlRedirect;

export const getStaticProps = makeStaticProperties(['common']);
export { getStaticPaths };
```

- [ ] **Step 2.3: hub 接入** —— `renderer/pages/[locale]/resources.tsx`：

(a) 顶部加导入：

```tsx
import ModelsTab from '@/components/resources/ModelsTab';
```

(b) 替换 models 占位：

```tsx
// 原:
// <TabsContent value="models" className="min-h-0 flex-1 overflow-auto">
//   <p className="text-sm text-muted-foreground">{t('tab.models')}</p>
// </TabsContent>
<TabsContent value="models" className="min-h-0 flex-1 overflow-auto">
  <ModelsTab />
</TabsContent>
```

- [ ] **Step 2.4: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

预期：不新增错误。

- [ ] **Step 2.5: 冒烟**：`yarn dev` 下进入 `资源中心 → 模型`，核对：分类卡片完整渲染、推荐徽章存在、下载源切换记忆（localStorage key `downSource` 不变）、下载/取消/删除/导入/更改路径全部可用；访问旧路由（侧边栏旧模型图标）自动跳到模型 Tab。

- [ ] **Step 2.6: Commit**

```bash
git add renderer/components/resources/ModelsTab.tsx renderer/pages/\[locale\]/modelsControl.tsx renderer/pages/\[locale\]/resources.tsx
git commit -m "feat(resources): migrate models management into resources models tab"
```

---

## Task 3: 翻译服务 Tab（T2）——平移 + 已配置徽章 + 旧页重定向

**Files:**

- Create: `renderer/lib/providerUtils.ts`（「已配置」判定，Task 5 全景复用）
- Create: `renderer/components/resources/ProvidersTab.tsx`（由 `translateControl.tsx` 主体平移）
- Rewrite: `renderer/pages/[locale]/translateControl.tsx`（薄重定向）
- Modify: `renderer/pages/[locale]/resources.tsx`（接入）
- Modify: `renderer/public/locales/zh/translateControl.json` / `en/translateControl.json`（+1 key）

- [ ] **Step 3.1: 创建 `renderer/lib/providerUtils.ts`**（完整内容）

```ts
import { Provider, PROVIDER_TYPES, CONFIG_TEMPLATES } from '../../types';

/**
 * 「已配置」= 该服务商类型声明的全部 required 字段均非空。
 * 无 required 字段的类型（如 Ollama 默认本地地址也需 apiUrl，见 PROVIDER_TYPES）按未配置处理，
 * 避免空对象被误判为已配置。
 */
export function isProviderConfigured(provider: Provider | undefined): boolean {
  if (!provider) return false;
  const typeDef =
    provider.type === 'openai'
      ? CONFIG_TEMPLATES.openai
      : PROVIDER_TYPES.find((t) => t.id === provider.type);
  const requiredFields = (typeDef?.fields || []).filter((f) => f.required);
  if (requiredFields.length === 0) return false;
  return requiredFields.every((f) => {
    const value = provider[f.key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}
```

- [ ] **Step 3.2: 创建 `renderer/components/resources/ProvidersTab.tsx`**

把现有 `renderer/pages/[locale]/translateControl.tsx`（361 行）整体复制过来，做且仅做以下 6 处修改：

(1) 删除页面专用导入：

```tsx
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
```

(2) 增加两个导入（`Badge` + 判定函数）：

```tsx
import { Badge } from '@/components/ui/badge';
import { isProviderConfigured } from 'lib/providerUtils';
```

注意 `Provider` 等类型导入路径 `'../../../types'` 从 `components/resources/` 出发仍指向仓库根 `types/`，无需改动。

(3) 组件重命名（原第 27 行）：

```tsx
// 原: const TranslateControl: React.FC = () => {
const ProvidersTab: React.FC = () => {
```

(4) 组件内（`getCurrentProvider` 函数之后）加一个按 id 找存量配置的辅助函数：

```tsx
const isConfiguredById = (providerId: string) =>
  isProviderConfigured(providers.find((p) => p.id === providerId));
```

(5) 左列两处按钮加「已配置」徽章：

内置服务商按钮（原第 196-218 行）改为：

```tsx
{
  PROVIDER_TYPES.filter((t) => t.isBuiltin).map((type) => (
    <button
      key={type.id}
      onClick={() => handleProviderSelect(type.id)}
      className={cn(
        'w-full text-left px-4 py-2 rounded-lg flex items-center space-x-2',
        selectedProvider === type.id
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-muted',
      )}
    >
      <span className="text-xl">
        {type.iconImg ? <img src={type.iconImg} className="w-5" /> : type.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {commonT(`provider.${type.name}`, { defaultValue: type.name })}
      </span>
      {isConfiguredById(type.id) && (
        <Badge
          variant="outline"
          className="ml-auto flex-shrink-0 border-green-500/50 px-1.5 py-0 text-[10px] text-green-600 dark:text-green-500"
        >
          {t('configured')}
        </Badge>
      )}
    </button>
  ));
}
```

自定义服务商按钮内（原第 239-244 行的名称区块之后、删除图标 `<span>` 之前）插入同样的徽章：

```tsx
{
  isConfiguredById(provider.id) && (
    <Badge
      variant="outline"
      className="mr-1 flex-shrink-0 border-green-500/50 px-1.5 py-0 text-[10px] text-green-600 dark:text-green-500"
    >
      {t('configured')}
    </Badge>
  );
}
```

(6) 尾部导出替换（原第 354-361 行）：

```tsx
export default ProvidersTab;
```

- [ ] **Step 3.3: 文案** —— `renderer/public/locales/zh/translateControl.json` 顶层加：

```json
  "configured": "已配置",
```

`renderer/public/locales/en/translateControl.json` 顶层加：

```json
  "configured": "Configured",
```

- [ ] **Step 3.4: 旧页改薄重定向** —— 用以下完整内容覆盖 `renderer/pages/[locale]/translateControl.tsx`：

```tsx
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

const TranslateControlRedirect = () => {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    const locale = router.query.locale as string;
    router.replace(`/${locale}/resources?tab=providers`);
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
};

export default TranslateControlRedirect;

export const getStaticProps = makeStaticProperties(['common']);
export { getStaticPaths };
```

- [ ] **Step 3.5: hub 接入** —— `renderer/pages/[locale]/resources.tsx` 加导入并替换占位：

```tsx
import ProvidersTab from '@/components/resources/ProvidersTab';
```

```tsx
<TabsContent value="providers" className="min-h-0 flex-1">
  <ProvidersTab />
</TabsContent>
```

- [ ] **Step 3.6: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

- [ ] **Step 3.7: 冒烟**：`资源中心 → 翻译服务`：左列分组与选中态正常、master-detail 高度不溢出（左列独立滚动）、填写必填字段后该项出现绿色「已配置」徽章、增删自定义服务商、测试翻译可用；旧翻译管理入口跳转正确。

- [ ] **Step 3.8: Commit**

```bash
git add renderer/lib/providerUtils.ts renderer/components/resources/ProvidersTab.tsx renderer/pages/\[locale\]/translateControl.tsx renderer/pages/\[locale\]/resources.tsx renderer/public/locales/zh/translateControl.json renderer/public/locales/en/translateControl.json
git commit -m "feat(resources): migrate translation providers into resources tab with configured badge"
```

---

## Task 4: 加速 Tab（T3）——GpuAccelerationCard 平移 + 深链接改向 + 设置页引导行

**Files:**

- Create: `renderer/components/resources/AccelerationTab.tsx`
- Modify: `renderer/pages/[locale]/resources.tsx`（接入）
- Modify: `renderer/pages/[locale]/settings.tsx`（移除卡片、加引导行）
- Modify: `renderer/components/Layout.tsx`（顶栏 GPU 指示器深链接）
- Modify: `renderer/public/locales/zh/settings.json` / `en/settings.json`（+2 keys）

- [ ] **Step 4.1: 创建 `renderer/components/resources/AccelerationTab.tsx`**（完整内容；`GpuAccelerationCard` 自身零改动，含其内部 `id="gpu-acceleration"` 锚点）

```tsx
import React from 'react';
import { GpuAccelerationCard } from '@/components/settings';

const AccelerationTab = () => {
  return (
    <div className="pb-4">
      <GpuAccelerationCard />
    </div>
  );
};

export default AccelerationTab;
```

- [ ] **Step 4.2: hub 接入** —— `renderer/pages/[locale]/resources.tsx` 加导入并替换占位：

```tsx
import AccelerationTab from '@/components/resources/AccelerationTab';
```

```tsx
<TabsContent value="acceleration" className="min-h-0 flex-1 overflow-auto">
  <AccelerationTab />
</TabsContent>
```

- [ ] **Step 4.3: 设置页移除卡片、加引导行** —— `renderer/pages/[locale]/settings.tsx`：

(a) 删除导入（原第 34 行）：

```tsx
import { GpuAccelerationCard } from '@/components/settings';
```

(b) 原第 543-544 行：

```tsx
{
  /* GPU 加速设置卡片 */
}
<GpuAccelerationCard />;
```

替换为：

```tsx
{
  /* GPU 加速已迁移至资源中心（过渡期引导，一个版本后可移除） */
}
<Card>
  <CardContent className="flex items-center justify-between py-4">
    <span className="text-sm text-muted-foreground">
      {t('gpuMovedToResources')}
    </span>
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        router.push(`/${i18n.language}/resources?tab=acceleration`)
      }
    >
      {t('goToResources')}
    </Button>
  </CardContent>
</Card>;
```

（`router`、`i18n`、`Card`/`CardContent`/`Button` 在该文件已有，见第 91-92 行与第 11-12 行。）

- [ ] **Step 4.4: 顶栏深链接改向** —— `renderer/components/Layout.tsx` 原第 355-357 行：

```tsx
// 原:
//   onClick={() =>
//     router.push(`/${locale}/settings#gpu-acceleration`)
//   }
                    onClick={() =>
                      router.push(`/${locale}/resources?tab=acceleration`)
                    }
```

- [ ] **Step 4.5: 文案** —— `renderer/public/locales/zh/settings.json` 顶层加：

```json
  "gpuMovedToResources": "GPU 加速设置已迁移至「资源中心 → 加速」",
  "goToResources": "前往资源中心",
```

`renderer/public/locales/en/settings.json` 顶层加：

```json
  "gpuMovedToResources": "GPU acceleration settings have moved to Resources → Acceleration",
  "goToResources": "Open Resources",
```

- [ ] **Step 4.6: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

- [ ] **Step 4.7: 冒烟**：`资源中心 → 加速` 下 GPU 卡全功能正常（状态卡、模式切换、加速包下载、检测详情）；顶栏 GPU 指示器点击落到加速 Tab；设置页原位置显示引导行且按钮可跳转；macOS 上加速 Tab 行为与原设置页内一致。

- [ ] **Step 4.8: Commit**

```bash
git add renderer/components/resources/AccelerationTab.tsx renderer/pages/\[locale\]/resources.tsx renderer/pages/\[locale\]/settings.tsx renderer/components/Layout.tsx renderer/public/locales/zh/settings.json renderer/public/locales/en/settings.json
git commit -m "feat(resources): move gpu acceleration card into resources acceleration tab"
```

---

## Task 5: 全景 Tab（T4）——三张状态卡 + 空状态 CTA + 实时刷新

**Files:**

- Create: `renderer/components/resources/OverviewTab.tsx`
- Modify: `renderer/pages/[locale]/resources.tsx`（接入）

- [ ] **Step 5.1: 创建 `renderer/components/resources/OverviewTab.tsx`**（完整内容）

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Bot, Languages, Zap, ArrowRight, AlertTriangle } from 'lucide-react';
import DownModel from '@/components/DownModel';
import DownModelButton from '@/components/DownModelButton';
import { modelCategories, getRecommendedCategory } from 'lib/utils';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { isProviderConfigured } from 'lib/providerUtils';
import { ISystemInfo } from '../../../types/types';
import { Provider } from '../../../types';
import { DownSource } from './ModelsTab';

const GPU_MODE_KEYS = ['auto', 'cpu-only', 'custom'] as const;

type GpuStatus = {
  isDarwin: boolean;
  enabled: boolean;
  label: string;
  mode: string;
};

const OverviewTab = ({
  onNavigateTab,
}: {
  onNavigateTab: (tab: string) => void;
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    downloadingModels: [],
    modelsPath: '',
  });
  const [providers, setProviders] = useState<Provider[]>([]);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [downSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

  const refresh = useCallback(async () => {
    try {
      const info = await window?.ipc?.invoke('getSystemInfo', null);
      if (info) setSystemInfo(info);
      const storedProviders = await window?.ipc?.invoke(
        'getTranslationProviders',
      );
      setProviders(storedProviders || []);

      const env = await window?.ipc?.invoke('get-gpu-environment');
      const settings = await window?.ipc?.invoke('getSettings');
      const active = await window?.ipc?.invoke('get-active-backend');
      const backendLabels: Record<string, string> = {
        cuda: 'CUDA',
        vulkan: 'Vulkan',
        cpu: 'CPU',
        metal: 'Metal',
        coreml: 'CoreML',
        custom: 'Custom',
      };
      const isDarwin = env?.platform === 'darwin';
      const isCpuResult = active?.backend === 'cpu';
      setGpu({
        isDarwin,
        enabled: isDarwin || (settings?.gpuMode !== 'cpu-only' && !isCpuResult),
        label:
          active && !isCpuResult
            ? active.backend === 'cuda' && active.variant
              ? `CUDA ${active.variant}`
              : backendLabels[active.backend] || active.backend
            : '',
        mode: settings?.gpuMode || 'auto',
      });
    } catch (error) {
      console.error('Failed to refresh overview:', error);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubProgress = window?.ipc?.on(
      'downloadProgress',
      (_model: string, progress: number) => {
        if (progress >= 1) refresh();
      },
    );
    const unsubBackend = window?.ipc?.on('active-backend-changed', () =>
      refresh(),
    );
    window.addEventListener('gpu-settings-changed', refresh);
    return () => {
      unsubProgress?.();
      unsubBackend?.();
      window.removeEventListener('gpu-settings-changed', refresh);
    };
  }, [refresh]);

  const installed = systemInfo.modelsInstalled || [];
  const downloading = systemInfo.downloadingModels || [];
  const recommendedId = getRecommendedCategory(systemInfo.totalMemoryGB ?? 8);
  const recommendedCategory = modelCategories.find(
    (c) => c.id === recommendedId,
  );
  const recommendedModel = recommendedCategory?.models.find(
    (m) => !m.isQuantized && !m.isEnglishOnly,
  );
  const configuredProviders = providers.filter(isProviderConfigured);
  const gpuModeKey = (GPU_MODE_KEYS as readonly string[]).includes(
    gpu?.mode ?? '',
  )
    ? (gpu?.mode as string)
    : 'auto';

  const manageButton = (tab: string) => (
    <Button
      variant="ghost"
      size="sm"
      className="text-xs"
      onClick={() => onNavigateTab(tab)}
    >
      {t('overview.manage')} <ArrowRight className="ml-1 h-3 w-3" />
    </Button>
  );

  return (
    <div className="grid items-start gap-4 md:grid-cols-3">
      {/* 语音模型 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4" />
            {t('overview.modelsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {installed.length > 0 ? (
            <>
              <p className="text-sm font-medium">
                {t('overview.installedCount', { count: installed.length })}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {installed.slice(0, 3).join(' · ')}
                {installed.length > 3 ? ' …' : ''}
              </p>
            </>
          ) : (
            <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {t('overview.noModels')}
            </p>
          )}
          {downloading.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('overview.downloadingCount', { count: downloading.length })}
            </p>
          )}
          {systemInfo.totalMemoryGB && recommendedModel ? (
            <p className="text-xs text-muted-foreground">
              {t('overview.recommendedModel', {
                model: recommendedModel.name,
                memory: systemInfo.totalMemoryGB,
              })}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            {installed.length === 0 && recommendedModel && (
              <DownModel
                modelName={recommendedModel.name}
                callBack={refresh}
                downSource={downSource}
                needsCoreML={recommendedModel.needsCoreML}
                globalDownloading={downloading.length > 0}
              >
                <DownModelButton />
              </DownModel>
            )}
            {manageButton('models')}
          </div>
        </CardContent>
      </Card>

      {/* 翻译服务 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages className="h-4 w-4" />
            {t('overview.providersTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {configuredProviders.length > 0 ? (
            <>
              <p className="text-sm font-medium">
                {t('overview.configuredCount', {
                  count: configuredProviders.length,
                })}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {configuredProviders
                  .slice(0, 3)
                  .map((p) =>
                    commonT(`provider.${p.name}`, { defaultValue: p.name }),
                  )
                  .join(' · ')}
                {configuredProviders.length > 3 ? ' …' : ''}
              </p>
            </>
          ) : (
            <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              {t('overview.noProviders')}
            </p>
          )}
          <div className="flex items-center gap-2">
            {configuredProviders.length === 0 && (
              <Button
                size="sm"
                className="text-xs"
                onClick={() => onNavigateTab('providers')}
              >
                {t('overview.enableProviders')}
              </Button>
            )}
            {manageButton('providers')}
          </div>
        </CardContent>
      </Card>

      {/* 显卡加速 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4" />
            {t('overview.accelerationTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {gpu?.isDarwin ? (
            <p className="text-sm font-medium text-green-600 dark:text-green-500">
              {t('overview.appleAcceleration')}
            </p>
          ) : gpu?.enabled && gpu.label ? (
            <p className="text-sm font-medium text-green-600 dark:text-green-500">
              {t('overview.gpuRunning', { backend: gpu.label })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('overview.gpuNotEnabled')}
            </p>
          )}
          {gpu && !gpu.isDarwin && (
            <p className="text-xs text-muted-foreground">
              {t('overview.gpuModeLabel', {
                mode: t(`overview.gpuMode.${gpuModeKey}`),
              })}
            </p>
          )}
          {manageButton('acceleration')}
        </CardContent>
      </Card>
    </div>
  );
};

export default OverviewTab;
```

- [ ] **Step 5.2: hub 接入** —— `renderer/pages/[locale]/resources.tsx` 加导入并替换 overview 占位：

```tsx
import OverviewTab from '@/components/resources/OverviewTab';
```

```tsx
<TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
  <OverviewTab onNavigateTab={handleTabChange} />
</TabsContent>
```

- [ ] **Step 5.3: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

- [ ] **Step 5.4: 冒烟**：全景 Tab 三卡状态准确（已装模型列表、已配置服务商数、GPU 后端标签）；空状态场景验证——临时把模型路径切到空目录后模型卡变引导态、「下载推荐模型」按钮直接触发下载且进度可见，完成后卡片自动转为已安装态；「管理 →」分别切到对应 Tab；在加速 Tab 改 GPU 模式后回全景，状态已刷新（`gpu-settings-changed` 事件）。

- [ ] **Step 5.5: Commit**

```bash
git add renderer/components/resources/OverviewTab.tsx renderer/pages/\[locale\]/resources.tsx
git commit -m "feat(resources): add overview tab with readiness status cards"
```

---

## Task 6: 侧边栏收编（T5）——移除模型/翻译旧入口

**Files:**

- Modify: `renderer/components/Layout.tsx`

- [ ] **Step 6.1: 删除两个旧入口**

删除 modelsControl 的整个 `<Tooltip>...</Tooltip>` 块（原第 204-222 行，含 `BotIcon` 按钮）与 translateControl 的整个 `<Tooltip>...</Tooltip>` 块（原第 223-241 行，含 `Languages` 按钮）。

- [ ] **Step 6.2: 清理未使用导入**

lucide 导入块中删除 `BotIcon,` 与 `Languages,`（确认文件内无其它使用后）。

- [ ] **Step 6.3: 类型检查**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
```

- [ ] **Step 6.4: 冒烟**：侧边栏为 5 项（任务/校对/合成/资源中心/设置）；直接访问旧 URL `/zh/modelsControl`、`/zh/translateControl` 仍能重定向到对应 Tab。

- [ ] **Step 6.5: Commit**

```bash
git add renderer/components/Layout.tsx
git commit -m "feat(resources): remove legacy models and translation sidebar entries"
```

---

## Task 7: 终验（T7）

**Files:** 无新改动（如发现问题则修复后重跑）

- [ ] **Step 7.1: 类型检查与构建**

```bash
npx tsc --noEmit -p renderer/tsconfig.json; echo "exit=$?"
yarn build
```

预期：类型错误不多于 Task 0 基线；`nextron build --no-pack` 成功结束。

- [ ] **Step 7.2: 全量冒烟清单**（`yarn dev`，对照 RESOURCE_HUB_REDESIGN_PLAN.md §11 验收清单）

- [ ] 四个 Tab 均可达，URL 直链（`/zh/resources?tab=providers` 等）/刷新/返回行为正确
- [ ] 旧路由 `/modelsControl`、`/translateControl` 重定向正确
- [ ] 模型下载/删除/导入/换路径与重构前一致；下载源偏好保留
- [ ] 服务商增删改/测试翻译一致；「已配置」徽章准确
- [ ] GPU 卡片全功能一致；顶栏指示器点击落到加速 Tab；设置页引导行可跳转
- [ ] 全景三卡状态准确；空状态 CTA 可用；下载推荐模型动线跑通
- [ ] macOS 下加速 Tab 仅显示状态卡 + 检测详情（沿用现有平台逻辑）
- [ ] zh/en 双语完整（切换语言逐 Tab 检查）；暗色模式逐 Tab 检查

- [ ] **Step 7.3: 如有修复，按所属任务的文件范围单独提交**

```bash
git add <仅修复涉及的文件>
git commit -m "fix(resources): <具体修复内容>"
```
