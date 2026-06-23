const webpack = require('webpack');

module.exports = {
  // Webpack 自定义见 nextron 文档；DEV_SIMULATE_* 必须在运行时读取，勿用 EnvironmentPlugin 注入
  //
  // https-proxy-agent / http-proxy-agent 自 v6+ 为纯 ESM，而主进程产物 background.js
  // 是 CommonJS（Electron 用 require 加载）。nextron 默认把 package.json 里所有依赖
  // 都 externals 化（运行时 require），会触发 ERR_REQUIRE_ESM。
  // 这里把这两个 ESM 包从 externals 移除，交给 webpack 打包进 bundle（其传递依赖
  // agent-base / proxy-agent-negotiate 未在 dependencies 中，默认即被打包）。
  webpack: (config) => {
    const BUNDLE_IN = new Set(['https-proxy-agent', 'http-proxy-agent']);
    if (Array.isArray(config.externals)) {
      config.externals = config.externals.filter(
        (ext) => !(typeof ext === 'string' && BUNDLE_IN.has(ext)),
      );
    }
    // proxy-agent-negotiate 仅在 Kerberos/Negotiate 代理鉴权时才 `await import('kerberos')`
    // （我们从不启用），kerberos 是可选原生模块。忽略它以消除无意义的打包告警。
    config.plugins = config.plugins || [];
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^kerberos$/ }),
    );
    return config;
  },
};
