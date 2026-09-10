# Decision: no ThePornDB metadata provider — Seerr stays TMDB-keyed

Date: 2026-09-01 (follow-up question to the Whisparr integration)

Question asked: Seerr only reads TMDB — should it also read ThePornDB (TPDB)
so Whisparr gets adult-native metadata?

## What was measured

**TMDB's adult catalog is not a rounding error** (live TMDB API, bundled key,
2026-09-01, `/discover/movie` with no other filters):

| `include_adult` | total_results |
|---|---|
| true | 1 296 183 |
| false | 1 174 210 |
| **adult delta** | **121 973** |

Search probes (`/search/movie`, results with `adult: true`):

| query | hits with adult | hits without | first adult hit |
|---|---|---|---|
| Deep Throat | 200 | 7 | Deep Throat III |
| Brazzers | 45 | 0 | Brazzers Goes Black |
| Tushy | 104 | 0 | Miss Tushy |
| Blacked | 135 | 3 | Blacked Out |
| SSIS-698 (JAV code) | 1 | 0 | Yua Mikami, Arata Arina And Minami Aizawa |

**Whisparr V3 treats TMDB as a first-class metadata source**, so nothing about
the shipped integration is a workaround —
`src/NzbDrone.Core/Configuration/MovieMetadataType.cs` (branch `eros`):

```csharp
public enum MovieMetadataType { NONE, TMDB, TPDB }
```

**Seerr's identity column is not pluggable.** `server/entity/Media.ts:90-92`:
`tmdbId` is a non-nullable `@Column()` under `@Index(['tmdbId', 'mediaType'])`,
while `tvdbId` and `imdbId` are `nullable: true` extras.

**The existing "Metadata Providers" feature is enrichment, not identity.**
`server/api/metadata.ts:7` returns a `TvShowProvider`, but the TVDB
implementation resolves *from* TMDB: `server/api/tvdb/index.ts:176` calls
`this.tmdb.getTvShow({ tvId })` first, derives the TVDB id from
`external_ids.tvdb_id` (`:550`), and falls back to plain TMDB on any error
(`:194`). No Media row can exist without a TMDB id.

**Blast radius, counted** (`.ts`/`.tsx`, excluding `node_modules`/`dist`):

| identifier | server hits / files | client hits / files |
|---|---|---|
| `tmdbId` | 807 / 79 | 168 / 31 |
| `tvdbId` | 361 / 39 | 41 / 11 |

TVDB is the cheapest possible second provider — TMDB hands over the cross-id
for free — and it still touches 50 files. TPDB shares no id with TMDB, so it
gets no such discount.

## Decision

Rejected by name: adding TPDB (or StashDB) as a Seerr metadata provider, and
the synthetic-tmdbId variant that would let TPDB items into `Media` without a
schema change (guaranteed id-space collision with real TMDB ids).

Reasons, in order of weight:

1. TPDB's actual value is *scene*-level metadata (`/scenes`: site, date,
   performers). Seerr's request unit is a `Media` row of type `movie` or `tv`;
   a scene is neither. The mismatch is in the domain model, not the plumbing.
2. Making `tmdbId` nullable means a migration on the indexed identity column
   plus a fork in every consumer of those 807 server references.
3. TPDB reads require a personal Bearer token
   (`theporndb.net/user/api-tokens`), so a shared family instance would have to
   ship an adult-site credential.

Kept instead: Whisparr's own UI for anything TMDB does not list — it searches
StashDB/TPDB natively, which is exactly the case Seerr cannot express.

## Operating requirement this creates

The Whisparr instance must run with metadata source **TMDB**, because Seerr
sends TMDB ids (`GET /movie/lookup/tmdb`, then `POST /movie` with `tmdbId`).
Pointing a Whisparr instance at TPDB metadata while Seerr feeds it TMDB ids is
the one configuration that will silently mismatch. Not reproduced against a
live Whisparr — no instance available here; conclusion is from the Eros source
above.
