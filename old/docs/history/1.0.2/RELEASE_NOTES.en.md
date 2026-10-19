# memora 1.0.2 · Desktop guide

One focused application, with the same functionality for personal use and distribution. README introduces the repository; this file covers installation and upgrades.

1. Extract `memora-1.0.2-windows-x64.zip` to a writable folder and run `Memora.exe`. Developers can run `dist/desktop/win-unpacked/Memora.exe` directly.
2. Python, Node and Rust do not need to be installed. Configure embedding/Judge model services separately; weights are not bundled. No embedding means lexical retrieval; no Judge means explicit rule classification.
3. The desktop retains its Electron user-data `memory` folder. Set `MEMORA_DATA` to reuse another existing memory directory. Close old processes and back up the complete data directory, including all three databases, documents and configuration, before upgrading.
4. Configure the two roles under Model connections and copy MCP host settings from Agent connections. Keys come from environment variables. Other MCP processes reload saved settings on their next call.
5. Use Classification and consolidation for approval, Markdown for dated immutable revisions, and Brain for semantic/hierarchical 2D/3D views. Document publication does not automatically approve memory.

Schema v2, memory IDs, dates, vector fingerprints and document history remain compatible. Existing chat, workflow, archive and HTTP bridge components remain in the source installation's extended entry point; they are excluded from the focused desktop backend. A configured model is not a verified live connection.

Build contents: `resources/backend/BUILD_MANIFEST.json`. Local validation: `dist/SMOKE_VALIDATION.json`. Changes: `docs/REFACTOR-1.0.2.md` and `CHANGELOG.md`. No GitHub upload is part of this local delivery.
