/**
 * 人工检查点管理：到闸系统通知（任务×闸门聚合节流）与放行派发。
 */

import { BrowserWindow, Notification } from 'electron';
import { logMessage, store } from '../storeManager';
import { getWorkItemById, saveWorkItem } from '../workItemStore';
import { enqueueProjectFiles } from '../taskProcessor';
import {
  GATE_FIELD,
  filterReleasableFiles,
  countReviewFiles,
  type GateKind,
} from './gateLogic';
import type { IFiles } from '../../../types';

/** 到闸通知聚合窗口（同任务同闸门在窗口内合并为一条） */
const NOTIFY_DEBOUNCE_MS = 5000;

const pendingNotify = new Map<string, NodeJS.Timeout>();

function isZh(): boolean {
  return (store.get('settings')?.language || 'zh') === 'zh';
}

function gateLabel(gate: GateKind): string {
  if (isZh()) return gate === 'subtitle' ? '字幕校对' : '配音确认';
  return gate === 'subtitle' ? 'subtitle review' : 'dubbing review';
}

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 文件到闸通知：按「任务×闸门」聚合节流；触发时按工作项当前 review 数出文案。
 * 应用前台时不打扰（任务列表的高亮与聚合操作条已足够）。
 */
export function notifyGateReview(projectId: string, gate: GateKind): void {
  const key = `${projectId}:${gate}`;
  if (pendingNotify.has(key)) return;
  pendingNotify.set(
    key,
    setTimeout(() => {
      pendingNotify.delete(key);
      try {
        const win = BrowserWindow.getAllWindows()[0];
        if (win?.isFocused()) return;
        if (!Notification.isSupported()) return;
        const item = getWorkItemById(projectId);
        if (!item) return;
        const counts = countReviewFiles((item.pipelineFiles ?? []) as IFiles[]);
        const count = gate === 'subtitle' ? counts.subtitle : counts.dubbing;
        if (count <= 0) return;
        const name = item.name || projectId;
        const notification = new Notification({
          title: isZh()
            ? `等待${gateLabel(gate)}`
            : `Waiting for ${gateLabel(gate)}`,
          body: isZh()
            ? `「${name}」有 ${count} 个文件等待${gateLabel(gate)}，处理后将自动继续`
            : `"${name}" has ${count} file(s) waiting for ${gateLabel(gate)}; they continue automatically once released`,
        });
        notification.on('click', focusMainWindow);
        notification.show();
      } catch (error) {
        logMessage(`notifyGateReview error: ${error}`, 'warning');
      }
    }, NOTIFY_DEBOUNCE_MS),
  );
}

export interface ReleaseGateResult {
  released: number;
  dispatched: boolean;
}

/**
 * 放行：仅 review→passed（并发保护），落库后按任务配置快照重新派发续跑。
 */
export function releaseGate(
  projectId: string,
  gate: GateKind,
  fileUuids?: string[],
): ReleaseGateResult | { error: string } {
  const item = getWorkItemById(projectId);
  if (!item || !Array.isArray(item.pipelineFiles)) {
    return { error: 'task not found' };
  }
  const snapshot = item.configSnapshot as Record<string, unknown> | undefined;
  if (!snapshot || (!snapshot.dub && !snapshot.compose)) {
    return { error: 'task has no config snapshot' };
  }

  const field = GATE_FIELD[gate];
  const targets = filterReleasableFiles(
    item.pipelineFiles as IFiles[],
    gate,
    fileUuids,
  );
  if (!targets.length) return { released: 0, dispatched: false };

  const targetUuids = new Set(targets.map((f) => f.uuid));
  const updatedFiles = (item.pipelineFiles as IFiles[]).map((file) =>
    targetUuids.has(file.uuid) ? { ...file, [field]: 'passed' as const } : file,
  );
  saveWorkItem({ ...item, pipelineFiles: updatedFiles });

  const releasedFiles = updatedFiles.filter((file) =>
    targetUuids.has(file.uuid),
  );
  const dispatched = enqueueProjectFiles(projectId, releasedFiles, snapshot);
  logMessage(
    `gate released: ${gate} × ${releasedFiles.length} file(s) in ${projectId} (dispatched=${dispatched})`,
    'info',
  );
  return { released: releasedFiles.length, dispatched };
}
