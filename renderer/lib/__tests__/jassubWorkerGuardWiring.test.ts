/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

// Windows 视频合成预览黑屏的规避（根因见 renderer/lib/jassub/syncCanvasGuard.ts）是靠
// webpack 把一行 `import guard` 注入 JASSUB 的 Worker 入口来生效的。规则一旦匹配不到
// （例如上游挪了 Worker 入口），守卫就不会被打进去，而构建不会有任何报错——
// 所以这里拿 jassub 的真实发布包做回归，保证「规则还命中、守卫还先于渲染器执行」。

type LoaderContext = { getOptions(): { guard?: string } };
type Loader = (this: LoaderContext, source: string) => string;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loader: Loader = require('../jassub-worker-guard-loader.js');

const JASSUB_DIST = path.resolve(
  __dirname,
  '../../../node_modules/jassub/dist',
);
const WORKER_ENTRY = path.join(JASSUB_DIST, 'worker/worker.js');

const inject = (source: string, guard = '/repo/renderer/lib/jassub/guard.ts') =>
  loader.call({ getOptions: () => ({ guard }) }, source);

describe('jassub-worker-guard-loader', () => {
  it('puts an import of the guard in front of the worker source', () => {
    expect(inject('console.log(1);')).toBe(
      'import "/repo/renderer/lib/jassub/guard.ts";console.log(1);',
    );
  });

  it('keeps the original source and its line numbers intact', () => {
    const source = "import a from 'a';\nrun(a);\n// done\n";
    const output = inject(source);

    expect(output.endsWith(source)).toBe(true);
    expect(output.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('writes Windows paths as a valid string literal', () => {
    const guard = 'C:\\repo\\renderer\\lib\\jassub\\workerGuard.ts';
    const literal = /^import (".*?");/.exec(inject('x', guard));

    expect(literal).not.toBeNull();
    expect(JSON.parse(literal![1])).toBe(guard);
  });

  it('refuses to run without the guard path', () => {
    expect(() => loader.call({ getOptions: () => ({}) }, 'x')).toThrow(/guard/);
  });
});

describe('renderer/next.config.js wiring', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nextConfig = require('../../next.config.js');
  const configured = nextConfig.webpack(
    { resolve: { modules: [] }, plugins: [], module: { rules: [] } },
    { isServer: false },
  );
  const rule = configured.module.rules.find(
    (r: { loader?: string }) =>
      typeof r.loader === 'string' &&
      r.loader.includes('jassub-worker-guard-loader'),
  );

  it('registers the loader as a pre-loader that points at an existing guard module', () => {
    expect(rule).toBeDefined();
    expect(rule.enforce).toBe('pre');
    expect(fs.existsSync(rule.loader)).toBe(true);
    expect(path.basename(rule.options.guard)).toBe('workerGuard.ts');
    expect(fs.existsSync(rule.options.guard)).toBe(true);
  });

  it.each([
    WORKER_ENTRY,
    'C:\\app\\node_modules\\jassub\\dist\\worker\\worker.js',
    '/app/node_modules/.pnpm/jassub@2.5.6/node_modules/jassub/dist/worker/worker.js',
  ])('applies to the JASSUB worker entry %s', (resource) => {
    expect(rule.test.test(resource)).toBe(true);
  });

  it.each([
    path.join(JASSUB_DIST, 'jassub.js'),
    path.join(JASSUB_DIST, 'worker/util.js'),
    path.join(JASSUB_DIST, 'worker/renderers/webgl2-renderer.js'),
    '/app/node_modules/other-lib/dist/worker/worker.js',
    path.resolve(__dirname, '../utils.ts'),
  ])('leaves %s alone', (resource) => {
    expect(rule.test.test(resource)).toBe(false);
  });

  it('matches the real worker entry shipped in node_modules', () => {
    expect(fs.existsSync(WORKER_ENTRY)).toBe(true);
    expect(rule.test.test(WORKER_ENTRY)).toBe(true);
  });
});

describe('JASSUB package shape the guard relies on (real jassub)', () => {
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const distFiles = () =>
    (fs.readdirSync(JASSUB_DIST, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.js'))
      .map((file) => path.join(JASSUB_DIST, file));

  // 沿着相对路径的 import / import() 走一遍，得到 Worker 入口会执行到的全部 dist 文件。
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const specifiers = Array.from(
        read(file).matchAll(
          /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g,
        ),
        (match) => match[2],
      );
      for (const specifier of specifiers)
        queue.push(path.resolve(path.dirname(file), specifier));
    }
    return seen;
  }

  it('still creates its Worker from dist/worker/worker.js (the file the rule targets)', () => {
    expect(read(path.join(JASSUB_DIST, 'jassub.js'))).toMatch(
      /new Worker\(\s*new URL\(\s*(['"])\.\/worker\/worker\.js\1\s*,\s*import\.meta\.url\s*\)/,
    );
  });

  it('only asks for a desynchronized canvas from code that runs inside that Worker', () => {
    const requesting = distFiles().filter((file) =>
      /\bdesynchronized\b/.test(read(file)),
    );
    const reachable = reachableFrom(WORKER_ENTRY);

    expect(requesting.length).toBeGreaterThan(0);
    expect(requesting.filter((file) => !reachable.has(file))).toEqual([]);
  });

  // 前提：上游确实写死了 true。若某天不再如此，说明这个规避可能已经多余，请复核并删除。
  it('still hard-codes desynchronized: true (the premise of this workaround)', () => {
    expect(
      distFiles().some((file) =>
        /\bdesynchronized\s*:\s*true\b/.test(read(file)),
      ),
    ).toBe(true);
  });
});

// JASSUB 允许用 opts.workerUrl 换一个自定义的 Worker 脚本（jassub/dist/jassub.js）。那样 webpack 的
// pre-loader 就碰不到实际运行的 Worker，守卫不会装上，Windows 黑屏会悄悄回来。目前应用从不传它；
// 将来真要传，得先让那份自定义 Worker 同样装上守卫，再来调整这条用例。
describe('how the app constructs JASSUB', () => {
  const RENDERER_DIR = path.resolve(__dirname, '../..');
  const IGNORED_DIRS = new Set([
    'node_modules',
    '.next',
    'out',
    'public',
    '__tests__',
  ]);
  const isSource = (name: string) =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) &&
    !/\.(?:test|d)\.[cm]?[jt]sx?$/.test(name);
  const IMPORTS_JASSUB =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])jassub(?:\/[^'"]*)?\1/;

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        return IGNORED_DIRS.has(entry.name) ? [] : sourceFiles(full);
      return isSource(entry.name) ? [full] : [];
    });
  }

  const importers = sourceFiles(RENDERER_DIR).filter((file) =>
    IMPORTS_JASSUB.test(fs.readFileSync(file, 'utf8')),
  );

  it('finds the code that imports JASSUB (so the check below is not vacuous)', () => {
    expect(
      importers.map((file) => path.relative(RENDERER_DIR, file)),
    ).toContain(
      path.join('components', 'subtitleMerge', 'hooks', 'useJassubPreview.ts'),
    );
  });

  it('never passes a custom workerUrl, which would bypass the worker guard', () => {
    expect(
      importers
        .filter((file) => /\bworkerUrl\b/.test(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(RENDERER_DIR, file)),
    ).toEqual([]);
  });
});
