import fs from 'fs';
import path from 'path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { GlossaryFileFormat } from '../../types/glossary';
import {
  parseGlossaryContent,
  serializeGlossaryEntries,
} from '../glossary/core';
import {
  GlossaryManagerError,
  createGlossary,
  deleteGlossary,
  deleteGlossaryEntry,
  getGlossary,
  importGlossaryEntries,
  listGlossaries,
  moveGlossary,
  saveGlossaryEntry,
  updateGlossary,
} from './glossaryManager';
import { logMessage, store } from './storeManager';

function errorCode(error: unknown): string {
  if (error instanceof GlossaryManagerError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'glossary';
}

export function setupGlossaryHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('glossaries:list', () => listGlossaries());

  ipcMain.handle('glossaries:create', (_event, input) => {
    try {
      return { success: true, data: createGlossary(input || {}) };
    } catch (error) {
      return { success: false, error: errorCode(error) };
    }
  });

  ipcMain.handle('glossaries:update', (_event, { id, patch }) => {
    try {
      return { success: true, data: updateGlossary(id, patch || {}) };
    } catch (error) {
      return { success: false, error: errorCode(error) };
    }
  });

  ipcMain.handle('glossaries:delete', (_event, id: string) => ({
    success: deleteGlossary(id),
  }));

  ipcMain.handle(
    'glossaries:move',
    (_event, { id, direction }: { id: string; direction: -1 | 1 }) => {
      try {
        return {
          success: true,
          data: moveGlossary(id, direction === -1 ? -1 : 1),
        };
      } catch (error) {
        return { success: false, error: errorCode(error) };
      }
    },
  );

  ipcMain.handle('glossaries:save-entry', (_event, { glossaryId, entry }) => {
    try {
      return {
        success: true,
        data: saveGlossaryEntry(glossaryId, entry || {}),
      };
    } catch (error) {
      return { success: false, error: errorCode(error) };
    }
  });

  ipcMain.handle(
    'glossaries:delete-entry',
    (_event, { glossaryId, entryId }) => ({
      success: deleteGlossaryEntry(glossaryId, entryId),
    }),
  );

  ipcMain.handle('glossaries:import', async (_event, glossaryId: string) => {
    try {
      if (!getGlossary(glossaryId)) {
        return { success: false, error: 'GLOSSARY_NOT_FOUND' };
      }
      const language = store.get('settings')?.language || 'zh';
      const result = await dialog.showOpenDialog(mainWindow, {
        title: language === 'zh' ? '导入词条' : 'Import glossary entries',
        filters: [
          { name: 'CSV / TXT', extensions: ['csv', 'txt'] },
          { name: 'CSV', extensions: ['csv'] },
          { name: 'TXT', extensions: ['txt'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      const filePath = result.filePaths[0];
      const extension = path.extname(filePath).toLowerCase();
      const format: GlossaryFileFormat | null =
        extension === '.csv' ? 'csv' : extension === '.txt' ? 'txt' : null;
      if (!format) return { success: false, error: 'UNSUPPORTED_FILE_TYPE' };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const entries = parseGlossaryContent(content, format);
      if (!entries.length) {
        return { success: false, error: 'NO_VALID_ENTRIES' };
      }
      const imported = importGlossaryEntries(glossaryId, entries);
      logMessage(
        `词库导入完成：${path.basename(filePath)}，新增 ${imported.added}，更新 ${imported.updated}，跳过 ${imported.skipped}`,
        'info',
      );
      return { success: true, data: imported };
    } catch (error) {
      logMessage(`词库导入失败：${errorCode(error)}`, 'error');
      return { success: false, error: errorCode(error) };
    }
  });

  ipcMain.handle(
    'glossaries:export',
    async (
      _event,
      {
        glossaryId,
        format,
      }: { glossaryId: string; format: GlossaryFileFormat },
    ) => {
      try {
        const glossary = getGlossary(glossaryId);
        if (!glossary) {
          return { success: false, error: 'GLOSSARY_NOT_FOUND' };
        }
        const normalizedFormat: GlossaryFileFormat =
          format === 'txt' ? 'txt' : 'csv';
        const language = store.get('settings')?.language || 'zh';
        const result = await dialog.showSaveDialog(mainWindow, {
          title: language === 'zh' ? '导出词库' : 'Export glossary',
          defaultPath: `${safeFileName(glossary.name)}.${normalizedFormat}`,
          filters: [
            {
              name: normalizedFormat.toUpperCase(),
              extensions: [normalizedFormat],
            },
          ],
        });
        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true };
        }
        const serialized = serializeGlossaryEntries(
          glossary.entries,
          normalizedFormat,
        );
        await fs.promises.writeFile(
          result.filePath,
          normalizedFormat === 'csv' ? `\uFEFF${serialized}` : serialized,
          'utf-8',
        );
        logMessage(
          `词库「${glossary.name}」已导出：${result.filePath}`,
          'info',
        );
        return { success: true, data: { filePath: result.filePath } };
      } catch (error) {
        logMessage(`词库导出失败：${errorCode(error)}`, 'error');
        return { success: false, error: errorCode(error) };
      }
    },
  );

  ipcMain.handle('glossaries:export-template', async () => {
    try {
      const language = store.get('settings')?.language || 'zh';
      const result = await dialog.showSaveDialog(mainWindow, {
        title:
          language === 'zh'
            ? '导出词库导入模板'
            : 'Export glossary import template',
        defaultPath: 'glossary-import-template.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      const serialized = serializeGlossaryEntries([], 'csv');
      await fs.promises.writeFile(
        result.filePath,
        `\uFEFF${serialized}`,
        'utf-8',
      );
      logMessage(`词库 CSV 导入模板已导出：${result.filePath}`, 'info');
      return { success: true, data: { filePath: result.filePath } };
    } catch (error) {
      logMessage(`词库 CSV 导入模板导出失败：${errorCode(error)}`, 'error');
      return { success: false, error: errorCode(error) };
    }
  });

  logMessage('词库 IPC 处理函数已注册', 'info');
}
