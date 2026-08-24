# DSH Switchboard

An independent, local control plane for DeepSeek Harness profiles. It discovers profiles, explains ordered bundle layers, runs Plugin Preflight and Compatibility Radar, creates reviewable change plans, validates with the official DSH CLI, and keeps private backup/rollback receipts in SQLite.

> Technical preview · noncommercial use only. This package is currently private and is distributed as part of the DSH Toolbox source repository.

The macOS MVP smoke test uses the official DSH `0.1.1-rc.2`: four Toolbox bundles are installed into an isolated profile, the full plugin tree is loaded, a bundle reorder is atomically applied and validated, and rollback restores the original SHA-256 profile state.

## Why it runs outside DSH

A plugin loaded by an active Harness profile should not rewrite the configuration that booted it. Switchboard is an external control plane: it changes an inactive or restart-bound profile, validates the composed configuration, and leaves an auditable receipt.

It follows the upstream profile contract rather than replacing it:

- profile manifests live at `$DSH_HOME/profiles/<name>/package.json`;
- `dsh.profile.bundles` is an ordered layer list;
- `cordis.patch.yml` remains the user-owned patch layer;
- the official `dsh plugin` command remains responsible for dependency installation/removal;
- `dsh --profile <name> --dump-config` is the runtime validation gate.

## Quick start

Run from the repository checkout:

```sh
node packages/dsh-switchboard/bin/dsh-switchboard.js detect
node packages/dsh-switchboard/bin/dsh-switchboard.js profiles
node packages/dsh-switchboard/bin/dsh-switchboard.js inspect toolbox
node packages/dsh-switchboard/bin/dsh-switchboard.js health toolbox
```

Bundle mutations are plan-first. This prints a plan and changes nothing:

```sh
node packages/dsh-switchboard/bin/dsh-switchboard.js bundle disable toolbox @dsh-toolbox/context-switchboard
```

After reviewing the JSON plan, either repeat with `--apply` or save/apply an explicit plan:

```sh
node packages/dsh-switchboard/bin/dsh-switchboard.js plan toolbox \
  --bundles @deepseek-ai/dsh-base,@dsh-toolbox/product-research-workbench \
  --out ./switchboard-plan.json

node packages/dsh-switchboard/bin/dsh-switchboard.js apply ./switchboard-plan.json
```

By default, apply and rollback require the `dsh` command and a successful config dump. `--skip-runtime-validation` exists for isolated recovery and tests; use it only when you accept static validation without proof that DSH can compose the profile.

Rollback refuses to overwrite unrelated changes made after a transaction:

```sh
node packages/dsh-switchboard/bin/dsh-switchboard.js history
node packages/dsh-switchboard/bin/dsh-switchboard.js rollback TRANSACTION_ID
```

## Preflight, compatibility, and reports

```sh
node packages/dsh-switchboard/bin/dsh-switchboard.js preflight packages/context-switchboard \
  --dsh-tools 0.1.1-rc.2 --cordis 4.0.1

node packages/dsh-switchboard/bin/dsh-switchboard.js report toolbox --audit \
  --dsh-tools 0.1.1-rc.2 --cordis 4.0.1
```

Reports are Markdown plus self-contained HTML. SQLite receipts, backups, and reports default to `~/.local/share/dsh-toolbox/dsh-switchboard`. Files are created with user-only permissions where supported. No profile data is uploaded, and no registry or update polling runs in the background.

## Safety behavior

- refuses profile paths that escape `$DSH_HOME/profiles`;
- refuses symlinked profile directories and managed manifest/patch files;
- rejects stale plans using a SHA-256 profile state fingerprint;
- uses same-directory temporary files and atomic rename;
- serializes cooperating changes with a profile lock;
- backs up before writing and automatically restores after failed validation;
- runs external commands without a shell;
- never edits dependency lockfiles or `node_modules` in this slice.

If the process is killed while applying a change, inspect `.dsh-switchboard.lock` in the profile directory and the matching SQLite/backup receipt before removing a stale lock.

See [`docs/RFC-DSH-SWITCHBOARD.md`](../../docs/RFC-DSH-SWITCHBOARD.md) for the architecture and boundaries.
