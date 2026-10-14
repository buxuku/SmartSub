/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// Windows 视频合成预览黑屏的构建期规避（根因见 renderer/lib/jassub-sync-canvas-loader.js）。
// 这里用 jassub 的真实渲染器源码做回归：上游升级后若不再写死
// `desynchronized: true`，或改了写法，这些用例（以及构建本身）会立刻报错，
// 提醒维护者复核/删除该规避，而不是让它悄悄失效。

type LoaderContext = { resourcePath: string };
type Loader = (this: LoaderContext, source: string) => string;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loader: Loader = require('../jassub-sync-canvas-loader.js');

const JASSUB_DIST = path.resolve(
  __dirname,
  '../../../node_modules/jassub/dist',
);
const RENDERERS_DIR = path.join(JASSUB_DIST, 'worker/renderers');
const RENDERERS = [
  '2d-renderer.js',
  'webgl1-renderer.js',
  'webgl2-renderer.js',
];

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SmartSub/3.9.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36';

const readRenderer = (file: string) =>
  fs.readFileSync(path.join(RENDERERS_DIR, file), 'utf8');
const transform = (file: string) =>
  loader.call(
    { resourcePath: path.join(RENDERERS_DIR, file) },
    readRenderer(file),
  );

// 取出 setCanvas 里对「真正显示的那块画布」的 getContext(...) 调用（变量名恒为 canvas），
// 在沙箱里执行，观察它实际向 getContext 传了什么属性。
function requestedDesynchronized(
  file: string,
  sandbox: { navigator?: { userAgent: string } },
): boolean {
  const call =
    /canvas\.getContext\((['"])(?:webgl2|webgl|2d)\1,\s*\{[^}]*\}\)/.exec(
      transform(file),
    );
  if (!call)
    throw new Error(`${file}: display-canvas getContext call not found`);
  const attrs = vm.runInNewContext(call[0], {
    canvas: { getContext: (_type: string, attributes: unknown) => attributes },
    ...sandbox,
  }) as { desynchronized: boolean };
  return attrs.desynchronized;
}

describe('jassub-sync-canvas-loader', () => {
  describe.each(RENDERERS)('%s (real JASSUB source)', (file) => {
    it('upstream still hard-codes desynchronized: true (the premise of this workaround)', () => {
      expect(readRenderer(file)).toMatch(/desynchronized\s*:\s*true/);
    });

    it('rewrites every desynchronized: true request instead of dropping the attribute', () => {
      const source = readRenderer(file);
      const out = transform(file);
      expect(out).not.toMatch(/desynchronized\s*:\s*true/);
      expect(out.match(/desynchronized/g)).toHaveLength(
        source.match(/desynchronized/g)!.length,
      );
    });

    it('asks for a synchronized canvas on Windows', () => {
      expect(
        requestedDesynchronized(file, { navigator: { userAgent: WINDOWS_UA } }),
      ).toBe(false);
    });

    it.each([
      ['macOS', MAC_UA],
      ['Linux', LINUX_UA],
    ])('keeps upstream behavior (desynchronized: true) on %s', (_name, ua) => {
      expect(
        requestedDesynchronized(file, { navigator: { userAgent: ua } }),
      ).toBe(true);
    });

    it('keeps upstream behavior when navigator is unavailable', () => {
      expect(requestedDesynchronized(file, {})).toBe(true);
    });
  });

  it('fails the build loudly when upstream no longer hard-codes desynchronized: true', () => {
    expect(() =>
      loader.call(
        { resourcePath: '/x/node_modules/jassub/dist/worker/renderers/y.js' },
        "canvas.getContext('webgl2', { desynchronized: false });",
      ),
    ).toThrow(/jassub\/dist\/worker\/renderers\/y\.js[\s\S]*desynchronized/);
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
      r.loader.includes('jassub-sync-canvas-loader'),
  );

  it('registers the loader and the loader file exists', () => {
    expect(rule).toBeDefined();
    expect(fs.existsSync(rule.loader)).toBe(true);
  });

  it.each([
    path.join(RENDERERS_DIR, '2d-renderer.js'),
    path.join(RENDERERS_DIR, 'webgl1-renderer.js'),
    path.join(RENDERERS_DIR, 'webgl2-renderer.js'),
    'C:\\app\\node_modules\\jassub\\dist\\worker\\renderers\\webgl2-renderer.js',
  ])('applies to %s', (resource) => {
    expect(rule.test.test(resource)).toBe(true);
  });

  // 防止升级 jassub 后文件被挪动/新增（规则匹配不到就不会触发 loader，也就不会报错）。
  it('covers every shipped jassub file that hard-codes desynchronized: true', () => {
    const hardCoded = (
      fs.readdirSync(JASSUB_DIST, { recursive: true }) as string[]
    )
      .filter((file) => file.endsWith('.js'))
      .map((file) => path.join(JASSUB_DIST, file))
      .filter((file) =>
        /\bdesynchronized\s*:\s*true\b/.test(fs.readFileSync(file, 'utf8')),
      );
    expect(hardCoded.length).toBeGreaterThan(0);
    for (const file of hardCoded) expect(rule.test.test(file)).toBe(true);
  });

  it.each([
    path.join(RENDERERS_DIR, 'webgpu-renderer.js'),
    path.join(RENDERERS_DIR, '../worker.js'),
    path.join(RENDERERS_DIR, '../util.js'),
    path.resolve(__dirname, '../utils.ts'),
  ])('does not touch %s', (resource) => {
    expect(rule.test.test(resource)).toBe(false);
  });
});
