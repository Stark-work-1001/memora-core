# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import copy_metadata

from pathlib import Path

# Paths are derived from this spec's own location so the file works in any checkout.
ROOT = Path(SPECPATH).resolve().parent.parent
BUILD = ROOT / 'pyinstaller' / 'focused-39vrovru'

datas = [(str(BUILD / 'memora' / 'static'), 'memora/static')]
hiddenimports = ['memora_native', 'memora.docindex', 'memora.brain_preview', 'memora.accumulation', 'memora.advanced', 'memora.agent', 'memora.brain_preview', 'memora.bridge', 'memora.chat_models', 'memora.config', 'memora.connections', 'memora.control', 'memora.core', 'memora.docindex', 'memora.docmigrate', 'memora.documents', 'memora.errors', 'memora.evaluation', 'memora.gateway', 'memora.ingest', 'memora.jobs', 'memora.judge', 'memora.knowledge', 'memora.local_sources', 'memora.mcp', 'memora.memory_exchange', 'memora.mirror', 'memora.model_registry', 'memora.ops', 'memora.projections', 'memora.providers', 'memora.schema', 'memora.scopes', 'memora.server', 'memora.service', 'memora.sessions', 'memora.stdio', 'memora.store', 'memora.text', 'memora.vectors', 'memora.web', 'memora.workbench', 'memora.workflow_templates', 'memora.workflows']
datas += copy_metadata('mcp')
hiddenimports += collect_submodules('mcp.server.fastmcp')
hiddenimports += collect_submodules('mcp.shared')
hiddenimports += collect_submodules('uvicorn')


a = Analysis(
    [str(BUILD / 'entry.py')],
    pathex=[str(BUILD)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'torch', 'transformers', 'sentence_transformers', 'llama_cpp'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='memora-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
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
    upx=True,
    upx_exclude=[],
    name='memora-backend',
)
