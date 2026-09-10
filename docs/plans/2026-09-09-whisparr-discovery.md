# Velvarr: standalone discovery and request implementation plan

Planned: 2026-09-09. Product scope approved: 2026-09-10. Reassessed: 2026-09-10. The revised delivery sequence below was this review's recommendation; M1 has since been implemented and locally verified, with live-server and container proofs still open (see the M1 status section below).

Product/repository: **Velvarr**, `Skare69/velvarr`. `main` is a fresh standalone root; `legacy/seerr-whisparr` retains a squashed Seerr integration snapshot; `next` was deleted. Update (2026-09-10): the standalone Velvarr application now exists — package manifest, Dockerfile, and Compose file included — and milestone M1 is implemented and verified locally (see [M1](#m1-first-useful-locally-runnable-checkpoint) below); only a published application image remains future work.

## Reassessment: what changes and what does not

- **Keep the product scope. Change the dependency order.** Missing metadata keys block provider proofs and provider-backed features, not a useful server with protected setup, Jellyfin login, real accessible library items, and read-only Whisparr status.
- **Prove one movie and one scene through the whole system before building a broad catalog UI.** Successful metadata search is not successful acquisition or playback.
- **Do not inherit a vanished foundation.** Familiar TypeScript/Next.js tooling is a deliberate choice, not an already-installed application. A Seerr adaptation is possible; avoiding its TMDB/movie/TV coupling is a maintenance decision, not a claim of technical impossibility.
- **Separate user intent, shared acquisition, and user-specific playback.** Logout, cancellation, a download finishing, and losing library access are different transitions.
- **Fix credential handling before asking for keys.** The reset removed `.gitignore` while local Seerr config/database files remained. This review restores exclusions for `.env*`, `config/`, `data/`, and `cache/`; container-context exclusions are required before the first Docker build. Ignoring a file does not load it or encrypt it.
- **No more repository resets to make sidebar statistics look clean.** Keep the current root and reference snapshot; concentrate on runnable behavior.

## Recommendation

Build a separate, discovery-first application with **Movies, Scenes, and Performers as first-class concepts**. Take Seerr's interaction quality and Omnibus's catalog-navigation ideas, not Seerr's TMDB-centered identity model or Omnibus's downloader/reader architecture.

This is not the previously suggested search-only scene requester. Movie discovery, scene discovery, performer filmographies, requests, supported metadata filters, and Jellyfin integration all belong in the first complete release. Development milestones below are sequencing, not permission to drop requirements.

The system has three distinct responsibilities:

- **Metadata providers:** discovery, artwork, credits, studios, tags, and external identities.
- **Whisparr:** accept supported items, monitor releases, search indexers, manage downloads and imports.
- **Jellyfin:** authenticate users, enforce library access, report playable items, and play media.

The new app owns catalog navigation, cross-provider identity links, access grants, request approval, and a truthful view of those external states. It does not become another downloader or video server.

**Provider recommendation: TPDB for Movies; StashDB for Scenes; verified links between their Performers.** TPDB also supplies movie/scene membership and filmographies. TMDB is not an unconditional fallback: its published API terms restrict applications involving pornographic content. Resolve permission before including TMDB content in this product; technical API support alone is insufficient.

## Reference audit

### Seerr: interaction quality to preserve

Inspected the original `seerr-team/seerr` repository and its published application preview, not only this modified checkout.

Keep:

- Persistent navigation, prominent global search, artwork-led discovery shelves.
- Movie detail pages with clear primary actions and navigable cast credits.
- Status visible on cards before opening details.
- Approve/decline actions close to request information.
- Responsive layouts, useful loading states, keyboard-accessible dialogs and filters.
- Jellyfin user-import/authentication and library-sync concepts.

Replace:

- Required TMDB identity, movie-versus-TV assumptions, season request flows.
- Radarr/Sonarr naming, duplicated service toggles, and `isWhisparr` routing flags.
- Adult classification as the switch deciding which downloader receives an item. This app has an explicit Whisparr destination and supported movie/scene identities.

### Omnibus: navigation and metadata lessons

Inspected `hankscafe/omnibus`, including its published discovery, library, and request-detail screenshots. It is a comics/manga manager, not a Whisparr integration.

Adopt the ideas:

- Discover -> rich details -> related works -> request without losing browsing context.
- Filters and grid/list controls near the catalog, rather than hidden in administration.
- Metadata provenance and deliberate matching rather than silently replacing curated identity.
- Distinct requested, pending-approval, downloading, and library states.

Do not copy its busy background treatment, reader, archive processing, direct-download engine, or infrastructure stack. Our visual baseline should be closer to Seerr's calmer catalog.

Seerr is MIT-licensed; retain notices for any reused code. Omnibus is GPL-3.0: use it as a design/reference source, not a source of copied implementation unless we explicitly choose to comply with those license obligations. New branding and artwork must not imply affiliation with either project.

## Product structure and user journeys

Primary navigation:

**Discover | Movies | Scenes | Performers | Requests**

Studios and tags are reachable from details, search, and filters. Users/settings are administration surfaces. A separate library-management product is unnecessary: availability filters and Jellyfin links cover that role.

### Discover

A real homepage, not an empty search box:

- New movie releases and new scene releases, with provider and date semantics made clear.
- Recently available in Jellyfin, restricted to the current user's permitted libraries.
- Performer and studio entry points into their catalogs.
- Recent requests visible according to the user's role.
- Provider-supplied popular/trending shelves only where the provider actually exposes a meaningful ranking. Do not rename "recently added metadata" to "trending".

Every shelf has a browse-all destination. Provider outages affect their own shelves, not the entire homepage. A bounded server-side metadata/image cache is part of making this usable; a full mirror of every provider is not.

### Movies

Portrait poster grid and a Seerr-quality detail page: title, year, runtime, synopsis, studio, cast, genres/tags where supplied, source links, availability, and one primary request/watch action.

Movies are requestable as whole features. A movie's constituent scenes may be displayed when the provider supplies a reliable relationship. Owning one scene must not mark the whole movie available; owning a feature must not claim separately playable scene items in Jellyfin.

### Scenes

Landscape scene cards, with title, date, studio, duration, and performer credits visible without a detail-page visit. No forced portrait crop of scene thumbnails.

Scene detail links back to each performer, its studio, tags, and an associated movie only when verified. A scene is requested individually through its supported Whisparr identity, not a fabricated TMDB ID.

### Performers: the actor -> catalog route

Use **Performer** as the domain term; actors/actresses are included in that label.

A performer page has a portrait, names/aliases, provider references, and **Scenes / Movies** tabs. Both tabs support filtering and requesting. Every cast credit on a movie or scene links here. Selecting a studio or tag continues the same browsing loop.

Cross-provider filmographies must be honest. Prefer explicit external IDs, including Whisparr performer lookup's StashDB `foreignId` and `tpdbId` when populated and verified. Otherwise require a reviewed administrator link. Similar names alone must never merge two people. Where identities cannot be linked, show source-specific results and an unlinked-source explanation, not a fabricated complete filmography or a misleading "no movies" result.

### Requests

Users can request from cards or details, see existing requests, and track progress. Administrators can approve/decline; explicitly granted users may auto-approve. Request errors must name the failed operation and give a useful reason, not merely show a generic Failed badge.

This app does not model episodic TV seasons. A studio's scene catalog is not a TV series. That limitation does not exclude movie compilations or provider-supported movie/scene relationships.

## UI acceptance standard

Seerr-level polish is an acceptance criterion, not a later cosmetic phase.

- Dark, artwork-led application shell with restrained background surfaces and a distinct product identity. Reuse reviewed UI primitives where useful; do not copy Seerr's logo or clone every screen.
- Three deliberate card treatments: portrait movies, landscape scenes, portrait/headshot performers.
- Desktop sidebar; compact mobile navigation. Main actions remain visible without hover.
- Global search with Movies, Scenes, Performers, and Studios result categories; source identity preserved behind results.
- Contextual filter drawer, removable active-filter chips, URL-persisted filters and scroll restoration when returning from details.
- Detail pages have clear type/date/studio hierarchy, linked credits, and Request / Pending / Downloading / Open in Jellyfin actions driven by real state.
- Skeletons matching the layout, useful empty states, inline request failures, image fallbacks, and explicit partial-provider errors.
- Verify real screens at 1366x768, a wider desktop, and approximately 390px mobile width, plus keyboard-only interaction, zoom, visible focus, reduced motion, and contrast.
- Public repository screenshots/demo fixtures use neutral imagery. The unauthenticated app shows neither catalog thumbnails nor request history.

## Metadata strategy and identity model

Target combination to validate: **TPDB for movie discovery, movie/scene membership, and performer filmographies; StashDB for Whisparr-aligned scenes, performers, studios, and tags.** Use TPDB scene records for relationships/additional coverage, but require a verified Whisparr-compatible identity before requesting them. Whisparr remains the authority for whether a discovered record can actually be submitted.

Public schemas are sufficient to start the provider-independent application and a provider-scoped identity model. Before enabling provider-backed discovery or submissions, prove account access/terms, representative catalog coverage, performer traversal, pagination/filtering, and exact Whisparr import identity. These are feature/release gates, not a reason to block setup, authentication, or direct Jellyfin library reads.

### Verified provider capabilities and limits

| Provider    | Source-inspected capability                                                                                                                                           | Product decision / outstanding proof                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TPDB**    | `/movies`, `/scenes`, performer-to-movies/scenes endpoints; paged search, tags, studios, release dates, duration input; a movie's `scenes[]` and a scene's `movies[]` | Primary movie source and movie/scene relationships. Bearer token required. Account-tier access, coverage, rate limits, exact filter serialization, and Whisparr import compatibility need credentialed checks.                                                   |
| **StashDB** | `queryScenes` with performer/studio/tag criteria and paging; performer-scoped scene queries; published date/duration/popularity/trending sort keys                    | Primary scene graph. READ-capable API key required for direct discovery. Hosted account policy, limits, and meaningful ranking data must be checked.                                                                                                             |
| **TMDB**    | Technically provides movies, credits, genres, and adult-inclusive queries                                                                                             | No default integration. [API terms, section 1.C][tmdb-terms] restrict applications involving pornographic content. Treat written provider permission covering this application as a prerequisite, including any proposed "mainstream-only enrichment" within it. |

Evidence: [TPDB OpenAPI v3.24.747][tpdb-spec] and [StashDB's stash-box schema][stash-schema], inspected during planning. An API declaration proves an operation exists, not that the intended account can use it or that its catalog has the desired coverage.

Two corrections to the earlier discussion:

- **StashDB is not local Stash.** The inspected stash-box schema exposes no first-class Movie/Group catalog. Local Stash's grouping features do not establish a hosted StashDB movie API. TPDB provides the verified movie/scene membership needed here.
- **`include_adult` is not usage permission.** Do not work around TMDB's application restrictions through Whisparr's metadata proxy. Existing IDs may remain identity references; active TMDB content support is a separate permission decision. Earlier Seerr-specific TMDB advice is not a valid provider strategy for this new product.

### Whisparr's role: resolution and delivery, not the discovery database

Historical source baseline: Whisparr **Eros**, commit `cc3fb2ab`. The deployed target reports **3.5.0.1585 / eros**, built 2026-09-09, in the authenticated M0 check on 2026-09-10. The older Sonarr-shaped V2 is not the target; source inspection of the historical build does not prove the newer build's add behavior.

- External text/ID lookups exist for scenes, movies, performers, and studios. However, there is no equivalent of a paged, globally filterable Seerr discovery catalog. `/movie/listByPerformerForeignId` lists already-known local items, not a performer's worldwide filmography.
- Direct provider APIs therefore supply browsing and filters. Whisparr's `/tag` contains local management tags, not the metadata tag taxonomy. Its internal hosted metadata endpoints are not a supported public discovery contract for this app.
- Resolve a TPDB feature with `GET /api/v3/movie/lookup/tpdb?tpdbId=...`; resolve a StashDB scene resource through `GET /api/v3/movie/lookup?term=stash:<uuid>`. The scene search endpoint `GET /api/v3/lookup/scene?term=stash:<uuid>` instead returns wrappers containing `movie`, `foreignId`, `isExisting`, and a search-result `id`; unwrap `movie` and do not treat that wrapper ID as a stored Whisparr item ID. Both paths were exercised on 3.5.0.1585. Verify source identity and item kind, then construct a server-owned, validated `POST /api/v3/movie` payload. Do not blindly spread the lookup response or trust a browser-supplied resource.
- **Add-time identity precedence is a real risk.** In the pinned `AddMovieService.GetMetadata`, a numeric `foreignId` or positive `tmdbId` takes precedence over `tpdbId`. For a TPDB movie, retain the verified nonnumeric foreign ID and explicit `tpdbId`, but omit/zero `tmdbId`. For a StashDB scene, retain the verified StashDB UUID and omit movie-routing `tmdbId`/`tpdbId`. Keep cross-IDs separately as catalog references; include the required validated profile/root/monitoring fields for delivery.
- The mapper emits `tpdbId:<id>` while one fallback tests lowercase `tpdbid:`. Do not rely on that prefix-only fallback or fix it by guessing another identity: carry the explicit `tpdbId` field and assert the stored source, foreign ID, and kind after a controlled add.
- Text movie search follows Whisparr's configured metadata source; the inspected dedicated ID paths/add-time cascade are separate. Test the actual deployed build and returned/stored identities. Do not silently change the existing server's global source, and do not claim that a successful lookup proves a successful add.
- Reading a performer page must not add/monitor that performer or run refresh commands that can bulk-add their catalog. Requesting a selected item is the only acquisition action in this browsing flow.
- Whisparr can expose StashDB/TPDB performer cross-IDs, but its cast/studio mapping may lack an entity when the StashDB link is absent. TPDB-only performers/studios remain legitimate catalog entities. Hosted performer/studio works endpoints are possible ID-link evidence, not a supported paged discovery replacement; do not make the app depend on those undocumented endpoints.

Evidence: [lookup controllers][whisparr-search], [movie ID lookup][whisparr-lookup], [add-time metadata resolution][whisparr-add], [foreign-ID mapping][whisparr-skyhook], and [performer external-ID fields][whisparr-performer]. Returned cross-IDs can bridge the graph, but their population and accuracy remain M0 fixtures, not an assumed universal crosswalk.

### Proposed domain language

- **Movie:** a feature/release that can be requested as a whole.
- **Scene:** an individually cataloged and requestable scene; not a TV episode by implication.
- **Performer:** a credited person, with names and provider-scoped identities.
- **Studio:** a production label/site, with a parent relationship only where supplied.
- **Tag:** a provider's descriptive topic. A TMDB genre and a StashDB tag are not automatically the same taxonomy.
- **Request:** one user's intent to acquire a movie or scene, with its own approval/decline/cancellation decision.
- **Acquisition:** shared durable work for one resolved item on the configured Whisparr server; several requests may attach to it.
- **Whisparr item:** the external monitored/imported item, which may predate every Velvarr request.
- **Playable item:** an exactly matched Jellyfin item that the current user is allowed to access and play; not a global property of a download.
- **Removal request:** one user's intent to have an entry taken away, with its own reason, approval level, and decision. Not an inverted acquisition.
- **Removal execution:** the shared destructive work for one resolved identity: unmonitor, drop from Whisparr, exclude, delete files, delete the Jellyfin item. File deletion has no undo.
- **Import exclusion:** a Whisparr-side block that stops list-driven re-adds of a removed identity; it is a reason a later request cannot proceed, not a silent failure.

### Storage rules

Use an application-owned ID for each catalog entity. A shared `MediaItem` with kind `movie` or `scene` serves one request flow; keep separate Performer, Studio, credits, tags, and verified scene-in-movie relationships. The old proposal for parallel SceneRequest tables was containment within Seerr, not the best design for a new app.

- Preserve external references as **provider + entity kind + external ID**, not one universal ID string. Enforce uniqueness in the database.
- TMDB IDs, TPDB IDs, StashDB UUIDs, Whisparr foreign IDs, and Jellyfin item IDs remain distinct values. Scope local-server references by server identity, not only the current hostname.
- Keep provider provenance and explicit/manual identity links. Never merge people or acquire media from fuzzy names/titles. Support linked, StashDB-only, and TPDB-only performers without manufacturing a complete filmography.
- Preserve the chosen delivery identity, not every competing routing field from a lookup result. Use the source-specific payload rule above and verify the stored Whisparr item; never build another mostly-Radarr payload and hope.
- Keep Whisparr mappings and Jellyfin mappings separate from catalog identity. Requests point to stable catalog records and attach to shared acquisitions; they do not each own a separate download.
- Distinguish an unsupported/unresolvable identity from an unavailable check. A verified deletion/not-found result blocks that reference; a timeout/5xx leaves the outcome unknown and retains the last successful observation. Neither deletes catalog history, user requests, or a separately valid playable mapping. Another reference may still resolve the same entity.
- Cache details/relationships lazily, with bounded size/age and provider permission. Evict cached payloads, not identity rows or reviewed links still referenced by requests/mappings. No full catalog mirror or eager Whisparr lookup for every discovery card.

## Filters and search semantics

Desired controls, exposed only where the selected provider supports them:

| Control                         | Expected surface                      | Rule                                                            |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Performer(s)                    | Movies and scenes                     | Use provider IDs/credits; never rely on display-name equality   |
| Studio/site                     | Movies and scenes                     | Parent-studio inclusion must be explicit                        |
| Genre                           | Movies                                | Preserve the source taxonomy                                    |
| Include/exclude tags            | Primarily scenes; movies if supported | Define ANY/ALL/exclude semantics instead of translating loosely |
| Release date/year               | Both                                  | Distinguish release date from provider-record creation time     |
| Duration                        | Both where supplied                   | Missing values remain unknown                                   |
| Available / requested / missing | Both                                  | Application/Jellyfin state, not provider metadata               |
| Sort                            | Both                                  | Only real provider sort keys or complete local result sets      |

Measured against both live APIs on 2026-09-10 with authenticated read-only keys (TPDB user `Skare`, StashDB role `READ`):

- **StashDB has no movie/group entity at all.** The live query root exposes only performers, studios, tags, scenes, sites, edits, users, drafts and fingerprint helpers. Movie discovery is therefore TPDB-only; scenes exist in both catalogs.
- StashDB scene criteria: `text`, `title`, `url`, `code`, `date`, `production_date`, `studios`, `parentStudio`, `tags`, `performers`, `alias`, `fingerprints`, `favorites`, `has_fingerprint_submissions`, plus `page`/`per_page`/`sort`/`direction`. Sort keys: `TITLE`, `DATE`, `DURATION`, `TRENDING`, `POPULARITY`, `CREATED_AT`, `UPDATED_AT`. Tag `INCLUDES` (ANY), `INCLUDES_ALL`, and `EXCLUDES` were exercised successfully. There is no duration or year criterion; the date input has one value and modifier, with no BETWEEN modifier. A release-after filter and duration sorting work; do not present a single date criterion as an exact bounded year range.
- TPDB's `/scenes` and `/movies` schemas list the same query set: `q`, `title`, `date` + `date_operation`, `year`, `duration`, `site`/`site_id`/`site_operation`, `performers`/`performer_id`/`performer_and`, `performer_genders`/`performer_gender_and`/`performer_gender_only`, `tags`/`tag_and`, `directors`/`director_id`/`director_and`, `category_id`, `external_id`, `hash`/`hashType`, `sku`, `url`, `is_collected`, `is_favourite`, `orderBy`, `page`, `per_page`. No tag-exclusion parameter is declared. Live movie queries confirmed `year=2007` and exact duration matching with `duration=7200` (seconds); that is not a verified min/max-duration control.
- TPDB's dedicated performer filmography endpoints — `/performers/{id}/scenes`, `/performers/{id}/movies`, `/performers/{id}/jav` — declare only `page`/`per_page` filters. This does **not** prevent filtered filmographies: `/scenes?performer_id=<numeric performer _id>&year=2025` was exercised successfully. Use the parent performer's numeric `_id` for that filter, not its UUID; site-specific scene/movie credits link back through `performers[].parent.id`.
- **Unfiltered TPDB list pagination is capped.** `/scenes` and `/movies` both report `total: 10000` with `last_page: 5000` regardless of the real catalog size, while StashDB reports a genuine count (1,095,435 scenes). Never render a TPDB unfiltered total as a catalog count; filtered queries return real counts.
- Neither shared genres nor one cross-provider popularity score exists. Use provider-native tags/categories where genres are absent. Unsupported controls remain visibly unavailable; do not invent mappings.

A multi-provider search must not promise globally ranked, globally filtered results if it only fetched a page from each source. Start with provider-backed shelves and explicit source sections/tabs, combining only verified duplicates. Available/requested views can query the complete locally tracked collection. Applying local-state filters to remote discovery requires bounded page scanning with an explicit continuation and scope; an empty scanned page is not proof of an empty catalog. Unsupported filters are unavailable with an explanation, never silently ignored.

Tags/genres can drive browse pages and related-content rails. Personal recommendations and follow-a-performer automation are later additions, not prerequisites for actor-driven discovery.

## Jellyfin: bootstrap, users, access, availability, playback

### Setup and admission

- An operator-supplied one-time setup secret authorizes initial configuration and explicit selection of a Jellyfin-authenticated owner. Atomically create that owner and close bootstrap permanently across restarts. Never grant the first visitor/login ownership or reopen setup merely because an administrator loses access. Recovery is an explicit operator action.
- Key imported identities by configured Jellyfin server plus stable user ID, not username/email. Import grants nothing; the owner selects allowed accounts/libraries and requester/moderator/admin rights. Importing another Jellyfin administrator does not admit them automatically.
- Velvarr admission authorizes adult catalog discovery. Jellyfin restrictions independently govern library/playback visibility; admitting an account is not an age-rating filter for the external provider catalog. No automatic family-wide access.
- Authenticate with `POST /Users/AuthenticateByName`; never retain passwords. Bind the returned **user token**, not the integration administrator key, to an opaque server-side session. Protect stored tokens and private configuration with restricted storage and a deployment secret; back up that secret with the recovery procedure, not in public artifacts.

### Authorization and transport

- Check current Velvarr grants on every protected request. Validate the actual Jellyfin user token/identity during session validation and before user-triggered privileged actions/watch checks. Proven revocation/disabled/deleted identity invalidates access; a timeout blocks authorization-dependent operations without deleting grants, requests, or mappings. Never fall back to administrator visibility or report an outage as an empty library.
- Logout invalidates the local session immediately, but does not cancel durable approved work. The delivery worker uses integration credentials and persisted approval, not a user's browser session. Before an unsent dispatch, recheck requester admission/account eligibility; revoked access blocks that user's pending intent without undoing another eligible request or deleting external media.
- Use HttpOnly/SameSite session cookies, Secure cookies for HTTPS, origin/CSRF protection for mutations, bounded login attempts, and freshly authorized administration for integration changes. Keep tokens/passwords out of URLs, browser storage, public `NEXT_PUBLIC_*` variables, responses, and logs.
- First local checkpoint binds to loopback by default. Production remote login requires HTTPS; any trusted private HTTP upstream exception must be explicit, not described as encrypted end-to-end. Do not disable certificate validation globally for a self-signed homelab certificate.
- Server-side Jellyfin calls originate from Velvarr's network, not the browser's. Therefore a user token alone does not preserve Jellyfin's remote-access restriction. Before remote exposure, define trusted proxy/client-network handling and conservatively enforce `EnableRemoteAccess`; never trust arbitrary forwarded headers. A remotely denied user must not gain access through Velvarr's LAN address. See the pinned [Jellyfin authorization handler][jellyfin-authorization].

### Protected data and artwork

- Restrict administrator library inventory to configured libraries. Before delivering library metadata, availability, artwork, or a watch link, use the current user's Jellyfin context and item-level parental/tag/playback policy. Folder membership and an administrator's successful GET are insufficient.
- Admission and applicable item authorization run **before cache-hit delivery**, not just before downloading bytes from the provider. Keep protected pages/API/image responses private/no-store and out of public static/CDN caches. A warmed image URL must still reject anonymous, ungranted, library-denied, and revoked users.
- Serve artwork through authenticated same-origin routes keyed by known records. Validate upstream data, descriptions, image type/size, and permitted image origins/redirects; never accept an arbitrary proxy URL from a user. Use provider-sized artwork and native lazy loading first. The default Next.js image optimizer does not forward authentication headers: use an unoptimized image path rather than weakening auth to make it work ([Next.js image documentation][next-image]).
- Shared provider bytes may be cached server-side where terms allow; user-filtered library results remain scoped. Logout/revocation prevents subsequent delivery, not erasure of images already downloaded by a browser.

### Availability and watching

- Whisparr monitoring/import does not mean Jellyfin has scanned the file or that a particular user may play it. Store last successful external observation separately from current check health; an outage changes neither item identity nor established facts to Missing/Failed/Available.
- Prefer exact provider-ID matches when actual plugin data supplies them. Otherwise correlate exact Whisparr/Jellyfin file paths using explicit container-path mappings. Match path components, not loose substring replacements; ambiguous/title-only matches require administrator review.
- Match existing local-library items directly for the first checkpoint without calling them TPDB movies or StashDB scenes. Provider-aware movie/scene matching is a later proven relationship, not something to infer from Jellyfin's generic Movie item type.
- Configure separate trusted internal Jellyfin API and browser-reachable web base URLs, preserving reverse-proxy prefixes and server identity. Never forward integration credentials across an unexpected origin/redirect.
- Show Open in Jellyfin only for an exactly matched, accessible, non-placeholder item with playback permitted. Build a credential-free link such as `/web/index.html#!/details?id=<itemId>&serverId=<serverId>` against the external web base. This is **not SSO**: the browser has its own Jellyfin session. Jellyfin owns playback, transcoding, clients, and watched state.
- Handle delayed scans, missing files, rescans, multiple files/editions, and item-level playback denial explicitly. Poll existing state; do not repeatedly launch library scans. Owning one scene does not satisfy its movie, nor does a movie imply independently playable scene files.

Source-inspected starting points are administrator `GET /Users`, user `POST /Users/AuthenticateByName`, user-token validation, and item enumeration with `ProviderIds`, `Path`, and media-source fields. None is universal proof of scene matching or playback on the installed server. See [Jellyfin user policy documentation][jellyfin-users] and pinned controller references.

## Request lifecycle and reliability

Keep three independent facts:

| Fact             | Owner and examples                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Request decision | One user's pending / approved / declined / cancelled intent                                          |
| Acquisition      | Shared resolved item: unsent / submitting / uncertain / monitoring / downloading / imported / failed |
| Playback access  | Exact Jellyfin mapping and the current user's allowed / denied / unavailable check                   |

A UI may show Pending -> Approved -> Monitoring -> Downloading -> Awaiting Jellyfin -> Open in Jellyfin, but this is a presentation derived from those facts, not one irreversible database status. Monitoring with no release is not a failure; one user's denial does not erase another user's valid request.

- Validate the browser's media reference server-side. Approval rechecks authorization, chosen source/kind, configuration, and existing external items. Adopt existing items rather than acquire a duplicate; shared acquisition status must not reveal another requester's private history.
- Database uniqueness constrains active per-user intent and shared acquisition by server plus resolved identity/kind. Claim durable work transactionally; perform network I/O outside the transaction.
- Persist an attempt **before** the Whisparr POST. SQLite and remote HTTP are not one atomic transaction. On timeout/crash, keep an uncertain result and reconcile by exact identity before another POST. Recover unfinished claims on startup; if absence cannot be established, keep it blocked/uncertain rather than promising exactly-once delivery. A generic HTTP 400 is not an already-existing item.
- Cancellation removes only that user's intent. The last withdrawal may suppress work not dispatched yet; accepted or uncertain external submission may continue. Never delete shared Whisparr/Jellyfin items or files as a cancellation side effect.
- Use bounded, restartable background reconciliation with persisted attempts, next checks, and last observations. No Redis/message broker or public webhook receiver is required. Provider/Whisparr/Jellyfin outages remain distinct, actionable conditions.
- A single optional **private Discord webhook** can follow the working loop. Default to no titles/artwork in notifications until explicitly enabled on the intended private destination. No notification-provider matrix, and notification failure must not roll back a valid request/acquisition.

## Implementation approach

**One self-hosted application, not a microservice rewrite.**

- Retain the familiar TypeScript/React/Next.js and Tailwind direction; use accessible Headless UI primitives when needed. Create a small new application and dependency manifest, not a copied Seerr tree. Reuse only reviewed generic MIT code with notices. No Express/custom-server layer just because Seerr used one.
- Use SQLite with prepared statements, database constraints, and versioned transactional SQL migrations; never production auto-synchronization. Proposed minimum dependency is Node 24 LTS's bundled `node:sqlite`, with exact runtime pinned and exercised in the first Windows/Linux/container checkpoint. Its current Node 24 documentation labels it **release candidate**, not fully stable. Resolve a real runtime/support failure in M1 rather than adding TypeORM/Prisma by inheritance ([Node SQLite documentation][node-sqlite]).
- `ponytail:` one long-lived Node process and one writable local SQLite volume; short synchronous queries suit the homelab scope. Multiple replicas or sustained blocking database work require a different concurrency/deployment decision, not an unsupported flag.
- Keep private modules for catalog/provider reads and identities; request decisions/Whisparr delivery; Jellyfin access/matching; and account/session policy. UI calls those modules server-side. Two concrete provider implementations justify a small common result shape (items, source, continuation, supported filters, explicit errors), not a universal provider plugin framework.
- Initialize storage and the reconciliation loop from a verified Node server-start hook, never from an API request or page render. Next.js documents `instrumentation.register` per server instance with Node-runtime gating; prove behavior in the actual dev and production builds, prevent overlapping loops, and recover persisted work after restart ([startup hook][next-startup]). Timers are scheduling, not durable job state; no serverless/Edge deployment claim.
- Start with one Whisparr Eros and one Jellyfin instance, a **fresh Velvarr data directory**, and no Seerr database migration. Keep server identities on mappings. Integration URLs, root-folder/profile choices, path mappings, network trust, and timeouts are real deployment inputs.
- Introduce Dockerfile, Compose, lockfile, and `.dockerignore` together in the first runnable checkpoint. Runtime credentials must not be build arguments, copied assets, or image layers. Bind the local port to loopback initially; validate persistent storage across restart.
- Back up a consistent SQLite snapshot using the backup API or `VACUUM INTO`/a stopped application, plus required protected settings/key material. Copying only a live WAL-mode main database file is not a recovery plan. Restore to a fresh volume and reconcile external work before retrying it ([SQLite backup documentation][sqlite-backup]).

## Repository and deployment state

- Rename is complete: `Skare69/velvarr`; `origin` points there. `main` is the standalone root. The former `next` branch no longer exists.
- `legacy/seerr-whisparr` preserves the Seerr integration **tree with squashed history**, not the original complete commit chain. Do not describe it as a verified deployment rollback or assert an old image is still available.
- Keep `upstream` pointing to `seerr-team/seerr` for reference, not routine merging. New implementation work uses ordinary feature branches from `main`; no more orphan resets or force-pushes are part of this plan.
- GitHub documents default-branch contribution-graph semantics and delayed statistics after rewrites. The earlier claim that all such statistics necessarily span branches was wrong; UI counters do not justify rewriting history ([GitHub contributor documentation][github-contributors]).
- Preserve local legacy configuration/database files without reading, importing, deleting, or committing their secrets. `.gitignore` was restored and checked in this review; protect the future Docker context before any image build.
- Use a separate Velvarr image/data volume. The first public application image is a future milestone, not something this repository currently provides. Before a deployment cutover, record and verify the old deployment image/config recovery path; never silently replace the family's Seerr container.

## Delivery milestones and acceptance gates

The revised dependency is **M1 alongside M0; then M2 -> M3 -> M4 -> M5 -> M6**, with **M7 (removal requests) after the release**. M0 gates provider-backed behavior and the full release, not a provider-independent runnable app. Every implementation checkpoint must leave something runnable and honestly labeled; none narrows the complete product scope.

### M0: real provider and delivery proofs, in parallel

Use the actual target build and authorized credentials to check account terms/tier, caching/household-use permission, coverage, rate limits, movie/scene relationships, cross-provider identities, pagination, and filters. Begin read-only. Do not rely on inaccessible internal hosted endpoints as an API contract or use TMDB through a proxy to bypass its application restrictions.

Before controlled additions, agree on exact test items and a safe target/configuration. Disabling immediate search alone is not proof that monitoring/RSS cannot acquire something. No production setting changes, monitoring, adds, downloads, or library mutations are authorized by this plan review.

| Required real case                                        | Observable result                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| TPDB-only feature                                         | Correct Movie lookup and supported TPDB add/stored identity; no invented TMDB ID           |
| TPDB feature with a TMDB cross-ID                         | Delivery still resolves/stores TPDB identity, not the higher-precedence TMDB path          |
| StashDB scene, including auxiliary cross-IDs when present | Correct Scene/UUID stored; competing movie-routing fields cannot redirect the add          |
| Linked, StashDB-only, and TPDB-only performers            | Correct source filmographies; missing cross-links are explained, not silently empty/merged |
| Movie/scene membership                                    | Source-backed links; a scene does not satisfy whole-movie availability                     |
| Two filtered pages and a final partial page               | Real provider serialization/continuation/count scope; unsupported filters unavailable      |
| Authoritative deletion versus timeout/outage              | Unresolvable reference versus unknown check; no fabricated empty success or lost history   |

**Stop condition:** if TPDB access/terms, needed catalog coverage, or Whisparr movie compatibility fails, record evidence and decide a compatible provider/build/configuration with the user. Do not call a scene-only result complete. A successful local-library checkpoint can remain useful while this is resolved.

#### Evidence ledger as of this review

- **Historical connectivity:** authenticated Whisparr `/api/v3/system/status` reported `3.4.0.1387`; its import lists provided no reusable provider credentials. Jellyfin reported `12.0.0`; the administrator integration key enumerated `/Users` with standard `Authorization: MediaBrowser ... Token="..."`, while the legacy `X-Emby-Token` attempt returned 401.
- **Not proven by that:** end-user login, disabled/revoked-user behavior, per-item library restrictions, plugin ID coverage, exact movie/scene matching, Whisparr add/acquisition, or actual playback. A detail-page link or status 200 is not playback proof.
- **Historical provider blocker:** unauthenticated TPDB `/movies` returned 401 and StashDB `queryScenes` returned `not authorized`. The restricted SSH account could not read Stash configuration; that restriction was respected.
- **Credential blockers cleared (2026-09-10):** `TPDB_API_TOKEN` and a READ-capable `STASHDB_API_KEY` were supplied and stored in the ignored `.env.local`. Whisparr URL/key were subsequently supplied and saved through the local lab's integration API into its encrypted configuration, not a tracked file. Keys shared in chat should be rotated and dependent integrations updated. Selected test items and explicit approval for the first controlled add remain outstanding.
- **Executed in this reassessment:** inspected current files and public contracts; confirmed the add-time identity precedence; reproduced absent Git ignore protection, restored it, and checked credential/runtime paths are ignored. No new private-instance probe or application implementation was performed.
- **Verified in the M1 implementation run (2026-09-10, local only):** the application, package manifest, Dockerfile, Compose file, and CI workflow exist; gates are green locally (TypeScript strict via `tsc --noEmit`, 58 node:test cases across storage/security, integration clients, and API routes, plus `next build`); and a browser-driven end-to-end run covered setup inspect, explicit library selection, owner bootstrap, a paged and searchable real library grid, authorized artwork responses (private/no-store), a detail view with credential-free Jellyfin link, a truthful playback-unavailable item, admin import (accounts imported disabled and grantless), Whisparr/TPDB/StashDB not-configured states, logout, restart persistence, and re-login, at 1366x768 and 390px. That run used a **throwaway local HTTP Jellyfin fixture, not the real homelab Jellyfin**; a fixture proves application wiring, not the installed server's behavior.
- **Verified against a real Jellyfin server (2026-09-10, local lab):** a portable Jellyfin `12.0.0` instance on this workstation (same version as the homelab) with two libraries (`movies`, `homevideos`), four generated h264/aac clips, an administrator API key, and a second non-administrator account restricted to one library and denied content deletion. Through the browser: setup inspect returned the verified owner account and its real libraries, explicit library selection and bootstrap completed, the paged grid listed all four real items, artwork proxied as `200 image/jpeg` with `private, no-store`, and the detail view produced a token-free `/web/index.html#!/details?id=…&serverId=…` link. Provider surfaces still report `Not configured`. This proves the Jellyfin contracts against a real server, not against the operator's installed instance or its libraries/permissions.
- **Provider access obtained and exercised read-only (2026-09-10):** TPDB `GET /user` returned 200 for account `Skare` (id 136293, empty `roles`/`permissions`); StashDB `{ me { roles } }` returned `["READ"]` for user `skare`. Both keys live in the ignored `.env.local` only. Proven from real responses: unified TPDB movie/scene record shape (`id` UUID, `_id`, `external_id`, `type`); source-backed membership — `Pirates 2: Stagnetti's Revenge` (Digital Playground, 2008-09-27) returns eight scene UUIDs, while sampled web scenes carry an empty `movies[]`, and that sample also contains two records titled `Pirates 2 - Scene 10`, so duplicate provider records must be deduplicated by ID and never by title; TPDB movie `links` carry IAFD/DATA18/AdultDVDEmpire but no TMDB link, whereas performer `links` do carry both `TMDB` and `StashDB`; StashDB pagination on a filtered query (studio `Tushy`, 682 scenes, `per_page` 5) returned 137 pages with disjoint ordered pages 1-2, a two-item final page, and an empty — not failing — past-the-end page; authoritative absence is distinguishable from an outage on both sides (TPDB unknown UUID → `404 {"message":"scene not found"}`, StashDB `findScene` → `data.findScene: null` at HTTP 200).
- **Cross-provider identity: performer level only.** StashDB performers expose `ThePornDB` and `TMDB` URLs (e.g. `Riley Reid`), and TPDB performers expose a `StashDB` performer UUID, so a performer can be linked in either direction. The sampled StashDB scenes carried only studio/IAFD URLs, so there is **no reliable scene-level cross-link**: keep TPDB and StashDB scenes as separate source-labeled records and never auto-merge them.
- **Whisparr live connectivity (2026-09-10, GET only):** the operator-supplied server returned 200 for `/api/v3/system/status`, `/api/v3/rootfolder`, and `/api/v3/qualityprofile`: Whisparr **3.5.0.1585**, branch `eros`, one accessible root `/data/xxx` (id 1), seven profiles (`Any`, `SD`, `HD-720p`, `HD-1080p`, `Ultra-HD`, `HD - 720p/1080p`, `VR`). `/api/v3/config/host` reports `whisparrMovieMetadataSource: "tmdb"`. That setting was read, never changed; no TMDB lookup or movie text search was issued.
- **TPDB movie lookup compatibility:** dedicated `/api/v3/movie/lookup/tpdb` returned 200 for `b6fd4f84-8961-4b8a-9194-e357628dea20` (Pirates 2: Stagnetti's Revenge) and `03764856-f46c-4230-9941-9e2187cb675f` (Pirates). Each returned `itemType: "movie"`, the requested UUID in `tpdbId`, `foreignId: "tpdbId:<uuid>"`, and `tmdbId: 0`, despite the global TMDB setting. This proves explicit TPDB resolution, not add-time precedence or stored identity. Neither response supplies the positive-TMDB-cross-ID fixture.
- **StashDB scene lookup compatibility:** `/api/v3/lookup/scene?term=stash:01a060a7-0644-7afd-8071-25752e1a45b7` returned 200 and one wrapper with `isExisting: false` and `id: 1`; its resource is nested under `movie`. `/api/v3/movie/lookup?term=stash:<same UUID>` separately returned the concrete START-602 resource with `itemType: "scene"`, matching `foreignId` and `stashId`, `tmdbId: 0`, and no `tpdbId`. The wrapper ID is not evidence that the scene was added.
- **Local integration smoke:** enabled the existing `VELVARR_ALLOW_HTTP=1` opt-in in ignored `.env.local` for the supplied private HTTP endpoint; restarted only Velvarr's local lab. Its authenticated integration PATCH returned 200. After re-authentication, `/api/admin/whisparr` returned 200 with the live version/root/profiles; the Settings screen displayed them and an empty, configured API-key field. Only local Velvarr configuration changed. No Whisparr POST/PUT/PATCH/DELETE, add, monitoring change, search command, download, or library mutation was issued. An accessible root is not an authorized mutation target.
- **Discovery smoke (2026-09-10):** 22 provider requests (TPDB GETs and read-only StashDB GraphQL, including schema inspection) plus two Whisparr GET lookups; nine in-memory assertions passed for identity, filters, pagination, credits, ordering, and resolution. One initial StashDB query returned 422 because `searchPerformers` returns `{ count, performers }`, not an array; correcting the selection returned 200. This was an executed experiment, not a new application feature or test suite. No acquisition, playback, or mutation was attempted.
- **Movie search and continuation:** TPDB `q=Babysitters` reported 406 matches; adding `year=2007` narrowed it to 10. With `orderBy=recently_released&per_page=4`, pages 1/2/3 contained 4/4/2 records, all distinct Movie UUIDs, all dated 2007, in nonincreasing release-date order across page boundaries. Adding `duration=7200` returned exactly two records, each 7,200 seconds.
- **Linked performer discovery:** selected Angela White through StashDB's explicit ThePornDB URL, linking StashDB `155f2559-d1f1-42b1-8cbe-9008542df5ce` to TPDB `a6fb1863-b433-4274-ae07-0e1327c854d1` (numeric `_id` 82889), not name equality. TPDB filmographies reported 671 movies and 1,846 scenes; StashDB's performer criterion reported 1,052 scenes. These are independent source counts, not a merged filmography or proof of completeness. TPDB `/scenes?performer_id=82889&year=2025` reported 142 scenes; all five sampled rows had 2025 dates and credits pointing to that canonical parent UUID.
- **StashDB filter semantics:** within that performer's filmography, including tag Dress returned 57 scenes, excluding it returned 995 (57 + 995 = 1,052). Dress AND Australian returned 54; Dress OR Australian returned 274. Each five-row sample satisfied its exact tag predicate and retained the selected performer. `date: { value: "2025-01-01", modifier: GREATER_THAN }` returned 85 scenes; the five-row `DURATION DESC` sample met the date predicate and was ordered by duration. This corrects the earlier chat claim that neither provider supports tag exclusion: StashDB does.
- **Fresh detail-to-resolution path:** TPDB filmography led to Zz Unscripted 6 (`abc2613d-a5b2-4e43-84c2-84eeb3541802`, Brazzers, 2026-07-14, 10,260 seconds); its detail credits link Angela White via `parent.id`, but `scenes[]` is empty, so membership cannot be invented. Whisparr resolved it as Movie with the same explicit TPDB UUID and `tmdbId: 0`. Newly discovered StashDB scene `01a08137-5eb3-7560-a888-b478577b6f80` (Brazzers Exxtra, 2026-09-08) resolved as Scene with matching `foreignId`/`stashId`. Neither lookup proves a stored acquisition or Jellyfin availability.
- **Still unproven for M0:** provider terms/tier, caching and household-use permission, quotas/rate limits (absent rate-limit headers establish no throughput guarantee), remaining coverage/cross-link cases, and every controlled delivery case (TPDB-only movie add, positive-TMDB-cross-ID precedence, StashDB scene add/stored identity). Whisparr credentials and read-only lookup compatibility are no longer blockers; exact mutation fixtures, root/profile, and explicit approval still are.
- **Still blocked on the operator:** the installed homelab Jellyfin's base URL, browser-reachable external URL, administrator API key, owner credentials, and permitted library selection for its live proof; an explicitly authorized safe Whisparr add target/configuration and selected real fixtures for M0 delivery. Local container verification remains unavailable because this workstation has no Docker, Podman, or WSL distro; the Linux/container build and smoke path have passed in CI.

### M1: first useful locally runnable checkpoint

No TPDB/StashDB keys required. With operator-provided Jellyfin/Whisparr configuration:

- Reproducible install/start and Docker/Compose build/start from a clean checkout; fresh persistent data and protected bootstrap.
- Explicit owner selection, Jellyfin login/import, account grants, logout, and immediate local revocation.
- Paged **real, user-accessible Jellyfin library items**, protected artwork, and a checked link to the browser-reachable Jellyfin web UI. Label the source as the local library; do not infer provider movie/scene identities.
- Administrator-only read-only Whisparr connectivity/configuration status, not a substitute Whisparr dashboard or downloader.
- Unconfigured provider features say **Not configured**; unavailable checks say **Unavailable**. No fake discovery fixtures, empty-success fallbacks, or acquisition calls.

**Status: implemented and locally verified (2026-09-10); the installed-server proof and local container smoke remain.** The acceptance commands exist: `bun install`, `bun run setup`, `bun run dev`/`build`/`start`, `bun run check`, `bun run test`, `bun run backup`, and `docker compose up --build`. Gates are green locally (TypeScript strict, 58 node:test cases, `next build`), and actual browser verification on desktop and 390px mobile plus a restart preserving setup/grants has been performed — first against a throwaway local HTTP Jellyfin fixture and then against a real local Jellyfin `12.0.0` server; the operator's installed instance is still unproven. See the [M0 evidence ledger](#evidence-ledger-as-of-this-review) above for the verified and blocked lists.

Live probing found and fixed one real routing bug: the catch-all API route trusted `context.params`, which Next strips of the static `/api` prefix, so every endpoint returned 404 on a real server while direct-handler tests passed; dispatch now derives segments from the request URL. Still outstanding: proof against the installed homelab Jellyfin (operator base URL, administrator API key, owner credentials, permitted library selection) and the compose build/container smoke path (no Docker, Podman, or WSL on this workstation; CI only). It is an early connected application, not the complete discovery release.

### M2: prove one complete movie and scene journey

Depends on M1 and the relevant M0 proofs. Implement provider-scoped catalog identities, selected real details/credits, request/approve/decline, shared acquisition, exact payload selection, Whisparr reconciliation, and exact Jellyfin matching for both kinds. Establish the three real card/detail treatments here, not after backend completion.

Gate: selected authorized movie **and** scene travel from provider detail through durable request/Whisparr acquisition to playback under the intended Jellyfin user. Existing library items are useful read-only fixtures but do not substitute for proving a controlled new add. Missing performer cross-links and acquisition uncertainty remain explicit.

### M3: expand into the full discovery product

Deliver Discover shelves, Movies/Scenes browse and detail pages, global Movies/Scenes/Performers/Studios search, performer Scenes/Movies tabs, studio/tag navigation, and supported filters/paging. Keep URL state and scroll restoration; label new release, metadata creation, popularity, and local-library scopes truthfully.

Gate: browse -> performer -> filter both supported catalogs -> request -> return without losing context, using real provider data. Both catalogs and every specified loading/empty/error/accessibility state are covered. The app is not complete at search-only, movie-only, or scene-only breadth.

### M4: harden availability, privacy, and request recovery

Finish general library/path matching, per-item visibility/playback checks, scan lag, stale observations, rescans/missing files, shared-request cancellation, and restart recovery. Use the same real movie/scene journeys as M2, not unrelated happy-path samples.

| Hazard                                                                 | Required behavior                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Ungranted user or concurrent bootstrap claim                           | No protected data or unauthorized owner grant                                                                  |
| Another admitted user warms a restricted image/detail cache            | Anonymous/library-denied/revoked users still cannot fetch those bytes                                          |
| Jellyfin outage, invalid user token, disabled account                  | Explicit distinct denial/unavailable behavior; no admin fallback or state deletion                             |
| Remote client denied by Jellyfin policy                                | Velvarr's LAN connection cannot bypass the restriction                                                         |
| Foreign-origin grant/approve/settings request                          | Rejected before any external mutation                                                                          |
| Two users approve the same target                                      | One shared acquisition; private request history stays private                                                  |
| Process dies after Whisparr accepts but before local acknowledgement   | Restart/restore reconciles exact identity without blindly posting again                                        |
| Logout, grant revocation, and cancellation                             | Logout preserves durable approval; revocation gates unsent intent; one cancellation cannot delete shared media |
| Monitoring/no release; imported/unscanned; scanned but playback denied | Three truthful outcomes, not Available                                                                         |
| File removed or paths/editions changed                                 | Revalidate exact mapping; no title-only or parent/child availability inference                                 |

### M5: production packaging and operational proof

Keep narrow regression checks for demonstrated identity/authorization/recovery hazards, using the standard test runner rather than an extra testing platform. Verify migration failure/rollback, consistent backup/restore to a fresh volume, runtime-only secrets, bounded polling/cache behavior, graceful restart, and readable errors without sensitive logs.

Set up Velvarr-specific CI and publish its own container image only after the local production build works. Preserve MIT notices for reviewed reuse; do not copy GPL implementation by accident. Use neutral public screenshots. Add the optional private Discord notifier after request delivery is reliable.

### M6: complete release and deliberate cutover

Gate: all requested product surfaces work together with both acquisition/playback journeys, tested user restrictions, known provider/filter limits, and a verified recovery procedure. No mock-backed success or unresolved movie-support assumption is hidden in the release.

Deploy beside the existing Seerr/Whisparr/Jellyfin stack using a separate volume/image/port. Changing the adult entry point is deliberate; neither the family Seerr database nor the old deployment is silently replaced. Product name/domain purchase is not a prerequisite for local testing.

### M7 (post-release): removal requests

Requested 2026-09-10, scheduled after the M6 release: let a user ask for an entry to be **removed**, which Seerr has no equivalent of. This is a separate intent kind, not an inverted acquisition, and it is the only destructive path in the product.

The escalation ladder below is deliberate. A requester asks; an **approver chooses the level**, and nothing above the first level happens implicitly.

| Level | External call | Effect | Reversible |
| ----- | ------------- | ------ | ---------- |
| Unmonitor | Whisparr `PUT /api/v3/movie/{id}` with `monitored: false` | Stops future grabs, keeps item and files | Yes |
| Drop from Whisparr | `DELETE /api/v3/movie/{id}` (defaults `deleteFiles=false`) | Removes the tracked item, leaves files on disk | Re-addable |
| Exclude | same call with `addImportExclusion=true` | Also blocks list-driven re-adds | Yes, by clearing the exclusion |
| Delete files | same call with `deleteFiles=true` | Deletes the media files | **No** |
| Delete the Jellyfin item | `DELETE /Items/{itemId}` | Removes the library entry and its file location | **No** |

Source-inspected: Whisparr's `DeleteMovie(int id, bool deleteFiles = false, bool addImportExclusion = false)` ([movie controller][whisparr-delete]) — one endpoint covers both kinds because Eros stores scenes and movies in the same movie entity. Jellyfin's `DeleteItem` ([library controller][jellyfin-delete]) is `[Authorize]` for any authenticated identity, enforces `item.CanDelete(user)` from the per-user `EnableContentDeletion` / `EnableContentDeletionFromFolders` policy, and always passes `DeleteFileLocation = true`: there is no metadata-only delete.

**The API-key hazard decides the design.** In that same handler an API-key identity resolves to a null user and skips the `CanDelete` check entirely, so Velvarr's integration administrator key could delete media the requesting user is forbidden to touch. Therefore Jellyfin deletion runs under the **requester's own user token** so Jellyfin enforces its own policy; the administrator key is never used to delete. A user without `EnableContentDeletion` gets an explicit denial, not an admin-key fallback.

Design rules:

- Removal is off unless an operator opts in (an explicit environment flag) **and** the approver holds a removal grant. Absent either, the action is visibly unavailable, not hidden.
- Reuse the three-fact model: a per-user removal request decision, one shared removal execution per resolved identity and server, and the resulting availability change. A denied removal does not erase another user's acquisition request.
- The requester supplies a reason and never chooses `deleteFiles`. Confirmation names the exact library, item identity, and file count/size that will disappear, and states that file deletion has no undo.
- Persist the attempt before the call, exactly as acquisition does. A timeout leaves the execution **uncertain**: re-resolve by identity and compare the item's added timestamp before any retry, so a retry cannot delete a freshly re-added item. Whisparr or Jellyfin returning 404 means already gone, which is success, not failure.
- An approved removal cancels pending acquisitions for the same identity. A later re-request is a new request, and an existing import exclusion must be surfaced as "an administrator excluded this" rather than a silent add failure.
- After removal, availability returns to not available once Jellyfin rescans; never invent `Missing` or `Failed`. File deletion invalidates the playable mapping and the watch link immediately.
- Keep an audit row per execution: requester, approver, chosen level, external identities, timestamps, and outcome. Catalog identity and audit history survive; only external media is removed.

Acceptance gate, on authorized real fixtures only: request → approve at `Drop from Whisparr` → Whisparr item gone with the file intact; then a separately approved `Delete files` removal on a throwaway file → item gone, file gone, Jellyfin entry gone after rescan, watch link withdrawn; a user without Jellyfin deletion permission is refused with the administrator key unused; an excluded title explains itself on re-request; an injected timeout leaves the execution uncertain and reconciles without a second delete.

Prerequisites: operator opt-in flag, a per-account removal grant, one Jellyfin test account with `EnableContentDeletion` for one test library, and an explicitly nominated throwaway item. Not started; no removal code exists.

## Explicit non-goals

No internal video player/transcoder, direct indexer/download-client orchestration, local Stash media-manager requirement, invented TV/season mappings, wholesale provider mirroring, automated fuzzy identity merges, recommendation/ML system, or Seerr-wide feature-parity checklist. Jellyfin, Whisparr, and metadata providers continue doing their existing jobs. Removal (M7) stays a per-entry, approver-chosen action: no bulk library cleanup tool, no disk-space dashboard, no automatic retention or expiry policy, and no Whisparr blocklist management.

No local Velvarr passwords/accounts: authentication, library permission and playback authority stay with the media server, because every authenticated read and the M7 removal run under the requesting user's own upstream token. Supporting a non-Jellyfin deployment means a second media-server provider behind the same four contracts, not a parallel identity system. See [ADR 0001](../adr/0001-no-local-accounts.md).

## Decisions and remaining prerequisites

- **Settled:** Velvarr; standalone product; both Movies and Scenes with performer-led discovery; Whisparr acquisition; Jellyfin watching; explicit account grants; one initial instance of each integration.
- **Recommended revision:** deliver M1 alongside M0, then the two complete vertical journeys before broad catalog expansion. Do not delay all server work for provider credentials, and do not build an empty mock server as a substitute.
- **Concrete inputs still required:** provider credentials/usage permission; selected Jellyfin owner, permitted users/libraries and restricted test account; selected real movie/scene records; verified path/provider-ID data; authorization before any mutation probe.
- **Default scope:** private homelab deployment, no TMDB integration without permission, no automatic performer monitoring, no public registration. Technical defaults can proceed without another naming/framework brainstorming phase.

Schema-level evidence supports starting this sequence. Coverage, crosswalk accuracy, installed-server behavior, and actual playable matching remain measured gates, not promises.

## Sources and evidence scope

- Original Seerr: https://github.com/seerr-team/seerr/tree/68c5bc8c7d8560d295387adeeee73982ea518e8f
- Seerr UI preview: https://github.com/seerr-team/seerr/blob/68c5bc8c7d8560d295387adeeee73982ea518e8f/public/preview.jpg
- Omnibus: https://github.com/hankscafe/omnibus/tree/6c63779c7b7a8dc3f7400dc1ae5cbdbce7b8f8ec
- Omnibus visual references: `docs/images/discover_NEW.png`, `library_page.png`, `one_click_request.png` at that revision.
- Whisparr source baseline: https://github.com/Whisparr/Whisparr/tree/cc3fb2abcf60f7c0048eb0294015d291b82bde08
- GitHub rename semantics: https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- TPDB API docs: https://api.theporndb.net/docs ; [OpenAPI specification v3.24.747][tpdb-spec].
- StashDB implementation: https://github.com/stashapp/stash-box/tree/b4b8aef21372e3843240e3260c5123443239f2fb ; [scene filters][stash-scenes] and [query schema][stash-schema].
- [TMDB API Terms of Use, section 1.C][tmdb-terms], page states updated October 20, 2023.
- Jellyfin [user documentation][jellyfin-users]; source baseline https://github.com/jellyfin/jellyfin/tree/cf09de60e4e5844ad181d7ef9019151c54969d44 ; `Jellyfin.Api/Controllers/UserController.cs`, `ItemsController.cs`, `MediaInfoController.cs`, and `MediaBrowser.Model/Users/UserPolicy.cs`. This pins inspected source, not the user's installed release.
- Whisparr and Jellyfin deletion contracts for M7: [movie delete][whisparr-delete] and [library item delete][jellyfin-delete], plus `EnableContentDeletion` / `EnableContentDeletionFromFolders` in `MediaBrowser.Model/Users/UserPolicy.cs` at the same pinned revisions.

This plan distinguishes public source/specification evidence, historical connectivity checks, proposed design, and future installation-specific acceptance. It does not claim that a live authenticated provider discovery flow, end-user authorization suite, successful Whisparr import, or actual playback was exercised during this reassessment.

[tpdb-spec]: https://api.theporndb.net/specs?openapi.json
[stash-schema]: https://github.com/stashapp/stash-box/blob/b4b8aef21372e3843240e3260c5123443239f2fb/graphql/schema/schema.graphql
[stash-scenes]: https://github.com/stashapp/stash-box/blob/b4b8aef21372e3843240e3260c5123443239f2fb/graphql/schema/types/scene.graphql
[tmdb-terms]: https://www.themoviedb.org/api-terms-of-use
[whisparr-search]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Search/SearchController.cs
[whisparr-delete]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Movies/MovieController.cs
[jellyfin-delete]: https://github.com/jellyfin/jellyfin/blob/cf09de60e4e5844ad181d7ef9019151c54969d44/Jellyfin.Api/Controllers/LibraryController.cs
[whisparr-lookup]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Movies/MovieLookupController.cs
[whisparr-add]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/NzbDrone.Core/Movies/AddMovieService.cs
[whisparr-skyhook]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/NzbDrone.Core/MetadataSource/SkyHook/SkyHookProxy.cs
[whisparr-performer]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Performers/PerformerResource.cs
[jellyfin-users]: https://jellyfin.org/docs/general/server/users/
[jellyfin-authorization]: https://github.com/jellyfin/jellyfin/blob/cf09de60e4e5844ad181d7ef9019151c54969d44/Jellyfin.Api/Auth/DefaultAuthorizationPolicy/DefaultAuthorizationHandler.cs
[next-image]: https://nextjs.org/docs/app/api-reference/components/image
[node-sqlite]: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
[next-startup]: https://nextjs.org/docs/app/guides/instrumentation
[sqlite-backup]: https://www.sqlite.org/backup.html
[github-contributors]: https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors
