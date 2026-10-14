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

    // jassub 的 WebGL2 / WebGL1 / 2D 渲染器写死 `desynchronized: true`（低延迟画布），
    // 在 Windows 上会被提升为独立的 DirectComposition 叠加层，使整块视频预览呈现为纯黑。
    // 构建期把它改写为「Windows 下为 false、其它平台保持不变」。
    // 根因、证据与取舍见 lib/jassub-sync-canvas-loader.js；上游写法变化时该 loader 会让构建失败。
    config.module.rules.push({
      test: /node_modules[\\/]jassub[\\/]dist[\\/]worker[\\/]renderers[\\/](?:2d|webgl1|webgl2)-renderer\.js$/,
      enforce: 'pre',
      loader: path.resolve(__dirname, 'lib/jassub-sync-canvas-loader.js'),
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
