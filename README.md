# Velvarr

Standalone adult-media discovery and request app for a homelab stack: browse movies, scenes, performers, and studios from **TPDB** and **StashDB**; request them through **Whisparr** (Eros) with administrator approval; check per-user availability in **Jellyfin** and watch through a credential-free link.

## Status and evidence

Runnable standalone application. Milestones M1 through M7 are implemented and verified locally against HTTP fixtures (provider, Jellyfin, Whisparr), with a green test suite and a CI pipeline that includes container smoke checks. What that actually exercised: one-time bootstrap and the account lifecycle, access-checked browsing of a real user-accessible library with credential-free watch links, provider-backed discovery and global search, durable requests with approval, the shared acquisition worker, backup and restore, migration rollback, and crash/boot reconciliation.

Unproven, stated so nobody assumes otherwise:

- **No Whisparr add has ever been executed.** The end-to-end acquisition-to-playback journey for a movie or a scene is unproven. Proving it needs the operator to nominate fixtures, a root folder, and a quality profile, and to authorize the first controlled add.
- **The installed homelab Jellyfin is unproven**; only a local lab Jellyfin 12.0.0 was used. That build ships empty `ProviderIds` and ignores `parentId` when ids are present, so library membership is proven via ancestors and availability matching leans on the Whisparr path.
- **No removal has ever been executed against a real system.** The removal ladder is proven against loopback fixtures only.
- **Container behavior is verified in CI**, because this workstation has no container runtime.
- **There is no LICENSE file.** The licence choice has not been made and is the operator's.
- **Neither provider publishes usage terms** covering third-party apps, artwork re-serving, caching, or rate limits. Nothing is cached; this remains an open operator question.

## What it does

Discovery is provider-backed: TPDB and StashDB catalogs for movies, scenes, performers, and studios, each with the filters and sort orders that provider actually supports (see the measured limits below), plus global search across both providers. Results are never merged across providers, and cross-provider identity is performer-level only, via explicit provider URLs. Discover shelves surface recent releases, bounded to titles released on or before today (UTC) and excluding records without a release date.

Users file durable requests for movies and scenes. Administrators and moderators approve or decline; an account can also carry an auto-approve grant. Approval attaches shared acquisition work — one record per media identity per Whisparr instance — and a single worker dispatches it: every attempt is persisted before any network call, uncertain outcomes (timeout, 5xx, network error) are reconciled by exact identity before any second submission, and observations (monitoring, downloading, imported) are recorded. A crash or restart leaves recoverable evidence, never a lost or duplicated add.

Imported Jellyfin accounts see only the libraries an administrator granted them, with per-user availability and a credential-free watch link; links are invalidated when the underlying item is removed. An optional notifier posts to a private Discord webhook, identity-only by default. An operator-gated removal ladder lets granted accounts request removals; an approver with an elevated role and the removal grant chooses an explicit level, and every attempt lands in an insert-only audit log. The destructive path is off unless the operator flag and a per-account grant are both present.

In short:

- Provider-backed catalogs (TPDB, StashDB) for movies, scenes, performers, studios, with per-provider filters and sorting
- Global search across both providers
- Durable requests with administrator approval and an optional per-account auto-approve grant
- Shared acquisition worker with crash-safe attempt records and identity reconciliation
- Per-user Jellyfin availability with credential-free watch links
- Optional private Discord notifier (identity-only by default)
- Operator-gated removal ladder with approver-chosen levels and an insert-only audit log

### Measured provider limits

These are observed upstream behaviors, not design choices; the UI states them where they bite:

- StashDB has no movie entity at all; movies are TPDB-only. Scenes exist in both catalogs; results are never merged across providers.
- Cross-provider identity is performer-level only, via explicit provider URLs. There is no reliable scene-level cross-link, so an unlinked performer shows an explicit reason rather than a fabricated filmography.
- TPDB unfiltered and title-only-filtered listings report a fake `total: 10000` cap. A count is shown only when it is genuinely real; filtered queries do return real counts.
- TPDB sort offers relevance, release recency, and duration only — no trending or popularity order. StashDB scenes additionally offer title, date, duration, trending, popularity, created, and updated; trending and popularity are StashDB's own ordering.
- StashDB scene filters have no year criterion (date plus a modifier only, with no BETWEEN). TPDB has year and an exact-duration filter but no tag-exclusion parameter; StashDB supports include, include-all, and exclude.
- A StashDB studio may be a parent whose scenes live under child studios (Brazzers: 48 children, 0 direct scenes versus 14,658 with children), so including a parent is an explicit choice.
- TPDB `date_operation` accepts only the operator strings `<=`, `>=`, `<`, `>`, `=`; every word form is rejected upstream.

## Run it locally

Requires Node 24.21.0+ and Bun 1.3.14.

```sh
bun install
bun run setup    # writes .env.local with fresh secrets; never overwrites existing credentials
bun run dev      # http://127.0.0.1:5577
```

Production: `docker compose up --build`. The image runs the Next standalone server (`node server.js`), which is the supported path for this build's `output: "standalone"`; image build, readiness, non-root, restart, and no-secrets checks run in CI. `bun run build` then `bun run start` is a local preview only; Next prints a warning that `next start` is not the standalone entry point. Checks: `bun run check` (TypeScript strict), `bun run test` (node:test).

## Environment variables

`bun run setup` writes `VELVARR_ORIGIN`, `VELVARR_SECRET_KEY`, and `VELVARR_SETUP_SECRET` to the git-ignored `.env.local`. The container reads them from the environment at runtime only; no credential enters the image as a build argument, copied file, or layer.

| Variable                     | Required         | Meaning                                                                                                                                                                                      |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VELVARR_SECRET_KEY`         | yes              | Exactly 64 hex characters. Decrypts credentials stored in the database; losing it loses the stored data and every backup. Restores require the key from backup time.                          |
| `VELVARR_SETUP_SECRET`       | until bootstrap  | At least 32 characters; gates the one-time owner setup.                                                                                                                                       |
| `VELVARR_ORIGIN`             | no               | Public origin; default `http://127.0.0.1:5577`.                                                                                                                                               |
| `VELVARR_DATA_DIR`           | no               | Data directory; default `./data`, `/data` in the container.                                                                                                                                   |
| `VELVARR_ALLOW_HTTP`         | no               | `1` allows plain HTTP to trusted private addresses; loopback is always allowed.                                                                                                               |
| `VELVARR_ENABLE_REMOVAL`     | no               | `1` enables the removal ladder instance-wide. Off by default, and even when on, creating or approving removals additionally requires a per-account removal grant set by an administrator.      |
| `VELVARR_DISCORD_WEBHOOK_URL`| no               | Discord webhook for notifications; unset disables the notifier entirely. Only https `discord.com`/`discordapp.com` webhook URLs are accepted (plain http only for loopback, which is how the test fixture works), and the URL is never logged or embedded in errors. |
| `VELVARR_DISCORD_DETAIL`     | no               | `1` includes titles in notifications. Off by default: messages carry only the event kind and the media identity (provider/kind/external id), never titles or artwork.                          |

## Backup and recovery

Take a consistent online backup:

```sh
bun run backup /backups/velvarr-2026-09-11.sqlite
```

The script snapshots the live database with SQLite `VACUUM INTO` (WAL included, so the copy is consistent while the app runs), verifies the snapshot with `PRAGMA quick_check`, refuses to overwrite an existing destination, and never stores or prints key material. It warns loudly if `VELVARR_SECRET_KEY` is not in the environment or `.env.local`, because a backup taken without knowing the key is unrecoverable.

To restore:

1. Start from a **fresh** data directory or volume. Never restore over a live data directory; there is deliberately no restore-overwrite command.
2. Copy the snapshot into that directory as `velvarr.sqlite` (`/data/velvarr.sqlite` in the container).
3. Start with the **same `VELVARR_SECRET_KEY`** as when the backup was taken. The key is never stored in the backup.

What then happens, each verified:

- **Wrong key:** startup fails with `secret_key_mismatch` — stored secrets cannot be decrypted with the configured key. The database is not modified; restoring again with the correct key works.
- **Failed migration:** each schema version runs inside its own transaction; a failure rolls that version back and startup refuses the database. The database stays at its previous version with all data intact — it is never half-migrated. Foreign or future databases (newer `user_version`) are refused without being touched.
- **Startup reconciliation:** a restored (or restarted) deployment does not blindly re-send anything. In-flight submissions flip from `submitting` to `uncertain`, every claim from the previous process dies, and the worker then reconciles by exact identity before any second submission: found means the real observation is recorded with no POST; provably absent means one fresh attempt; an unknown check (outage) means recheck later. In-flight removal attempts reconcile the same way — re-resolve by identity and compare the recorded facts before any retry.

## Cutover position

Velvarr is deployed **beside** the existing Seerr/Whisparr/Jellyfin stack: its own image (`velvarr:local`, built locally by compose; nothing is published), its own named volume (`velvarr-data`), and its own loopback port (`127.0.0.1:5577`). Nothing in this repository replaces, reconfigures, or touches the family's existing deployment. Changing the adult entry point is a deliberate operator decision, made by the operator, not performed or scheduled by this codebase.

Prerequisites that remain open before any cutover decision:

1. The authorized first Whisparr add (fixtures, root folder, quality profile nominated by the operator), without which acquisition-to-playback is unproven.
2. Proof against the installed homelab Jellyfin, not just the local lab instance.
3. The licence choice — there is no LICENSE file, and adding one is the operator's call.
4. The provider usage-terms question — nothing is cached until the operator decides what the providers' unpublished terms allow.

## Repository layout

| Reference               | Contents                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `main`                  | Clean standalone product root; no inherited Seerr application                       |
| `legacy/seerr-whisparr` | Seerr integration snapshot with squashed history; reference only                    |
| `upstream` remote       | [seerr-team/seerr](https://github.com/seerr-team/seerr); not a routine merge source |

A Seerr adaptation is possible, but its TMDB/movie/TV assumptions make the requested movie/scene/performer model an expensive fit. Velvarr has its own domain and storage.

## Local credentials

`.env*`, `config/`, `data/`, and `cache/` are ignored by Git. Old local Seerr configuration/database files must not become Velvarr's runtime data or enter an image. Keep secrets out of chat, commits, browser-exposed variables, and logs; the allowlist `.dockerignore` keeps secrets, Git history, and legacy/runtime state out of the build context.
