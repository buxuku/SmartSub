import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  getSessionDraftPath as draftPath,
  assertSessionAvailable,
} from './sessionStore';
import { parseDubbingConfigDraft } from '../../../types/dubbingConfigDraft';
import { parseDubbingCueDraft } from '../../../types/dubbingCueDraft';

export function readConfigDraft(sessionId: string): string | null {
  return readDraft(sessionId, 'config');
}

export function readCueDraft(sessionId: string): string | null {
  return readDraft(sessionId, 'cue');
}

function readDraft(sessionId: string, kind: 'config' | 'cue'): string | null {
  assertSessionAvailable(sessionId);
  try {
    return fs.readFileSync(draftPath(sessionId, kind), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeConfigDraft(
  sessionId: string,
  expected: string | null,
  raw: string | null,
): string | null {
  return writeDraft(sessionId, expected, raw, 'config');
}

export function writeCueDraft(
  sessionId: string,
  expected: string | null,
  raw: string | null,
): string | null {
  return writeDraft(sessionId, expected, raw, 'cue');
}

function writeDraft(
  sessionId: string,
  expected: string | null,
  raw: string | null,
  kind: 'config' | 'cue',
): string | null {
  if (raw !== null) {
    if (
      typeof raw !== 'string' ||
      raw.length > (kind === 'config' ? 65536 : 20 * 1024 * 1024)
    )
      throw new Error('Invalid dubbing draft');
    if (kind === 'config') parseDubbingConfigDraft(raw, sessionId);
    else parseDubbingCueDraft(raw, sessionId);
  }
  const previous = readDraft(sessionId, kind);
  if (previous === raw) return raw;
  if (previous !== expected)
    throw new Error('Dubbing configuration draft changed in another editor');
  const file = draftPath(sessionId, kind);
  if (raw === null) {
    fs.unlinkSync(file);
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, raw, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return raw;
}
