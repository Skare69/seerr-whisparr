# Decision: Whisparr rides the Radarr server list, and only V3 is supported

Date: 2026-09-01 (feature: Whisparr integration, `feat(whisparr)` on `main`)

## What was measured (Whisparr source, `openapi.json` of both lines)

`src/Whisparr.Api.V3/openapi.json` on each branch, plus the README install
section, settle the lineage that third-party summaries get backwards:

| | Whisparr V2 (`v2-develop`, default branch, releases `v2.2.0-develop.*`) | Whisparr V3 "Eros" (`eros`) |
|---|---|---|
| Fork of | **Sonarr** (studios) | **Radarr** (scenes + movies) |
| API prefix | `/api/v3` | `/api/v3` |
| Content resource | `series` + `episodes` + `seasonpass` | `movie` + `moviefiles` |
| External ids in schemas | `tvdbId`, `tpdbId` | `tmdbId`, `imdbId`, `stashId`, `foreignId` |
| TMDB lookup route | none | `GET /movie/lookup/tmdb?tmdbId=` |

So **V2 is unusable from Seerr**: its ids are TPDB studio ids and Seerr's media
identity is a TMDB id, with no mapping between them. V3 accepts `tmdbId`
directly. Rejected by name: wiring Whisparr V2 as a second Sonarr.

`NzbDrone.Core/MetadataSource/SkyHook/SkyHookProxy.cs` also shows why the
Radarr client cannot be reused verbatim: `SearchForNewMovie` only parses the
`tmdb:<id>` term prefix when the instance config
`WhisparrMovieMetadataSource == TMDB` (it can also be `TPDB` or `NONE`).
`GET /movie/lookup/tmdb` calls `GetMovieInfo(tmdbId)` directly and is
config-independent, so `WhisparrAPI` overrides exactly that one method.

## Decision

Whisparr servers are stored in `settings.radarr` with `isWhisparr: true`,
*not* in a new `settings.whisparr` array.

Rejected alternative by name: a first-class parallel server type mirroring the
Sonarr integration (own settings array, own `/settings/whisparr` routes, own
scanner, own job ids, own `serviceId` bookkeeping). Counted before rejecting:
`settings.radarr` is read by `availabilitySync`, `downloadtracker`, the Radarr
scanner, `baseScanner`, `Media.serviceUrl`, `OverrideRule`, `routes/request`,
`routes/media`, `routes/service`, `routes/settings/radarr` and the public
settings — 15 files that would need a twin for zero functional gain, because
Whisparr V3 answers all of those endpoints identically. The flag cost 7 backend
files and every one of those features works against Whisparr for free.

Consequences accepted:

- Every place that picks a default movie server must compare
  `!!server.isWhisparr === isAdult`, otherwise a default Whisparr server
  steals ordinary movie requests. Done in `MediaRequestSubscriber.sendToRadarr`,
  `MediaRequest.request` (override-rule lookup), `routes/settings/radarr`
  (isDefault clearing), `fullPublicSettings.movie4kEnabled`, and the
  `AdvancedRequester` server dropdown.
- The cache bucket stays `radarr` and base-class log labels still say Radarr;
  adding a `whisparr` cache name would mean editing the `AvailableCacheIds`
  union for no behavioural difference.
- Routing signal is TMDB's `adult` flag on the movie, gated by a new
  `REQUEST_ADULT` permission (bit `536870912`, the free bit between
  `MANAGE_BLOCKLIST` and `VIEW_BLOCKLIST`). Without the permission nothing
  changes: `include_adult` stays `false` in search and movie discover, so the
  catalog is identical to upstream.

## Environment limit hit while verifying

`pnpm dev` cannot start on Windows: the script passes `--exec 'ts-node …'` with
single quotes, which `cmd.exe` treats as part of the binary name
(`Der Befehl "'ts-node" ist … nicht gefunden`). Run the server directly for
manual verification:

```
pnpm exec ts-node -r tsconfig-paths/register --files --project server/tsconfig.json server/index.ts
```

`pnpm cypress:prepare` seeds an initialized instance plus
`admin@seerr.dev` / `test1234`, which is the cheapest way to reach the
authenticated settings UI without a real Plex or Jellyfin server.
