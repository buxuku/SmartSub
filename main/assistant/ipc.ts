import path from 'path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import { store } from '../helpers/store';
import type { AutomationService } from '../automation/service';
import type {
  AssistantContextSnapshot,
  EditorCommand,
  EditorCommandResult,
} from '../../types/assistant';
import { AssistantSessionStore } from './sessionStore';
import { requestAssistant, supportsAssistant } from './provider';
import { AssistantRuntime } from './runtime';
import { assistantData } from './protocol';
import { guardEditorFiles } from './editorGuard';
import { AssistantAttachments } from './attachments';
import { ASSISTANT_ATTACHMENT_EXTENSIONS } from '../../types/assistantAttachments';
import { ASSISTANT_MAX_ATTACHMENTS } from '../../types/assistant';

const id = z.string().uuid();
const contextSchema = z
  .object({
    page: z.string().max(2000),
    capturedAt: z.number(),
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
    files: z.array(z.string()).max(1000).optional(),
    task: z.record(z.unknown()).optional(),
    recentErrors: z.array(z.string().max(2000)).max(10).optional(),
    editor: z
      .object({
        documentId: z.string().max(10000),
        revision: z.string().max(200),
        files: z.array(z.string()).max(10),
        dirty: z.boolean(),
        selectedIndex: z.number().int(),
        currentTime: z.number(),
        total: z.number().int(),
        sourceLanguage: z.string().optional(),
        targetLanguage: z.string().optional(),
        editableFields: z
          .array(z.enum(['sourceContent', 'targetContent']))
          .max(2),
        cues: z
          .array(
            z.object({
              index: z.number().int(),
              sourceContent: z.string(),
              targetContent: z.string(),
              start: z.number().optional(),
              end: z.number().optional(),
            }),
          )
          .max(100),
      })
      .optional(),
  })
  .strict();

export function setupAssistantHandlers(service: AutomationService) {
  const attachments = new AssistantAttachments(
    path.join(app.getPath('userData'), 'assistant', 'attachments'),
  );
  const sessions = new AssistantSessionStore(
    path.join(app.getPath('userData'), 'assistant', 'sessions'),
  );
  const windows = new Map<number, WebContents>();
  const contexts = new Map<number, AssistantContextSnapshot>();
  const pending = new Map<
    string,
    {
      owner: number;
      resolve: (value: EditorCommandResult) => void;
      reject: (error: Error) => void;
    }
  >();
  const send = (_owner: number, event: unknown) => {
    for (const sender of windows.values())
      if (!sender.isDestroyed()) sender.send('assistant:event', event);
  };
  const changed = (operation: string) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('assistant:event', {
        type: 'changed',
        operation,
      });
  };
  // Manual saves and imported configuration must refresh an already open panel too.
  const stopWatchingProviders = store.onDidChange('translationProviders', () =>
    changed('providers.update'),
  );
  const runtime = new AssistantRuntime({
    sessions,
    provider(providerId) {
      const provider = (store.get('translationProviders') || []).find(
        (p) => p.id === providerId,
      );
      if (!provider || !supportsAssistant(provider))
        throw new Error('ASSISTANT_PROVIDER_UNAVAILABLE');
      return structuredClone(provider);
    },
    call: (operation, args, options) => service.call(operation, args, options),
    request: requestAssistant,
    emit: send,
    changed,
    guard(operation, args) {
      guardEditorFiles(operation, args, contexts.values());
    },
    editor(owner, command, signal) {
      return new Promise((resolve, reject) => {
        const sender = windows.get(owner);
        if (signal.aborted || !sender || sender.isDestroyed())
          return reject(new Error('EDITOR_UNAVAILABLE'));
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          pending.delete(command.id);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const abort = () => fail(new Error('RUN_STOPPED'));
        const timer = setTimeout(
          () =>
            fail(
              new Error(
                'EDITOR_RESULT_UNKNOWN: Inspect the document before retrying.',
              ),
            ),
          30000,
        );
        signal.addEventListener('abort', abort, { once: true });
        pending.set(command.id, {
          owner,
          resolve: (value) => {
            cleanup();
            resolve(value);
          },
          reject: fail,
        });
        sender.send(
          'assistant:editor-command',
          command satisfies EditorCommand,
        );
      });
    },
    async captureScreen(owner, options, signal) {
      const sender = windows.get(owner);
      if (!sender || sender.isDestroyed())
        throw new Error('WINDOW_UNAVAILABLE');
      return captureWorkspaceScreen(sender, options, signal);
    },
  });
  async function captureWorkspaceScreen(
    sender: WebContents,
    options: { region?: 'workspace' | 'full' } = {},
    signal?: AbortSignal,
  ) {
    if (signal?.aborted || sender.isDestroyed())
      throw new Error('WINDOW_UNAVAILABLE');
    const win = BrowserWindow.fromWebContents(sender);
    let rect: Electron.Rectangle | undefined;
    if (options.region !== 'full' && win) {
      const [winWidth, winHeight] = win.getContentSize();
      if (winWidth > 600) {
        rect = {
          x: 0,
          y: 0,
          width: Math.max(360, winWidth - 440),
          height: winHeight,
        };
      }
    }
    const nativeImage = rect
      ? await sender.capturePage(rect)
      : await sender.capturePage();
    if (signal?.aborted) throw new Error('RUN_STOPPED');
    const size = nativeImage.getSize();
    let target = nativeImage;
    if (size.width > 1280) {
      const targetWidth = 1280;
      const targetHeight = Math.round((size.height * targetWidth) / size.width);
      target = nativeImage.resize({
        width: targetWidth,
        height: targetHeight,
        quality: 'better',
      });
    }
    const buffer = target.toJPEG(85);
    const attachment = await attachments.saveBuffer(
      buffer,
      'jpeg',
      `screenshot-${Date.now()}.jpg`,
    );
    const finalSize = target.getSize();
    return {
      attachment,
      attachmentId: attachment.id,
      imagePath: attachment.imagePath!,
      mimeType: attachment.mimeType!,
      width: finalSize.width,
      height: finalSize.height,
    };
  }
  function register(sender: WebContents) {
    if (windows.has(sender.id)) return;
    windows.set(sender.id, sender);
    const disconnect = () => {
      runtime.disconnect(sender.id);
      contexts.delete(sender.id);
      for (const receipt of pending.values())
        if (receipt.owner === sender.id)
          receipt.reject(new Error('EDITOR_UNAVAILABLE'));
    };
    sender.on(
      'did-start-navigation',
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) disconnect();
      },
    );
    sender.on('render-process-gone', disconnect);
    sender.once('destroyed', () => {
      disconnect();
      windows.delete(sender.id);
    });
  }
  const handle = (name: string, fn: (sender: WebContents, args: any) => any) =>
    ipcMain.handle(`assistant:${name}`, async (event, args) => {
      register(event.sender);
      return assistantData(await fn(event.sender, args));
    });
  handle('providers', () =>
    (store.get('translationProviders') || [])
      .filter(supportsAssistant)
      .map(({ id, name, modelName }) => ({ id, name, modelName })),
  );
  handle('attachments', async (sender, args) => {
    let paths = z
      .array(z.string())
      .max(ASSISTANT_MAX_ATTACHMENTS)
      .optional()
      .parse(args?.paths);
    if (!paths) {
      const owner = BrowserWindow.fromWebContents(sender);
      const options = {
        filters: [
          {
            name: 'SmartSub files and images',
            extensions: ASSISTANT_ATTACHMENT_EXTENSIONS,
          },
        ],
        properties: ['openFile', 'multiSelections'] as (
          | 'openFile'
          | 'multiSelections'
        )[],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return { attachments: [], errors: [] };
      paths = result.filePaths;
    }
    if (paths.length > ASSISTANT_MAX_ATTACHMENTS)
      throw new Error('ATTACHMENT_LIMIT');
    const imported = [];
    const errors = [];
    for (const filePath of paths) {
      try {
        imported.push(await attachments.import(filePath));
      } catch (error) {
        errors.push({
          name: path.basename(filePath),
          code: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { attachments: imported, errors };
  });
  handle('capture-screen', async (sender, args) => {
    const region = args?.region === 'full' ? 'full' : 'workspace';
    const result = await captureWorkspaceScreen(sender, { region });
    return result.attachment;
  });
  handle('list', () => sessions.list());
  handle('create', (_, args) =>
    sessions.create(z.string().parse(args?.providerId || '')),
  );
  handle('get', (_, args) => sessions.get(id.parse(args?.id)));
  handle('delete', (_, args) => {
    sessions.delete(id.parse(args?.id));
    return true;
  });
  handle('start', async (sender, args) => {
    const input = z
      .object({
        id,
        providerId: z.string().min(1),
        text: z.string().trim().min(1).max(20000),
        context: contextSchema.optional(),
        attachmentIds: z
          .array(z.string().uuid())
          .max(ASSISTANT_MAX_ATTACHMENTS)
          .optional(),
      })
      .strict()
      .parse(args);
    if (JSON.stringify(input.context || {}).length > 100000)
      throw new Error('CONTEXT_TOO_LARGE');
    if (input.context)
      contexts.set(sender.id, input.context as AssistantContextSnapshot);
    return runtime.start(
      sender.id,
      input.id,
      input.providerId,
      input.text,
      input.context as AssistantContextSnapshot | undefined,
      await Promise.all(
        (input.attachmentIds || []).map((id) => attachments.get(id)),
      ),
    );
  });
  handle('stop', (_, args) => {
    runtime.stop(id.parse(args?.id));
    return true;
  });
  handle('context', (sender, args) => {
    if (!args) contexts.delete(sender.id);
    else
      contexts.set(
        sender.id,
        contextSchema.parse(args) as AssistantContextSnapshot,
      );
    return true;
  });
  handle('editor-result', (sender, args) => {
    const entry = pending.get(args?.id);
    if (!entry || entry.owner !== sender.id) return false;
    if (args.error) entry.reject(new Error(String(args.error)));
    else {
      try {
        const context = contextSchema.parse(
          args.result?.context,
        ) as AssistantContextSnapshot;
        contexts.set(sender.id, context);
        entry.resolve({ ...args.result, context });
      } catch {
        entry.reject(new Error('INVALID_EDITOR_RESULT'));
      }
    }
    return true;
  });
  handle('task', (_, args) =>
    service.call('tasks.get', { id: z.string().min(1).parse(args?.id) }),
  );
  handle('cancel-task', (_, args) =>
    service.call('tasks.cancel', { id: z.string().min(1).parse(args?.id) }),
  );
  app.once('will-quit', () => {
    stopWatchingProviders();
    runtime.shutdown();
  });
  return runtime;
}
