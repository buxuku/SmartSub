# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 构建配置:smartsub-engine 冻结产物(onedir)。

构建:.venv/bin/pyinstaller --clean --noconfirm smartsub-engine.spec
产物:dist/smartsub-engine/(整目录分发,入口 smartsub-engine[.exe])

选择 onedir 而非 onefile:启动无需解压临时目录(快数秒)、杀软误报少、
后续可做差量更新。体积裁剪原则:只删确定用不到的库,宁大勿崩。
"""

from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = []

# faster-whisper 运行所需的全部资源(含 silero VAD onnx 资产)
for package in ("faster_whisper", "ctranslate2", "tokenizers", "huggingface_hub", "av"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # 确定用不到的大块头:科学计算/绘图/GUI/调试
        "matplotlib",
        "scipy",
        "pandas",
        "PIL",
        "tkinter",
        "IPython",
        "pytest",
        "setuptools",
        "pip",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="smartsub-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # sidecar 走 stdio,必须保留 console 通道(spawn 时用 windowsHide 隐藏)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="smartsub-engine",
)
