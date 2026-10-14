/**
 * 预览黑屏诊断面板（仅诊断安装包里出现）。
 *
 * 放在左侧设置面板的最上方：黑屏正是「鼠标移到这里」时发生的，所以测试的人在复现状态下
 * 就能直接操作它。流程：复现 → 标记黑屏（自动取证）→ 逐项勾选实验看是否恢复 → 标记正常 → 导出诊断包。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  MITIGATE_ALL_FLAGS,
  changedFlags,
  diagLog,
  flushDiagLog,
  resetPreviewDiagFlags,
  setPreviewDiagFlags,
  usePreviewDiagFlags,
  usePreviewDiagInfo,
  type PreviewDiagFlags,
} from '@/lib/previewDiagnostics';
import {
  collectContext,
  runMark,
  startRecorder,
  type LayerReading,
  type MarkOutcome,
} from './recorder';

const TRACE_SECONDS = 6;

function formatLayer(layer: LayerReading | undefined): string {
  if (!layer) return '未测';
  if (!layer.ok || !layer.video) return `未取到（${layer.error ?? '无数据'}）`;
  return `暗像素 ${Math.round(layer.video.darkRatio * 100)}%，平均亮度 ${layer.video.mean}`;
}

function Check({
  flag,
  label,
  hint,
  checked,
  onChange,
}: {
  flag?: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 leading-snug">
      <input
        type="checkbox"
        data-diag-flag={flag}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-amber-600"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {hint && (
          <span className="block text-[11px] text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function Pick<T extends string>({
  flag,
  label,
  value,
  options,
  onChange,
}: {
  flag?: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="min-w-0 leading-snug">{label}</span>
      <select
        data-diag-flag={flag}
        className="h-7 max-w-[55%] shrink-0 rounded border border-input bg-background px-1 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 border-t border-amber-500/30 pt-2">
      <p className="font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}

export default function PreviewDiagnosticsPanel() {
  const info = usePreviewDiagInfo();
  const flags = usePreviewDiagFlags();
  const [sampleRaf, setSampleRaf] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [last, setLast] = useState<{ outcome: MarkOutcome; at: string } | null>(
    null,
  );
  const [presetId, setPresetId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const enabled = Boolean(info?.enabled);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    return startRecorder({ sampleRaf });
  }, [enabled, sampleRaf]);

  const mark = useCallback(async (kind: 'black' | 'normal') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('mark');
    setStatus(
      kind === 'black' ? '正在取证（约 1 秒）……' : '正在记录「正常」基线……',
    );
    const outcome = await runMark(kind);
    setLast({ outcome, at: new Date().toLocaleTimeString() });
    setStatus(
      outcome.ok
        ? kind === 'black'
          ? '已记录。现在可以勾选下面的实验，看画面有没有恢复。'
          : '已记录「正常」基线。'
        : `没有成功：${outcome.error ?? '未知原因'}`,
    );
    busyRef.current = false;
    setBusy(null);
  }, []);

  // F8 / F9：鼠标在视频上（画面正常）时也能采集，不必点面板按钮
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F8') {
        event.preventDefault();
        void mark('black');
      } else if (event.key === 'F9') {
        event.preventDefault();
        void mark('normal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, mark]);

  if (!enabled || !info) return null;

  const set = (patch: Partial<PreviewDiagFlags>) => setPreviewDiagFlags(patch);
  const activeCount = Object.keys(changedFlags(flags)).length;
  const selectedPreset = presetId ?? info.pendingPresetId ?? 'default';
  const run = async (name: string, task: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    try {
      setStatus(await task());
    } catch (error) {
      setStatus(
        `失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const snapshot = () =>
    run('snapshot', async () => {
      const result = await window.ipc.invoke(
        'previewDiag:snapshot',
        collectContext(),
      );
      return result?.ok
        ? `环境快照已保存（${result.file}）。`
        : `快照失败：${result?.error ?? '未知'}`;
    });

  const trace = () =>
    run('trace', async () => {
      const started = await window.ipc.invoke('previewDiag:trace', 'start');
      if (!started?.ok) return `追踪启动失败：${started?.error ?? '未知'}`;
      performance.mark?.('smartsub:trace:start');
      diagLog('trace-ui', { action: 'start' });
      for (let left = TRACE_SECONDS; left > 0; left -= 1) {
        setStatus(
          `追踪录制中，剩余 ${left} 秒：请把鼠标在左侧面板和视频区之间来回移动……`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const stopped = await window.ipc.invoke('previewDiag:trace', 'stop');
      diagLog('trace-ui', { action: 'stop', ok: stopped?.ok });
      return stopped?.ok
        ? `追踪已保存（${stopped.file}，${Math.round((stopped.bytes ?? 0) / 1024)} KB）。`
        : `追踪失败：${stopped?.error ?? '未知'}`;
    });

  const exportBundle = () =>
    run('export', async () => {
      await flushDiagLog();
      const result = await window.ipc.invoke('previewDiag:export');
      if (result?.canceled) return '已取消导出。';
      return result?.ok
        ? `诊断包已导出：${result.file}（${Math.round((result.bytes ?? 0) / 1024)} KB）。`
        : `导出失败：${result?.error ?? '未知'}`;
    });

  const openFolder = () =>
    run('folder', async () => {
      const result = await window.ipc.invoke('previewDiag:openFolder');
      return result?.ok
        ? '已打开日志文件夹。'
        : `打开失败：${result?.error ?? '未知'}`;
    });

  const applyPreset = () =>
    run('preset', async () => {
      const label =
        info.presets?.find((preset) => preset.id === selectedPreset)?.label ??
        selectedPreset;
      if (
        !window.confirm(`将重启应用，以「${label}」的启动参数运行。继续吗？`)
      ) {
        return '已取消。';
      }
      await window.ipc.invoke('previewDiag:setPreset', selectedPreset);
      return '正在重启……';
    });

  return (
    <div
      data-diag-hud
      className="space-y-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-2.5 text-xs text-foreground"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">
          预览黑屏诊断
          <span className="ml-1.5 rounded bg-amber-600 px-1 py-0.5 text-[10px] font-normal text-white">
            测试版
          </span>
        </p>
        <button
          type="button"
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </div>

      <ol className="list-decimal space-y-0.5 pl-4 leading-snug text-muted-foreground">
        <li>把鼠标移到本面板，复现黑屏。</li>
        <li>点「现在是黑屏」（或按 F8），会自动取证。</li>
        <li>勾选下面的实验，看画面是否恢复；再点「现在正常」（F9）。</li>
        <li>最后点「导出诊断包」发给开发者。</li>
      </ol>

      <div className="grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy !== null}
          onClick={() => void mark('black')}
        >
          现在是黑屏 (F8)
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void mark('normal')}
        >
          现在正常 (F9)
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        提示：先把鼠标放在视频上、画面正常时按一次
        F9，作为「正常」基线，判断会更准。
      </p>

      {last && (
        <div className="space-y-0.5 rounded border border-amber-500/40 bg-background/70 p-2 leading-snug">
          <p className="font-medium">
            最近一次：{last.outcome.kind === 'black' ? '黑屏' : '正常'}（
            {last.at}）
          </p>
          {last.outcome.ok ? (
            <>
              <p>系统层（肉眼所见）：{formatLayer(last.outcome.os)}</p>
              <p>合成器层：{formatLayer(last.outcome.viz)}</p>
              {last.outcome.kind === 'black' && last.outcome.verdict && (
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  初判：{last.outcome.verdict.text}
                </p>
              )}
            </>
          ) : (
            <p className="text-destructive">{last.outcome.error}</p>
          )}
        </div>
      )}

      {!collapsed && (
        <>
          <Group
            title={`实验开关（立即生效，一次只改一项）${activeCount ? ` · 已开启 ${activeCount} 项` : ''}`}
          >
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setPreviewDiagFlags({ ...MITIGATE_ALL_FLAGS }, 'mitigate-all')
                }
              >
                全部缓解
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => resetPreviewDiagFlags()}
              >
                还原默认
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              「全部缓解」一次关掉所有怀疑项：若黑屏消失，再逐项还原，找出是哪一项。
            </p>

            <p className="pt-1 text-[11px] font-medium text-muted-foreground">
              JASSUB 字幕引擎
            </p>
            <Check
              flag="disableJassub"
              label="不使用 JASSUB（回退到 CSS 模拟字幕）"
              checked={flags.disableJassub}
              onChange={(value) => set({ disableJassub: value })}
            />
            <Check
              flag="jassubHideCanvas"
              label="隐藏 JASSUB 画布（引擎仍在运行）"
              checked={flags.jassubHideCanvas}
              onChange={(value) => set({ jassubHideCanvas: value })}
            />
            <Check
              flag="boundsReadback"
              label="字幕范围回读（3.9.0 新增，每 100ms）"
              hint="取消勾选 = 关闭回读（字幕拖拽手柄会随之消失）"
              checked={flags.boundsReadback}
              onChange={(value) => set({ boundsReadback: value })}
            />
            <Pick
              flag="jassubDesync"
              label="WebGL desynchronized（默认 true）"
              value={flags.jassubDesync}
              options={[
                { value: 'unchanged', label: '不改' },
                { value: 'false', label: '改为 false' },
              ]}
              onChange={(value) => set({ jassubDesync: value })}
            />
            <Pick
              flag="jassubPower"
              label="WebGL powerPreference（默认 high-performance）"
              value={flags.jassubPower}
              options={[
                { value: 'unchanged', label: '不改' },
                { value: 'default', label: 'default' },
                { value: 'low-power', label: 'low-power' },
              ]}
              onChange={(value) => set({ jassubPower: value })}
            />
            <Pick
              flag="jassubRenderer"
              label="JASSUB 渲染后端"
              value={flags.jassubRenderer}
              options={[
                { value: 'auto', label: '自动（WebGL2）' },
                { value: 'webgl1', label: 'WebGL1' },
                { value: '2d', label: 'Canvas 2D' },
              ]}
              onChange={(value) => set({ jassubRenderer: value })}
            />

            <p className="pt-1 text-[11px] font-medium text-muted-foreground">
              页面层结构
            </p>
            <Check
              flag="subtitleLayer"
              label="字幕拖拽层（SubtitleCanvas）"
              hint="取消勾选 = 整层不挂载"
              checked={flags.subtitleLayer}
              onChange={(value) => set({ subtitleLayer: value })}
            />
            <Pick
              flag="handleMode"
              label="拖拽手柄"
              value={flags.handleMode}
              options={[
                { value: 'hover', label: '悬停显示（默认）' },
                { value: 'pinned', label: '一直显示' },
                { value: 'hidden', label: '不渲染' },
              ]}
              onChange={(value) => set({ handleMode: value })}
            />
            <Check
              flag="ancestorFilter"
              label="视频容器加 filter: opacity(0.999)"
              hint="让视频不走 DirectComposition 叠加层"
              checked={flags.ancestorFilter}
              onChange={(value) => set({ ancestorFilter: value })}
            />
            <Check
              flag="roundedClip"
              label="恢复圆角裁剪（3.8 的样式）"
              checked={flags.roundedClip}
              onChange={(value) => set({ roundedClip: value })}
            />
            <Check
              flag="noHoverScrollbar"
              label="关闭全局悬停滚动条样式"
              checked={flags.noHoverScrollbar}
              onChange={(value) => set({ noHoverScrollbar: value })}
            />
          </Group>

          <Group title="观察">
            <Check
              flag="marker"
              label="在视频区右上角显示时钟"
              hint="黑屏时它还在不在？在 = 黑的只是视频层，不在 = 整块 DOM 都没显示"
              checked={flags.marker}
              onChange={(value) => set({ marker: value })}
            />
            <Check
              label="采样页面帧率（会让页面持续出帧，可能影响现象）"
              checked={sampleRaf}
              onChange={setSampleRaf}
            />
          </Group>

          <Group title="启动参数（需要重启）">
            <p className="text-[11px] leading-snug text-muted-foreground">
              当前：
              {info.presets?.find(
                (preset) => preset.id === info.appliedPresetId,
              )?.label ?? '默认'}
            </p>
            <select
              data-diag-preset
              className="h-7 w-full rounded border border-input bg-background px-1 text-xs"
              value={selectedPreset}
              onChange={(event) => setPresetId(event.target.value)}
            >
              {info.presets?.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {
                info.presets?.find((preset) => preset.id === selectedPreset)
                  ?.detail
              }
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void applyPreset()}
            >
              应用并重启
            </Button>
          </Group>

          <Group title="取证工具">
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void snapshot()}
              >
                环境快照
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void trace()}
              >
                录制 {TRACE_SECONDS} 秒追踪
              </Button>
              <Button
                size="sm"
                variant="default"
                disabled={busy !== null}
                onClick={() => void exportBundle()}
              >
                导出诊断包
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void openFolder()}
              >
                打开日志文件夹
              </Button>
            </div>
          </Group>
        </>
      )}

      <p
        role="status"
        aria-live="polite"
        className="min-h-4 break-all leading-snug text-muted-foreground"
      >
        {status}
      </p>
      <p className="text-[10px] leading-snug text-muted-foreground">
        诊断版 {info.appVersion} · 数据目录 {info.dir}
      </p>
    </div>
  );
}
