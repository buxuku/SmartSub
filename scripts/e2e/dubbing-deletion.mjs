import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { _electron, expect } from '@playwright/test';

const output = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-dubbing-deletion-e2e-'),
);
const profile = path.join(output, 'profile');
const subtitle = path.join(output, 'deletion.srt');
await fs.writeFile(
  subtitle,
  '1\n00:00:00,000 --> 00:00:04,000\nDeletion fixture.\n',
);
const errors = [],
  checks = [];
let app, page, root, locked;
const go = (url) => page.evaluate((url) => window.next.router.push(url), url);
const journals = (id) =>
  ['config', 'cue'].map((kind) =>
    path.join(
      root,
      'dubbing-sessions',
      `.${kind}-drafts`,
      `${createHash('sha256').update(id).digest('hex')}.json`,
    ),
  );
const directory = (id) => path.join(root, 'dubbing-sessions', id);
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
const launch = async () => {
  app = await _electron.launch({
    args: [
      '.',
      process.env.SMARTSUB_RENDERER_PORT || '8888',
      `--user-data-dir=${profile}`,
    ],
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/localhost:\d+/);
  await expect
    .poll(() =>
      app.evaluate(({ ipcMain }) =>
        ipcMain._invokeHandlers.has('dubbing:loadSubtitle'),
      ),
    )
    .toBe(true);
  root = await app.evaluate(({ app, BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.closeDevTools(),
    );
    dialog.showMessageBoxSync = () => 0;
    return app.getPath('userData');
  });
};
const create = async () =>
  page.evaluate(async (subtitle) => {
    const leaseId = crypto.randomUUID();
    const result = await window.ipc.invoke('dubbing:loadSubtitle', {
      leaseId,
      subtitlePath: subtitle,
    });
    if (!result.success) throw new Error(result.error);
    await window.ipc.invoke('dubbing:disposeSession', {
      sessionId: result.data.sessionId,
      leaseId,
    });
    return result.data;
  }, subtitle);
const seed = async (session) => {
  await page.evaluate((id) => {
    for (const prefix of [
      'smartsub_dubbing_config_draft_v1:',
      'smartsub_dubbing_cue_draft_v1:',
    ])
      localStorage.setItem(prefix + id, '{retained local bytes');
  }, session.sessionId);
  await fs.writeFile(
    path.join(directory(session.sessionId), 'fixture.wav'),
    'recoverable audio',
  );
  for (const file of journals(session.sessionId)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{retained malformed draft');
  }
};
const intact = async (session, checkLocal = true) => {
  if (checkLocal)
    assert.deepEqual(
      await page.evaluate(
        (id) =>
          [
            'smartsub_dubbing_config_draft_v1:',
            'smartsub_dubbing_cue_draft_v1:',
          ].map((prefix) => localStorage.getItem(prefix + id)),
        session.sessionId,
      ),
      ['{retained local bytes', '{retained local bytes'],
    );
  assert.equal(
    await fs.readFile(
      path.join(directory(session.sessionId), 'fixture.wav'),
      'utf8',
    ),
    'recoverable audio',
  );
  for (const file of journals(session.sessionId))
    assert.equal(await fs.readFile(file, 'utf8'), '{retained malformed draft');
  assert.ok(
    await page.evaluate(
      (id) => window.ipc.invoke('getWorkItem', id),
      session.workItemId,
    ),
  );
};
const gone = async (session) => {
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          [
            'smartsub_dubbing_config_draft_v1:',
            'smartsub_dubbing_cue_draft_v1:',
          ].map((prefix) => localStorage.getItem(prefix + id)),
        session.sessionId,
      ),
    )
    .toEqual([null, null]);
  assert.equal(await exists(directory(session.sessionId)), false);
  for (const file of journals(session.sessionId))
    assert.equal(await exists(file), false);
  assert.equal(
    await page.evaluate(
      (id) => window.ipc.invoke('getWorkItem', id),
      session.workItemId,
    ),
    null,
  );
};
const remove = (channel, id) =>
  page.evaluate(
    async ({ channel, id }) => {
      try {
        return { result: await window.ipc.invoke(channel, id) };
      } catch (error) {
        return { error: String(error) };
      }
    },
    { channel, id },
  );
try {
  await launch();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  const first = await create();
  await seed(first);
  const before = await fs.readFile(
    path.join(directory(first.sessionId), 'session.json'),
    'utf8',
  );
  locked = profile;
  await fs.chmod(profile, 0o500);
  const failed = await remove('deleteWorkItem', first.workItemId);
  assert.match(failed.error || '', /EACCES|EPERM/);
  await intact(first);
  assert.equal(
    await fs.readFile(
      path.join(directory(first.sessionId), 'session.json'),
      'utf8',
    ),
    before,
  );
  await fs.chmod(profile, 0o700);
  locked = undefined;
  assert.equal((await remove('deleteWorkItem', first.workItemId)).result, true);
  await gone(first);
  checks.push(
    'Actual task-store chmod failure restores exact session/audio/two-journal bytes; retry deletes only internal data',
  );

  const second = await create();
  await seed(second);
  locked = path.join(root, 'dubbing-sessions', '.cue-drafts');
  await fs.chmod(locked, 0o500);
  await go('/zh/recent-tasks/');
  // Use the task's actual accessible delete control in whichever list layout is active.
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('内部配音');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('删除未完成');
  await intact(second);
  for (const [width, height] of [
    [1024, 700],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const bounds = await dialog.boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= width &&
        bounds.y + bounds.height <= height,
    );
    await page.screenshot({
      path: path.join(output, `delete-error-${width}.png`),
    });
  }
  await fs.chmod(locked, 0o700);
  locked = undefined;
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await gone(second);
  checks.push(
    'Actual mid-staging journal permission failure rolls back earlier moves; UI retains confirmation and error until retry succeeds',
  );

  const shared = await create();
  await seed(shared);
  await page.evaluate(async (session) => {
    const item = await window.ipc.invoke('getWorkItem', session.workItemId);
    await window.ipc.invoke('saveWorkItem', { ...item, id: 'alias-reference' });
  }, shared);
  assert.equal(
    (await remove('deleteTaskProject', shared.workItemId)).result,
    true,
  );
  assert.equal(await exists(directory(shared.sessionId)), true);
  assert.equal(
    (await remove('deleteWorkItem', 'alias-reference')).result,
    true,
  );
  await gone(shared);
  checks.push(
    'Legacy task deletion endpoint uses the same transaction; shared sessions survive until their last task reference is deleted',
  );

  const a = await create(),
    b = await create();
  await seed(a);
  await seed(b);
  locked = profile;
  await fs.chmod(profile, 0o500);
  assert.match((await remove('clearAllWorkItems')).error || '', /EACCES|EPERM/);
  await intact(a);
  await intact(b);
  await fs.chmod(profile, 0o700);
  locked = undefined;
  assert.equal((await remove('clearAllWorkItems')).result, true);
  await gone(a);
  await gone(b);
  assert.equal(
    await fs.readFile(subtitle, 'utf8'),
    '1\n00:00:00,000 --> 00:00:04,000\nDeletion fixture.\n',
  );
  checks.push(
    'Clear-all stages all sessions and rolls them all back on task-store failure, then deletes both journals on success; source retained',
  );
  for (const phase of ['before-commit', 'after-commit']) {
    const crashed = await create();
    await seed(crashed);
    await app.evaluate(({}, phase) => {
      const fs = process.getBuiltinModule('fs');
      if (phase === 'before-commit') {
        const rename = fs.renameSync;
        fs.renameSync = (...args) => {
          const result = rename(...args);
          if (
            String(args[1]).includes('/.deleted/') &&
            String(args[1]).endsWith('.cue')
          )
            process.kill(process.pid, 'SIGKILL');
          return result;
        };
      } else {
        const rm = fs.rmSync;
        fs.rmSync = (...args) => {
          if (String(args[0]).includes('/.deleted/'))
            process.kill(process.pid, 'SIGKILL');
          return rm(...args);
        };
      }
    }, phase);
    const exited = once(app.process(), 'exit');
    await page.evaluate((id) => {
      setTimeout(() => {
        void window.ipc.invoke('deleteWorkItem', id).catch(() => {});
      }, 50);
    }, crashed.workItemId);
    await exited;
    app = null;
    await launch();
    if (phase === 'before-commit') {
      await intact(crashed, false);
      assert.equal(
        (await remove('deleteWorkItem', crashed.workItemId)).result,
        true,
      );
    } else await gone(crashed);
    assert.equal(
      (await fs.readdir(path.join(root, 'dubbing-sessions', '.deleted')))
        .length,
      0,
    );
  }
  checks.push(
    'Actual whole-main-process SIGKILL before task-store commit restores data at restart; SIGKILL after commit finishes cleanup without resurrecting the task',
  );
  for (const rebuild of [false, true]) {
    for (const phase of ['before-link', 'after-link']) {
      const previous = rebuild ? await create() : null;
      if (previous) await seed(previous);
      const previousIds = (
        await fs.readdir(path.join(root, 'dubbing-sessions'))
      ).filter((name) => !name.startsWith('.'));
      const previousTasks = await page.evaluate(() =>
        window.ipc.invoke('getWorkItems'),
      );
      await app.evaluate(
        ({ ipcMain }, { phase, previousIds }) => {
          const fs = process.getBuiltinModule('fs');
          const path = process.getBuiltinModule('path');
          if (phase === 'after-link') {
            const original = ipcMain._invokeHandlers.get(
              'dubbing:loadSubtitle',
            );
            ipcMain._invokeHandlers.set(
              'dubbing:loadSubtitle',
              async (...args) => {
                const result = await original(...args);
                if (result.success) process.kill(process.pid, 'SIGKILL');
                return result;
              },
            );
            return;
          }
          const rename = fs.renameSync;
          fs.renameSync = (...args) => {
            const result = rename(...args);
            const destination = String(args[1]);
            if (
              destination.includes('/dubbing-sessions/') &&
              destination.endsWith('/session.json')
            ) {
              const id = path.basename(path.dirname(destination));
              if (!previousIds.includes(id)) {
                if (phase === 'before-link')
                  process.kill(process.pid, 'SIGKILL');
              }
            }
            return result;
          };
        },
        { phase, previousIds },
      );
      const exited = once(app.process(), 'exit');
      await page.evaluate(
        ({ subtitle, previous }) => {
          setTimeout(() => {
            void window.ipc
              .invoke('dubbing:loadSubtitle', {
                subtitlePath: subtitle,
                leaseId: crypto.randomUUID(),
                ...(previous
                  ? {
                      rebuildSessionId: previous.sessionId,
                      workItemId: previous.workItemId,
                    }
                  : {}),
              })
              .catch(() => {});
          }, 50);
        },
        { subtitle, previous },
      );
      await exited;
      app = null;
      const createdIds = (
        await fs.readdir(path.join(root, 'dubbing-sessions'))
      ).filter((name) => !name.startsWith('.') && !previousIds.includes(name));
      assert.equal(createdIds.length, 1);
      const createdId = createdIds[0];
      await launch();
      const tasks = await page.evaluate(() =>
        window.ipc.invoke('getWorkItems'),
      );
      if (phase === 'before-link') {
        assert.equal(await exists(directory(createdId)), false);
        assert.equal(tasks.length, previousTasks.length);
        if (previous) await intact(previous, false);
      } else {
        const linked = tasks.find(
          (item) => item.configSnapshot?.sessionId === createdId,
        );
        assert.ok(linked);
        if (previous) {
          assert.equal(linked.id, previous.workItemId);
          assert.equal(await exists(directory(previous.sessionId)), false);
          for (const journal of journals(previous.sessionId))
            assert.equal(await exists(journal), false);
        }
        const meta = JSON.parse(
          await fs.readFile(
            path.join(directory(createdId), 'session.json'),
            'utf8',
          ),
        );
        assert.equal(meta.pendingTaskLink, false);
        assert.equal(meta.cues[0].text, 'Deletion fixture.');
        assert.equal((await remove('deleteWorkItem', linked.id)).result, true);
      }
      if (phase === 'before-link' && previous)
        assert.equal(
          (await remove('deleteWorkItem', previous.workItemId)).result,
          true,
        );
    }
  }
  checks.push(
    'SIGKILL after new-session metadata and after durable task linkage, for both import and rebuild: unlinked untouched creations are removed, linked creations retained, old project/audio/journals recovered or deleted according to committed reference',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, checks }, null, 2));
} catch (error) {
  console.error('Evidence:', output);
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText()).slice(-10000));
    await page.screenshot({ path: path.join(output, 'failure.png') });
  }
  throw error;
} finally {
  if (locked) await fs.chmod(locked, 0o700);
  await app?.close();
}
