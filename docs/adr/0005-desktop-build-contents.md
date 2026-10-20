# ADR-0005 — Declare and check what the desktop build contains

Status: accepted (1.1.0)

## Context (measured on the 1.0.0 release)

* The backend exe (32.6 MB) bundled numpy (with a 20 MB OpenBLAS DLL), Pillow and fontTools —
  about 46 % of its payload — and pypdf 6.21.1. None is declared in `docs/THIRD-PARTY.md`, which
  says the backend has no third-party runtime dependency. They came from whatever the build
  environment had installed: PyInstaller followed pypdf's *optional* imports.
* 55 Chromium locale packs (50.6 MB unpacked) for a single-language product.
* Electron fuses at their defaults: RunAsNode, NODE_OPTIONS and `--inspect` all enabled.
* The release zip was assembled by hand; it is not reproducible from the tag (its `app.asar`
  says `"license": "Apache-2.0"` while the repository and tag say MIT).
* The backend exe shipped twice (top level and `MemoraCore/resources/backend`).

## Decision

* The desktop build includes **pypdf** on purpose (PDF import works in the desktop app) and
  pins it with PyInstaller in `tools/requirements-desktop.txt`. The library/source run stays
  standard-library only; without pypdf, PDF import reports "需要 pypdf，未安装".
  This is HANDOVER §3's "a different answer for the desktop build than for the library".
* `tools/package.py` excludes pypdf's optional extras and then reads the produced exe with
  `tools/inspect_exe.py --check`, failing on any third-party package not declared in
  THIRD-PARTY.md. Result: 31.1 MB → 12.0 MB, 750 → 267 modules, with numpy and Pillow present in
  the build environment.
* `electronLanguages: [zh-CN, en-US]`; fuses: RunAsNode off, NODE_OPTIONS off, CLI inspect off,
  cookie encryption on, only load app from asar (verified by reading the fuse wire of the built
  exe and by launching the packaged app).
* `tools/desensitize_scan.py` backs the README's "scanned byte by byte" claim: it searches the
  artefacts (including zip members, PyInstaller archives and `app.asar`) for this build machine's
  identity and fails the build on a hit. `tools/release.py` assembles the zip reproducibly and runs
  both checks.
* The top-level `memora-backend.exe` is **deprecated, not removed**: docs/INDEX.md promised it, so
  an MCP host may point at it. 1.1.0 keeps a byte-identical copy (now 12 MB instead of 32 MB) and a
  README-release note; 1.2.0 removes it.

## Alternatives rejected

* **PyInstaller `--onedir`** (no extraction to %TEMP% on every start). It changes the backend's
  path inside the app, which every copied MCP config contains — a break for existing hosts.
* **Asar integrity validation** fuse: not enabled until it is verified on a signed build; turning
  it on without embedded integrity data can stop the app from starting.
* **Signing and auto-update**: need the owner's certificate and a release host. Not something a
  contributor can do or verify; the reproducible zip + SHA256SUMS is the prerequisite.
