import { execSync } from 'child_process';
import path from 'path';

const testFiles = [
  'test-encoding-detector.ts',
  'test-subtitle-converter.ts',
  'test-video-trimmer.ts',
  'test-subtitle-sync.ts',
  'test-bilingual-subtitles.ts',
  'test-audio-extractor.ts',
];

console.log('=== Running All Toolbox Unit Tests ===\n');

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`--- Running ${file} ---`);
  try {
    const output = execSync(`npx tsx "${filePath}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(output.trim());
    console.log(`✓ ${file} passed\n`);
  } catch (err: any) {
    console.error(`✗ ${file} failed:\n`, err.stderr || err.stdout || err.message);
    process.exit(1);
  }
}

console.log('🎉 All Toolbox Unit Tests Passed Successfully!');
