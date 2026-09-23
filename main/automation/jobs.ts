import fs from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { app } from 'electron';
import type {
  AutomationContext,
  AutomationJob,
  ArtifactRef,
} from '../../types/automation';
import { taskSubmissionKey } from '../../types/taskSubmission';
import { redact, safeMessage } from '../../automation/redact';
import { createServiceEvent } from './events';
import { subscribeJobProgress } from './progress';

export class JobFailure extends Error {
  constructor(
    message: string,
    readonly result: unknown,
  ) {
    super(message);
  }
}
function fingerprint(operation: string, input: any) {
  return createHash('sha256')
    .update(taskSubmissionKey({ operation, input }))
    .digest('hex');
}

export const terminal = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export function collectArtifacts(value: any): ArtifactRef[] {
  const found = new Map<string, ArtifactRef>();
  function visit(entry: any, key = '') {
    if (
      typeof entry === 'string' &&
      /(?:path|file|files|data)$/i.test(key) &&
      ![
        'filePath',
        'videoPath',
        'subtitlePath',
        'sourcePath',
        'primaryPath',
        'secondaryPath',
        'tempAudioFile',
        'wordTimelineFile',
      ].includes(key) &&
      path.isAbsolute(entry) &&
      fs.existsSync(entry) &&
      fs.statSync(entry).isFile()
    )
      found.set(entry, {
        kind: path.extname(entry).slice(1) || 'file',
        path: entry,
      });
    else if (Array.isArray(entry)) entry.forEach((v) => visit(v, key));
    else if (entry && typeof entry === 'object')
      Object.entries(entry).forEach(([k, v]) => visit(v, k));
  }
  visit(value);
  return [...found.values()];
}

export class JobStore {
  private jobs = new Map<string, AutomationJob>();
  private active = new Map<
    string,
    { controller: AbortController; cancel?: () => void | Promise<void> }
  >();
  private directory = path.join(app.getPath('userData'), 'automation', 'jobs');
  constructor() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of fs
      .readdirSync(this.directory)
      .filter((n) => /^[\w-]+\.json$/.test(n))) {
      const job = JSON.parse(
        fs.readFileSync(path.join(this.directory, name), 'utf8'),
      ) as AutomationJob;
      if (!job.id || !job.operation)
        throw new Error('Invalid automation job receipt');
      this.jobs.set(job.id, job);
      if (!terminal.has(job.status) && job.status !== 'review') {
        job.status = 'interrupted';
        job.error = {
          code: 'TASK_INTERRUPTED',
          message:
            'Backend restarted. Inspect artifacts before explicitly retrying.',
        };
        job.actions = ['retry'];
        this.save(job);
      }
    }
  }
  save(job: AutomationJob) {
    job.updatedAt = Date.now();
    const target = path.join(this.directory, `${job.id}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(redact(job)));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  busy() {
    return this.active.size > 0;
  }
  isActive(id: string) {
    return this.active.has(id);
  }
  resume(id: string, execute: (ctx: AutomationContext) => Promise<any>) {
    const job = this.get(id);
    if (!job) throw new Error('TASK_NOT_FOUND');
    if (this.active.has(id)) return job;
    job.error = undefined;
    job.status = 'queued';
    this.save(job);
    this.run(job, execute);
    return job;
  }
  delete(id: string) {
    const job = this.get(id);
    if (!job) throw new Error('TASK_NOT_FOUND');
    if (this.active.has(id) || job.status === 'review')
      throw new Error('TASK_BUSY');
    fs.unlinkSync(path.join(this.directory, `${id}.json`));
    this.jobs.delete(id);
    return { deleted: true };
  }
  submit(
    operation: string,
    input: any,
    execute: (ctx: AutomationContext) => Promise<any>,
  ): AutomationJob {
    const existing = this.replay(operation, input);
    if (existing) return existing;
    const job: AutomationJob = {
      id: randomUUID(),
      operation,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      requestId: input.requestId,
      fingerprint: fingerprint(operation, input),
      artifacts: [],
      actions: [],
    };
    this.save(job);
    this.jobs.set(job.id, job);
    this.run(job, execute);
    return job;
  }
  replay(operation: string, input: any) {
    if (!input.requestId) return undefined;
    const existing = this.list().find((j) => j.requestId === input.requestId);
    if (existing && existing.fingerprint !== fingerprint(operation, input))
      throw new Error('REQUEST_CONFLICT');
    return existing;
  }
  private run(
    job: AutomationJob,
    execute: (ctx: AutomationContext) => Promise<any>,
  ) {
    const runtime: {
      controller: AbortController;
      cancel?: () => void | Promise<void>;
    } = { controller: new AbortController() };
    this.active.set(job.id, runtime);
    let lastSaved = 0;
    const updateProgress = (channel: string, ...args: any[]) => {
      job.progress = redact({ channel, data: args });
      if (Date.now() - lastSaved > 1000) {
        lastSaved = Date.now();
        this.save(job);
      }
    };
    const event = createServiceEvent(updateProgress);
    const cleanupProgress = subscribeJobProgress(
      job.id,
      job.operation,
      updateProgress,
    );
    const ctx: AutomationContext = {
      jobId: job.id,
      event,
      signal: runtime.controller.signal,
      setCancel: (cancel) => {
        runtime.cancel = cancel;
        job.actions = ['cancel'];
        if (runtime.controller.signal.aborted) void cancel();
      },
      trackModelProgress: cleanupProgress.trackModel,
    };
    setImmediate(async () => {
      try {
        job.status = 'running';
        this.save(job);
        const result = await execute(ctx);
        job.result = redact(result);
        job.artifacts = collectArtifacts(result);
        job.status =
          runtime.controller.signal.aborted || result?.cancelled
            ? 'cancelled'
            : result?.status === 'review'
              ? 'review'
              : 'completed';
      } catch (error) {
        if (error instanceof JobFailure) {
          job.result = redact(error.result);
          job.artifacts = collectArtifacts(error.result);
        }
        job.status = runtime.controller.signal.aborted ? 'cancelled' : 'failed';
        const message = safeMessage(
          error instanceof Error ? error.message : error,
        );
        job.error = {
          code: /^[A-Z_]+/.exec(message)?.[0] || 'PROCESSING_FAILED',
          message,
        };
      } finally {
        cleanupProgress.dispose();
        job.actions =
          job.projectId && ['failed', 'interrupted'].includes(job.status)
            ? ['retry']
            : [];
        try {
          this.save(job);
        } catch (error) {
          console.error('Automation receipt could not be saved', error);
        }
        this.active.delete(job.id);
        event.sender.emit('destroyed');
      }
    });
  }
  async cancel(id: string) {
    const job = this.get(id);
    if (!job) throw new Error('TASK_NOT_FOUND');
    const runtime = this.active.get(id);
    if (!runtime) return job;
    if (!runtime.cancel)
      throw new Error(
        'CANCEL_UNSUPPORTED: This operation cannot currently be interrupted',
      );
    job.status = 'cancelling';
    runtime.controller.abort();
    this.save(job);
    await runtime.cancel();
    return job;
  }
  async wait(id: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = this.get(id);
      if (!job) throw new Error('TASK_NOT_FOUND');
      if (
        terminal.has(job.status) ||
        job.status === 'review' ||
        Date.now() >= deadline
      )
        return job;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
