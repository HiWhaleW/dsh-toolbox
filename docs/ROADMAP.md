# Delivery Roadmap

## Phase 1 — Product Research Workbench MVP ✅

- Local SQLite project/source/evidence/analysis/report pipeline
- URL and pasted-text import with SSRF, redirect, timeout, and size controls
- Deterministic local extraction plus human-reviewed evidence cards
- Transparent opportunity scoring and Markdown/self-contained HTML reports
- Full-content opt-in JSON backup/restore, checksum validation, and confirmed deletion

## Phase 2 — Context Switchboard MVP ✅

- Named profiles, positive/negative routing rules, priority, enable/disable, and token budgets
- Explicit activation receipts, per-session LIFO history, and rollback
- Native DSH `systemPrompt.context()` snapshots without replacing persona or policy
- Profile export/import, conflict diagnosis, and Alpha-database migration

## Phase 3 — Plugin Preflight MVP ✅

- Bundle patch, manifest, package-content, license, lifecycle, dependency, and capability checks
- SHA-256 packed-content fingerprint and dependency SBOM
- Configurable license/scope/capability/risk policy
- Private Markdown/self-contained HTML audit reports
- Static-only operation: no scripts, dependency installation, symlink traversal, or registry access

## Phase 4 — Compatibility Radar MVP ✅

- Local Profile Bundle discovery and runtime-version inference
- DSH Tools, Cordis, and Node compatibility matrices
- SQLite snapshots, diffs, regression detection, and remediation guidance
- Private Markdown/self-contained HTML upgrade reports
- No background monitoring or automatic upgrades

## Phase 5 — DSH Switchboard control-plane core ✅

- Independent DSH adapter instead of a long-lived CC Switch fork
- `$DSH_HOME` and Profile/Bundle discovery following the upstream contract
- Plan-first enable, disable, and reorder operations with stale-state protection
- Plugin Preflight and Compatibility Radar integration
- Atomic manifest writes, private backups, SQLite receipts, runtime validation, and rollback
- Markdown/self-contained HTML profile reports

## Phase 6 — Desktop shell and package operations

- Tauri desktop shell consuming the same adapter API
- Structured `cordis.patch.yml` editor with raw diff preview
- Preflight-gated `dsh plugin` install/remove orchestration
- Active-profile/restart awareness, recovery UI, and cross-platform installers

## Release gates

- [x] Four independently installable DSH Profile Bundle manifests
- [x] Node 22.19+/24 test suite and workspace validation
- [x] Package dry-runs for all four bundles
- [x] Plugin Preflight self-scans and current/breaking compatibility matrices
- [x] Isolated installation/config-load/tool-execution smoke test against `@deepseek-ai/dsh@0.1.1-rc.2`
- [ ] Cross-platform user feedback and hardening
- [x] Switchboard adapter unit and failure-path tests against isolated DSH homes
- [x] Switchboard install, full plugin-tree/Web load, HTTP health, apply, validation, and rollback smoke test against a real DSH `0.1.1-rc.2` CLI on macOS
- [ ] Switchboard smoke test against a real installed DSH CLI on Linux and Windows

The `0.2.1` source is public under the PolyForm Noncommercial License 1.0.0; commercial use is not permitted. Earlier MIT grants remain applicable to copies received under those earlier releases. npm publication and GitHub Releases remain intentionally deferred pending cross-platform feedback and an explicit release decision.
