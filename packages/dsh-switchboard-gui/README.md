# DSH Switchboard GUI

A light-theme, single-user local control panel for DeepSeek Harness Profiles and Profile Bundles.

The fixed application frame has four left-side views—DSH Profiles, Plugins, Activity, and Settings—a task-focused center panel, and recent local activity fixed on the right. Long content scrolls inside its panel instead of expanding the whole page.

It turns the safety workflow of `@dsh-toolbox/dsh-switchboard` into a visual flow:

1. select a real Profile from `$DSH_HOME/profiles`;
2. inspect its active and inactive Profile Bundles;
3. run `dsh --profile <name> --dump-config` as a health check;
4. toggle a Bundle to create a reviewable plan without changing files;
5. apply the plan only after review, create a backup, and validate with DSH;
6. restore a prior backup if the result is not what you wanted.

The backup dialog also provides an explicit **Back up now** action. Manual snapshots are restorable, and Switchboard creates a fresh recovery point before restoring one.

The GUI runs outside the active DSH process so it never rewrites the Profile that booted it. It has no account, cloud database, analytics, telemetry, or background registry access.

## Start

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm switchboard:gui
```

Open `http://127.0.0.1:4173/`. The standalone server rejects non-loopback hosts. Use `DSH_HOME` to select a different Harness home and `DSH_SWITCHBOARD_DATA_DIR` to select a different local backup/receipt directory.

## Privacy and safety

- API credential values are never returned to the browser.
- Write requests require a per-process session token and same-origin browser context.
- Request bodies are limited to 64 KiB.
- Bundle toggles create plans first; they do not edit Profile files immediately.
- Apply and rollback use Switchboard's stale-state checks, backups, atomic writes, DSH validation, and failure restore behavior.

Original project code is available for noncommercial use under the repository's PolyForm Noncommercial License 1.0.0. Bundled third-party notices are listed in [`third-party-licenses`](third-party-licenses).
