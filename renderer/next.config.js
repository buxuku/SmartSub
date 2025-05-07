/** @type {import('next').NextConfig} */
const path = require('path');

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
