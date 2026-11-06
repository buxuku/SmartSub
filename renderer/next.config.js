/** @type {import('next').NextConfig} */
const path = require('path');
const webpack = require('webpack');

module.exports = {
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  output: 'export',
  distDir: process.env.NODE_ENV === 'production' ? '../app' : '.next',
  webpack: (config, { isServer }) => {
    // 添加 types 目录到 webpack 解析路径
    config.resolve.modules.push(path.resolve('./types'));

    // jassub 2.5.6 发布包缺失 dist/default.woff2（上游打包 bug）。
    // 该文件仅在未提供 defaultFont/availableFonts 时被引用，我们始终显式传入字体，
    // 属死代码——用空占位文件替换以通过构建。
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^\.\/default\.woff2$/,
        path.resolve(__dirname, 'lib/jassub-default-font.woff2'),
      ),
    );

    // jassub 的 WebGL2 / WebGL1 / 2D 渲染器在 Worker 里写死 `desynchronized: true`（低延迟画布），
    // 在 Windows 上会被提升为独立的 DirectComposition 叠加层，使整块视频预览呈现为纯黑。
    // 不改写 jassub 的源码：在它的 Worker 入口最前面注入一行 `import guard`，
    // 由守卫在运行时把「请求 desynchronized」改成「Windows 下不请求」，其它平台保持上游行为。
    // 根因、证据与取舍见 lib/jassub/syncCanvasGuard.ts；
    // 规则是否仍命中真实的 jassub Worker 入口，由 lib/__tests__/jassubWorkerGuardWiring.test.ts 把关；
    // 规则命中不了时构建不会报错，所以产物里是否真的带着守卫，另由 CI 在 yarn build 之后跑
    // scripts/check-jassub-worker-guard.mjs 把关。
    config.module.rules.push({
      test: /node_modules[\\/]jassub[\\/]dist[\\/]worker[\\/]worker\.js$/,
      enforce: 'pre',
      loader: path.resolve(__dirname, 'lib/jassub-worker-guard-loader.js'),
      options: { guard: path.resolve(__dirname, 'lib/jassub/workerGuard.ts') },
    });

    // 确保 TypeScript 文件被正确处理
    config.module.rules.push({
      test: /\.tsx?$/,
      use: [
        {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-typescript'],
          },
        },
      ],
    });

    return config;
  },
};
