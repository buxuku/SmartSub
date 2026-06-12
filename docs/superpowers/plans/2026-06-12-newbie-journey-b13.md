# B13 新手旅程闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引导第 4 步「试一试」示例任务 + 帮助菜单「常见问题」+ 模型下载进度全局 pill,把新手从启动到第一份字幕的旅程闭环(报告 6.7.1-3)。

**Architecture:** 示例任务复用正常工程流(getDroppedFiles → saveTaskProject → 任务页 ?autostart=1),不走特殊代码路径;FAQ 仿 ShortcutsHelpDialog 受控 Dialog 模式;下载 pill 直接在 Layout 监听主进程已有的全局广播事件 `modelDownloadDetail`,无需状态提升或改主进程。

**Tech Stack:** Electron IPC、Next.js(pages router)、shadcn Dialog、next-i18next(zh/en 对等,门禁 `node scripts/check-i18n.mjs`)。

**上游设计:** `docs/superpowers/specs/2026-06-12-remaining-roadmap-design.md` §3

**门禁(每个 task commit 前):**

```bash
node scripts/check-i18n.mjs        # 通过
cd renderer && npx tsc --noEmit    # 非测试错误 0,不得新增
npx tsc --noEmit -p tsconfig.json  # main/ 错误 95 个存量,不得新增
```

**项目惯例:** 无 UI 单测基建,验证 = 门禁 + 实机手测点(与批次 1-12 相同);一 task 一 commit,conventional 风格。

---

## Task 1: 生成示例音频并接入打包

**Files:**

- Create: `extraResources/sample-onboarding.mp3`(TTS 生成,~10s 英文口播)
- Modify: `electron-builder.yml`(mac/win/linux 三处 extraResources)

- [ ] **Step 1: 生成 TTS 音频**

```bash
say -v Samantha -r 175 -o /tmp/sample-onboarding.aiff "Welcome to SmartSub! This app turns videos and audio into subtitles, right on your own computer. Your files never leave your machine. Enjoy creating your first subtitle."
./node_modules/ffmpeg-static/ffmpeg -y -i /tmp/sample-onboarding.aiff -codec:a libmp3lame -b:a 64k -ar 16000 -ac 1 extraResources/sample-onboarding.mp3
```

- [ ] **Step 2: 验证音频时长与大小**

```bash
afinfo extraResources/sample-onboarding.mp3 | grep -E "estimated duration|data size"
```

Expected: duration 10-14 秒,大小 < 150KB。人工试听一遍(`afplay extraResources/sample-onboarding.mp3`),口播清晰无截断。若 Samantha 效果差,备选 `say -v Daniel`(en_GB)重新生成。

- [ ] **Step 3: electron-builder.yml 三平台各加一条 extraResources**

在 mac(L24-30)、win(L34-40)、linux(L56-62)三处的 `extraResources:` 列表里,`ggml-silero-v6.2.0.bin` 条目之后各追加:

```yaml
- from: ./extraResources/sample-onboarding.mp3
  to: ./extraResources/sample-onboarding.mp3
```

- [ ] **Step 4: 门禁(i18n/tsc 无涉及,跑通即可)+ Commit**

```bash
git add extraResources/sample-onboarding.mp3 electron-builder.yml
git commit -m "feat(onboarding): bundle 10s sample audio for try-it step"
```

---

## Task 2: 主进程支持——示例路径 IPC + 工程自定义名

**Files:**

- Modify: `main/helpers/ipcHandlers.ts`(新增 `getOnboardingSamplePath` handler,L165 `openUrl` handler 附近)
- Modify: `main/helpers/taskManager.ts:148-189`(saveTaskProject 支持可选 name)

- [ ] **Step 1: ipcHandlers.ts 新增示例路径 handler**

`main/helpers/ipcHandlers.ts` 顶部 import 区(L8 `import { renderTemplate } from './utils';`)改为同时引入 getExtraResourcesPath:

```ts
import { renderTemplate, getExtraResourcesPath } from './utils';
```

在 `ipcMain.on('openUrl', ...)`(L165-167)之后新增:

```ts
// 引导「试一试」示例音频的绝对路径(dev 与打包态由 getExtraResourcesPath 区分)
ipcMain.handle('getOnboardingSamplePath', () => {
  return path.join(getExtraResourcesPath(), 'sample-onboarding.mp3');
});
```

注意:`utils.ts` 的 `getExtraResourcesPath` 当前未被 ipcHandlers 引用,确认 `path` 已在文件顶部 import(已有,L1-3 区域)。

- [ ] **Step 2: taskManager.ts saveTaskProject 支持 name**

`main/helpers/taskManager.ts` L148-153 handler 签名的 payload 类型加 `name?: string`:

```ts
  ipcMain.handle(
    'saveTaskProject',
    (
      event,
      payload: {
        id: string;
        taskType?: TaskProjectType;
        files: IFiles[];
        name?: string;
      },
    ) => {
      const { id, taskType, files, name } = payload || {};
```

L177-184 新建工程时优先用传入名:

```ts
const project: TaskProject = {
  id,
  name: name?.trim() || buildTaskName(files),
  taskType: normalizeTaskType(taskType),
  files,
  createdAt: now,
  updatedAt: now,
};
```

(upsert 已存在分支 L167-175 不动——更新文件列表不改名。)

- [ ] **Step 3: 门禁 + Commit**

```bash
npx tsc --noEmit -p tsconfig.json   # main/ 错误数不超过 95 存量
git add main/helpers/ipcHandlers.ts main/helpers/taskManager.ts
git commit -m "feat(main): sample path ipc and named task projects for onboarding demo"
```

---

## Task 3: 任务页 autostart 机制

**Files:**

- Modify: `renderer/components/TaskControls.tsx`(加 autoStart prop)
- Modify: `renderer/pages/[locale]/tasks/[type].tsx:531-537`(读 query 传 prop)

- [ ] **Step 1: TaskControls 增加 autoStart prop**

`renderer/components/TaskControls.tsx`:props 接口(组件签名处)加 `autoStart?: boolean`。组件体内、`handleTask` 定义(L66)之后新增:

```ts
// ?autostart=1 进入页面时自动开始一次(仅 idle 态,ref 防 StrictMode/重渲染重复触发)
const autoStartedRef = useRef(false);
useEffect(() => {
  if (!autoStart || autoStartedRef.current) return;
  if (!files?.length) return;
  if (taskStatus !== 'idle') return;
  autoStartedRef.current = true;
  handleTask();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [autoStart, files, taskStatus]);
```

确认文件顶部已 import `useRef`/`useEffect`(现有代码已用,无需新增 import)。

- [ ] **Step 2: [type].tsx 读 query 并传入**

`renderer/pages/[locale]/tasks/[type].tsx` L531 的 `<TaskControls ...>` 增加一行 prop:

```tsx
<TaskControls
  formData={formData}
  files={files}
  typeDef={typeDef}
  projectId={projectId}
  onStatusChange={handleStatusChange}
  autoStart={router.query.autostart === '1'}
/>
```

- [ ] **Step 3: 门禁 + Commit**

```bash
cd renderer && npx tsc --noEmit
git add renderer/components/TaskControls.tsx "renderer/pages/[locale]/tasks/[type].tsx"
git commit -m "feat(tasks): support autostart query flag to begin task on page entry"
```

---

## Task 4: OnboardingDialog 第 4 步「试一试」

**Files:**

- Modify: `renderer/components/onboarding/OnboardingDialog.tsx`(steps 数组 L189-332 末尾加第 4 项 + runSample 逻辑)
- Modify: `renderer/public/locales/zh/common.json`(onboarding 块加 key)
- Modify: `renderer/public/locales/en/common.json`(同步)

- [ ] **Step 1: OnboardingDialog 加状态、依赖与 runSample**

文件顶部 import 增加(合并进现有 import):

```ts
import { v4 as uuidv4 } from 'uuid'; // 不需要——示例工程用固定 id,见下;此行勿加
import { isProviderConfigured } from 'lib/providerUtils';
import { Loader2, PlayCircle } from 'lucide-react'; // 并入现有 lucide-react import
```

组件内 state 区(L100 附近)新增:

```ts
const [sampleLoading, setSampleLoading] = useState(false);
```

`closeAndGo`(L167-171)之后新增:

```ts
/**
 * 一键示例任务:固定 id,存在即删除重建——示例音频仅 10s,
 * 重建保证每次都是干净的演示,语义最简单。
 */
const SAMPLE_PROJECT_ID = 'sample-onboarding';
const runSample = async () => {
  setSampleLoading(true);
  try {
    const samplePath = await window?.ipc?.invoke(
      'getOnboardingSamplePath',
      null,
    );
    const providers = await window?.ipc?.invoke('getTranslationProviders');
    const hasProvider = (providers || []).some((p: any) =>
      isProviderConfigured(p),
    );
    // 已配翻译服务 → 完整链路;未配 → 纯转写,零配置可跑
    const taskType = hasProvider ? 'generateAndTranslate' : 'generateOnly';
    const slug = hasProvider ? 'generate-translate' : 'generate';

    const existing = await window?.ipc?.invoke(
      'getTaskProject',
      SAMPLE_PROJECT_ID,
    );
    if (existing) {
      await window?.ipc?.invoke('deleteTaskProject', SAMPLE_PROJECT_ID);
    }
    const dropped = await window?.ipc?.invoke('getDroppedFiles', {
      files: [samplePath],
      taskType: 'media',
    });
    if (!dropped?.length) {
      throw new Error('sample audio missing');
    }
    await window?.ipc?.invoke('saveTaskProject', {
      id: SAMPLE_PROJECT_ID,
      taskType,
      files: dropped,
      name: t('onboarding.sampleProjectName'),
    });
    markCompleted();
    onOpenChange(false);
    router.push(
      `/${locale}/tasks/${slug}?project=${SAMPLE_PROJECT_ID}&autostart=1`,
    );
  } catch (error) {
    console.error('Failed to run sample task:', error);
  } finally {
    setSampleLoading(false);
  }
};
```

- [ ] **Step 2: steps 数组末尾(L331 第 3 步对象之后)加第 4 步**

```tsx
    {
      title: t('onboarding.step4Title'),
      desc: t('onboarding.step4Desc'),
      body: (
        <div className="space-y-3 py-2">
          <div className="rounded-lg border bg-muted/30 px-3 py-3 text-sm text-muted-foreground leading-relaxed">
            {t('onboarding.sampleExplain')}
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={runSample}
              disabled={sampleLoading || (installedCount === 0 && !downloadDone)}
            >
              {sampleLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="mr-2 h-4 w-4" />
              )}
              {sampleLoading
                ? t('onboarding.sampleRunning')
                : t('onboarding.sampleRun')}
            </Button>
            {installedCount === 0 && !downloadDone && (
              <span className="text-xs text-muted-foreground">
                {t('onboarding.sampleNeedsModel')}
              </span>
            )}
          </div>
        </div>
      ),
    },
```

说明:步骤指示点(L361 `steps.map`)、`stepLabel` 的 total、`isLast` 判断(L334)都依赖 `steps.length`,数组加项后自动变为 4 步,无需其他改动。

- [ ] **Step 3: zh/common.json onboarding 块加 key**

`renderer/public/locales/zh/common.json` 的 `"onboarding"` 对象(L167 起)内追加:

```json
    "step4Title": "试一试",
    "step4Desc": "用内置的 10 秒示例音频,完整体验一次「音频 → 字幕」。",
    "sampleExplain": "点击下方按钮,会用一段内置英文示例音频创建任务并自动开始转写。十几秒后你就能看到第一份字幕;如果已配置翻译服务,还会自动翻译成双语。",
    "sampleRun": "运行示例任务",
    "sampleRunning": "正在准备…",
    "sampleNeedsModel": "需要先在第 2 步下载语音模型",
    "sampleProjectName": "示例 · 第一个字幕"
```

- [ ] **Step 4: en/common.json 同步**

`renderer/public/locales/en/common.json` 的 `"onboarding"` 对象内追加:

```json
    "step4Title": "Try it out",
    "step4Desc": "Run the bundled 10-second sample audio through the full audio-to-subtitle flow.",
    "sampleExplain": "Click the button below to create a task from a bundled English sample audio and start transcribing automatically. You'll see your first subtitle in seconds; if a translation provider is configured, it will be translated too.",
    "sampleRun": "Run sample task",
    "sampleRunning": "Preparing…",
    "sampleNeedsModel": "Download a speech model in step 2 first",
    "sampleProjectName": "Sample · First subtitle"
```

- [ ] **Step 5: 门禁 + 实机验证 + Commit**

```bash
node scripts/check-i18n.mjs
cd renderer && npx tsc --noEmit
```

实机(`yarn dev`):重开引导 → 第 4 步 → 运行示例 → 跳任务页自动开始 → 完成出横幅。再点一次「运行示例」(重开引导)→ 旧示例工程被重建。

```bash
git add renderer/components/onboarding/OnboardingDialog.tsx renderer/public/locales/zh/common.json renderer/public/locales/en/common.json
git commit -m "feat(onboarding): add try-it step that runs bundled sample through real task flow"
```

---

## Task 5: 帮助菜单「常见问题」Dialog

**Files:**

- Create: `renderer/components/FaqDialog.tsx`
- Modify: `renderer/components/Layout.tsx`(帮助下拉加入口 L566-569 之后 + Dialog 挂载 L622 附近 + state)
- Modify: `renderer/public/locales/zh/common.json` + `renderer/public/locales/en/common.json`(faq 块 + help.faq)

- [ ] **Step 1: 新建 FaqDialog.tsx**

```tsx
import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChevronDown } from 'lucide-react';
import { cn } from 'lib/utils';

interface FaqDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** hasCommand 的条目在答案下方以 <code> 块展示可复制命令(key 后缀 Cmd) */
const FAQ_ITEMS = [
  { id: 'macDamaged', hasCommand: true },
  { id: 'cudaCrash', hasCommand: false },
  { id: 'slowDownload', hasCommand: false },
  { id: 'translateFailed', hasCommand: false },
  { id: 'subtitleGarbled', hasCommand: false },
] as const;

export default function FaqDialog({ open, onOpenChange }: FaqDialogProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[70vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('faq.title')}</DialogTitle>
        </DialogHeader>
        <div className="divide-y rounded-md border">
          {FAQ_ITEMS.map((item) => {
            const isOpen = expanded === item.id;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-muted/50"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : item.id)}
                >
                  {t(`faq.${item.id}Q`)}
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-180',
                    )}
                  />
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 text-sm leading-relaxed text-muted-foreground">
                    {t(`faq.${item.id}A`)}
                    {item.hasCommand && (
                      <code className="mt-2 block select-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
                        {t(`faq.${item.id}Cmd`)}
                      </code>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Layout.tsx 接线**

import 区加 `import FaqDialog from './FaqDialog';`(L42 ShortcutsHelpDialog 之后)。state 区(`showShortcuts` 同处)加:

```ts
const [showFaq, setShowFaq] = useState(false);
```

帮助下拉「快捷键速查」项(L566-569)之后插入:

```tsx
<DropdownMenuItem onClick={() => setShowFaq(true)}>
  <HelpCircle className="mr-2 h-4 w-4" />
  {t('help.faq')}
</DropdownMenuItem>
```

Dialog 挂载区 `<ShortcutsHelpDialog ...>`(L622-625)之后:

```tsx
<FaqDialog open={showFaq} onOpenChange={setShowFaq} />
```

- [ ] **Step 3: zh/common.json 加 key**

`"help"` 块(L140-147)内加 `"faq": "常见问题",`;顶层(help 块之后)加:

```json
  "faq": {
    "title": "常见问题",
    "macDamagedQ": "macOS 提示「应用程序已损坏,无法打开」?",
    "macDamagedA": "这是 macOS 对未签名应用的隔离机制,并非应用真的损坏。在「终端」中执行以下命令后重新打开应用:",
    "macDamagedCmd": "sudo xattr -dr com.apple.quarantine /Applications/SmartSub.app",
    "cudaCrashQ": "启用 GPU 加速后转写闪退?",
    "cudaCrashA": "通常是加速包版本与显卡驱动不匹配。前往「资源中心 → 加速」切换其他版本的加速包,或暂时改用 CPU 模式——CPU 模式速度较慢,但永远能完成转写。",
    "slowDownloadQ": "模型下载很慢或一直失败?",
    "slowDownloadA": "前往「资源中心 → 模型」,把下载源切换为「国内加速源」后重试;也可以手动下载模型文件后,用「导入模型」添加。",
    "translateFailedQ": "字幕翻译大量失败?",
    "translateFailedA": "先到「资源中心 → 翻译服务」用「测试翻译」确认服务可用(密钥、网络、额度)。修复后回到校对编辑器,用「仅失败」筛选配合「批量重翻」一键重译失败条目。",
    "subtitleGarbledQ": "烧录到视频的字幕乱码或显示方块?",
    "subtitleGarbledA": "多为所选字体不支持中文。在「合成到视频」的样式设置中选择支持中文的字体(如苹方、微软雅黑、思源黑体)后重新合成。"
  },
```

- [ ] **Step 4: en/common.json 同步**

`"help"` 块加 `"faq": "FAQ",`;顶层加:

```json
  "faq": {
    "title": "Frequently Asked Questions",
    "macDamagedQ": "macOS says the app is damaged and can't be opened?",
    "macDamagedA": "This is macOS quarantine for unsigned apps, not actual damage. Run the following command in Terminal, then reopen the app:",
    "macDamagedCmd": "sudo xattr -dr com.apple.quarantine /Applications/SmartSub.app",
    "cudaCrashQ": "Transcription crashes after enabling GPU acceleration?",
    "cudaCrashA": "Usually the acceleration package version doesn't match your GPU driver. Go to Resource Hub → Acceleration and switch to another package version, or fall back to CPU mode — slower, but it always completes.",
    "slowDownloadQ": "Model downloads are slow or keep failing?",
    "slowDownloadA": "Go to Resource Hub → Models and switch the download source, then retry. You can also download the model file manually and add it via Import Model.",
    "translateFailedQ": "Many subtitle translations failed?",
    "translateFailedA": "First verify the provider works via Test Translation in Resource Hub → Translation Services (key, network, quota). Then back in the proofread editor, use the failed-only filter with batch retranslate to fix them in one go.",
    "subtitleGarbledQ": "Burned-in subtitles show garbled text or boxes?",
    "subtitleGarbledA": "The selected font likely lacks CJK glyphs. Pick a font that supports your language (e.g. PingFang, Microsoft YaHei, Source Han Sans) in the burn-in style settings and merge again."
  },
```

- [ ] **Step 5: 门禁 + 实机验证 + Commit**

```bash
node scripts/check-i18n.mjs
cd renderer && npx tsc --noEmit
```

实机:帮助菜单 → 常见问题 → 条目展开/收起、命令块可全选复制、zh/en 切换正常、暗色模式正常。

```bash
git add renderer/components/FaqDialog.tsx renderer/components/Layout.tsx renderer/public/locales/zh/common.json renderer/public/locales/en/common.json
git commit -m "feat(help): in-app FAQ dialog covering top support issues"
```

---

## Task 6: 模型下载进度全局 pill

**Files:**

- Modify: `renderer/components/Layout.tsx`(监听 `modelDownloadDetail` + 侧边栏底部渲染)
- Modify: `renderer/public/locales/zh/common.json` + `renderer/public/locales/en/common.json`

主进程 `modelDownloader.ts` L98-107 已向所有页面广播 `modelDownloadDetail(model, {status, progress(0-100), ...})`,status 枚举 `idle|downloading|extracting|completed|error`(L12),取消时回 `idle`(L144)。**无需改主进程。**

- [ ] **Step 1: Layout.tsx 加状态与监听**

import 区:lucide-react import 并入 `Loader2, CheckCircle2, AlertCircle`(已有的保留)。state 区加:

```ts
const [downloadPill, setDownloadPill] = useState<{
  model: string;
  progress: number;
  status: string;
} | null>(null);
```

组件内(现有 useEffect 区)新增:

```ts
// 模型下载全局可见:主进程 modelDownloadDetail 是全局广播,任何页面都能收到
useEffect(() => {
  let hideTimer: NodeJS.Timeout | null = null;
  const unsub = window?.ipc?.on(
    'modelDownloadDetail',
    (model: string, detail: { status: string; progress: number }) => {
      if (!detail) return;
      if (detail.status === 'downloading' || detail.status === 'extracting') {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        setDownloadPill({
          model,
          progress: detail.progress ?? 0,
          status: detail.status,
        });
      } else if (detail.status === 'completed' || detail.status === 'error') {
        setDownloadPill({ model, progress: 100, status: detail.status });
        hideTimer = setTimeout(() => setDownloadPill(null), 5000);
      } else {
        setDownloadPill(null); // idle = 取消,立即隐藏
      }
    },
  );
  return () => {
    unsub?.();
    if (hideTimer) clearTimeout(hideTimer);
  };
}, []);
```

- [ ] **Step 2: 侧边栏底部渲染 pill**

`<nav className={cn('mt-auto p-2 flex gap-1', ...)}>`(L448)之前插入:

```tsx
{
  downloadPill && (
    <div className="mt-auto px-2 pb-1">
      <button
        type="button"
        onClick={() => router.push(`/${locale}/resources?tab=models`)}
        aria-label={t('downloadPill.aria')}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-full border px-2 py-1.5 text-[11px] transition-colors',
          sidebarExpanded ? '' : 'justify-center',
          downloadPill.status === 'error'
            ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        {downloadPill.status === 'error' ? (
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
        ) : downloadPill.status === 'completed' ? (
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
        )}
        {sidebarExpanded && (
          <span className="truncate">
            {downloadPill.status === 'completed'
              ? t('downloadPill.done', { model: downloadPill.model })
              : downloadPill.status === 'error'
                ? t('downloadPill.failed', { model: downloadPill.model })
                : downloadPill.status === 'extracting'
                  ? t('downloadPill.extracting', {
                      model: downloadPill.model,
                    })
                  : `${downloadPill.model} ${Math.round(downloadPill.progress)}%`}
          </span>
        )}
      </button>
    </div>
  );
}
```

注意:pill 渲染时占了 `mt-auto`,需把原 L448 nav 的 `mt-auto` 改为条件——pill 存在时 nav 不再需要 `mt-auto`。最简做法:nav 的 className 改为:

```tsx
        <nav
          className={cn(
            'p-2 flex gap-1',
            !downloadPill && 'mt-auto',
            sidebarExpanded
              ? 'flex-row items-center justify-between'
              : 'flex-col items-center',
          )}
        >
```

- [ ] **Step 3: i18n key(zh + en)**

zh/common.json 顶层加:

```json
  "downloadPill": {
    "aria": "模型下载进度,点击查看",
    "done": "{{model}} 下载完成",
    "failed": "{{model}} 下载失败",
    "extracting": "{{model}} 解压中"
  },
```

en/common.json:

```json
  "downloadPill": {
    "aria": "Model download progress, click to view",
    "done": "{{model}} downloaded",
    "failed": "{{model}} download failed",
    "extracting": "Extracting {{model}}"
  },
```

- [ ] **Step 4: 门禁 + 实机验证 + Commit**

```bash
node scripts/check-i18n.mjs
cd renderer && npx tsc --noEmit
```

实机:资源中心发起模型下载 → 切到启动台/任务页,侧边栏底部 pill 持续更新百分比 → 点击 pill 跳回模型 Tab → 下载完成 pill 显示完成态 5 秒后消失;取消下载 pill 立即消失;侧边栏收起态只显示旋转图标。

```bash
git add renderer/components/Layout.tsx renderer/public/locales/zh/common.json renderer/public/locales/en/common.json
git commit -m "feat(models): global download progress pill in sidebar"
```

---

## Task 7: 批次收尾——门禁复核 + 进度文档更新

**Files:**

- Modify: `docs/UX_REFACTOR_PROGRESS.md`(批次表加 B13 行、剩余项划掉、候选节更新)

- [ ] **Step 1: 三项门禁全量复核**

```bash
node scripts/check-i18n.mjs
cd renderer && npx tsc --noEmit   # 非测试错误 0
cd .. && npx tsc --noEmit -p tsconfig.json   # main/ ≤95
```

- [ ] **Step 2: 更新进度文档**

`docs/UX_REFACTOR_PROGRESS.md`:

- §3 已完成批次表追加一行:`| 13 | 新手旅程闭环:引导第 4 步示例任务(TTS 内置音频+autostart)、应用内 FAQ、模型下载全局 pill(6.7.1-3) | <commit 列表> |`
- §4 「P2 功能补全」删去已完成三项(示例任务/FAQ/下载 pill)。
- §5 下一批次候选改为:B14 零碎收尾(范围见 roadmap 设计文档 §4)。
- 文档头「最后更新」日期刷新。

- [ ] **Step 3: Commit + interactive_feedback 交接实机验证清单**

```bash
git add docs/UX_REFACTOR_PROGRESS.md
git commit -m "docs: mark B13 newbie journey batch complete in progress handover"
```

通过 interactive_feedback 向用户交付验证清单:

1. 重开引导走到第 4 步,模型已装状态下「运行示例」→ 自动开始 → 看到字幕(纯转写;若已配翻译服务则双语);
2. 未装模型时按钮禁用且有提示;
3. 重复点「运行示例」重建干净示例工程;
4. 帮助菜单 → 常见问题,5 条内容审核(尤其 xattr 命令与 CUDA 描述准确性);
5. 模型下载中离开资源中心,侧边栏 pill 可见、可点、完成/失败/取消三态正确;
6. zh/en 切换 + 暗色模式过一遍新增 UI。

---

## 自审记录(writing-plans Self-Review)

1. **Spec 覆盖**:设计文档 §3.1(示例任务,决策 1A/2A、重复语义、复用工程流)→ Task 1/2/3/4;§3.2(FAQ 4-6 条双语)→ Task 5(5 条);§3.3(pill 全局可见、点击直达、完成失败驻留)→ Task 6;§3.4 验收 → Task 7 交接清单。卡点 #1(状态提升)已被探索结论消解——事件本就全局广播,Layout 直接监听;卡点 #2(TTS 质量)→ Task 1 Step 2 试听验证 + Task 4 实机跑通;卡点 #3(双态路径)→ getExtraResourcesPath 现成函数;卡点 #4(FAQ 准确性)→ Task 7 交接用户终审。
2. **占位符扫描**:无 TBD/TODO;Task 4 Step 1 的 import 注释「此行勿加」是对执行者的明确指令(uuid 不需要,固定 id),非占位。
3. **类型一致性**:`getOnboardingSamplePath`(Task 2 定义,Task 4 调用)、`saveTaskProject` 的 `name`(Task 2 定义,Task 4 传入)、`autostart=1` query(Task 3 定义,Task 4 拼 URL)、`downloadPill.aria/done/failed/extracting` key(Task 6 定义并使用)均一致。
4. **设计偏差说明**:示例工程重复点击语义从「未完成→聚焦/已完成→重建」简化为「存在即重建」——10 秒音频重跑成本趋零,统一重建语义最简且永远是干净演示,已在 Task 4 代码注释中注明。
