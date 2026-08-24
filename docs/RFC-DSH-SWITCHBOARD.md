# RFC: DSH Switchboard control plane

Status: accepted for MVP implementation  
Date: 2026-08-14
Compatibility review: DSH `0.1.1-rc.2` on 2026-08-24

## Decision

DSH Toolbox will add an independent local control plane named **DSH Switchboard**. It will use the product patterns that make CC Switch useful—discovery, explicit change plans, backups, validation, receipts, and rollback—without forking CC Switch or adding DSH to CC Switch's hard-coded application enum.

The four existing DSH Profile Bundles remain independently installable. DSH Switchboard runs outside the active Harness process and manages profiles through a small adapter contract. This keeps a plugin from rewriting the profile that is currently booting it.

## Product boundary

The control plane owns:

- discovery of `$DSH_HOME` and `$DSH_HOME/profiles/<name>`;
- inspection of profile manifests, ordered bundle layers, user patches, and local dependencies;
- static plugin Preflight and runtime Compatibility Radar checks;
- explicit change plans for enabling, disabling, and reordering bundle layers;
- atomic manifest writes, private backups, SQLite receipts, stale-plan detection, runtime validation, and rollback;
- local Markdown and self-contained HTML reports.

The DSH CLI remains the owner of dependency installation and removal. Switchboard will invoke `dsh plugin --profile <name> ...` only through a separately reviewed workflow; the first vertical slice does not reimplement pnpm reconciliation or edit lockfiles.

The control plane does not own provider/API-key proxying, cloud sync, telemetry, background registry polling, automatic upgrades, or hot mutation of a running profile.

## Adapter contract

Every runtime adapter must implement:

1. `detect()` — identify the runtime and installation status.
2. `discoverProfiles()` — enumerate locally managed profiles.
3. `readProfile(name)` — return normalized state plus a content hash.
4. `planBundleChange(name, bundles)` — create a non-mutating, reviewable plan.
5. `apply(plan)` — verify the plan is fresh, back up, atomically apply, and validate.
6. `rollback(transactionId)` — restore a known backup without silently overwriting newer edits.
7. `healthCheck(name)` — run static checks and the runtime's canonical validation command.
8. `close()` — release local resources.

`DshAdapter` is the first implementation. Its canonical validation command is:

```sh
dsh --profile <name> --dump-config
```

## DSH profile model

The implementation follows the upstream DeepSeek Harness contract:

- the default home is `~/.dsh`, overridden by non-empty `DSH_HOME`;
- a profile is `$DSH_HOME/profiles/<name>`;
- `package.json` contains dependencies and the ordered `dsh.profile.bundles` list;
- `cordis.patch.yml` is the profile-owned final patch layer;
- bundle packages declare `dsh.bundle.patch`;
- bundle ordering is semantically significant;
- bundle packages resolve from the DSH installation before the Profile directory;
- the official `dsh plugin` command owns dependency installation and reconciliation.

## Safety invariants

- Profile names cannot contain separators and cannot be `.`, `..`, or `node_modules`.
- Profile directories and managed files are not followed through symbolic links.
- A plan contains a SHA-256 base-state hash and is rejected after any intervening edit.
- Writes use a temporary file in the target directory followed by an atomic rename.
- Backups and SQLite receipts default to user-only permissions.
- Runtime validation failure automatically restores the previous manifest.
- Rollback refuses to overwrite state that no longer matches the applied transaction unless the user explicitly forces it.
- Command execution never uses a shell.
- Reports do not embed remote scripts or upload profile data.

## Packaging and UI

The first slice is a dependency-light Node.js core and CLI package, `@dsh-toolbox/dsh-switchboard`. A later Tauri desktop shell can call the same adapter API. UI code must not duplicate mutation, validation, or rollback logic.

The repository's original code remains under PolyForm Noncommercial 1.0.0. CC Switch source is not copied in this implementation. If MIT-licensed CC Switch code is incorporated later, its copyright and MIT license must be preserved in `THIRD_PARTY_NOTICES.md` and in affected distributions; the inherited MIT grant cannot be made noncommercial retroactively.

## Delivery stages

1. Core adapter, discovery, inspection, plans, health checks, Preflight/Radar integration.
2. Atomic apply, private backup, SQLite receipts, rollback, Markdown/HTML reporting.
3. Local desktop shell, patch editor, install/remove orchestration, and cross-platform packaging.

## Primary references

- [DeepSeek Harness profile implementation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/boot/app-boot/src/profile.ts)
- [DeepSeek Harness CLI behavior reference](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/reference/README.md)
- [DeepSeek Harness plugin forwarder and reconciliation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/src/plugin.ts)
- [CC Switch repository](https://github.com/farion1231/cc-switch) and its [MIT license](https://github.com/farion1231/cc-switch/blob/eb69e4922ee187a261fd29c216a738e838f85bc4/LICENSE)
