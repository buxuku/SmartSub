import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TaskStorageMigrationPreview } from '../../../types/taskStorage';
import type { TaskDraft } from '../../../types/taskRun';
import type { TaskRunStore } from './store';
import { hashFile, copyIndependent } from './artifacts';
import {
  readJson,
  writeJson,
  rewritePaths,
  walkFiles,
  within,
} from './storageIO';

interface Transfer {
  source: string;
  target: string;
  staged: string;
  original: string;
  digest: string;
  size: number;
  remove: boolean;
}
interface SupersededDraft {
  source: string;
  target: string;
  original: string;
}
export interface MigrationJournal {
  version: 1;
  id: string;
  target: string;
  phase:
    | 'scheduled'
    | 'copying'
    | 'committing'
    | 'rebinding'
    | 'cleanup'
    | 'done'
    | 'failed';
  files?: Transfer[];
  supersededDrafts?: SupersededDraft[];
  runs?: Array<{ key: string; root: string }>;
  error?: string;
}
interface MigrationOptions {
  journalPath: string;
  metadataFiles: () => Promise<string[]>;
  progress?: (phase: string, current: number, total: number) => void;
  checkpoint?: (phase: string) => void;
}
const sha = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex');
const prefix = 'smartsub_proofread_draft_v1:';

/** Startup-only transaction. Until commit begins, the complete source remains authoritative. */
export function createTaskRunMigration(
  store: TaskRunStore,
  options: MigrationOptions,
) {
  const journal = () => readJson<MigrationJournal>(options.journalPath);
  async function inventory(target: string) {
    const sources: string[] = [];
    const pairs: Array<{ source: string; target: string }> = [];
    const drafts = new Map<string, string[]>();
    const supersededDrafts: Array<{ source: string; target: string }> = [];
    for (const directory of store.projectDirectoriesAll()) {
      if (path.dirname(directory) === target) continue;
      if (
        directory === target ||
        within(directory, target) ||
        within(target, directory)
      )
        throw new Error('TASK_STORAGE_OVERLAP');
      sources.push(directory);
      for (const source of await walkFiles(directory)) {
        const destination = path.join(
          target,
          path.basename(directory),
          path.relative(directory, source),
        );
        if (path.relative(directory, source) === 'draft.json') {
          const candidates = drafts.get(destination) ?? [];
          candidates.push(source);
          drafts.set(destination, candidates);
          continue;
        }
        if (fs.existsSync(destination))
          throw new Error(`TASK_STORAGE_CONFLICT: ${destination}`);
        if (source.endsWith('manifest.json')) {
          const run = readJson<any>(source);
          if (run?.schemaVersion !== 1)
            throw new Error(`TASK_RUN_VERSION_UNSUPPORTED: ${source}`);
        }
        if (source.endsWith('.json')) readJson(source); // reject corrupt data before starting
        pairs.push({ source, target: destination });
      }
    }
    // Match readDraft's highest-revision selection across every known root.
    // Resolve the winner before scheduling transfers to avoid duplicate targets.
    for (const [destination, candidates] of drafts) {
      if (fs.existsSync(destination)) candidates.push(destination);
      const versions = candidates
        .map((source) => {
          const draft = readJson<TaskDraft>(source);
          if (!draft || !Number.isSafeInteger(draft.revision))
            throw new Error(`TASK_STORAGE_CONFLICT: ${source}`);
          return { source, draft };
        })
        .sort((a, b) => b.draft.revision - a.draft.revision);
      const winner = versions[0];
      if (
        versions.some(
          ({ draft }) =>
            draft.revision === winner.draft.revision &&
            JSON.stringify(draft) !== JSON.stringify(winner.draft),
        )
      )
        throw new Error(`TASK_STORAGE_CONFLICT: ${destination}`);
      // Prefer an identical destination copy so it need not be republished.
      const selected =
        versions.find(
          ({ source, draft }) =>
            source === destination && draft.revision === winner.draft.revision,
        ) ?? winner;
      if (selected.source !== destination)
        pairs.push({ source: selected.source, target: destination });
      for (const source of candidates)
        if (source !== selected.source && source !== destination)
          supersededDrafts.push({ source, target: destination });
    }
    return { sources, pairs, supersededDrafts };
  }
  async function preview(): Promise<TaskStorageMigrationPreview> {
    const result: TaskStorageMigrationPreview = {
      id: randomUUID(),
      target: store.root,
      sources: [],
      files: 0,
      bytes: 0,
      blockers: [],
    };
    try {
      for (const [key, root] of store.locations?.entries() ?? [])
        if (!fs.existsSync(path.join(root, key, 'manifest.json')))
          throw new Error(`TASK_STORAGE_UNAVAILABLE: ${root}`);
      const { sources, pairs, supersededDrafts } = await inventory(
        result.target,
      );
      result.sources = sources;
      result.files = pairs.length + supersededDrafts.length;
      for (const pair of [...pairs, ...supersededDrafts])
        result.bytes += (await fs.promises.stat(pair.source)).size;
      const running = store
        .all()
        .some((run) =>
          ['preparing', 'queued', 'running', 'pausing', 'cancelling'].includes(
            run.status,
          ),
        );
      if (running) result.blockers.push('TASK_STORAGE_BUSY');
    } catch (error) {
      result.blockers.push(String(error));
    }
    return result;
  }
  async function discardStaging(state: MigrationJournal | null) {
    if (!state || !/^[a-zA-Z0-9-]+$/.test(state.id)) return;
    const directory = path.join(state.target, '.task-migration', state.id);
    if (fs.existsSync(directory)) {
      await walkFiles(directory);
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
  async function schedule(id: string, target: string) {
    const previous = journal();
    if (
      previous &&
      ['copying', 'committing', 'rebinding', 'cleanup'].includes(previous.phase)
    )
      throw new Error('TASK_MIGRATION_IN_PROGRESS');
    await discardStaging(previous);
    writeJson(options.journalPath, {
      version: 1,
      id,
      target,
      phase: 'scheduled',
    } satisfies MigrationJournal);
  }
  async function cancel() {
    const current = journal();
    if (current && !['scheduled', 'failed', 'done'].includes(current.phase))
      throw new Error('TASK_MIGRATION_IN_PROGRESS');
    await discardStaging(current);
    fs.rmSync(options.journalPath, { force: true });
  }
  async function execute() {
    let current = journal();
    if (!current || ['done', 'failed'].includes(current.phase)) return;
    if (current.version !== 1 || !/^[a-zA-Z0-9-]+$/.test(current.id))
      throw new Error('TASK_MIGRATION_VERSION_UNSUPPORTED');
    const staging = path.join(current.target, '.task-migration', current.id);
    const save = () => writeJson(options.journalPath, current);
    try {
      if (['scheduled', 'copying'].includes(current.phase)) {
        if (store.root !== current.target)
          throw new Error('TASK_MIGRATION_TARGET_CHANGED');
        const { sources, pairs, supersededDrafts } = await inventory(
          current.target,
        );
        current.supersededDrafts = await Promise.all(
          supersededDrafts.map(async (draft) => ({
            ...draft,
            original: (await hashFile(draft.source)).digest,
          })),
        );
        const mapPath = (value: string) => {
          const source = sources.find(
            (dir) => value === dir || within(dir, value),
          );
          return source
            ? path.join(
                current!.target,
                path.basename(source),
                path.relative(source, value),
              )
            : value;
        };
        current.phase = 'copying';
        current.error = undefined;
        save();
        // Rebuild incomplete staging; never touch source files during this phase.
        await fs.promises.rm(staging, { recursive: true, force: true });
        await fs.promises.mkdir(staging, { recursive: true });
        const disk = await fs.promises.statfs(staging);
        const needed = (
          await Promise.all(pairs.map((pair) => fs.promises.stat(pair.source)))
        ).reduce((sum, stat) => sum + stat.size, 0);
        if (disk.bavail * disk.bsize < needed * 2)
          throw new Error('TASK_MIGRATION_INSUFFICIENT_SPACE');
        const metadata = new Set(await options.metadataFiles());
        for (const directory of store.projectDirectoriesAll())
          if (path.dirname(directory) === current.target)
            for (const file of await walkFiles(directory))
              if (file.endsWith('.json')) metadata.add(file);
        const items = [
          ...pairs.map((pair) => ({ ...pair, remove: true })),
          ...[...metadata]
            .filter(
              (file) =>
                !pairs.some(
                  (pair) => pair.source === file || pair.target === file,
                ) && !supersededDrafts.some((draft) => draft.source === file),
            )
            .map((source) => ({ source, target: source, remove: false })),
        ];
        const draftTargets = new Map<string, string>();
        const draftKeys = new Map<string, string>();
        for (const item of items)
          if (item.source.endsWith('.json.key')) {
            const key = await fs.promises.readFile(item.source, 'utf8');
            if (!key.startsWith(prefix))
              throw new Error(`TASK_DRAFT_IDENTITY_UNKNOWN: ${item.source}`);
            const values = JSON.parse(key.slice(prefix.length));
            if (
              !Array.isArray(values) ||
              values.some((value) => typeof value !== 'string')
            )
              throw new Error('TASK_DRAFT_IDENTITY_UNKNOWN');
            const next = prefix + JSON.stringify(values.map(mapPath));
            if (next !== key) {
              const file = item.source.slice(0, -4);
              const target = path.join(path.dirname(file), sha(next) + '.json');
              if (fs.existsSync(target))
                throw new Error(`TASK_STORAGE_CONFLICT: ${target}`);
              draftTargets.set(file, target);
              draftTargets.set(item.source, target + '.key');
              draftKeys.set(item.source, next);
            }
          }
        const transfers: Transfer[] = [];
        const json = new Map<string, any>();
        const targets = new Set<string>();
        let index = 0;
        for (const item of items) {
          const target = draftTargets.get(item.source) ?? item.target;
          if (targets.has(target))
            throw new Error(`TASK_STORAGE_CONFLICT: ${target}`);
          targets.add(target);
          const before = await hashFile(item.source);
          const staged = path.join(staging, String(index++));
          if (item.source.endsWith('.json')) {
            const raw = readJson(item.source);
            const data = rewritePaths(raw, mapPath);
            // Unkeyed drafts cannot safely be rebound to a new document identity.
            if (
              ['proofread-drafts', 'quality-reviews'].includes(
                path.basename(path.dirname(item.source)),
              ) &&
              raw !== null &&
              !fs.existsSync(item.source + '.key')
            )
              throw new Error(`TASK_DRAFT_IDENTITY_UNKNOWN: ${item.source}`);
            await fs.promises.writeFile(staged, JSON.stringify(data), {
              mode: 0o600,
            });
            json.set(target, data);
          } else if (draftKeys.has(item.source))
            await fs.promises.writeFile(staged, draftKeys.get(item.source)!, {
              mode: 0o600,
            });
          else await copyIndependent(item.source, staged);
          const after = await hashFile(item.source);
          if (before.digest !== after.digest)
            throw new Error('TASK_INPUT_CHANGED');
          const copied = await hashFile(staged);
          if (
            !item.source.endsWith('.json') &&
            !draftKeys.has(item.source) &&
            copied.digest !== before.digest
          )
            throw new Error('TASK_MIGRATION_VERIFY_FAILED');
          transfers.push({
            source: item.source,
            target,
            staged,
            original: before.digest,
            digest: copied.digest,
            size: copied.identity.size,
            remove: item.remove || target !== item.source,
          });
          options.progress?.('copying', index, items.length);
        }
        // Refresh artifact checksums, including state.json files referenced by
        // manifests on either volume. Reject cycles instead of guessing hashes.
        let stable = false;
        for (let pass = 0; pass < 16; pass++) {
          let changed = false;
          const byPath = new Map(transfers.map((file) => [file.target, file]));
          const refresh = (value: any) => {
            if (!value || typeof value !== 'object') return;
            if (
              typeof value.path === 'string' &&
              typeof value.digest === 'string' &&
              typeof value.size === 'number'
            ) {
              const file = byPath.get(value.path);
              if (file) {
                // Rewriting managed paths changes JSON bytes, not the cached
                // result. Preserve the original identity across repeated moves
                // and every manifest that reuses this artifact.
                if (value.digest !== file.digest)
                  value.cacheDigest ??= value.digest;
                value.digest = file.digest;
                value.size = file.size;
              }
            }
            for (const child of Object.values(value)) refresh(child);
          };
          for (const file of transfers) {
            if (!json.has(file.target)) continue;
            const value = json.get(file.target);
            refresh(value);
            const text = JSON.stringify(value);
            const digest = sha(text);
            if (digest === file.digest) continue;
            await fs.promises.writeFile(file.staged, text, { mode: 0o600 });
            file.digest = digest;
            file.size = Buffer.byteLength(text);
            changed = true;
          }
          if (!changed) {
            stable = true;
            break;
          }
        }
        if (!stable) throw new Error('TASK_MIGRATION_REFERENCE_CYCLE');
        current.files = transfers.filter(
          (file) => file.remove || file.original !== file.digest,
        );
        current.runs = pairs
          .filter((pair) => path.basename(pair.source) === 'manifest.json')
          .map((pair) => ({
            key: path.relative(current!.target, path.dirname(pair.target)),
            root: current!.target,
          }));
        // Every source must still match before entering the roll-forward phase.
        for (const file of current.files) {
          if ((await hashFile(file.source)).digest !== file.original)
            throw new Error('TASK_INPUT_CHANGED');
          const handle = await fs.promises.open(file.staged, 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        for (const draft of current.supersededDrafts)
          if ((await hashFile(draft.source)).digest !== draft.original)
            throw new Error('TASK_INPUT_CHANGED');
        current.phase = 'committing';
        save();
        options.checkpoint?.('committing');
      }
      if (current.phase === 'committing') {
        let index = 0;
        for (const file of current.files!) {
          if (
            fs.existsSync(file.target) &&
            (await hashFile(file.target)).digest === file.digest
          )
            continue;
          if ((await hashFile(file.staged)).digest !== file.digest)
            throw new Error('TASK_MIGRATION_VERIFY_FAILED');
          if (
            fs.existsSync(file.target) &&
            file.target !== file.source &&
            path.basename(file.target) !== 'draft.json'
          )
            throw new Error(`TASK_STORAGE_CONFLICT: ${file.target}`);
          const temporary = `${file.target}.${current.id}.migration`;
          await copyIndependent(file.staged, temporary);
          const handle = await fs.promises.open(temporary, 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          if ((await hashFile(temporary)).digest !== file.digest)
            throw new Error('TASK_MIGRATION_VERIFY_FAILED');
          await fs.promises.rename(temporary, file.target);
          options.progress?.('committing', ++index, current.files!.length);
          options.checkpoint?.('file-committed');
        }
        current.phase = 'rebinding';
        save();
        options.checkpoint?.('rebinding');
      }
      if (current.phase === 'rebinding') {
        // A run may consume another run's managed audio/subtitle as its input.
        // Moving that file changes inode/ctime even though its bytes are identical.
        // Refresh identity only for a verified relocated input, never external media.
        for (const file of current.files!.filter(
          (file) => path.basename(file.target) === 'manifest.json',
        )) {
          const run = readJson<any>(file.target);
          for (const input of run.files ?? []) {
            const moved = current.files!.find(
              (candidate) =>
                candidate.remove && candidate.target === input.input?.filePath,
            );
            if (!moved || !input.inputIdentity) continue;
            const hashed = await hashFile(moved.target);
            if (hashed.digest !== moved.original)
              throw new Error('TASK_MIGRATION_INPUT_CHANGED');
            input.inputIdentity = hashed.identity;
          }
          writeJson(file.target, run);
        }
        for (const run of current.runs!)
          store.locations?.pin(run.key, run.root);
        current.phase = 'cleanup';
        save();
        options.checkpoint?.('cleanup');
      }
      if (current.phase === 'cleanup') {
        const errors: string[] = [];
        for (const file of [
          ...current.files!,
          ...(current.supersededDrafts ?? []).map((draft) => ({
            ...draft,
            remove: true,
          })),
        ]) {
          if (
            !file.remove ||
            file.source === file.target ||
            !fs.existsSync(file.source)
          )
            continue;
          try {
            // Publication verified these files before the location index switched.
            // Editable metadata may legitimately change while cleanup is deferred.
            await fs.promises.access(file.target);
            if ((await hashFile(file.source)).digest !== file.original)
              throw new Error(`TASK_MIGRATION_SOURCE_CHANGED: ${file.source}`);
            await fs.promises.unlink(file.source);
          } catch (error) {
            errors.push(String(error));
          }
        }
        if (errors.length) {
          current.error = errors.join('\n');
          save();
          return;
        }
        current.phase = 'done';
        current.error = undefined;
        save();
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    } catch (error) {
      current.error = String(error);
      if (['scheduled', 'copying'].includes(current.phase))
        current.phase = 'failed';
      save();
      throw error;
    }
  }
  return { journal, preview, schedule, cancel, execute };
}
