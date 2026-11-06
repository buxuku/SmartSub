import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export interface ClientOptions {
  dataDir?: string;
  appPath?: string;
}
export class AutomationClient {
  readonly dataDir: string;
  private endpoint: any;
  private connecting?: Promise<void>;
  constructor(private options: ClientOptions = {}) {
    const base =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.platform === 'win32'
          ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
          : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    this.dataDir = path.resolve(
      options.dataDir ||
        process.env.SMARTSUB_DATA_DIR ||
        path.join(
          base,
          'smartsub' + (process.env.SMARTSUB_DEV === '1' ? '-dev' : ''),
        ),
    );
  }
  private async discover() {
    try {
      const next = JSON.parse(
        fs.readFileSync(
          path.join(this.dataDir, 'automation', 'endpoint.json'),
          'utf8',
        ),
      );
      if (
        next.apiVersion !== 1 ||
        !Number.isInteger(next.port) ||
        next.port < 1 ||
        next.port > 65535 ||
        typeof next.token !== 'string'
      )
        return false;
      const response = await fetch(`http://127.0.0.1:${next.port}/health`, {
        headers: { Authorization: `Bearer ${next.token}` },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const health = (await response.json()) as any;
      if (health.apiVersion !== 1) throw new Error('API_VERSION_MISMATCH');
      this.endpoint = next;
      return true;
    } catch {
      return false;
    }
  }
  private async start() {
    if (await this.discover()) return;
    const executable =
      this.options.appPath || process.env.SMARTSUB_APP_PATH || process.execPath;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const dev = process.env.SMARTSUB_DEV === '1';
    const args = dev ? [path.resolve(__dirname, '../..')] : [];
    args.push(
      '--automation-background',
      `--automation-data-dir=${this.dataDir}`,
    );
    fs.mkdirSync(path.join(this.dataDir, 'automation'), {
      recursive: true,
      mode: 0o700,
    });
    const log = fs.openSync(
      path.join(this.dataDir, 'automation', 'backend.log'),
      'a',
      0o600,
    );
    const child = spawn(executable, args, {
      env: { ...env, ...(dev ? { NODE_ENV: 'development' } : {}) },
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    let error: Error | undefined;
    child.once('error', (e) => {
      error = e;
    });
    child.unref();
    fs.closeSync(log);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (error) throw error;
      if (await this.discover()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `BACKEND_UNAVAILABLE: See ${path.join(this.dataDir, 'automation', 'backend.log')}`,
    );
  }
  private async connect() {
    if (!this.connecting)
      this.connecting = this.start().finally(() => {
        this.connecting = undefined;
      });
    await this.connecting;
  }
  async call(operation: string, args: any = {}) {
    // Probe before sending a mutation: reconnecting here cannot replay an
    // ambiguously accepted request after a lost response.
    if (!this.endpoint || !(await this.discover())) await this.connect();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.endpoint.port}/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.endpoint.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operation, args }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      this.endpoint = undefined;
      throw new Error(
        `CONNECTION_LOST: Query the task or retry with the same requestId. ${String(error)}`,
      );
    }
    const result = (await response.json()) as any;
    if (!response.ok || !result.ok) {
      const error = new Error(
        result.error?.message || `HTTP ${response.status}`,
      );
      (error as any).code = result.error?.code;
      throw error;
    }
    return result.result;
  }
}
