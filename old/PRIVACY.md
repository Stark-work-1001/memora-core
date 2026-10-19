# Privacy / 数据与隐私

Memora stores private memory. The active local data directory contains plaintext SQL, Markdown versions, source conversations, policies, MCP credentials and an integration outbox. It is not an encrypted vault. Audience labels describe document purpose, not authorization.

## Data flow

Connected agents explicitly submit conversations using memory_absorb or capture/import. The installed DSH lifecycle adapter automatically submits actual user/assistant text. It excludes injected recall, thinking blocks and tool outputs; it does not scan every agent's complete historical archive.

Models receive embedding inputs, candidates, quotes and workflow context. Configured cloud stages send their input and relevant retrieved evidence to the selected HTTPS provider. Remote use requires explicit configuration; keys come from named environment variables, not model JSON. Pattern screening is not complete personal-information removal or data-loss prevention.

HTTP MCP requires a generated bearer token and listens on loopback. Stdio relies on local process permissions. Peer identities are self-reported. This is a single-user trusted-host design, not multi-tenant account isolation.

## Retention and deletion

SQL is authoritative. Four databases, Markdown mirrors, immutable source documents, outboxes, settings and backups form the complete data set. A derived memory and its source conversation are separate records. Forget removes retrieval visibility; purging a memory does not erase its source documents, external DSH histories or previous backups. Those copies must be handled explicitly. Failed jobs retain archived sources for recovery.

Stop all writers before copying the whole data directory. A single SQLite backup is not an atomic four-database snapshot. See [operations](docs/OPERATIONS.md).

## Source and local artifacts

Source control ignores data, runtime state, databases, logs, credentials, weights and private DSH integration backups. This running working folder still contains ignored private files; do not publish the whole folder blindly.

The desktop build uses an allowlisted staging tree. Packaging rejects runtime database/configuration/key/log files and checks that the public CA bundle contains no private key. Frozen smoke scans code filenames for compiler-home paths. These limited checks do not guarantee removal of every possible sensitive pattern. No public upload is performed by local build scripts.
