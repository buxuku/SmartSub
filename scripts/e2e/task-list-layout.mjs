/**
 * Task list geometry in a real window: stable cards and rows, right-hand insets,
 * visible outlines, aligned columns, a drop overlay that does not reflow and an
 * undo for removing a single file. Local fixtures only (generated silent WAV
 * files); no models, credentials or network.
 *
 *   node scripts/e2e/task-list-layout.mjs [--production] [--label before|after] [--out <dir>]
 *
 * Every check is evaluated (not just the first failure) so a run against an old
 * layout prints the measured numbers. The script exits non-zero when any check
 * fails; screenshots land in the output directory.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { _electron, expect } from '@playwright/test';
import { appOrigin, waitForAppPage } from './app-page.mjs';

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const label = argValue('--label') || 'run';
const output =
  argValue('--out') ||
  (await fs.mkdtemp(
    path.join(os.tmpdir(), `smartsub-task-list-layout-${label}-`),
  ));
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), 'smartsub-task-list-layout-profile-'),
);

// Test hooks first; the class selectors keep the same script able to measure
// the layout from before the hooks existed.
const PANEL =
  '[data-testid="task-list-panel"], [class*="min-h-0"][class*="flex-1"][class*="overflow-hidden"][class*="rounded-lg"][class*="p-2.5"]';
const CARD = '[data-testid="task-card"], .grid > .group';
const ROW = '[data-testid="task-row"], [class*="space-y-"] > .group';
const PROGRESS_LABEL = '[data-testid="task-progress-label"], span.tabular-nums';
const RAIL_CHIP =
  '[data-testid="rail-chip"], span.inline-flex.items-center.gap-1.text-xs.whitespace-nowrap';
const ADD_SCRIPT = '+ 参考文稿';
const OPEN_FOLDER = '打开所在文件夹';
const REMOVE = '移除';
const UNDO = '撤销';

// Index 0: long name, waiting. 2: failed. 3: finished. 4: has its own reference
// script (kept last so a row of script-less cards shows what hovering does).
const names = [
  'interview-with-the-founder-about-building-a-subtitle-tool-final-cut-v12-FINAL',
  'short',
  'product-demo-walkthrough-2026-spring-release-candidate',
  'clip-04',
  'episode-12-recap',
];
const WITH_SCRIPT = 4;
const media = [];
for (const name of names) {
  const file = path.join(output, `${name}.wav`);
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=16000',
    '-t',
    '1',
    '-ac',
    '1',
    file,
  ]);
  media.push(file);
}
const manuscript = path.join(output, 'script.txt');
await fs.writeFile(manuscript, 'Hello there.\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`,
  );
};
/** A broken section is one failed check, not the end of the whole run. */
const guarded = async (name, section) => {
  try {
    await section();
  } catch (error) {
    check(
      `${name}: ran to completion`,
      false,
      String(error?.message ?? error).split('\n')[0],
    );
  }
};
const fixed = (value) => Number(value).toFixed(1);
const near = (a, b, tolerance = 0.75) => Math.abs(a - b) <= tolerance;
const box = async (locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
};
const sameBox = (a, b) =>
  near(a.x, b.x) &&
  near(a.y, b.y) &&
  near(a.width, b.width) &&
  near(a.height, b.height);

const app = await _electron.launch({
  args: [
    '.',
    process.env.SMARTSUB_RENDERER_PORT || '8888',
    `--user-data-dir=${profile}`,
  ],
  env: {
    ...process.env,
    NODE_ENV: process.argv.includes('--production')
      ? 'production'
      : 'development',
  },
});

try {
  const page = await app.firstWindow();
  page.on('dialog', (dialog) => {
    // Leaving a page with a "leave site?" prompt must not stall the run.
    void (
      dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
    ).catch(() => {});
  });
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await waitForAppPage(page);
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows().forEach((win) =>
      win.webContents.closeDevTools(),
    );
  });
  await page
    .getByRole('button', { name: '跳过', exact: true })
    .click()
    .catch(() => {});

  const seed = (projectId) =>
    page.evaluate(
      async ({ media, manuscript, withScript, projectId }) => {
        const config = await window.ipc.invoke('getUserConfig');
        const dropped = await window.ipc.invoke('getDroppedFiles', {
          files: media,
          taskType: 'any',
        });
        const byPath = new Map(dropped.map((file) => [file.filePath, file]));
        const files = media.map((filePath, index) => ({
          ...byPath.get(filePath),
          ...(index === withScript
            ? { manuscriptPath: manuscript, manuscriptName: 'script.txt' }
            : {}),
          ...(index === 2
            ? {
                extractAudio: 'done',
                extractSubtitle: 'error',
                extractSubtitleError: 'Connection timed out',
              }
            : {}),
          ...(index === 3
            ? { extractAudio: 'done', extractSubtitle: 'done' }
            : {}),
        }));
        await window.ipc.invoke('saveTaskProject', {
          id: projectId,
          name: 'Task list layout',
          taskType: 'generateOnly',
          files,
          taskDraft: { config, manuscripts: [] },
          preserveTaskProgress: true,
        });
      },
      { media, manuscript, withScript: WITH_SCRIPT, projectId },
    );
  await seed('task-list-layout');
  // Removing files changes a project: one per view keeps every run independent.
  await seed('task-list-undo-grid');
  await seed('task-list-undo-list');

  const origin = appOrigin(page);
  const panel = page.locator(PANEL).first();
  const open = async (projectId, locale = 'zh') => {
    await page.goto(`${origin}/${locale}/tasks/generate/?project=${projectId}`);
    await expect(panel.locator('.group').first()).toBeVisible();
  };
  const showMode = async (mode, language = 'zh') => {
    const viewLabel =
      language === 'zh'
        ? { grid: '网格视图', list: '列表视图' }
        : { grid: 'Grid view', list: 'List view' };
    // Saved first so that late-arriving settings cannot flip the view back.
    await page.evaluate(
      (taskViewMode) => window.ipc.invoke('setSettings', { taskViewMode }),
      mode,
    );
    await page
      .getByRole('button', { name: viewLabel[mode], exact: true })
      .click();
    await expect(panel.locator(mode === 'grid' ? CARD : ROW)).toHaveCount(
      names.length,
    );
    await page.mouse.move(1, 1);
    await page.waitForTimeout(400);
    await expect(panel.locator(mode === 'grid' ? CARD : ROW)).toHaveCount(
      names.length,
    );
  };
  const resize = async (width, height) => {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          /^(app:|http:)/.test(candidate.webContents.getURL()),
        );
        win.setContentSize(size.width, size.height);
      },
      { width, height },
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    await page.waitForTimeout(300);
  };
  const setTheme = async (theme) => {
    const isDark = () =>
      page.evaluate(() => document.documentElement.classList.contains('dark'));
    if ((await isDark()) !== (theme === 'dark')) {
      await page
        .getByRole('button', { name: 'Toggle theme', exact: true })
        .click();
    }
    await expect.poll(isDark).toBe(theme === 'dark');
    await page.waitForTimeout(300);
  };
  const shot = (name) =>
    page.screenshot({
      path: path.join(output, `${label}-${name}.png`),
      animations: 'disabled',
    });

  /** Border and fill of an entry against the panel behind it (WCAG ratio). */
  const outline = (shell) =>
    shell.evaluate((el, panelSelector) => {
      const parse = (value) => {
        const nums = value.match(/-?\d*\.?\d+/g)?.map(Number) ?? [0, 0, 0, 0];
        const scale = value.startsWith('color(') ? 255 : 1;
        const [r, g, b, a = 1] = nums;
        return { r: r * scale, g: g * scale, b: b * scale, a };
      };
      const over = (top, bottom) => ({
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1,
      });
      const effective = (node) => {
        const layers = [];
        for (let n = node; n; n = n.parentElement)
          layers.push(parse(getComputedStyle(n).backgroundColor));
        return layers.reverse().reduce((under, layer) => over(layer, under), {
          r: 255,
          g: 255,
          b: 255,
          a: 1,
        });
      };
      const luminance = ({ r, g, b }) => {
        const lin = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (a, b) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const style = getComputedStyle(el);
      const behind = effective(el.closest(panelSelector));
      const border = over(parse(style.borderTopColor), effective(el));
      return {
        width: parseFloat(style.borderTopWidth),
        border: ratio(border, behind),
        fill: ratio(effective(el), behind),
      };
    }, PANEL);

  const checkOutlines = async (tag, shells) => {
    const count = await shells.count();
    const ratios = [];
    for (let i = 0; i < count; i += 1) {
      const { width, border } = await outline(shells.nth(i));
      ratios.push(width >= 1 ? border : 1);
    }
    check(
      `${tag}: every entry is outlined against the panel (contrast >= 1.25)`,
      count === names.length && ratios.every((ratio) => ratio >= 1.25),
      ratios.map((ratio) => ratio.toFixed(2)).join(' / '),
    );
  };

  /** Nothing may move or resize while the pointer wanders over the entries. */
  const checkHoverStable = async (tag, shells) => {
    const count = await shells.count();
    const moved = [];
    for (let i = 0; i < count; i += 1) {
      await page.mouse.move(1, 1);
      await shells.nth(i).scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const rest = [];
      for (let j = 0; j < count; j += 1) rest.push(await box(shells.nth(j)));
      await shells.nth(i).hover();
      await page.waitForTimeout(300);
      for (let j = 0; j < count; j += 1) {
        const now = await box(shells.nth(j));
        if (!sameBox(rest[j], now))
          moved.push(
            `hover #${i}: #${j} height ${fixed(rest[j].height)}->${fixed(now.height)}, y ${fixed(rest[j].y)}->${fixed(now.y)}`,
          );
      }
    }
    await page.mouse.move(1, 1);
    check(
      `${tag}: hovering any entry moves and resizes nothing`,
      moved.length === 0,
      moved.slice(0, 2).join('; '),
    );
  };

  const checkGrid = async (tag) => {
    const cards = panel.locator(CARD);
    await cards.first().scrollIntoViewIfNeeded();
    const boxes = [];
    for (let i = 0; i < (await cards.count()); i += 1)
      boxes.push(await box(cards.nth(i)));
    const widths = boxes.map((rect) => rect.width);
    check(
      `${tag}: cards share one width despite a long file name`,
      Math.max(...widths) - Math.min(...widths) <= 0.5,
      widths.map(fixed).join(','),
    );
    check(
      `${tag}: cards stay at least 16rem wide`,
      Math.min(...widths) >= 255.5,
      `min ${fixed(Math.min(...widths))}px`,
    );

    // The long-named card: the progress label, the status chevron and the action
    // icons share one right edge, well inside the card.
    const card = cards.first();
    const cardBox = boxes[0];
    const labelBox = await box(card.locator(PROGRESS_LABEL).first());
    const chevronBox = await box(
      card.locator('[data-testid="task-activity"] svg').first(),
    );
    const iconBox = await box(
      card
        .getByRole('button', { name: OPEN_FOLDER, exact: true })
        .locator('svg'),
    );
    const insetLabel = cardBox.right - labelBox.right;
    const insetChevron = cardBox.right - chevronBox.right;
    check(
      `${tag}: the progress label keeps >= 14px from the card edge`,
      insetLabel >= 14,
      `${fixed(insetLabel)}px`,
    );
    check(
      `${tag}: the status chevron keeps >= 14px from the card edge`,
      insetChevron >= 14,
      `${fixed(insetChevron)}px`,
    );
    check(
      `${tag}: the action icons share the label and chevron right edge`,
      near(iconBox.right, labelBox.right, 4) &&
        near(iconBox.right, chevronBox.right, 4),
      `icon ${fixed(cardBox.right - iconBox.right)} / label ${fixed(insetLabel)} / chevron ${fixed(insetChevron)}px from the edge`,
    );

    // The add-script chip is laid out at rest; only its opacity changes.
    const chip = card.getByTitle(ADD_SCRIPT);
    const paint = () =>
      chip.evaluate((el) => ({
        display: getComputedStyle(el).display,
        opacity: getComputedStyle(el).opacity,
      }));
    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
    const rest = await paint();
    await card.hover();
    await page.waitForTimeout(300);
    const hovered = await paint();
    await card.screenshot({
      path: path.join(
        output,
        `${label}-${tag.replace(/\W+/g, '-')}-card-hover.png`,
      ),
      animations: 'disabled',
    });
    await page.mouse.move(1, 1);
    check(
      `${tag}: the add-script chip is laid out at rest and fades in on hover`,
      rest.display !== 'none' &&
        Number(rest.opacity) < 0.05 &&
        Number(hovered.opacity) > 0.95,
      `rest ${rest.display}/${rest.opacity}, hover ${hovered.display}/${hovered.opacity}`,
    );
    const meta = card.locator('[data-testid="task-card-meta"]');
    const metaHeight = (await meta.count()) ? (await box(meta)).height : null;
    check(
      `${tag}: the meta row has a fixed 24px height`,
      metaHeight !== null && near(metaHeight, 24, 0.5),
      metaHeight === null ? 'missing' : `${fixed(metaHeight)}px`,
    );

    // A long name is truncated in the middle of the stem, not at the extension.
    const name = card.locator('[data-testid="task-name"]');
    const ext = card.locator('[data-testid="task-name-ext"]');
    const hasName = (await name.count()) === 1 && (await ext.count()) === 1;
    const truncated = hasName
      ? await name.evaluate((el) => {
          const stem = el.firstElementChild;
          return stem.scrollWidth > stem.clientWidth;
        })
      : false;
    check(
      `${tag}: the long name is truncated but its extension stays visible`,
      hasName &&
        truncated &&
        (await ext.innerText()) === '.wav' &&
        (await box(ext)).right <= cardBox.right - 8,
      hasName ? `truncated=${truncated}` : 'missing task-name hooks',
    );

    // A reference script pill must not squeeze the size and duration text.
    const sizeText = cards
      .nth(WITH_SCRIPT)
      .locator('[data-testid="task-card-meta"] > span')
      .first();
    const sizeClipped =
      (await sizeText.count()) === 1
        ? await sizeText.evaluate((el) => el.scrollWidth > el.clientWidth)
        : true;
    check(
      `${tag}: the file size stays readable next to a reference script`,
      !sizeClipped,
      sizeClipped ? 'clipped or no meta row' : '',
    );

    await checkHoverStable(tag, cards);
    await checkOutlines(tag, cards);
  };

  const checkList = async (tag) => {
    const rows = panel.locator(ROW);
    await rows.first().scrollIntoViewIfNeeded();
    const boxes = [];
    for (let i = 0; i < (await rows.count()); i += 1)
      boxes.push(await box(rows.nth(i)));
    const gaps = boxes.slice(1).map((rect, i) => rect.y - boxes[i].bottom);
    check(
      `${tag}: rows are separated by at least 8px`,
      gaps.length > 0 && gaps.every((gap) => gap >= 7.5),
      gaps.map(fixed).join(','),
    );

    // A waiting and a finished row have the same stages: their chips line up.
    const chipX = async (index) =>
      (await box(rows.nth(index).locator(RAIL_CHIP).first())).x;
    const [waiting, finished] = [await chipX(0), await chipX(3)];
    check(
      `${tag}: stage chips line up between a waiting and a finished row`,
      near(waiting, finished, 0.5),
      `x ${fixed(waiting)} vs ${fixed(finished)}`,
    );

    // The status text starts under the file name; the chevron sits with the
    // action icons, inside the row.
    const first = rows.first();
    const rowBox = boxes[0];
    const nameLocator = first.locator('[data-testid="task-name"]').first();
    const nameBox = (await nameLocator.count()) ? await box(nameLocator) : null;
    const messageBox = await box(
      first.locator('[data-testid="task-activity-message"]').first(),
    );
    check(
      `${tag}: the status text starts under the file name`,
      nameBox !== null && near(messageBox.x, nameBox.x, 1.5),
      nameBox
        ? `status ${fixed(messageBox.x)} / name ${fixed(nameBox.x)}`
        : 'missing task-name hook',
    );
    const chevronBox = await box(
      first.locator('[data-testid="task-activity"] svg').first(),
    );
    const iconBox = await box(
      first
        .getByRole('button', { name: OPEN_FOLDER, exact: true })
        .locator('svg'),
    );
    check(
      `${tag}: the chevron lines up with the action icons, inside the row`,
      near(chevronBox.right, iconBox.right, 4) &&
        rowBox.right - chevronBox.right >= 14,
      `chevron ${fixed(rowBox.right - chevronBox.right)} / icon ${fixed(rowBox.right - iconBox.right)}px from the edge`,
    );

    const chip = first.getByTitle(ADD_SCRIPT);
    check(
      `${tag}: the add-script chip has a single plus`,
      (await chip.count()) === 1 &&
        (await chip.first().locator('svg').count()) === 0,
    );

    await checkHoverStable(tag, rows);
    await checkOutlines(tag, rows);
  };

  const checkDropOverlay = async (tag, shells) => {
    const first = shells.first();
    await first.scrollIntoViewIfNeeded();
    const rest = await box(first);
    const fire = (type, intoChild) =>
      panel.evaluate(
        (el, { type, intoChild }) => {
          el.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: new DataTransfer(),
              relatedTarget: intoChild
                ? el.querySelector(
                    '[data-testid="task-card"], [data-testid="task-row"], .group',
                  )
                : null,
            }),
          );
        },
        { type, intoChild },
      );
    const overlay = page.locator('[data-testid="task-list-drop-overlay"]');
    const overlayOpacity = async () =>
      (await overlay.count()) === 1
        ? Number(await overlay.evaluate((el) => getComputedStyle(el).opacity))
        : -1;
    await fire('dragover', false);
    await page.waitForTimeout(300);
    const dragging = await box(first);
    check(
      `${tag}: dragging a file over the list does not move the entries`,
      sameBox(rest, dragging),
      `x ${fixed(rest.x)}->${fixed(dragging.x)}, y ${fixed(rest.y)}->${fixed(dragging.y)}, width ${fixed(rest.width)}->${fixed(dragging.width)}`,
    );
    const shown = await overlayOpacity();
    check(
      `${tag}: a drop overlay announces the target`,
      shown > 0.95,
      shown === -1 ? 'no overlay' : `opacity ${shown}`,
    );
    await shot(`${tag.replace(/\W+/g, '-')}-dragging`);
    await fire('dragleave', true);
    await page.waitForTimeout(300);
    const kept = await overlayOpacity();
    check(
      `${tag}: moving onto a child of the list keeps the overlay (no flicker)`,
      kept > 0.95,
      kept === -1 ? 'no overlay' : `opacity ${kept}`,
    );
    await fire('dragleave', false);
    await page.waitForTimeout(300);
    const gone = await overlayOpacity();
    check(
      `${tag}: leaving the list hides the overlay`,
      gone === 0,
      gone === -1 ? 'no overlay' : `opacity ${gone}`,
    );
  };

  const checkUndo = async (tag, shells) => {
    const order = () =>
      shells.evaluateAll((els) =>
        els.map((el) => el.innerText.split('\n').find(Boolean)),
      );
    const before = await order();
    const victim = shells.nth(1);
    await victim.scrollIntoViewIfNeeded();
    await victim.hover();
    await victim.getByRole('button', { name: REMOVE, exact: true }).click();
    await expect(shells).toHaveCount(names.length - 1);
    const undo = page.getByRole('button', { name: UNDO, exact: true });
    const offered = await undo
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    check(`${tag}: removing one file offers an undo`, offered);
    if (offered) {
      await undo.click();
      await expect(shells).toHaveCount(names.length);
    }
    const after = await order();
    check(
      `${tag}: undo puts the file back in its original place`,
      JSON.stringify(after) === JSON.stringify(before),
      `${before.length} -> ${after.length} entries`,
    );
  };

  // Geometry in the dark theme, outlines and screenshots in both themes.
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [
      [1024, 700],
      [1440, 900],
    ]) {
      await open('task-list-layout');
      await setTheme(theme);
      await resize(width, height);
      for (const mode of ['grid', 'list']) {
        await showMode(mode);
        const tag = `${mode}@${width} ${theme}`;
        await shot(`${mode}-${width}-${theme}`);
        await guarded(tag, () =>
          theme === 'dark'
            ? (mode === 'grid' ? checkGrid : checkList)(tag)
            : checkOutlines(tag, panel.locator(mode === 'grid' ? CARD : ROW)),
        );
      }
    }
  }

  await setTheme('dark');
  await resize(1024, 700);
  for (const mode of ['grid', 'list']) {
    await showMode(mode);
    await guarded(`${mode}@1024 drag`, () =>
      checkDropOverlay(
        `${mode}@1024`,
        panel.locator(mode === 'grid' ? CARD : ROW),
      ),
    );
  }

  // English labels are longer: look at them, too.
  await open('task-list-layout', 'en');
  for (const mode of ['grid', 'list']) {
    await showMode(mode, 'en');
    await shot(`${mode}-1024-dark-en`);
  }

  // Removing a file is undoable.
  for (const mode of ['grid', 'list']) {
    await open(`task-list-undo-${mode}`);
    await showMode(mode);
    await guarded(`${mode} removal`, () =>
      checkUndo(`${mode} removal`, panel.locator(mode === 'grid' ? CARD : ROW)),
    );
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors[0]);
} finally {
  await app.close();
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed; screenshots: ${output}`,
);
if (failed.length) {
  console.error(
    `${failed.length} failing:\n${failed
      .map(
        (result) =>
          `  - ${result.name}${result.detail ? ` [${result.detail}]` : ''}`,
      )
      .join('\n')}`,
  );
  process.exitCode = 1;
}
