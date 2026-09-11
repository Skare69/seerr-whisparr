# Velvarr

Standalone adult-media discovery and request app for a homelab stack: browse movies, scenes, and performers; request them through **Whisparr** (Eros); check availability in **Jellyfin**. Metadata comes from TPDB and StashDB.

**Status: runnable standalone application, verified locally.** The server, package manifest, Dockerfile, and Compose file exist; no application image is published yet. Stack: Next 16.3.4 App Router, React 19.3.0, TypeScript strict, Node 24.21.0 runtime, Bun 1.3.14 package manager, SQLite via `node:sqlite` in a fresh data directory. Milestone M1 is implemented and browser-verified end to end against a local HTTP Jellyfin fixture: protected one-time bootstrap with explicit owner and library selection, Jellyfin authentication, account import that grants nothing, explicit role/library grants, immediate logout and revocation, paged browsing of the real user-accessible Jellyfin library with authorized artwork and credential-free watch links, and administrator-only read-only Whisparr status.

Not delivered yet: provider-backed discovery, requests, and acquisition (TPDB/StashDB credentials are still missing), and playback proof against the real homelab servers. The fixture run proves application wiring, not the installed servers' behavior.

## Run it locally

Requires Node 24.21.0+ and Bun 1.3.14.

```sh
bun install
bun run setup    # writes .env.local with fresh secrets; never overwrites existing credentials
bun run dev      # http://127.0.0.1:5577
```

Production: `docker compose up --build`. The image runs the Next standalone server (`node server.js`), which is the supported path for this build's `output: "standalone"`; the image build, readiness, non-root, restart and no-secrets checks run in CI. `bun run build` then `bun run start` is a local preview only and Next prints a warning that `next start` is not the standalone entry point. Checks: `bun run check` (TypeScript strict), `bun run test` (node:test).

## Environment variables

`bun run setup` writes `VELVARR_ORIGIN`, `VELVARR_SECRET_KEY`, and `VELVARR_SETUP_SECRET` to the git-ignored `.env.local`. The container reads them from the environment at runtime only; no credential enters the image as a build argument, copied file, or layer.

| Variable                | Required        | Meaning                                                                                                                                            |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VELVARR_SECRET_KEY`    | yes             | Exactly 64 hex characters. Decrypts credentials stored in the database; losing it loses the stored data and every backup.                            |
| `VELVARR_SETUP_SECRET`  | until bootstrap | At least 32 characters; gates the one-time owner setup.                                                                                             |
| `VELVARR_ORIGIN`        | no              | Public origin; default `http://127.0.0.1:5577`.                                                                                                     |
| `VELVARR_DATA_DIR`      | no              | Data directory; default `./data`, `/data` in the container.                                                                                         |
| `VELVARR_ALLOW_HTTP`    | no              | `1` allows plain HTTP to trusted private addresses; loopback is always allowed.                                                                     |
| `VELVARR_DISCORD_WEBHOOK_URL` | no        | Discord webhook for request notifications; unset disables the notifier entirely. Only https `discord.com`/`discordapp.com` webhook URLs are accepted (plain http only for loopback, which is how the test fixture works), and the URL is never logged or embedded in errors. |
| `VELVARR_DISCORD_DETAIL` | no             | `1` includes titles in notifications. Off by default: messages carry only the event kind and the media identity (provider/kind/external id), never titles or artwork. |

## Operations

- **Backup and restore:** `bun run backup <destination>` writes a consistent SQLite snapshot to a fresh destination. To restore, copy the snapshot into a new data directory or fresh volume as `velvarr.sqlite` and start with the same `VELVARR_SECRET_KEY`; the key is never stored in the backup.
- **Failed migration:** each schema version runs inside its own transaction; a failure rolls that version back and startup refuses the database rather than half-migrating it. Foreign or future databases are refused without being touched.
- **Shutdown:** the acquisition loop uses unref'd timers and persists every attempt before dispatching, so stopping the process never delays exit and never loses or duplicates work; the next boot recovers anything left in flight.
- **Container verification:** image build, readiness, non-root, restart on a persistent volume, and the no-secrets-in-image assertion run in CI, because this workstation has no container runtime.

## Repository layout

| Reference               | Contents                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `main`                  | Clean standalone product root; no inherited Seerr application                       |
| `legacy/seerr-whisparr` | Seerr integration snapshot with squashed history; reference only                    |
| `upstream` remote       | [seerr-team/seerr](https://github.com/seerr-team/seerr); not a routine merge source |

A Seerr adaptation is possible, but its TMDB/movie/TV assumptions make the requested movie/scene/performer model an expensive fit. Velvarr starts with its own domain and storage; small reviewed MIT-licensed pieces may be reused with their notices. The complete release still includes both movie and scene discovery, performer traversal, filters, requests/approval, and Jellyfin availability.

## Integrations

- **Whisparr Eros:** resolve and acquire supported movies/scenes using verified external identities.
- **Jellyfin:** authenticate selected users, enforce per-user library/playback access, and handle watching.
- **TPDB / StashDB:** provider-backed discovery and relationships; direct access needs credentials and compatibility proof.

Earlier Whisparr status and Jellyfin administrator-list reads established connectivity only. M1 adds end-to-end login, import, and access-checked library browsing against the configured Jellyfin server, verified locally against a fixture; live playback proof against the homelab servers is still pending.

## Local credentials

`.env*`, `config/`, `data/`, and `cache/` are ignored by Git. Old local Seerr configuration/database files must not become Velvarr's runtime data or enter an image. Keep secrets out of chat, commits, browser-exposed variables, and logs; the allowlist `.dockerignore` keeps secrets, Git history, and legacy/runtime state out of the build context.
