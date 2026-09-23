const webpack = require('webpack');
const path = require('path');
const config = require('../nextron.config.js').webpack({
  mode: 'development',
  target: 'electron-main',
  entry: { background: './main/background.ts', preload: './main/preload.ts' },
  output: {
    path: path.resolve('app'),
    filename: '[name].js',
    library: { type: 'commonjs2' },
  },
  externals: Object.keys(require('../package.json').dependencies),
  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: require.resolve('babel-loader'),
          options: { extends: require.resolve('nextron/babel') },
        },
      },
    ],
  },
  resolve: { extensions: ['.ts', '.tsx', '.js', '.json'] },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('development'),
    }),
  ],
  node: { __dirname: false, __filename: false },
});
webpack(config).run((error, stats) => {
  if (error) throw error;
  console.log(
    stats.toString({ all: false, errors: true, warnings: true, timings: true }),
  );
  process.exitCode = stats.hasErrors() ? 1 : 0;
});
