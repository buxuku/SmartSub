import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { AutomationService } from './service';
import { safeMessage, redact } from '../../automation/redact';
import { isTranscriptionBusy } from '../helpers/taskProcessor';
import { isComposeBusy } from '../helpers/compose/composeQueue';
import { isVideoDownloadBusy } from '../helpers/videoDownload/scheduler';
import { isPyEngineDownloadBusy } from '../helpers/pythonRuntime/downloader';

export async function startAutomationServer() {
  const service = new AutomationService();
  const token = randomBytes(32).toString('hex');
  const directory = path.join(app.getPath('userData'), 'automation');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const endpointFile = path.join(directory, 'endpoint.json');
  let lastAccess = Date.now();
  let pending = 0;
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, value: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(redact(value)));
    };
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      req.headers.origin ||
      !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      reply(401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Local authentication required',
        },
      });
      return;
    }
    lastAccess = Date.now();
    if (req.method === 'GET' && req.url === '/health') {
      reply(200, {
        apiVersion: 1,
        version: app.getVersion(),
        pid: process.pid,
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/call') {
      reply(404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
      return;
    }
    pending++;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('REQUEST_TOO_LARGE');
        chunks.push(chunk);
      }
      const { operation, args } = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );
      const result = await service.call(operation, args);
      reply(200, { ok: true, result: result ?? null });
    } catch (error) {
      const message = safeMessage(
        error instanceof Error ? error.message : error,
      );
      reply(400, {
        ok: false,
        error: {
          code:
            (error as any)?.name === 'ZodError'
              ? 'INVALID_ARGUMENT'
              : /^[A-Z_]+/.exec(message)?.[0] || 'OPERATION_FAILED',
          message,
        },
      });
    } finally {
      pending--;
      lastAccess = Date.now();
    }
  });
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as any).port;
  const temp = `${endpointFile}.${process.pid}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify({
      apiVersion: 1,
      pid: process.pid,
      port,
      token,
      version: app.getVersion(),
    }),
    { mode: 0o600 },
  );
  fs.renameSync(temp, endpointFile);
  const idle = setInterval(() => {
    if (
      Date.now() - lastAccess > 5 * 60 * 1000 &&
      !pending &&
      !service.jobs.busy() &&
      !isTranscriptionBusy() &&
      !isComposeBusy() &&
      !isVideoDownloadBusy() &&
      !isPyEngineDownloadBusy() &&
      BrowserWindow.getAllWindows().length === 0
    )
      app.quit();
  }, 30000);
  idle.unref();
  app.once('will-quit', () => {
    clearInterval(idle);
    server.close();
    try {
      if (JSON.parse(fs.readFileSync(endpointFile, 'utf8')).pid === process.pid)
        fs.unlinkSync(endpointFile);
    } catch {}
  });
}
