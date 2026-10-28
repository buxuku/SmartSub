const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loader(stubs) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        structuredClone,
        process: stubs.process || process,
        console,
        AbortController,
        URL,
        setInterval,
        clearInterval,
        require(request) {
          if (stubs[request]) return stubs[request];
          if (request.startsWith('.'))
            return load(path.resolve(path.dirname(filename), `${request}.ts`));
          return require(request);
        },
      },
      { filename },
    );
    return module.exports;
  }
  return load;
}

module.exports = loader;
