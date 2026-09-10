# Velvarr

Standalone adult-media discovery and request app for a homelab stack: browse movies, scenes, and performers; request them through **Whisparr** (Eros); check availability in **Jellyfin**. Metadata comes from TPDB and StashDB.

**Status: planning.** Implementation has not started — the first milestone (M0, provider contract proofs) is blocked on TPDB/StashDB API credentials. See [docs/plans/2026-09-09-whisparr-discovery.md](docs/plans/2026-09-09-whisparr-discovery.md).

## Repository layout

| Branch | Contents |
|---|---|
| `main` | Velvarr itself: docs now, application code as milestones land |
| `legacy/seerr-whisparr` | Frozen Seerr fork with the completed Whisparr server integration (archived approach; kept for reference) |
| `upstream` | Remote pointing at [seerr-team/seerr](https://github.com/seerr-team/seerr), for the legacy branch only |

The fork-based approach (Whisparr as a server type inside Seerr) is fully implemented on `legacy/seerr-whisparr` and preserved there. Development moved to this standalone app because the fork cannot provide performer/scene-native discovery, per-user account grants, or an adult-appropriate catalog model.

## Integration surfaces

- **Whisparr (Eros):** V3 API, add/list movies and scenes, `foreignId` required on add
- **Jellyfin:** user auth via standard `Authorization` header, library and playback-status reads
- **TPDB / StashDB:** scene, performer, and studio metadata; read-only keys
