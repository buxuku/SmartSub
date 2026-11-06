import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { mock } from 'node:test';
import { AssistantSessionStore } from '../main/assistant/sessionStore';
import {
  AssistantRuntime,
  abortableDelay,
  type AssistantDependencies,
} from '../main/assistant/runtime';
import {
  assistantData,
  collectReply,
  sessionMessages,
  type ModelReply,
} from '../main/assistant/protocol';
import { createAssistantEditor } from '../renderer/lib/assistantEditor';
import { operations } from '../automation/catalog';
import { guardEditorFiles } from '../main/assistant/editorGuard';
import { AssistantAttachments } from '../main/assistant/attachments';
import { modelRequestMessages } from '../main/assistant/messageContent';

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartsub-assistant-'));
const call = (id: string, name: string, args: unknown): ModelReply => ({
  content: '',
  calls: [{ id, name, arguments: JSON.stringify(args) }],
});
const answer: ModelReply = { content: 'Done', calls: [] };
let count = 0;
async function test(name: string, run: () => Promise<void> | void) {
  await run();
  count++;
  console.log(`✓ ${name}`);
}
function fixture(overrides: Partial<AssistantDependencies> = {}) {
  const sessions = new AssistantSessionStore(
    path.join(directory, `history-${count}`),
  );
  const session = sessions.create('fixture');
  const events: any[] = [];
  const deps: AssistantDependencies = {
    sessions,
    provider: () => ({
      id: 'fixture',
      name: 'Fixture',
      type: 'openai',
      isAi: true,
    }),
    call: async () => ({ ok: true }),
    request: async () => answer,
    editor: async () => {
      throw new Error('EDITOR_UNAVAILABLE');
    },
    captureScreen: async () => ({
      attachmentId: 'fixture-screenshot-id',
      imagePath: path.join(directory, 'fixture-screenshot.jpg'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
    }),
    guard: () => {},
    emit: (_, event) => events.push(structuredClone(event)),
    changed: () => {},
    ...overrides,
  };
  return { sessions, session, events, runtime: new AssistantRuntime(deps) };
}

async function main() {
  await test('the active chat provider is passed as trusted context for shared task resolution', async () => {
    let requests = 0;
    let submitted = false;
    const f = fixture({
      request: async () =>
        requests++ === 0
          ? call('load-refine', 'assistant_load_tools', {
              names: ['transcribe'],
            })
          : requests === 2
            ? call('refine', 'smartsub_transcribe', {
                files: ['/voice.wav'],
                config: { aiSegmentation: true },
              })
            : answer,
      call: async (operation, args: any, options) => {
        assert.equal(operation, 'transcribe');
        assert.equal(options?.assistantProviderId, 'fixture');
        assert.equal(args.config.aiSegmentation, true);
        assert.equal(args.config.refineProvider, undefined);
        assert.equal(args.assistantProviderId, undefined);
        submitted = true;
        return { id: 'refined', status: 'completed', artifacts: [] };
      },
    });
    f.runtime.start(
      1,
      f.session.id,
      'fixture',
      'Transcribe with AI segmentation',
    );
    await f.runtime.wait(f.session.id);
    assert.equal(f.session.status, 'idle');
    assert.equal(submitted, true);
  });
  await test('only supported files are accepted and only images retain content', async () => {
    const storage = new AssistantAttachments(
      path.join(directory, 'attachments'),
    );
    const image = path.join(directory, 'image.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    fs.writeFileSync(image, png);
    const attachedImage = await storage.import(image);
    fs.unlinkSync(image);
    const messages = await modelRequestMessages([
      {
        role: 'user',
        content: 'Describe',
        images: [
          { path: attachedImage.imagePath!, mimeType: attachedImage.mimeType! },
        ],
      },
    ]);
    assert.equal(
      (messages[0].content as any[])[1].image_url.url,
      `data:image/png;base64,${png.toString('base64')}`,
    );
    const binary = path.join(directory, 'archive.bin');
    fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
    await assert.rejects(storage.import(binary), /ATTACHMENT_UNSUPPORTED/);
    for (const name of [
      'document.pdf',
      'document.docx',
      'sheet.csv',
      'script.py',
      'page.html',
    ]) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, 'content');
      await assert.rejects(storage.import(file), /ATTACHMENT_UNSUPPORTED/);
    }
    fs.writeFileSync(image, png);
    fs.truncateSync(image, 6 * 1024 * 1024);
    await assert.rejects(storage.import(image), /ATTACHMENT_TOO_LARGE/);
    await assert.rejects(storage.import(directory), /NOT_FILE/);
    await assert.rejects(
      storage.import('relative.md'),
      /INVALID_ATTACHMENT_PATH/,
    );
    await assert.rejects(storage.get('../escape'), /INVALID_ATTACHMENT/);
  });
  await test('supported non-image attachments send paths only and can drive shared MCP tasks without workspace context', async () => {
    const storagePath = path.join(directory, 'media-attachments');
    const storage = new AssistantAttachments(storagePath);
    const marker = 'MEDIA_BYTES_MUST_NOT_REACH_THE_CHAT_MODEL';
    const files = [
      'video with spaces.MP4',
      'voice recording.wav',
      'subtitles.srt',
      'reference.md',
      'proofread.json',
    ].map((name) => path.join(directory, name));
    for (const file of files) {
      fs.writeFileSync(file, marker);
      fs.truncateSync(file, 24 * 1024 * 1024);
    }
    const open = mock.method(fs.promises, 'open', async () => {
      throw new Error('Media attachments must not read file content');
    });
    let attachments: Awaited<ReturnType<typeof storage.import>>[];
    try {
      attachments = await Promise.all(
        files.map((file) => storage.import(file)),
      );
      assert.equal(open.mock.callCount(), 0);
    } finally {
      open.mock.restore();
    }
    assert.deepEqual(
      attachments.map((file) => file.kind),
      ['video', 'audio', 'file', 'file', 'file'],
    );
    assert.deepEqual(
      attachments.map((file) => file.path),
      files,
    );
    assert.equal(fs.readdirSync(storagePath).length, 5);
    for (const attachment of attachments) {
      assert.equal(attachment.size, 24 * 1024 * 1024);
      assert.deepEqual(Object.keys(attachment).sort(), [
        'id',
        'kind',
        'name',
        'path',
        'size',
      ]);
      assert.ok(
        fs.statSync(path.join(storagePath, `${attachment.id}.json`)).size <
          1024,
      );
    }
    let requests = 0;
    const submitted: any[] = [];
    const f = fixture({
      request: async (_, messages) => {
        const wire = await modelRequestMessages(messages);
        const serialized = JSON.stringify(wire);
        assert.ok(!serialized.includes(marker));
        assert.ok(!serialized.includes(Buffer.from(marker).toString('base64')));
        assert.ok(!serialized.includes('Workspace data'));
        assert.ok(
          wire.every(
            (message) =>
              typeof message.content === 'string' || message.content === null,
          ),
        );
        const message = messages.find((message) =>
          message.content?.startsWith('Attached files'),
        )!;
        const refs = JSON.parse(
          message.content!.split('\n').slice(1).join('\n'),
        );
        assert.deepEqual(
          refs.map((file) => file.path),
          files,
        );
        assert.ok(
          refs.every(
            (file) =>
              Object.keys(file).sort().join(',') === 'id,kind,name,path,size',
          ),
        );
        switch (requests++) {
          case 0:
            return call('load-media', 'assistant_load_tools', {
              names: ['transcribe'],
            });
          case 1:
            return call('transcribe-media', 'smartsub_transcribe', {
              files: refs.slice(0, 2).map((file) => file.path),
            });
          default:
            return answer;
        }
      },
      call: async (operation, args: any) => {
        submitted.push({ operation, files: args.files });
        return {
          id: 'media-job',
          status: 'completed',
          artifacts: [
            { kind: 'srt', path: path.join(directory, 'result.srt') },
          ],
        };
      },
    });
    f.runtime.start(
      1,
      f.session.id,
      'fixture',
      'Transcribe the attached video and audio',
      undefined,
      attachments,
    );
    await f.runtime.wait(f.session.id);
    assert.equal(f.session.status, 'idle');
    assert.deepEqual(submitted, [
      { operation: 'transcribe', files: files.slice(0, 2) },
    ]);
    // Even unexpected fields in persisted metadata cannot encode media as image input.
    f.session.messages[0].attachments![0] = {
      ...attachments[0],
      text: marker,
      imagePath: files[0],
      mimeType: 'video/mp4',
    } as any;
    const messages = await modelRequestMessages(sessionMessages(f.session));
    assert.ok(!JSON.stringify(messages).includes(marker));
    assert.ok(messages.every((message) => !Array.isArray(message.content)));
  });
  await test('legacy document previews are dropped after history recovery', async () => {
    const f = fixture();
    const marker = 'OLD_EXTRACTED_DOCUMENT_CONTENT';
    f.session.messages.push({
      id: 'old',
      turnId: 'old-turn',
      role: 'user',
      content: 'Earlier file',
      createdAt: 0,
      attachments: [
        {
          id: 'old-attachment',
          name: 'notes.md',
          path: '/notes.md',
          size: 20,
          kind: 'text',
          text: marker,
          characters: 20,
          truncated: false,
        } as any,
      ],
    });
    f.sessions.save(f.session);
    const recovered = new AssistantSessionStore(
      path.join(directory, `history-${count}`),
    ).get(f.session.id);
    assert.equal(recovered.messages[0].attachments?.[0].kind, 'file');
    assert.ok(!JSON.stringify(recovered).includes(marker));
    assert.ok(!JSON.stringify(sessionMessages(recovered)).includes(marker));
  });
  await test('three-step media workflow waits for each artifact before submitting the next job', async () => {
    let request = 0;
    const submitted: string[] = [];
    const f = fixture({
      request: async (_, messages) => {
        const replies = [
          call('load', 'assistant_load_tools', {
            names: ['transcribe', 'translate', 'compose.run'],
          }),
          call('asr', 'smartsub_transcribe', { files: ['/input.mp4'] }),
          call('translate', 'smartsub_translate', {
            files: ['/asr.srt'],
            targetLanguage: 'zh',
          }),
          call('compose', 'smartsub_compose_run', {
            videoPath: '/input.mp4',
            subtitlePath: '/translated.srt',
          }),
          answer,
        ];
        if (request >= 2)
          assert.ok(
            messages.some(
              (message) =>
                message.role === 'tool' &&
                message.content?.includes('completed'),
            ),
          );
        return replies[request++];
      },
      call: async (name, args: any) => {
        if (name === 'tasks.get')
          return {
            id: args.id,
            status: 'completed',
            artifacts: [
              {
                kind: 'srt',
                path: args.id === 'transcribe' ? '/asr.srt' : '/translated.srt',
              },
            ],
          };
        submitted.push(name);
        return { id: name, status: 'queued', artifacts: [] };
      },
    });
    f.runtime.start(
      1,
      f.session.id,
      'fixture',
      'Transcribe, translate and compose',
    );
    await f.runtime.wait(f.session.id);
    assert.deepEqual(submitted, ['transcribe', 'translate', 'compose.run']);
    assert.equal(f.session.status, 'idle');
  });
  await test('compatible reasoning state is replayed only in the active model turn', async () => {
    let requests = 0;
    const f = fixture({
      request: async (_, messages) => {
        if (requests++ === 0)
          return {
            ...call('reasoned', 'assistant_context', {}),
            reasoningContent: 'private protocol state',
            calls: [
              {
                id: 'reasoned',
                name: 'assistant_context',
                arguments: '{}',
                extra_content: { google: { thought_signature: 'opaque' } },
              },
            ],
          };
        const previous = messages.find(
          (message) => message.tool_calls?.[0].id === 'reasoned',
        );
        assert.equal(previous?.reasoning_content, 'private protocol state');
        assert.deepEqual(previous?.tool_calls?.[0].extra_content, {
          google: { thought_signature: 'opaque' },
        });
        return answer;
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Test');
    await f.runtime.wait(f.session.id);
    assert.ok(!JSON.stringify(f.events).includes('private protocol state'));
    assert.ok(!JSON.stringify(f.session).includes('opaque'));
  });
  await test('file writes protect every active editor, including symlink aliases', () => {
    const file = path.join(directory, 'active.srt');
    const alias = path.join(directory, 'alias.srt');
    fs.writeFileSync(file, 'subtitle');
    fs.symlinkSync(file, alias);
    const contexts: any[] = [{ page: '/proofread', editor: { files: [file] } }];
    assert.throws(
      () => guardEditorFiles('subtitles.write', { filePath: alias }, contexts),
      /ACTIVE_EDITOR/,
    );
    assert.throws(
      () =>
        guardEditorFiles(
          'compose.run',
          { config: { outputPath: file } },
          contexts,
        ),
      /ACTIVE_EDITOR/,
    );
    assert.doesNotThrow(() =>
      guardEditorFiles('subtitles.read', { filePath: file }, contexts),
    );
    assert.doesNotThrow(() =>
      guardEditorFiles(
        'subtitles.convert',
        { filePath: file, outputDir: directory },
        contexts,
      ),
    );
  });
  await test('internal results cross the same JSON boundary as external MCP', () => {
    const data = assistantData({
      models: [{ name: 'fixture', resolvePath: () => '/local' }],
      apiKey: 'private',
    });
    assert.deepEqual(structuredClone(data), {
      models: [{ name: 'fixture' }],
      apiKey: '[REDACTED]',
    });
  });
  await test('streamed tool calls join by index; text streams immediately', async () => {
    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              content: 'Hello',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  function: { name: 'tool', arguments: '{"' },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'value":1}' } }],
            },
          },
        ],
      };
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
    }
    const text: string[] = [];
    const result = await collectReply(
      stream(),
      new AbortController().signal,
      (delta) => text.push(delta),
    );
    assert.deepEqual(text, ['Hello']);
    assert.equal(result.calls[0].arguments, '{"value":1}');
  });
  await test('truncated, disconnected and aborted streams cannot execute', async () => {
    for (const finish of [undefined, 'length', 'content_filter']) {
      async function* stream() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'x',
                    function: { name: 'write', arguments: '{}' },
                  },
                ],
              },
              finish_reason: finish,
            },
          ],
        };
      }
      await assert.rejects(
        collectReply(stream(), new AbortController().signal, () => {}),
        /INCOMPLETE_RESPONSE/,
      );
    }
    const controller = new AbortController();
    controller.abort();
    async function* empty() {}
    await assert.rejects(
      collectReply(empty(), controller.signal, () => {}),
      /RUN_STOPPED/,
    );
  });
  await test('discover/load exposes exact catalog schemas and invokes shared service', async () => {
    let requests = 0;
    const invoked: string[] = [];
    const f = fixture({
      request: async (_, messages, tools) => {
        assert.ok(messages[0].content?.includes('SmartSub'));
        switch (requests++) {
          case 0:
            return call('1', 'assistant_discover_tools', { query: 'models' });
          case 1:
            return call('2', 'assistant_load_tools', {
              names: ['models.list'],
            });
          case 2:
            assert.ok(
              tools.some(
                (tool) => tool.function.name === 'smartsub_models_list',
              ),
            );
            return call('3', 'smartsub_models_list', {});
          default:
            assert.ok(
              messages.some(
                (message) =>
                  message.role === 'tool' && message.tool_call_id === '3',
              ),
            );
            return answer;
        }
      },
      call: async (name) => {
        invoked.push(name);
        return { models: ['tiny'] };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'List models');
    await f.runtime.wait(f.session.id);
    assert.deepEqual(invoked, ['models.list']);
    assert.equal(f.session.status, 'idle');
    assert.equal(f.session.messages.at(-1)?.content, 'Done');
  });
  await test('assistant can query system.logs with log type filters and receives recentErrors in workspace context', async () => {
    let requests = 0;
    const logCalls: any[] = [];
    let workspaceSeen = '';
    const f = fixture({
      request: async (_, messages) => {
        const workspaceMsg = messages.find(
          (m) =>
            m.content?.includes('Captured workspace DATA') ||
            m.content?.includes('captured workspace DATA'),
        );
        if (workspaceMsg?.content) workspaceSeen = workspaceMsg.content;
        switch (requests++) {
          case 0:
            return call('1', 'assistant_load_tools', {
              names: ['system.logs'],
            });
          case 1:
            return call('2', 'smartsub_system_logs', {
              projectId: 'project-42',
              types: ['error'],
              limit: 5,
            });
          default:
            return answer;
        }
      },
      call: async (name, args) => {
        if (name === 'system.logs') {
          logCalls.push(args);
          return [{ message: 'Engine process failed', type: 'error' }];
        }
        return { ok: true };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Why did it fail?', {
      page: '/tasks/generateOnly',
      capturedAt: Date.now(),
      projectId: 'project-42',
      recentErrors: ['Engine process failed'],
    });
    await f.runtime.wait(f.session.id);
    assert.equal(logCalls.length, 1);
    assert.deepEqual(logCalls[0].types, ['error']);
    assert.equal(logCalls[0].projectId, 'project-42');
    assert.ok(workspaceSeen.includes('Engine process failed'));
    assert.equal(f.session.status, 'idle');
  });
  await test('assistant can call assistant_capture_screen and provide multimodal visual context to the model', async () => {
    let requests = 0;
    let imageReceived = false;
    const testImagePath = path.join(directory, 'screen-test.jpg');
    fs.writeFileSync(testImagePath, Buffer.from('fake-jpeg-data'));
    const f = fixture({
      captureScreen: async (_owner, args) => {
        assert.equal(args.region, 'workspace');
        return {
          attachmentId: 'att-123',
          imagePath: testImagePath,
          mimeType: 'image/jpeg',
          width: 1280,
          height: 720,
        };
      },
      request: async (_, messages) => {
        if (requests === 0) {
          requests++;
          return call('snap-1', 'assistant_capture_screen', {
            region: 'workspace',
          });
        }
        const imgMsg = messages.find((m) =>
          m.images?.some((img) => img.path === testImagePath),
        );
        if (imgMsg) imageReceived = true;
        return { content: 'I see the error on screen: CUDA OOM.', calls: [] };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Check screen error');
    await f.runtime.wait(f.session.id);
    assert.ok(
      imageReceived,
      'Expected model to receive screenshot in messages',
    );
    assert.equal(f.session.status, 'idle');
    const lastMsg = f.session.messages.at(-1);
    assert.ok(lastMsg?.content.includes('CUDA OOM'));
  });
  await test('assistant can query system.info to inspect engine runtimes and storage topology', async () => {
    let requests = 0;
    const f = fixture({
      request: async (_, messages) => {
        switch (requests++) {
          case 0:
            return call('1', 'assistant_load_tools', {
              names: ['system.info'],
            });
          case 1:
            return call('2', 'smartsub_system_info', {});
          default:
            const infoMsg = messages.find(
              (m) => m.role === 'tool' && m.tool_call_id === '2',
            );
            const data = JSON.parse(infoMsg?.content || '{}');
            assert.ok(data.storageTopology?.userData);
            assert.ok(data.engineRuntimes?.fasterWhisper?.engineDir);
            assert.equal(
              data.engineRuntimes?.fasterWhisper?.requiresExternalPython,
              false,
            );
            assert.ok(data.architectureNotes?.qualityRules);
            return {
              content: `faster-whisper is located at ${data.engineRuntimes.fasterWhisper.engineDir}`,
              calls: [],
            };
        }
      },
      call: async (name) => {
        if (name === 'system.info') {
          return {
            version: '3.8.0',
            storageTopology: {
              userData: '/Users/test/Library/Application Support/SmartSub',
              pyEnginesRoot:
                '/Users/test/Library/Application Support/SmartSub/py-engines',
            },
            engineRuntimes: {
              fasterWhisper: {
                engineType: 'python-portable',
                engineDir:
                  '/Users/test/Library/Application Support/SmartSub/py-engines/faster-whisper',
                pythonExecutable:
                  '/Users/test/Library/Application Support/SmartSub/py-engines/faster-whisper/bin/python3',
                requiresExternalPython: false,
              },
            },
            architectureNotes: {
              qualityRules: 'CPS reading speed excludes whitespace',
            },
          };
        }
        return {};
      },
    });
    f.runtime.start(
      1,
      f.session.id,
      'fixture',
      'Where is faster-whisper runtime?',
    );
    await f.runtime.wait(f.session.id);
    assert.equal(f.session.status, 'idle');
    const lastMsg = f.session.messages.at(-1);
    assert.ok(lastMsg?.content.includes('faster-whisper is located at'));
  });
  await test('invalid arguments return errors without dispatching writes', async () => {
    let request = 0,
      writes = 0;
    const f = fixture({
      request: async () =>
        [
          call('1', 'assistant_load_tools', { names: ['subtitles.write'] }),
          call('2', 'smartsub_subtitles_write', {
            filePath: 'relative',
            cues: [],
          }),
          answer,
        ][request++],
      call: async () => {
        writes++;
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Write');
    await f.runtime.wait(f.session.id);
    assert.equal(writes, 0);
    assert.equal(f.session.messages[2].tools?.[0].status, 'failed');
  });
  await test('long jobs persist receipts, poll terminal state, and continue with artifacts', async () => {
    let request = 0;
    const argsSeen: any[] = [];
    const f = fixture({
      request: async (_, messages) => {
        if (request++ === 0)
          return call('load', 'assistant_load_tools', {
            names: ['transcribe'],
          });
        if (request === 2)
          return call('job', 'smartsub_transcribe', {
            files: ['/fixture.mp4'],
            requestId: 'untrusted',
          });
        assert.ok(
          messages.some(
            (message) =>
              message.role === 'tool' && message.content?.includes('completed'),
          ),
        );
        return answer;
      },
      call: async (name, args: any) => {
        argsSeen.push(args);
        return name === 'transcribe'
          ? { id: 'job-1', status: 'running', artifacts: [] }
          : {
              id: 'job-1',
              status: 'completed',
              artifacts: [{ kind: 'srt', path: '/fixture.srt' }],
            };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Transcribe');
    await f.runtime.wait(f.session.id);
    assert.notEqual(argsSeen[0].requestId, 'untrusted');
    assert.ok(argsSeen[0].requestId.endsWith(':job'));
    assert.ok(
      f.events.some((event) =>
        event.session?.messages.some((message: any) =>
          message.tools?.some((tool: any) => tool.job?.status === 'running'),
        ),
      ),
    );
    assert.equal(f.session.messages[2].tools?.[0].job?.status, 'completed');
  });
  await test('stopping waiting leaves submitted job running and prevents follow-up writes', async () => {
    let request = 0,
      calls = 0;
    const f = fixture({
      request: async () =>
        request++ === 0
          ? call('load', 'assistant_load_tools', { names: ['transcribe'] })
          : call('job', 'smartsub_transcribe', { files: ['/fixture.mp4'] }),
      call: async () => {
        calls++;
        return { id: 'job-stop', status: 'running', artifacts: [] };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Transcribe');
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.runtime.stop(f.session.id);
    await f.runtime.wait(f.session.id);
    assert.equal(calls, 1);
    assert.equal(f.session.status, 'interrupted');
    assert.equal(f.session.messages[2].tools?.[0].job?.id, 'job-stop');
    const reloaded = new AssistantSessionStore(
      path.join(directory, `history-${count}`),
    ).get(f.session.id);
    assert.equal(reloaded.messages[2].tools?.[0].job?.id, 'job-stop');
  });
  await test('duplicate call IDs reuse receipts; conflicting payloads are rejected', async () => {
    let request = 0,
      calls = 0;
    const f = fixture({
      request: async () =>
        [
          call('load', 'assistant_load_tools', { names: ['settings.update'] }),
          call('same', 'smartsub_settings_update', {
            settings: { language: 'en' },
          }),
          call('same', 'smartsub_settings_update', {
            settings: { language: 'en' },
          }),
          call('same', 'smartsub_settings_update', {
            settings: { language: 'zh' },
          }),
          answer,
        ][request++],
      call: async () => {
        calls++;
        return { success: true };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Use English');
    await f.runtime.wait(f.session.id);
    assert.equal(calls, 1);
    assert.equal(f.session.messages[4].tools?.[0].status, 'failed');
  });
  await test('provider failure, window closure, and request cap settle runs', async () => {
    let f = fixture({
      request: async () => {
        throw new Error('unsupported tools');
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Test');
    await f.runtime.wait(f.session.id);
    assert.equal(f.session.status, 'failed');
    f = fixture({
      request: async (_, __, ___, signal) => {
        await abortableDelay(30000, signal);
        return answer;
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Test');
    f.runtime.disconnect(1);
    await f.runtime.wait(f.session.id);
    assert.equal(f.session.status, 'interrupted');
    let requests = 0;
    f = fixture({
      request: async () => call(String(requests++), 'assistant_context', {}),
    });
    f.runtime.start(1, f.session.id, 'fixture', 'Test');
    await f.runtime.wait(f.session.id);
    assert.equal(requests, 20);
    assert.equal(f.session.status, 'limited');
  });
  await test('history recovery interrupts running messages without replay', () => {
    const f = fixture();
    f.session.status = 'running';
    f.session.messages.push({
      id: 'm',
      turnId: 't',
      role: 'assistant',
      content: '',
      createdAt: 0,
      tools: [{ id: 'c', name: 'write', arguments: '{}', status: 'running' }],
    });
    f.sessions.save(f.session);
    const recovered = new AssistantSessionStore(
      path.join(directory, `history-${count}`),
    ).get(f.session.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.messages[0].tools?.[0].status, 'interrupted');
    const messages = sessionMessages(recovered);
    assert.equal(messages[1].role, 'tool');
    assert.ok(messages[1].content?.includes('Never replay'));
  });
  await test('continuing a size-limited turn preserves the request, completed receipts and next step', async () => {
    let requests = 0;
    const submitted: string[] = [];
    const originalRequest =
      'Transcribe /input.mp4, then translate its subtitles into French';
    const f = fixture({
      request: async (_, messages) => {
        requests++;
        if (requests === 1)
          return call('load', 'assistant_load_tools', {
            names: ['transcribe'],
          });
        if (requests === 2)
          return {
            ...call('submitted', 'smartsub_transcribe', {
              files: ['/input.mp4'],
            }),
            content: `${'Long explanation. '.repeat(6500)}Next: translate the transcript into French.`,
          };
        const history = JSON.stringify(messages);
        assert.ok(history.length < 65000);
        assert.ok(history.includes(originalRequest));
        assert.ok(history.includes('submitted'));
        assert.ok(history.includes('completed'));
        assert.ok(history.includes('transcribe-job'));
        assert.ok(history.includes('/transcript.srt'));
        assert.ok(history.includes('Next: translate'));
        assert.ok(history.includes('do not repeat'));
        assert.ok(!messages.some((message) => message.tool_calls?.length));
        return answer;
      },
      call: async (operation) => {
        submitted.push(operation);
        return {
          id: 'transcribe-job',
          status: 'completed',
          artifacts: [{ kind: 'srt', path: '/transcript.srt' }],
        };
      },
    });
    f.runtime.start(1, f.session.id, 'fixture', originalRequest);
    await f.runtime.wait(f.session.id);
    assert.equal(f.session.status, 'limited');
    assert.equal(requests, 2);
    assert.ok(JSON.stringify(sessionMessages(f.session)).length > 100000);
    // Exercise disk recovery as well as the next request: no in-memory summary is required.
    const sessions = new AssistantSessionStore(
      path.join(directory, `history-${count}`),
    );
    const resumed = new AssistantRuntime({ ...f.runtime.deps, sessions });
    resumed.start(1, f.session.id, 'fixture', 'continue');
    await resumed.wait(f.session.id);
    assert.equal(sessions.get(f.session.id).status, 'idle');
    assert.equal(requests, 3);
    assert.deepEqual(submitted, ['transcribe']);
  });
  await test('source-only subtitle edits reject unavailable translations atomically', async () => {
    const original = [
      { id: '1', startEndTime: '', content: ['Hello'], sourceContent: 'Hello' },
    ];
    let cues = original;
    const history: (typeof cues)[] = [];
    let dirty = false;
    const adapter = createAssistantEditor(() => ({
      documentId: 'source-only',
      files: ['/source.srt'],
      editableFields: ['sourceContent'],
      getSubtitles: () => cues,
      getIsDirty: () => dirty,
      selectedIndex: 0,
      currentTime: 0,
      ready: true,
      updateSubtitles: (next) => {
        history.push(cues);
        cues = next as typeof cues;
        dirty = true;
      },
      locate: () => {},
      save: async () => true,
    }));
    const editor = adapter.snapshot().editor!;
    assert.deepEqual(editor.editableFields, ['sourceContent']);
    await assert.rejects(
      adapter.execute({
        id: 'edit',
        kind: 'edit',
        documentId: editor.documentId,
        expectedRevision: editor.revision,
        edits: [
          { index: 0, field: 'sourceContent', text: 'Changed' },
          { index: 0, field: 'targetContent', text: 'Bonjour' },
        ],
      }),
      /SUBTITLE_FIELD_UNAVAILABLE/,
    );
    assert.equal(cues, original);
    assert.equal(history.length, 0);
    assert.equal(dirty, false);
    assert.equal(adapter.snapshot().editor!.revision, editor.revision);
    await adapter.execute({
      id: 'source',
      kind: 'edit',
      documentId: editor.documentId,
      expectedRevision: editor.revision,
      edits: [{ index: 0, field: 'sourceContent', text: 'Goodbye' }],
    });
    assert.equal(cues[0].sourceContent, 'Goodbye');
    assert.equal(history.length, 1);
  });
  await test('draft edits are atomic, versioned, undoable and explicitly saved', async () => {
    let cues = [
      {
        id: '1',
        startEndTime: '',
        content: ['Hello'],
        sourceContent: 'Hello',
        targetContent: 'Bonjour',
        startTimeInSeconds: 0,
      },
    ];
    const history: (typeof cues)[] = [];
    let dirty = false,
      saves = 0,
      ready = true;
    const adapter = createAssistantEditor(() => ({
      documentId: 'doc',
      files: ['/fixture.srt'],
      getSubtitles: () => cues,
      getIsDirty: () => dirty,
      selectedIndex: 0,
      currentTime: 0,
      editableFields: ['sourceContent', 'targetContent'],
      ready,
      updateSubtitles: (next) => {
        history.push(cues);
        cues = next as typeof cues;
        dirty = true;
      },
      locate: () => {},
      save: async () => {
        saves++;
        dirty = false;
        return true;
      },
    }));
    const initial = adapter.snapshot().editor!;
    const result = await adapter.execute({
      id: 'edit',
      kind: 'edit',
      documentId: 'doc',
      expectedRevision: initial.revision,
      edits: [{ index: 0, field: 'targetContent', text: 'Salut' }],
    });
    assert.equal(cues[0].targetContent, 'Salut');
    assert.equal(history.length, 1);
    assert.equal(saves, 0);
    assert.equal(dirty, true);
    await assert.rejects(
      adapter.execute({
        id: 'stale',
        kind: 'edit',
        documentId: 'doc',
        expectedRevision: initial.revision,
        edits: [{ index: 0, field: 'targetContent', text: 'Stale' }],
      }),
      /CONFLICT/,
    );
    const version = result.context.editor!.revision;
    await assert.rejects(
      adapter.execute({
        id: 'invalid',
        kind: 'edit',
        documentId: 'doc',
        expectedRevision: version,
        edits: [
          { index: 0, field: 'sourceContent', text: 'Changed' },
          { index: 9, field: 'sourceContent', text: 'Wrong' },
        ],
      }),
      /INVALID/,
    );
    assert.equal(cues[0].sourceContent, 'Hello');
    await adapter.execute({
      id: 'save',
      kind: 'save',
      documentId: 'doc',
      expectedRevision: version,
    });
    assert.equal(saves, 1);
    cues = history.pop()!;
    assert.equal(cues[0].targetContent, 'Bonjour');
    await assert.rejects(
      adapter.execute({
        id: 'old',
        kind: 'save',
        documentId: 'doc',
        expectedRevision: version,
      }),
      /CONFLICT/,
    );
    ready = false;
    assert.equal(adapter.snapshot().editor, undefined);
  });
  assert.ok(operations.length > 50);
  console.log(`${count} assistant checks passed`);
}
main()
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
