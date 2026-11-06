import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reserveToolboxOutput,
  toolboxOutputDirectory,
} from '../../main/helpers/toolbox/outputPath';
import { convertSubtitleFile } from '../../main/helpers/toolbox/subtitleConverter';

async function main() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'smartsub-output-test-'),
  );
  try {
    const source = path.join(directory, 'source.srt');
    const content = '1\n00:00:00,000 --> 00:00:01,000\nTest\n';
    fs.writeFileSync(source, content);
    const reserved = reserveToolboxOutput(source);
    assert.notEqual(reserved, source);
    assert.equal(fs.readFileSync(source, 'utf8'), content);
    assert.notEqual(reserveToolboxOutput(source), reserved);
    assert.throws(() =>
      toolboxOutputDirectory(path.join(directory, 'missing'), source),
    );
    assert.throws(() => toolboxOutputDirectory(source, source));
    const outputs = await Promise.all(
      Array.from({ length: 3 }, () =>
        convertSubtitleFile({ filePath: source, targetFormat: 'vtt' }),
      ),
    );
    assert.ok(outputs.every((result) => result.success));
    assert.equal(new Set(outputs.map((result) => result.outputPath)).size, 3);
    for (const output of outputs)
      assert.match(fs.readFileSync(output.outputPath!, 'utf8'), /Test/);
    assert.equal(fs.readFileSync(source, 'utf8'), content);
    console.log(
      'Toolbox output safety: source preservation, concurrent collision reservation and invalid directories passed.',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
