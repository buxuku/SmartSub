# 三层架构 P0：PBS 基座 + 可重定位引擎包（faster-whisper 跑通）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐 Task 实施。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 把 faster-whisper 从「PyInstaller 单可执行 sidecar」迁移到「App 内置 PBS（python-build-standalone）基座 + 按需下载的 uv 可重定位引擎包（PYTHONPATH 叠加）」，端到端跑通 tiny 模型转写，作为三层架构地基。

**Architecture:** 基座层 = 随安装包按平台内置的裁剪版 CPython 3.12.10（加载时优先 `userData/py-base/current`，回退内置，支持远程升级）；引擎层 = `uv pip install --target site-packages` 产出的可重定位包（含 `main.py`+`engines/`+`_version.py`+`site-packages/`），按引擎独立下载到 `userData/py-engines/<id>/`，spawn 基座 python 时用 `PYTHONPATH` 挂载当前引擎包；模型层不变（沿用 `faster-whisper-models` 与 HF 缓存）。

**Tech Stack:** Electron 30 + Nextron、TypeScript、Python 3.12.10（PBS）、uv、GitHub Actions、现有 `PythonRuntimeManager` / `PyEngineDownloader`(MirrorDownloader) / electron-builder。

**上游设计:** `docs/superpowers/specs/2026-06-16-three-layer-multi-engine-design.md`（已评审，§2/§3/§4/§9/§10/§12-P0）

**两个仓库:**

- 引擎仓 `~/code/github.com/buxuku/smartsub-py-engine`（分支 `feat/three-layer-p0`）：生产引擎包。
- 主仓 `~/code/github.com/buxuku/video-subtitle-master`（分支 `feat/three-layer-p0`）：内置基座 + 消费引擎包。

**关键约定（全程不可漂移）:**

- `PYTHON_VERSION = 3.12.10`（基座与所有引擎包 wheel ABI=cp312 必须一致）。
- 引擎包产物名：`smartsub-faster-whisper-<suffix>.tar.gz`，`<suffix> ∈ {macos-arm64, macos-x64, windows-x64, linux-x64}`，**归档内容在顶层**（`tar -C dist/package .`），解压即得 `main.py`/`engines/`/`_version.py`/`site-packages/`。
- 引擎包安装目录：`userData/py-engines/faster-whisper/`；基座目录：内置 `extraResources/py-base/`，可升级覆盖 `userData/py-base/current/`。
- 基座 python 入口：unix=`<base>/bin/python3`，windows=`<base>/python.exe`（PBS `install_only` 解压根为 `python/`，我们把该 `python/` 目录本身作为 `<base>`）。

**验证基线（本仓库无 jest/pytest 框架）:** 每 Task 用 `npx tsc --noEmit`（根 + `renderer/tsconfig.json`）做类型门禁；Python 用引擎仓 `smoke_test.py --package`；功能用 `npm run dev` + DevTools IPC 手工冒烟；纯函数用现有 `npm run test:engines`（tsc+node）风格补轻量单测；末 Task 跑 `npm run build`。

**提交说明:** 每次 commit 只 `git add` 本 Task 列出的文件，**绝不 `git add .`**；未明确要求不 push。提交信息用 HEREDOC。

---

## 文件结构总览

### 引擎仓 smartsub-py-engine

| 文件                                                       | 职责                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `build_engine_package.py`                                  | uv `--target` 组装可重定位引擎包 + macOS dylib id 修正 + ad-hoc 重签     |
| `_version.py`                                              | `ENGINE_VERSION` / `PROTOCOL_VERSION` 单一来源（bump 0.2.0）             |
| `requirements.txt`                                         | faster-whisper 依赖                                                      |
| `smoke_test.py`                                            | `--package` 模式：基座 python + PYTHONPATH 跑包内 main.py 做 ping        |
| `.github/workflows/release.yml`                            | 每平台 uv 构建 `smartsub-faster-whisper-<suffix>.tar.gz` + manifest.json |
| 删除 `smartsub-engine.spec`、`.python-version`(工作区残留) | 清理 PyInstaller 痕迹                                                    |

### 主仓 video-subtitle-master

| 文件                                          | 职责                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `scripts/fetch-python-base.mjs`               | CI/本地拉取 PBS、裁剪、落地 `extraResources/py-base/`                   |
| `scripts/check-bundle-size.mjs`               | 主包体积门禁（≤200MB）                                                  |
| `electron-builder.yml`                        | `extraResources` 加 `py-base/`                                          |
| `main/helpers/pythonRuntime/paths.ts`         | 新增基座/引擎包多组件路径解析 + 多 manifest                             |
| `main/helpers/pythonRuntime/manager.ts`       | `buildSanitizedEnv` 改为设 PYTHONHOME/受控 PYTHONPATH                   |
| `main/helpers/pythonRuntime/index.ts`         | `resolveEngineCommand` 组合「基座 python + 引擎 main.py + PYTHONPATH」  |
| `main/helpers/pythonRuntime/downloader.ts`    | 安装校验改为「site-packages + main.py」可重定位布局 + macOS ad-hoc 重签 |
| `main/helpers/pythonRuntime/macSign.ts`       | 新增：下载后递归 ad-hoc `codesign -s -` 兜底（仅 macOS）                |
| `main/helpers/engines/fasterWhisperEngine.ts` | `isAvailable` 改为「基座就绪 + 引擎包就绪」                             |
| `types/engine.ts`                             | `PyEngineManifest` 加 `pythonAbi`/`engineId`；新增基座 manifest 类型    |
| `package.json`                                | 加 `base:fetch`、`build` 前置 size gate 脚本                            |

---

## Task 0：基线快照

**Files:** 无代码改动

- [ ] **Step 0.1：记录两仓当前类型/构建基线**

主仓：

```bash
cd ~/code/github.com/buxuku/video-subtitle-master
npx tsc --noEmit 2>&1 | tail -5; echo "root exit=${PIPESTATUS[0]}"
npx tsc --noEmit -p renderer/tsconfig.json 2>&1 | tail -5; echo "renderer exit=${PIPESTATUS[0]}"
```

预期：记录现有历史错误条数，后续以「不新增错误」为通过标准。

- [ ] **Step 0.2：确认引擎仓工作区状态并清理 PyInstaller 残留前先备份认知**

```bash
cd ~/code/github.com/buxuku/smartsub-py-engine
git status
git show HEAD:build_engine_package.py | head -5   # 确认 HEAD 仍有 uv 版可参考
```

预期：HEAD 含 uv 版 `build_engine_package.py`（工作区已删，Task 1 恢复并定稿）。

---

## Task 1（引擎仓）：恢复并定稿 build_engine_package.py

**Files:**

- Modify/Restore: `build_engine_package.py`
- Modify: `_version.py`
- Modify: `requirements.txt`
- Delete: `smartsub-engine.spec`（工作区残留的 PyInstaller spec）

- [ ] **Step 1.1：定稿 `build_engine_package.py`（uv --target + macOS dylib 修正 + ad-hoc 重签）**

```python
#!/usr/bin/env python3
"""为当前平台组装可重定位的 faster_whisper 引擎包。

产物布局（默认 dist/package/）：
  main.py, _version.py, engines/, site-packages/<deps...>

运行（需 PATH 上有 uv；--python 指向目标 3.12.10 PBS 解释器或兼容解释器）：
  uv run --python 3.12.10 -- python build_engine_package.py [OUT_DIR]
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "package"
SITE = OUT / "site-packages"


def run(*args):
    print("+", " ".join(str(a) for a in args))
    subprocess.check_call(list(args))


def fix_macos_dylibs(site: Path):
    """把 site-packages 内 dylib 的绝对 install id 改为相对（@rpath），并 ad-hoc 重签。
    仅 macOS 执行；非 Mach-O 文件 codesign 会失败，忽略即可。"""
    if sys.platform != "darwin":
        return
    for path in site.rglob("*"):
        if path.suffix in (".so", ".dylib") and path.is_file():
            subprocess.call(["install_name_tool", "-id", f"@rpath/{path.name}", str(path)])
            subprocess.call(["codesign", "--force", "--sign", "-", str(path)])


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    SITE.mkdir(parents=True)

    run(
        "uv", "pip", "install",
        "--python", sys.executable,
        "--target", str(SITE),
        "-r", str(ROOT / "requirements.txt"),
    )

    shutil.copy2(ROOT / "main.py", OUT / "main.py")
    shutil.copy2(ROOT / "_version.py", OUT / "_version.py")
    shutil.copytree(ROOT / "engines", OUT / "engines")

    for p in OUT.rglob("__pycache__"):
        shutil.rmtree(p, ignore_errors=True)

    fix_macos_dylibs(SITE)

    assert (OUT / "main.py").is_file(), "main.py missing in package"
    assert (SITE / "faster_whisper").is_dir(), "faster_whisper missing in site-packages"
    print("package assembled at", OUT)


if __name__ == "__main__":
    main()
```

- [ ] **Step 1.2：`_version.py` bump 到 0.2.0（与 uv 包方案对齐）**

```python
ENGINE_VERSION = "0.2.0"
PROTOCOL_VERSION = 1
```

- [ ] **Step 1.3：确认 `requirements.txt`**

```
faster-whisper>=1.1.0
```

- [ ] **Step 1.4：删除 PyInstaller spec 残留**

```bash
git rm -f smartsub-engine.spec 2>/dev/null || rm -f smartsub-engine.spec
rm -f .python-version
```

- [ ] **Step 1.5：本地构建冒烟（需本机有 uv）**

```bash
uv run --python 3.12.10 -- python build_engine_package.py dist/package
ls dist/package            # 期望: main.py engines _version.py site-packages
ls dist/package/site-packages | grep -E "faster_whisper|ctranslate2"
```

预期：`dist/package/` 顶层有 `main.py` 与 `site-packages/faster_whisper`。

- [ ] **Step 1.6：Commit**

```bash
git add build_engine_package.py _version.py requirements.txt
git rm --cached smartsub-engine.spec 2>/dev/null || true
git commit -m "$(cat <<'EOF'
build: finalize uv relocatable engine package builder; drop PyInstaller spec

Assemble main.py + site-packages via uv --target; fix macOS dylib ids and
ad-hoc resign so packages run without a developer certificate.
EOF
)"
```

---

## Task 2（引擎仓）：smoke_test.py 支持 --package 模式

**Files:**

- Modify: `smoke_test.py`

- [ ] **Step 2.1：实现 `--package` 模式（用指定 python + PYTHONPATH 跑包内 main.py）**

```python
#!/usr/bin/env python3
"""对可重定位引擎包或 dev main.py 做 ping 冒烟。

用法:
  python smoke_test.py                         # dev: 当前解释器 + ./main.py
  python smoke_test.py --package <PKG_DIR> <PY> # 包模式: PY + PYTHONPATH=<PKG>/site-packages 跑 <PKG>/main.py
"""
import json
import os
import subprocess
import sys


def run_smoke(command, args, env=None):
    proc = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env,
    )
    proc.stdin.write(json.dumps({"id": "1", "method": "ping", "params": {}}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    proc.stdin.write(json.dumps({"method": "shutdown", "params": {}}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=30)
    data = json.loads(line)
    assert "result" in data, data
    assert "engines" in data["result"], data
    print("smoke ok:", data["result"])


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--package":
        pkg_dir, py = sys.argv[2], sys.argv[3]
        env = dict(os.environ)
        env["PYTHONPATH"] = os.path.join(pkg_dir, "site-packages")
        run_smoke(py, [os.path.join(pkg_dir, "main.py")], env=env)
    elif len(sys.argv) > 1:
        run_smoke(sys.argv[1], sys.argv[2:])
    else:
        run_smoke(sys.executable, ["main.py"])
```

- [ ] **Step 2.2：本地验证包模式冒烟**

```bash
PY=$(uv python find 3.12.10)
"$PY" smoke_test.py --package dist/package "$PY"
```

预期：`smoke ok: {... 'engines': {'faster_whisper': true}, 'protocolVersion': 1 ...}`。

- [ ] **Step 2.3：Commit**

```bash
git add smoke_test.py
git commit -m "$(cat <<'EOF'
test: add --package smoke mode (base python + PYTHONPATH layout)
EOF
)"
```

---

## Task 3（引擎仓）：CI 改为每平台 uv 构建引擎包 + manifest

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `README.md`

- [ ] **Step 3.1：重写 `release.yml`（每平台 uv 构建 `smartsub-faster-whisper-<suffix>.tar.gz`）**

关键点：用 `astral-sh/setup-uv` 装 uv，`uv python install 3.12.10`，构建后 `tar -C dist/package .` 顶层归档；publish 阶段生成 `checksums.sha256` 与 `manifest.json`（含 `pythonVersion`、`engineId`、每产物 sha256），删除并重建 rolling `latest`。

```yaml
name: Release smartsub-engine

on:
  workflow_dispatch:
  push:
    branches: [main]

concurrency:
  group: smartsub-py-engine-release
  cancel-in-progress: true

env:
  PYTHON_VERSION: '3.12.10'
  ENGINE_ID: 'faster-whisper'

jobs:
  build_engine:
    name: Engine ${{ matrix.artifact_suffix }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            artifact_suffix: macos-arm64
          - os: macos-15-intel
            artifact_suffix: macos-x64
          - os: windows-2022
            artifact_suffix: windows-x64
          - os: ubuntu-22.04
            artifact_suffix: linux-x64
    steps:
      - uses: actions/checkout@v4
      - name: Install uv
        uses: astral-sh/setup-uv@v6
      - name: Install pinned Python
        run: uv python install ${{ env.PYTHON_VERSION }}
      - name: Build relocatable engine package
        run: uv run --python ${{ env.PYTHON_VERSION }} -- python build_engine_package.py dist/package
      - name: Smoke test (package mode)
        shell: bash
        run: |
          PY="$(uv python find ${PYTHON_VERSION})"
          "$PY" smoke_test.py --package dist/package "$PY"
      - name: Archive (contents at top level)
        shell: bash
        run: tar -czf smartsub-${{ env.ENGINE_ID }}-${{ matrix.artifact_suffix }}.tar.gz -C dist/package .
      - uses: actions/upload-artifact@v4
        with:
          name: pkg-${{ matrix.artifact_suffix }}
          path: smartsub-${{ env.ENGINE_ID }}-${{ matrix.artifact_suffix }}.tar.gz
          if-no-files-found: error

  publish_latest:
    name: Publish latest Release
    runs-on: ubuntu-latest
    needs: build_engine
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with: { path: artifacts, merge-multiple: true }
      - uses: actions/checkout@v4
        with: { path: src }
      - name: Generate checksums and manifest
        shell: bash
        env:
          PYTHON_VERSION: ${{ env.PYTHON_VERSION }}
          ENGINE_ID: ${{ env.ENGINE_ID }}
        run: |
          cd artifacts
          sha256sum smartsub-*.tar.gz > checksums.sha256
          cat checksums.sha256
          ENGINE_VERSION=$(python3 -c "import sys; sys.path.insert(0,'../src'); import _version; print(_version.ENGINE_VERSION)")
          PROTOCOL_VERSION=$(python3 -c "import sys; sys.path.insert(0,'../src'); import _version; print(_version.PROTOCOL_VERSION)")
          BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
          GIT_SHA=$(echo "${GITHUB_SHA}" | cut -c1-7)
          python3 - "$ENGINE_VERSION" "$PROTOCOL_VERSION" "$BUILT_AT" "$GIT_SHA" "$PYTHON_VERSION" "$ENGINE_ID" <<'PY'
          import json, os, sys, hashlib
          ev, pv, built_at, git_sha, pyver, engine_id = sys.argv[1:7]
          plat = {
              f"smartsub-{engine_id}-windows-x64.tar.gz": "windows-x64",
              f"smartsub-{engine_id}-macos-arm64.tar.gz": "macos-arm64",
              f"smartsub-{engine_id}-macos-x64.tar.gz": "macos-x64",
              f"smartsub-{engine_id}-linux-x64.tar.gz": "linux-x64",
          }
          artifacts = {}
          for fname, key in plat.items():
              if not os.path.exists(fname):
                  continue
              data = open(fname, "rb").read()
              artifacts[key] = {"sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
          manifest = {
              "engineVersion": ev, "protocolVersion": int(pv), "pythonVersion": pyver,
              "engineId": engine_id, "pythonAbi": "cp312",
              "builtAt": built_at, "gitSha": git_sha,
              "engines": ["faster_whisper"], "artifacts": artifacts,
          }
          json.dump(manifest, open("manifest.json", "w"), indent=2)
          print(json.dumps(manifest, indent=2))
          PY
      - name: Delete existing latest release
        run: gh release delete latest --yes || true
        env: { GH_TOKEN: ${{ github.token }} }
      - name: Publish latest release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: latest
          name: latest
          body: |
            Rolling latest build of smartsub-engine relocatable packages.
            Loaded by SmartSub's bundled python-build-standalone base via PYTHONPATH.
          files: artifacts/*
          make_latest: true
```

> 说明：P0 暂保留现有 GitCode 同步 job 不动（若存在）；产物名变化后同步脚本如有写死名，Step 3.3 一并校正。

- [ ] **Step 3.2：更新 README「Release 资产」段为新产物名**

把资产清单改为 `smartsub-faster-whisper-<suffix>.tar.gz` + `checksums.sha256` + `manifest.json`；删除 PyInstaller 构建说明，改为 `uv run --python 3.12.10 -- python build_engine_package.py`。

- [ ] **Step 3.3：（如存在）校正 `scripts/sync-gitcode-release.sh` 中写死的产物名**

把 `smartsub-engine-*` 匹配改为 `smartsub-*`（覆盖多引擎）。无写死则跳过。

- [ ] **Step 3.4：Commit**

```bash
git add .github/workflows/release.yml README.md scripts/sync-gitcode-release.sh
git commit -m "$(cat <<'EOF'
ci: build per-platform uv relocatable packages; publish manifest with pythonVersion/engineId
EOF
)"
```

---

## Task 4（主仓）：PBS 基座拉取/裁剪脚本

**Files:**

- Create: `scripts/fetch-python-base.mjs`
- Create: `.gitignore` 追加 `extraResources/py-base/`

- [ ] **Step 4.1：创建 `scripts/fetch-python-base.mjs`**

下载 PBS `install_only`、解压、裁剪（删 test/idlelib/tkinter/ensurepip/lib2to3/**pycache** 等）、落地到 `extraResources/py-base/`。triple 由 `--platform/--arch`（默认 host）决定。

```javascript
// 拉取并裁剪 python-build-standalone 基座到 extraResources/py-base/
// 用法: node scripts/fetch-python-base.mjs [--platform darwin|win32|linux] [--arch arm64|x64]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execSync } from 'node:child_process';

const PYTHON_VERSION = '3.12.10';
// 确认为 python-build-standalone 实际存在的 release tag（github.com/astral-sh/python-build-standalone/releases）
const PBS_RELEASE = '20250610';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const platform = getArg('platform', process.platform);
const arch = getArg('arch', process.arch);

const TRIPLES = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc-shared',
  'linux:x64': 'x86_64-unknown-linux-gnu',
};
const triple = TRIPLES[`${platform}:${arch}`];
if (!triple) throw new Error(`Unsupported target ${platform}:${arch}`);

const asset = `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${triple}-install_only.tar.gz`;
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}`;

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoRoot, 'extraResources', 'py-base');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-'));
const tarPath = path.join(tmp, asset);

function download(u, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(u, { headers: { 'User-Agent': 'SmartSub-build' } }, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close();
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200)
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

const TRIM = [
  'lib/python3.12/test',
  'lib/python3.12/idlelib',
  'lib/python3.12/tkinter',
  'lib/python3.12/lib2to3',
  'lib/python3.12/ensurepip',
  'lib/python3.12/turtledemo',
  // Windows 布局
  'Lib/test',
  'Lib/idlelib',
  'Lib/tkinter',
  'Lib/lib2to3',
  'Lib/ensurepip',
];

console.log(`Fetching ${url}`);
await download(url, tarPath);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
// PBS install_only 解压根目录为 python/；将其内容平铺进 outDir
execSync(`tar -xzf "${tarPath}" -C "${tmp}"`);
const pyDir = path.join(tmp, 'python');
execSync(`cp -R "${pyDir}/." "${outDir}/"`);

for (const rel of TRIM) {
  fs.rmSync(path.join(outDir, rel), { recursive: true, force: true });
}
execSync(`find "${outDir}" -name __pycache__ -type d -prune -exec rm -rf {} +`);

console.log(`Base ready at ${outDir} (${platform}/${arch})`);
```

> 说明：Windows runner 上 `tar`/`find`/`cp` 由 Git Bash 提供（CI 用 `shell: bash`）。本地 Windows 开发以 mac 为主，可忽略。

- [ ] **Step 4.2：`.gitignore` 追加（基座为构建产物，不入库）**

```
extraResources/py-base/
```

- [ ] **Step 4.3：本地拉取并量基座体积（mac 优先）**

```bash
cd ~/code/github.com/buxuku/video-subtitle-master
node scripts/fetch-python-base.mjs
du -sh extraResources/py-base
extraResources/py-base/bin/python3 -c "import ssl, ctypes, sqlite3, lzma; print('base ok')"
```

预期：体积约 40–70MB；`base ok`。若超 80MB，追加裁剪项后重跑。

- [ ] **Step 4.4：Commit**

```bash
git add scripts/fetch-python-base.mjs .gitignore
git commit -m "$(cat <<'EOF'
build: add python-build-standalone base fetch+trim script
EOF
)"
```

---

## Task 5（主仓）：基座内置进打包 + 体积门禁

**Files:**

- Modify: `electron-builder.yml`
- Create: `scripts/check-bundle-size.mjs`
- Modify: `package.json`

- [ ] **Step 5.1：`electron-builder.yml` 三平台 `extraResources` 各加 `py-base/`**

在 mac/win/linux 三处 `extraResources` 列表追加：

```yaml
- from: ./extraResources/py-base/
  to: ./extraResources/py-base/
  filter:
    - '**/*'
```

- [ ] **Step 5.2：创建 `scripts/check-bundle-size.mjs`（≤200MB 门禁）**

```javascript
// 校验 dist/ 下生成的安装包体积 ≤ 200MB
import fs from 'node:fs';
import path from 'node:path';

const LIMIT_MB = 200;
const distDir = path.resolve(import.meta.dirname, '..', 'dist');
if (!fs.existsSync(distDir)) {
  console.error('dist/ not found; run build first');
  process.exit(1);
}
const exts = ['.dmg', '.zip', '.exe', '.AppImage', '.deb'];
let failed = false;
for (const f of fs.readdirSync(distDir)) {
  if (!exts.includes(path.extname(f))) continue;
  const mb = fs.statSync(path.join(distDir, f)).size / 1024 / 1024;
  const tag = mb <= LIMIT_MB ? 'OK ' : 'BIG';
  console.log(`[${tag}] ${f}: ${mb.toFixed(1)}MB`);
  if (mb > LIMIT_MB) failed = true;
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 5.3：`package.json` 加脚本**

```json
"base:fetch": "node scripts/fetch-python-base.mjs",
"size:check": "node scripts/check-bundle-size.mjs"
```

- [ ] **Step 5.4：本地全量构建并验门禁（mac）**

```bash
npm run base:fetch
npm run build:local
npm run size:check
```

预期：安装包含 `extraResources/py-base/`；`size:check` 全 `OK`。若 `BIG`，回 Task 4 加裁剪或转「下载基座」（设计 §3.2 兜底）。

- [ ] **Step 5.5：Commit**

```bash
git add electron-builder.yml scripts/check-bundle-size.mjs package.json
git commit -m "$(cat <<'EOF'
build: bundle PBS base into installer and add 200MB size gate
EOF
)"
```

---

## Task 6（主仓）：类型与基座/引擎包路径解析

**Files:**

- Modify: `types/engine.ts`
- Modify: `main/helpers/pythonRuntime/paths.ts`

- [ ] **Step 6.1：扩展 `types/engine.ts`**

`PyEngineManifest` 追加可选 `engineId`/`pythonAbi`；新增基座 manifest 与组件枚举：

```typescript
export interface PyEngineManifest {
  version: string;
  platform: string;
  sha256: string;
  installedAt: string;
  engineVersion?: string;
  protocolVersion?: number;
  builtAt?: string;
  gitSha?: string;
  engineId?: string; // 新增：'faster-whisper' 等
  pythonAbi?: string; // 新增：'cp312'
}

export interface PyBaseManifest {
  pythonVersion: string; // '3.12.10'
  platform: string;
  sha256?: string;
  installedAt: string;
  source: 'builtin' | 'downloaded';
}

export type PyEngineId = 'faster-whisper';
```

- [ ] **Step 6.2：在 `paths.ts` 新增基座解析**

在文件顶部 import 后追加（保留现有 `getPyEngineCacheDir`、`getPyEngineArtifactSuffix`、URL helpers 不变）：

```typescript
import { getExtraResourcesPath } from '../utils';
import type { PyBaseManifest, PyEngineId } from '../../../types/engine';

/** 内置基座目录（随 App 打包） */
export function getBuiltinPyBaseDir(): string {
  return path.join(getExtraResourcesPath(), 'py-base');
}

/** 可升级覆盖基座目录（userData，优先于内置） */
export function getUserPyBaseDir(): string {
  return path.join(app.getPath('userData'), 'py-base', 'current');
}

/** 解析当前生效基座目录：userData 覆盖优先，回退内置 */
export function resolvePyBaseDir(): string {
  const userDir = getUserPyBaseDir();
  if (fs.existsSync(getPyBasePythonPath(userDir))) return userDir;
  return getBuiltinPyBaseDir();
}

/** 基座 python 解释器路径（按平台） */
export function getPyBasePythonPath(baseDir: string): string {
  return process.platform === 'win32'
    ? path.join(baseDir, 'python.exe')
    : path.join(baseDir, 'bin', 'python3');
}

export function isPyBaseReady(): boolean {
  return fs.existsSync(getPyBasePythonPath(resolvePyBaseDir()));
}
```

- [ ] **Step 6.3：在 `paths.ts` 新增引擎包（可重定位布局）解析**

```typescript
const DEFAULT_ENGINE_ID: PyEngineId = 'faster-whisper';

export function getPyEnginesRoot(): string {
  return path.join(app.getPath('userData'), 'py-engines');
}

export function getEngineDir(engineId: PyEngineId = DEFAULT_ENGINE_ID): string {
  return path.join(getPyEnginesRoot(), engineId);
}

export function getEngineSitePackages(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'site-packages');
}

export function getEngineMainPy(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'main.py');
}

/** 引擎包就绪 = main.py + site-packages 同时存在（取代旧的单二进制判定） */
export function isEnginePackageInstalled(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): boolean {
  return (
    fs.existsSync(getEngineMainPy(engineId)) &&
    fs.existsSync(getEngineSitePackages(engineId))
  );
}

export function getEngineManifestPath(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return path.join(getEngineDir(engineId), 'manifest.json');
}

export function readEngineManifest(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): PyEngineManifest | null {
  const p = getEngineManifestPath(engineId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PyEngineManifest;
  } catch {
    return null;
  }
}

export function writeEngineManifest(
  manifest: PyEngineManifest,
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): void {
  const dir = getEngineDir(engineId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getEngineManifestPath(engineId),
    JSON.stringify(manifest, null, 2),
  );
}
```

- [ ] **Step 6.4：调整产物名 helper（按 engineId）**

把 `getPyEngineDownloadUrl` 的资产名从固定 `smartsub-engine-` 改为按引擎：

```typescript
export function getEngineArtifactName(
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
): string {
  return `smartsub-${engineId}-${getPyEngineArtifactSuffix()}.tar.gz`;
}

export function getEngineDownloadUrl(
  source: 'github' | 'ghproxy' | 'gitcode',
  engineId: PyEngineId = DEFAULT_ENGINE_ID,
  tag: string = PY_ENGINE_TAG,
): string {
  return `${getPyEngineReleaseBaseUrl(source, tag)}/${getEngineArtifactName(engineId)}`;
}
```

（保留旧 `getPyEngineDownloadUrl` 暂不删，Task 8 切换 downloader 后再清理无引用项。）

- [ ] **Step 6.5：类型检查**

```bash
npx tsc --noEmit
```

预期：无新增错误（旧的 `getPyEngineBinaryPath` 等仍存在，未删，引用不破）。

- [ ] **Step 6.6：Commit**

```bash
git add types/engine.ts main/helpers/pythonRuntime/paths.ts
git commit -m "$(cat <<'EOF'
feat(py-runtime): add PBS base + relocatable engine-package path resolution
EOF
)"
```

---

## Task 7（主仓）：Manager 环境与 ResolveCommand 组合基座+PYTHONPATH

**Files:**

- Modify: `main/helpers/pythonRuntime/manager.ts`
- Modify: `main/helpers/pythonRuntime/index.ts`

- [ ] **Step 7.1：`manager.ts` 的 `buildSanitizedEnv` 改为「设受控 PYTHONHOME/PYTHONPATH」**

把「删除 PYTHONPATH」改为「按传入覆盖设置」；其余消毒保留。改为接受可选覆盖：

```typescript
export function buildSanitizedEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides?: { pythonHome?: string; pythonPath?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
  // 先清污染源
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  delete env.PYTHONSTARTUP;
  delete env.VIRTUAL_ENV;
  delete env.CONDA_PREFIX;
  // 再按三层模型注入受控值
  if (overrides?.pythonHome) env.PYTHONHOME = overrides.pythonHome;
  if (overrides?.pythonPath) env.PYTHONPATH = overrides.pythonPath;
  return env;
}
```

- [ ] **Step 7.2：`manager.ts` spawn 处传入 cmd.env 的同时合并 overrides**

`EngineCommand` 增加可选 `pythonHome`/`pythonPath`；`start()` 内 spawn 改为：

```typescript
const proc = spawn(cmd.command, cmd.args, {
  cwd: cmd.cwd,
  env: {
    ...buildSanitizedEnv(process.env, {
      pythonHome: cmd.pythonHome,
      pythonPath: cmd.pythonPath,
    }),
    ...(cmd.env || {}),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
```

在 `EngineCommand` 接口加字段：

```typescript
export interface EngineCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  pythonHome?: string; // 新增
  pythonPath?: string; // 新增
}
```

- [ ] **Step 7.3：重写 `index.ts` 的 `resolveEngineCommand`（基座 python + 引擎 main.py + PYTHONPATH）**

```typescript
import path from 'path';
import { logMessage } from '../storeManager';
import { getFasterWhisperModelsPath } from '../modelCatalog';
import { PythonRuntimeManager, type EngineCommand } from './manager';
import {
  resolvePyBaseDir,
  getPyBasePythonPath,
  isPyBaseReady,
  getEngineDir,
  getEngineMainPy,
  getEngineSitePackages,
  isEnginePackageInstalled,
} from './paths';

export * from './protocol';
export { PythonRuntimeManager, PythonEngineError } from './manager';

const NOT_READY_MSG =
  'Python engine not ready. Ensure the base runtime is bundled and the engine package is downloaded (Resource Hub > Engines), or set PYTHON_ENGINE_CMD for local dev.';

function resolveEngineCommand(): EngineCommand {
  const override = process.env.PYTHON_ENGINE_CMD;
  if (override) {
    const parts = override.split(' ').filter(Boolean);
    return { command: parts[0], args: parts.slice(1) };
  }

  if (!isPyBaseReady() || !isEnginePackageInstalled('faster-whisper')) {
    throw new Error(NOT_READY_MSG);
  }

  const baseDir = resolvePyBaseDir();
  const modelsPath = getFasterWhisperModelsPath();
  return {
    command: getPyBasePythonPath(baseDir),
    args: [getEngineMainPy('faster-whisper')],
    cwd: getEngineDir('faster-whisper'),
    pythonHome: baseDir,
    pythonPath: getEngineSitePackages('faster-whisper'),
    env: {
      HF_HOME: modelsPath,
      HF_HUB_CACHE: path.join(modelsPath, 'hub'),
    },
  };
}

let manager: PythonRuntimeManager | null = null;

export function getPythonRuntimeManager(): PythonRuntimeManager {
  if (!manager) {
    manager = new PythonRuntimeManager(resolveEngineCommand, (msg, level) =>
      logMessage(msg, level),
    );
  }
  return manager;
}

export async function shutdownPythonRuntime(): Promise<void> {
  if (manager) {
    await manager.stop();
    manager = null;
  }
}
```

- [ ] **Step 7.4：类型检查**

```bash
npx tsc --noEmit
```

预期：`index.ts`/`manager.ts` 无新增错误（注意 downloader.ts 仍引用旧 `isPyEngineInstalled`/`normalizePyEngineLayout`，Task 8 一并处理；若此刻报错，先保留旧导出避免破坏，仅 Task 8 删）。

- [ ] **Step 7.5：本地 dev 冒烟（用内置基座 + 本地构建的引擎包，免下载）**

把 Task 1 产物软链/拷到 userData 引擎目录，验证组合加载：

```bash
node scripts/fetch-python-base.mjs   # 确保内置基座存在（dev 下 getExtraResourcesPath 指向项目 extraResources）
UD="$HOME/Library/Application Support/SmartSub"   # mac userData（以实际 productName 为准）
mkdir -p "$UD/py-engines/faster-whisper"
cp -R ~/code/github.com/buxuku/smartsub-py-engine/dist/package/. "$UD/py-engines/faster-whisper/"
npm run dev
```

DevTools Console：

```javascript
await window.ipc.invoke('python-engine:ping'); // 期望 engines.faster_whisper=true
```

预期：ping 成功，说明「内置基座 + PYTHONPATH 引擎包」链路打通。

- [ ] **Step 7.6：Commit**

```bash
git add main/helpers/pythonRuntime/manager.ts main/helpers/pythonRuntime/index.ts
git commit -m "$(cat <<'EOF'
feat(py-runtime): spawn bundled base python with per-engine PYTHONPATH
EOF
)"
```

---

## Task 8（主仓）：下载安装改为可重定位布局 + macOS ad-hoc 兜底

**Files:**

- Create: `main/helpers/pythonRuntime/macSign.ts`
- Modify: `main/helpers/pythonRuntime/downloader.ts`
- Modify: `main/helpers/pythonRuntime/paths.ts`（清理仅剩无引用的旧单二进制 helper）

- [ ] **Step 8.1：创建 `macSign.ts`（递归 ad-hoc 重签，仅 macOS）**

```typescript
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logMessage } from '../storeManager';

/** 对目录内所有 Mach-O 原生库做 ad-hoc 重签（无证书可执行的兜底，仅 macOS）。 */
export function adhocResignDir(dir: string): void {
  if (process.platform !== 'darwin' || !fs.existsSync(dir)) return;
  const exts = new Set(['.so', '.dylib', '.node']);
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.has(path.extname(entry.name))) {
        try {
          execFileSync('codesign', ['--force', '--sign', '-', full], {
            stdio: 'ignore',
          });
        } catch {
          // 非 Mach-O 或已签失败：忽略，dlopen 时再暴露
        }
      }
    }
  };
  try {
    walk(dir);
    logMessage(`ad-hoc resigned native libs under ${dir}`, 'info');
  } catch (error) {
    logMessage(`ad-hoc resign skipped: ${error}`, 'warning');
  }
}
```

- [ ] **Step 8.2：`downloader.ts` 改 URL/校验/安装为引擎包语义**

改动点（保持 MirrorDownloader、断点续传、checksums、staging→current 原子替换、previous 回滚、ping 自检 全部不变）：

1. import 替换：

```typescript
import {
  PY_ENGINE_TAG,
  getEngineDir,
  getEngineDownloadUrl,
  getEngineArtifactName,
  getPyEngineChecksumsUrl,
  getPyEngineManifestUrl,
  isEnginePackageInstalled,
  isPyBaseReady,
  writeEngineManifest,
  readEngineManifest,
  getEngineSitePackages,
  getEngineMainPy,
} from './paths';
import { adhocResignDir } from './macSign';
```

2. 下载 URL：`getPyEngineDownloadUrl(source, tag)` → `getEngineDownloadUrl(source, 'faster-whisper', tag)`；产物名 helper 改 `getEngineArtifactName('faster-whisper')`。

3. `verifyExtractAndInstall` 的「解压后校验」从「单二进制存在」改为「`main.py` + `site-packages` 存在」：

```typescript
// 解压到 staging 后：
const stagingMain = path.join(stagingDir, 'main.py');
const stagingSite = path.join(stagingDir, 'site-packages');
if (!fs.existsSync(stagingMain) || !fs.existsSync(stagingSite)) {
  throw new Error('Invalid engine package: missing main.py or site-packages');
}
```

（删除对 `normalizePyEngineLayout` / `getPyEngineBinaryName` 的调用。）

4. `installFromStaging` 的 current 目录改为 `getEngineDir('faster-whisper')`（替代 `getPyEngineCurrentDir`）；swap 完成、写 manifest 后、ping 自检前，插入 macOS 兜底：

```typescript
adhocResignDir(getEngineDir('faster-whisper'));
```

5. `buildLocalManifest` 写入 `engineId:'faster-whisper'` 与 `pythonAbi: remoteManifest?.pythonAbi ?? 'cp312'`。

6. 安装前增加基座存在校验（缺基座给清晰错误）：

```typescript
if (!isPyBaseReady()) {
  throw new Error(
    'Python base runtime missing; reinstall SmartSub or update base.',
  );
}
```

- [ ] **Step 8.3：清理 `paths.ts` 旧单二进制 helper（确认全仓无引用后删）**

```bash
grep -rn "getPyEngineBinaryPath\|getPyEngineCurrentDir\|normalizePyEngineLayout\|isPyEngineInstalled\|getPyEngineDownloadUrl" main renderer | grep -v "pythonRuntime/paths.ts"
```

对仍有引用处（如 `fasterWhisperEngine.ts`、`systemInfoManager.ts`、`registry`/IPC）改用新函数（`isEnginePackageInstalled`/`readEngineManifest`）；确认无引用后删除旧函数与 `ensurePyEngineExecutable`/`normalizePyEngineLayout`。

- [ ] **Step 8.4：类型检查**

```bash
npx tsc --noEmit
```

预期：无新增错误；旧符号引用全部迁移完。

- [ ] **Step 8.5：Commit**

```bash
git add main/helpers/pythonRuntime/macSign.ts main/helpers/pythonRuntime/downloader.ts main/helpers/pythonRuntime/paths.ts
git commit -m "$(cat <<'EOF'
feat(py-runtime): install relocatable engine packages with macOS ad-hoc resign
EOF
)"
```

---

## Task 9（主仓）：faster-whisper 适配器与系统信息对齐新就绪判定

**Files:**

- Modify: `main/helpers/engines/fasterWhisperEngine.ts`
- Modify: `main/helpers/systemInfoManager.ts`（如引用旧判定）

- [ ] **Step 9.1：`fasterWhisperEngine.isAvailable` 改为「基座 + 引擎包」就绪**

替换原 `isPyEngineInstalled()` 判定：

```typescript
import {
  isPyBaseReady,
  isEnginePackageInstalled,
  readEngineManifest,
} from '../pythonRuntime/paths';

async isAvailable(): Promise<EngineStatus> {
  if (!isPyBaseReady()) {
    return { state: 'error', message: 'Python base runtime missing' };
  }
  if (!isEnginePackageInstalled('faster-whisper')) {
    return { state: 'not_installed', message: 'faster-whisper engine package not installed' };
  }
  const manifest = readEngineManifest('faster-whisper');
  return { state: 'ready', version: formatInstalledVersion(manifest) };
}
```

（`formatInstalledVersion` 保留；其余转写逻辑不变。）

- [ ] **Step 9.2：`systemInfoManager` 的 pythonEngineStatus 用新判定**

把 `isPyEngineInstalled()` / `readPyEngineManifest()` 改为 `isEnginePackageInstalled('faster-whisper')` / `readEngineManifest('faster-whisper')`，并补 `pyBaseReady: isPyBaseReady()`（供 UI 区分「缺基座」与「缺引擎包」）。

- [ ] **Step 9.3：类型检查**

```bash
npx tsc --noEmit
npx tsc --noEmit -p renderer/tsconfig.json
```

- [ ] **Step 9.4：Commit**

```bash
git add main/helpers/engines/fasterWhisperEngine.ts main/helpers/systemInfoManager.ts
git commit -m "$(cat <<'EOF'
feat(engines): gate faster-whisper on base + engine-package readiness
EOF
)"
```

---

## Task 10（主仓）：端到端冒烟 + 全量构建 + 体积门禁

**Files:** 无代码改动（必要修复回到对应 Task）

- [ ] **Step 10.1：真实下载路径冒烟（引擎仓已发 latest 后）**

资源中心 → 引擎 → 下载 faster-whisper（走 `download` → staging → current → ad-hoc 重签 → ping 自检）。
DevTools：

```javascript
await window.ipc.invoke('get-engine-status');
await window.ipc.invoke('python-engine:ping');
```

预期：状态 ready；ping engines.faster_whisper=true。

- [ ] **Step 10.2：tiny 模型转写出 SRT**

资源中心下载 faster-whisper tiny 模型 → 任务页选 faster-whisper + tiny → 跑示例音频。
预期：进度推进、产出 SRT、取消可用、`device=auto` 在无卡机回退 CPU 并回显。

- [ ] **Step 10.3：回归 whisper.cpp（builtin）不受影响**

切回 whisper.cpp + 已有 ggml 模型转写。预期：正常，无回归。

- [ ] **Step 10.4：全量类型检查 + i18n 门禁 + 构建 + 体积门禁**

```bash
npx tsc --noEmit
npx tsc --noEmit -p renderer/tsconfig.json
node scripts/check-i18n.mjs
npm run base:fetch
npm run build:local
npm run size:check
```

预期：全绿；安装包含基座；体积 ≤200MB。

- [ ] **Step 10.5：Commit（如有收尾修复）**

```bash
git add -p
git commit -m "$(cat <<'EOF'
chore(py-runtime): P0 end-to-end fixes for three-layer faster-whisper
EOF
)"
```

---

## Spec 覆盖自检（对照设计 §12-P0）

| 设计要点（P0）                            | 对应 Task                          |
| ----------------------------------------- | ---------------------------------- |
| 引擎仓 build_engine_package 定稿(uv)      | Task 1                             |
| smoke `--package` 模式                    | Task 2                             |
| CI 每平台引擎包 + manifest(pythonVersion) | Task 3                             |
| PBS 基座内置（裁剪）                      | Task 4, 5                          |
| 200MB 体积门禁                            | Task 5, 10                         |
| 基座「内置+可升级」双源解析               | Task 6（resolvePyBaseDir）         |
| 每引擎独立 site-packages + PYTHONPATH     | Task 6, 7                          |
| resolveCommand 组合基座+引擎包            | Task 7                             |
| ComponentManager 雏形（多组件下载/安装）  | Task 8（引擎包；基座下载流为后续） |
| macOS 无证书 ad-hoc 兜底                  | Task 1, 8                          |
| faster-whisper 跑通新机制                 | Task 9, 10                         |
| whisper.cpp 不回归                        | Task 10.3                          |

**P0 显式不含（留 P1+ 或后续）：** 基座远程下载升级的完整 UI 流（仅留 `resolvePyBaseDir` 覆盖位）、`py-gpu` 共享 CUDA 注入（faster-whisper GPU 加速，设计 §6.1/§8，作为 P0 后增量）、FunASR/Qwen 引擎（P1/P2）。

> 无 TBD / 占位符。基座远程升级与 GPU 库注入已在「显式不含」标注，非遗漏。

---

## 执行方式

**Plan 已保存至 `docs/superpowers/plans/2026-06-16-three-layer-p0.md`。两种执行方式：**

1. **Subagent-Driven（推荐）** — 每 Task 派独立 subagent，Task 间审查，迭代快。
2. **Inline Execution** — 本会话按 Task 顺序实现，每 2–3 Task 设检查点。

> 注：本仓库用户规则禁用子代理。如遵循该规则，则采用 **Inline Execution**（superpowers:executing-plans），由主代理逐 Task 实施。
