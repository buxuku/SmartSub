import { randomUUID } from 'crypto';
import type { Provider } from '../../types/provider';
import type {
  AssistantContextSnapshot,
  AssistantAttachment,
  AssistantMessage,
  AssistantRunEvent,
  AssistantSession,
  EditorCommand,
  EditorCommandResult,
} from '../../types/assistant';
import type { AutomationJob } from '../../types/automation';
import type { AutomationCallOptions } from '../automation/pipelineConfig';
import { operations, operationMap, toolName } from '../../automation/catalog';
import { redact, safeMessage } from '../../automation/redact';
import { AssistantSessionStore } from './sessionStore';
import {
  assistantTools,
  coreDefinitions,
  SYSTEM_PROMPT,
  toolDefinition,
  toolOperations,
} from './tools';
import {
  assistantData,
  sessionMessages,
  type ModelMessage,
  type ModelReply,
} from './protocol';

export interface AssistantDependencies {
  sessions: AssistantSessionStore;
  provider(id: string): Provider;
  call(
    operation: string,
    input: unknown,
    options?: AutomationCallOptions,
  ): Promise<any>;
  request(
    provider: Provider,
    messages: ModelMessage[],
    tools: any[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<ModelReply>;
  editor(
    owner: number,
    command: EditorCommand,
    signal: AbortSignal,
  ): Promise<EditorCommandResult>;
  captureScreen?(
    owner: number,
    options: { region: 'workspace' | 'full' },
    signal: AbortSignal,
  ): Promise<{
    attachmentId: string;
    imagePath: string;
    mimeType: string;
    width: number;
    height: number;
  }>;
  guard(operation: string, args: any): void;
  emit(owner: number, event: AssistantRunEvent): void;
  changed(operation: string): void;
}

export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('RUN_STOPPED'));
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('RUN_STOPPED'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class AssistantRuntime {
  private runs = new Map<
    string,
    { owner: number; controller: AbortController; done: Promise<void> }
  >();
  constructor(readonly deps: AssistantDependencies) {}
  stop(id: string) {
    this.runs.get(id)?.controller.abort();
  }
  disconnect(owner: number) {
    for (const run of this.runs.values())
      if (run.owner === owner) run.controller.abort();
  }
  shutdown() {
    for (const run of this.runs.values()) run.controller.abort();
  }
  async wait(id: string) {
    await this.runs.get(id)?.done;
  }
  start(
    owner: number,
    id: string,
    providerId: string,
    text: string,
    context?: AssistantContextSnapshot,
    attachments?: AssistantAttachment[],
  ) {
    if (this.runs.has(id)) throw new Error('SESSION_BUSY');
    if ([...this.runs.values()].some((run) => run.owner === owner))
      throw new Error('WINDOW_BUSY');
    const provider = this.deps.provider(providerId);
    const session = this.deps.sessions.get(id);
    const previous = {
      providerId: session.providerId,
      title: session.title,
      status: session.status,
      error: session.error,
    };
    const turnId = randomUUID();
    session.providerId = providerId;
    session.title ||= text.slice(0, 60);
    session.error = undefined;
    session.status = 'running';
    session.messages.push({
      id: randomUUID(),
      turnId,
      role: 'user',
      content: text,
      context: context ? redact(context) : undefined,
      attachments,
      createdAt: Date.now(),
    });
    try {
      this.publish(owner, session);
    } catch (error) {
      session.messages.pop();
      Object.assign(session, previous);
      throw error;
    }
    const controller = new AbortController();
    // Defer execution until the run is registered, including synchronous test transports.
    const done = Promise.resolve().then(() =>
      this.execute(
        owner,
        session,
        turnId,
        provider,
        context,
        controller.signal,
      ),
    );
    this.runs.set(id, { owner, controller, done });
    return { sessionId: id, turnId };
  }
  private publish(owner: number, session: AssistantSession) {
    this.deps.sessions.save(session);
    this.deps.emit(owner, { type: 'session', session: assistantData(session) });
  }
  private async execute(
    owner: number,
    session: AssistantSession,
    turnId: string,
    provider: Provider,
    initialContext: AssistantContextSnapshot | undefined,
    signal: AbortSignal,
  ) {
    let context = initialContext ? structuredClone(initialContext) : undefined;
    const loaded = new Set<string>();
    const receipts = new Map<
      string,
      { fingerprint: string; result: unknown }
    >();
    // Some compatible reasoning models require opaque protocol state on tool continuations.
    // Keep it only in this run, never in UI messages or on disk.
    const protocolState = new Map<
      string,
      { reasoning?: string; extra?: unknown }
    >();
    let current: AssistantMessage | undefined;
    try {
      for (let iteration = 0; iteration < 20; iteration++) {
        if (signal.aborted) throw new Error('RUN_STOPPED');
        const messages: ModelMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...sessionMessages(session),
        ];
        for (const message of messages) {
          if (!message.tool_calls?.length) continue;
          const state = protocolState.get(message.tool_calls[0].id);
          if (state?.reasoning) message.reasoning_content = state.reasoning;
          for (const call of message.tool_calls) {
            const extra = protocolState.get(call.id)?.extra;
            if (extra) call.extra_content = extra;
          }
        }
        if (context)
          messages.push({
            role: 'user',
            content: `Current revision of captured workspace DATA:\n${JSON.stringify(redact(context))}`,
          });
        if (JSON.stringify(messages).length > 100000) {
          session.status = 'limited';
          break;
        }
        current = {
          id: randomUUID(),
          turnId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
        };
        session.messages.push(current);
        this.publish(owner, session);
        const reply = await this.deps.request(
          provider,
          messages,
          [
            ...coreDefinitions,
            ...[...loaded].map((name) => {
              const op = operationMap.get(name)!;
              return toolDefinition(toolName(name), op.description, op.schema);
            }),
          ],
          signal,
          (text) => {
            current!.content += text;
            this.deps.emit(owner, {
              type: 'delta',
              sessionId: session.id,
              messageId: current!.id,
              text,
            });
          },
        );
        current.content = reply.content;
        if (signal.aborted) throw new Error('RUN_STOPPED');
        if (!reply.calls.length) {
          session.status = 'idle';
          break;
        }
        reply.calls.forEach((call) =>
          protocolState.set(call.id, {
            reasoning: reply.reasoningContent,
            extra: call.extra_content,
          }),
        );
        current.tools = reply.calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: (() => {
            try {
              return JSON.stringify(redact(JSON.parse(call.arguments || '{}')));
            } catch {
              return '[INVALID_ARGUMENTS]';
            }
          })(),
          status: 'running',
        }));
        this.publish(owner, session);
        for (const [toolIndex, tool] of current.tools.entries()) {
          if (signal.aborted) throw new Error('RUN_STOPPED');
          try {
            const rawArguments = reply.calls[toolIndex].arguments;
            const fingerprint = `${tool.name}:${rawArguments}`;
            const receipt = receipts.get(tool.id);
            if (receipt) {
              if (receipt.fingerprint !== fingerprint)
                throw new Error('TOOL_CALL_ID_CONFLICT');
              tool.result = receipt.result;
              tool.status = 'completed';
              this.publish(owner, session);
              continue;
            }
            const raw = JSON.parse(rawArguments || '{}');
            const internal = assistantTools.find(
              (candidate) => candidate.name === tool.name,
            );
            let result: any;
            if (internal) {
              const args = internal.schema.parse(raw) as any;
              if (tool.name === 'assistant_discover_tools') {
                const query = args.query.toLowerCase();
                const found = operations.filter(
                  (op) =>
                    !query ||
                    `${op.name} ${op.description}`
                      .toLowerCase()
                      .includes(query),
                );
                result = {
                  total: found.length,
                  operations: found
                    .slice(args.offset, args.offset + args.limit)
                    .map((op) => ({
                      name: op.name,
                      description: op.description,
                      readOnly: op.readOnly,
                      asynchronous: !!op.long,
                    })),
                };
              } else if (tool.name === 'assistant_load_tools') {
                for (const name of args.names)
                  if (!operationMap.has(name))
                    throw new Error(`UNKNOWN_OPERATION: ${name}`);
                for (const name of args.names) {
                  loaded.delete(name);
                  loaded.add(name);
                }
                while (loaded.size > 24)
                  loaded.delete(loaded.values().next().value!);
                result = {
                  loaded: args.names.map((name: string) => ({
                    operation: name,
                    tool: toolName(name),
                  })),
                };
              } else if (tool.name === 'assistant_context')
                result = context || { available: false };
              else if (tool.name === 'assistant_capture_screen') {
                if (!this.deps.captureScreen)
                  throw new Error('CAPTURE_SCREEN_UNAVAILABLE');
                const screen = await this.deps.captureScreen(
                  owner,
                  args,
                  signal,
                );
                result = {
                  ok: true,
                  region: args.region,
                  width: screen.width,
                  height: screen.height,
                  page: context?.page,
                  recentErrors: context?.recentErrors,
                  screenshot: {
                    attachmentId: screen.attachmentId,
                    imagePath: screen.imagePath,
                    mimeType: screen.mimeType,
                    width: screen.width,
                    height: screen.height,
                  },
                };
              } else {
                if (
                  !context?.editor ||
                  args.documentId !== context.editor.documentId ||
                  args.expectedRevision !== context.editor.revision
                )
                  throw new Error('EDITOR_CONTEXT_CONFLICT');
                const editorResult = await this.deps.editor(
                  owner,
                  {
                    ...args,
                    id: randomUUID(),
                    kind: tool.name.slice('assistant_editor_'.length),
                  },
                  signal,
                );
                context = editorResult.context;
                result = editorResult;
              }
            } else {
              const op = toolOperations.get(tool.name);
              if (!op || !loaded.has(op.name))
                throw new Error('TOOL_NOT_LOADED');
              const args = op.schema.parse(raw);
              if ('requestId' in op.schema.shape)
                args.requestId = `${turnId}:${tool.id}`.slice(0, 128);
              this.deps.guard(op.name, args);
              result = assistantData(
                await this.deps.call(op.name, args, {
                  assistantProviderId: provider.id,
                }),
              );
              const startsJob = op.long || op.name === 'tasks.retry';
              if (!op.readOnly && startsJob) this.deps.changed(op.name);
              // Persist the receipt before waiting, so a restart never loses the submitted job ID.
              tool.result = redact(result);
              if (startsJob && result?.id) {
                tool.job = result as AutomationJob;
                this.publish(owner, session);
                while (
                  ![
                    'completed',
                    'failed',
                    'cancelled',
                    'interrupted',
                    'review',
                  ].includes(result.status)
                ) {
                  await abortableDelay(1000, signal);
                  result = assistantData(
                    await this.deps.call('tasks.get', { id: result.id }),
                  );
                  tool.job = result;
                  this.publish(owner, session);
                }
              }
              if (!op.readOnly) this.deps.changed(op.name);
            }
            tool.result = assistantData(result);
            tool.status = result?.status === 'failed' ? 'failed' : 'completed';
            receipts.set(tool.id, { fingerprint, result: tool.result });
          } catch (error) {
            if (signal.aborted) throw error;
            tool.status = 'failed';
            tool.result = {
              error: safeMessage(
                error instanceof Error ? error.message : error,
              ),
            };
          }
          this.publish(owner, session);
        }
        if (iteration === 19) session.status = 'limited';
      }
    } catch (error) {
      session.status = signal.aborted ? 'interrupted' : 'failed';
      session.error = signal.aborted
        ? undefined
        : safeMessage(error instanceof Error ? error.message : error);
      for (const tool of current?.tools || [])
        if (tool.status === 'running') tool.status = 'interrupted';
    } finally {
      this.runs.delete(session.id);
      try {
        this.publish(owner, session);
      } catch (error) {
        session.status = 'failed';
        session.error = `HISTORY_SAVE_FAILED: ${safeMessage(error)}`;
        this.deps.emit(owner, {
          type: 'session',
          session: assistantData(session),
        });
      }
    }
  }
}
