import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { buildAssDocument } from '../main/helpers/assStyleBuilder';
import {
  styleAssDocument,
  buildStyledAssDocument,
  translatedAssFilter,
} from '../main/helpers/assCanvas';
import {
  absoluteSubtitleY,
  draggedSubtitleY,
  assEventPositionY,
  assMarginPositionY,
} from '../types/subtitleCanvas';
import type { SubtitleAlignment, SubtitleStyle } from '../types/subtitleMerge';
import { buildComposePlan } from '../main/helpers/compose/composeCommandBuilder';

const style: SubtitleStyle = {
  fontName: 'Arial',
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 1,
  outline: 0,
  shadow: 0,
  alignment: 2,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};
async function main() {
  const output = await fs.mkdtemp(
    path.join(os.tmpdir(), 'smartsub-compose-canvas-unit-'),
  );
  const bounds = [];
  for (let alignment = 1; alignment <= 9; alignment++) {
    const file = path.join(output, `alignment-${alignment}.ass`);
    await fs.writeFile(
      file,
      buildAssDocument([{ startMs: 0, endMs: 1000, text: 'TEST' }], {
        ...style,
        alignment: alignment as SubtitleAlignment,
      }),
    );
    const pixels = execFileSync(ffmpeg!, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=384x288:d=1',
      '-vf',
      `ass='${file}'`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    let minX = 384,
      maxX = 0,
      minY = 288,
      maxY = 0;
    for (let i = 0; i < pixels.length; i++)
      if (pixels[i] > 200) {
        const x = i % 384,
          y = Math.floor(i / 384);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    assert.ok(maxX > minX && maxY > minY, 'libass must render visible glyphs');
    bounds.push({ alignment, x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  }
  console.log(JSON.stringify({ output, bounds }));
  for (const item of bounds) {
    const column = (item.alignment - 1) % 3;
    const row = Math.floor((item.alignment - 1) / 3);
    assert.ok(
      column === 0
        ? item.x < 96
        : column === 1
          ? Math.abs(item.x - 192) < 10
          : item.x > 288,
      `alignment ${item.alignment}: horizontal position`,
    );
    assert.ok(
      row === 0
        ? item.y > 216
        : row === 1
          ? Math.abs(item.y - 144) < 12
          : item.y < 72,
      `alignment ${item.alignment}: vertical position`,
    );
  }
  assert.equal(absoluteSubtitleY({ ...style, positionY: NaN }), undefined);
  assert.equal(absoluteSubtitleY({ ...style, positionY: 120 }), 100);
  assert.equal(draggedSubtitleY({ ...style, positionY: 50 }, 36, 360), 60);
  assert.equal(draggedSubtitleY({ ...style, positionY: 50 }, -900, 360), 0);
  assert.equal(draggedSubtitleY({ ...style, positionY: 50 }, 0, 0), 50);
  assert.equal(assEventPositionY('{\\pos(90,480)}ASS', 640, 0, 3000), 75);
  assert.equal(
    assEventPositionY('{\\move(90,480,120,160)}ASS', 640, 1500, 3000),
    50,
  );
  assert.equal(
    assEventPositionY('{\\move(90,480,120,160,1000,2000)}ASS', 640, 2500, 3000),
    25,
  );
  assert.equal(
    assEventPositionY('{\\move(90,480,120,160,1000,2000)}ASS', 640, 500, 3000),
    75,
  );
  assert.equal(assEventPositionY('{\\pos(90,no)}ASS', 640, 0, 3000), undefined);
  assert.equal(assEventPositionY('{\\pos(90,480)}ASS', 0, 0, 3000), undefined);
  assert.equal(assMarginPositionY('ASS', style, 640), 96.875);
  assert.equal(assMarginPositionY('{\\an7}ASS', style, 640, 80), 12.5);
  assert.equal(assMarginPositionY('{\\a10}ASS', style, 640, 80), 50);
  const original = buildAssDocument(
    [{ startMs: 0, endMs: 1000, text: 'First\nSecond' }],
    style,
  )
    .replace('PlayResX: 384', 'PlayResX: 1920')
    .replace('PlayResY: 288', 'PlayResY: 1080')
    .replace(
      'First\\NSecond',
      '{\\pos(840,900)\\bord4\\i1}First, text\\NSecond',
    );
  const moved = styleAssDocument(original, { ...style, positionY: 25 });
  assert.match(moved, /\\pos\(840,270\)/);
  assert.match(moved, /\\bord4\\i1\}First, text\\NSecond/);
  assert.equal((moved.match(/\\pos\(/g) || []).length, 1);
  assert.ok(
    styleAssDocument(original, style).includes(
      '{\\pos(840,900)\\bord4\\i1}First, text\\NSecond',
    ),
  );
  const layered = buildAssDocument(
    [{ startMs: 0, endMs: 1000, text: 'PLACEHOLDER' }],
    style,
  ).replace(
    /^Dialogue:.*$/m,
    [
      'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an7\\pos(20,40)\\org(20,40)\\p1\\clip(0,30,100,70)\\t(0,500,\\clip(0,20,120,80))}m 0 0 l 20 0 20 20 0 20',
      'Dialogue: 2,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an5\\move(100,140,200,160,100,900)\\iclip(2,m 0 200 l 400 200 400 400 0 400)}MOVING',
      'Dialogue: 4,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\pos(190,230)}BOTTOM',
    ].join('\n'),
  );
  const shifted = styleAssDocument(layered, {
    ...style,
    positionReferenceY: (40 / 288) * 100,
    positionY: (60 / 288) * 100,
  });
  assert.match(
    shifted,
    /\\an7\\pos\(20,60\)\\org\(20,60\)\\p1\\clip\(0,50,100,90\)\\t\(0,500,\\clip\(0,40,120,100\)\)/,
  );
  assert.match(
    shifted,
    /\\an5\\move\(100,160,200,180,100,900\)\\iclip\(2,m 0 240 l 400 240 400 440 0 440\)/,
  );
  assert.match(shifted, /\\pos\(190,250\)/);
  assert.match(shifted, /m 0 0 l 20 0 20 20 0 20/);
  const pixelFrame = (file: string, time: number, translateY = 0) =>
    execFileSync(ffmpeg!, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=384x288:r=25:d=1',
      '-vf',
      `format=rgba,${translatedAssFilter(`ass='${file}'`, translateY)}`,
      '-ss',
      String(time),
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
  const beforeFile = path.join(output, 'layers-before.ass');
  const afterFile = path.join(output, 'layers-after.ass');
  await fs.writeFile(beforeFile, styleAssDocument(layered, style));
  await fs.writeFile(afterFile, shifted);
  for (const time of [0.12, 0.52, 0.92]) {
    const before = pixelFrame(beforeFile, time);
    const after = pixelFrame(afterFile, time);
    let visible = 0;
    let mismatch = 0;
    for (let y = 0; y < 268; y++) {
      for (let x = 0; x < 384; x++) {
        const index = y * 384 + x;
        if (before[index] > 50) visible++;
        if (before[index] !== after[index + 20 * 384]) mismatch++;
      }
    }
    assert.ok(visible > 400, `visible layers at ${time}`);
    assert.equal(
      mismatch,
      0,
      `all animated layers translate exactly 20 pixels at ${time}`,
    );
  }
  const stacked = buildAssDocument(
    [
      { startMs: 0, endMs: 1000, text: 'LOWER' },
      { startMs: 0, endMs: 1000, text: 'UPPER' },
    ],
    { ...style, marginV: 50 },
  );
  const stackedMoved = styleAssDocument(stacked, {
    ...style,
    marginV: 50,
    positionY: ((288 - 50 + 20) / 288) * 100,
  });
  assert.doesNotMatch(stackedMoved, /\\pos\(/);
  await fs.writeFile(beforeFile, stacked);
  await fs.writeFile(afterFile, stackedMoved);
  const stackedBefore = pixelFrame(beforeFile, 0.52);
  const stackedAfter = pixelFrame(afterFile, 0.52);
  assert.deepEqual(
    stackedBefore.subarray(0, 268 * 384),
    stackedAfter.subarray(20 * 384),
    'automatic collision stacking translates without overlap',
  );
  for (const alignment of [2, 8] as const) {
    for (const delta of alignment === 2 ? [20, 40] : [-20, -40]) {
      const boundaryStyle = { ...style, alignment, marginV: 20 };
      const originalY = alignment === 2 ? 268 : 20;
      const source = buildAssDocument(
        [
          { startMs: 0, endMs: 1000, text: 'FIRST' },
          { startMs: 0, endMs: 1000, text: 'SECOND' },
          { startMs: 0, endMs: 1000, text: 'THIRD' },
        ],
        boundaryStyle,
      );
      // A captured pointer anchor can be inside a stacked block, not its edge.
      const moved = buildStyledAssDocument(source, {
        ...boundaryStyle,
        positionReferenceY: 50,
        positionY: 50 + (delta / 288) * 100,
      });
      assert.doesNotMatch(moved.content, /\\pos\(/);
      await fs.writeFile(beforeFile, source);
      await fs.writeFile(afterFile, moved.content);
      const before = pixelFrame(beforeFile, 0.52);
      const after = pixelFrame(afterFile, 0.52, moved.translateY);
      let visible = 0;
      for (let y = 0; y < 288; y++) {
        const sourceY = y - delta;
        for (let x = 0; x < 384; x++) {
          const expected =
            sourceY >= 0 && sourceY < 288 ? before[sourceY * 384 + x] : 0;
          const actual = after[y * 384 + x];
          if (actual > 200) visible++;
          assert.equal(actual, expected, `edge ${originalY} delta ${delta}`);
        }
      }
      assert.ok(visible > 50, 'at least one stacked line stays visible');
    }
  }
  const centered = buildAssDocument(
    [
      { startMs: 0, endMs: 1000, text: 'FIRST' },
      { startMs: 0, endMs: 1000, text: 'SECOND' },
    ],
    { ...style, alignment: 5 },
  );
  const stationary = styleAssDocument(centered, {
    ...style,
    alignment: 5,
    positionY: 50,
  });
  assert.doesNotMatch(stationary, /\\pos\(/);
  await fs.writeFile(beforeFile, centered);
  await fs.writeFile(afterFile, stationary);
  assert.deepEqual(pixelFrame(beforeFile, 0.52), pixelFrame(afterFile, 0.52));
  const inlineCenter = centered
    .replace(/,,FIRST/, ',,{\\an5}FIRST')
    .replace(/,,SECOND/, ',,{\\an5}SECOND');
  const inlineMoved = buildStyledAssDocument(inlineCenter, {
    ...style,
    positionY: 60,
  });
  assert.equal(
    inlineMoved.translateY,
    0.1,
    'numeric Y uses native inline alignment, not the panel default',
  );
  for (const delta of [-40, 40]) {
    const moved = buildStyledAssDocument(centered, {
      ...style,
      alignment: 5,
      positionY: 50 + (delta / 288) * 100,
    });
    assert.equal(moved.content, centered);
    await fs.writeFile(afterFile, moved.content);
    const before = pixelFrame(beforeFile, 0.52);
    const after = pixelFrame(afterFile, 0.52, moved.translateY);
    assert.deepEqual(
      before.subarray(
        Math.max(0, -delta) * 384,
        Math.min(288, 288 - delta) * 384,
      ),
      after.subarray(
        Math.max(0, delta) * 384,
        Math.min(288, 288 + delta) * 384,
      ),
      'centered automatic collision layout moves as one composited layer',
    );
  }
  for (const direction of ['up', 'down']) {
    const source = buildAssDocument(
      [{ startMs: 0, endMs: 1000, text: 'SCROLLING\nSECOND LINE' }],
      style,
    ).replace(',0,0,0,,', `,0,0,0,Scroll ${direction};50;230;5;10,`);
    const moved = styleAssDocument(source, {
      ...style,
      positionReferenceY: 50,
      positionY: 50 + (20 / 288) * 100,
    });
    assert.ok(moved.includes(`Scroll ${direction};70;250;5;10`));
    assert.doesNotMatch(moved, /\\pos\(/);
    await fs.writeFile(beforeFile, source);
    await fs.writeFile(afterFile, moved);
    for (const time of [0.12, 0.52, 0.92]) {
      const before = pixelFrame(beforeFile, time);
      const after = pixelFrame(afterFile, time);
      assert.ok(
        before.some((pixel) => pixel > 200),
        'scroll is visible',
      );
      assert.deepEqual(
        before.subarray(0, 268 * 384),
        after.subarray(20 * 384),
        `${direction} scrolling text and clip translate at ${time}`,
      );
    }
  }
  const video = path.join(output, 'matrix.mp4');
  const audio = path.join(output, 'matrix.wav');
  const run = (args: string[]) =>
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', ...args]);
  run([
    '-f',
    'lavfi',
    '-i',
    'color=black:s=384x288:r=25:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    video,
  ]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', audio]);
  const matrix = buildStyledAssDocument(centered, {
    ...style,
    alignment: 5,
    positionY: 60,
  });
  await fs.writeFile(afterFile, matrix.content);
  for (const mode of ['keep', 'replace', 'mix', 'addTrack'] as const) {
    const final = path.join(output, `matrix-${mode}.mkv`);
    const plan = buildComposePlan(
      {
        videoPath: video,
        outputPath: final,
        subtitle: {
          mode: 'hard',
          filter: translatedAssFilter(`ass='${afterFile}'`, matrix.translateY),
          encoderArgs: ['-c:v', 'libx264', '-crf', '18'],
          needsNv12: true,
        },
        audio: mode === 'keep' ? { mode } : { mode, trackPath: audio },
      },
      { tempTag: mode },
    );
    if (plan.prep) run(['-i', plan.prep.src, '-c:a', 'aac', plan.prep.dst]);
    run([
      ...plan.inputs.flatMap((file) => ['-i', file]),
      ...(plan.videoFilter ? ['-vf', plan.videoFilter] : []),
      ...(plan.complexFilter
        ? ['-filter_complex', plan.complexFilter.join(';')]
        : []),
      ...plan.outputOptions,
      final,
    ]);
    const frame = run([
      '-i',
      final,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    assert.ok(
      frame.filter((pixel) => pixel > 200).length > 250,
      `${mode}: translated subtitle layer survives audio graph and nv12 conversion`,
    );
  }
  for (const positionY of [25, 50, 75]) {
    const file = path.join(output, `position-${positionY}.ass`);
    await fs.writeFile(
      file,
      buildAssDocument([{ startMs: 0, endMs: 1000, text: 'TEST' }], {
        ...style,
        alignment: 5,
        positionY,
      }),
    );
    const pixels = execFileSync(ffmpeg!, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=384x288:d=1',
      '-vf',
      `ass='${file}'`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    const rows = Array.from(pixels.entries())
      .filter(([, value]) => value > 200)
      .map(([i]) => Math.floor(i / 384));
    const center = (Math.min(...rows) + Math.max(...rows)) / 2;
    assert.ok(
      Math.abs(center - (positionY * 288) / 100) < 3,
      `absolute anchor ${positionY}% matches rendered pixels`,
    );
  }
  console.log('Compose canvas: real libass nine-position rendering passed.');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
