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
