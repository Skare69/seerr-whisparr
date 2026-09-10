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

Production: `bun run build`, then `bun run start`. Checks: `bun run check` (TypeScript strict), `bun run test` (node:test). Operations: `bun run backup` writes a consistent SQLite snapshot to a fresh destination. Containers: `docker compose up --build`; the image build and container smoke path are exercised in CI.

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
