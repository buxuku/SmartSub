import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AssistantSession } from '../../types/assistant';
import { redact, safeMessage } from '../../automation/redact';
import { assistantAttachmentReference } from '../../types/assistantAttachments';

/** Separate atomic files keep chat history out of the settings store. */
export class AssistantSessionStore {
  private sessions = new Map<string, AssistantSession>();
  constructor(private directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(directory)) {
      if (!/^[\w-]+\.json$/.test(name)) continue;
      try {
        const session = JSON.parse(
          fs.readFileSync(path.join(directory, name), 'utf8'),
        ) as AssistantSession;
        if (name !== `${session.id}.json` || !Array.isArray(session.messages))
          continue;
        for (const message of session.messages)
          if (message.attachments)
            message.attachments = message.attachments.map(
              assistantAttachmentReference,
            );
        this.sessions.set(session.id, session);
        if (session.status === 'running') {
          session.status = 'interrupted';
          for (const message of session.messages)
            for (const tool of message.tools || [])
              if (tool.status === 'running') tool.status = 'interrupted';
          this.save(session);
        }
      } catch (error) {
        console.warn(
          'Assistant history could not be read:',
          name,
          safeMessage(error),
        );
      }
    }
  }
  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ messages, ...session }) => ({ ...session, messages: [] }));
  }
  get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    return session;
  }
  create(providerId: string) {
    const session: AssistantSession = {
      id: randomUUID(),
      title: '',
      providerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      messages: [],
    };
    this.save(session);
    return session;
  }
  save(session: AssistantSession) {
    session.updatedAt = Date.now();
    const target = path.join(this.directory, `${session.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(redact(session)));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    this.sessions.set(session.id, session);
  }
  delete(id: string) {
    const session = this.get(id);
    if (session.status === 'running') throw new Error('SESSION_BUSY');
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
    this.sessions.delete(id);
  }
}
