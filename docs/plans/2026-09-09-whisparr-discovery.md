# Implementation plan: standalone discovery and requests for Whisparr

Planned: 2026-09-09. Implementation approved: 2026-09-10, on a new branch. Status: `next` created; M0 awaiting provider credentials.

Working title: **Whisparr Discovery**. Final product/repository name remains open.
Reuse `Skare69/seerr-whisparr` and its history. Implementation is isolated on `next`; the existing integration is preserved on `legacy/seerr-whisparr` and `main`. Final naming/cutover follows the release gates. No deployment, repository rename, or application rewrite has occurred.

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

Do not select a provider merely because it has a search endpoint. Before committing provider defaults, prove movie/scene discovery, performer traversal, pagination/filtering, credentials/usage terms, and the exact Whisparr import identity. Provider-specific findings and limitations are recorded below.

### Verified provider capabilities and limits

| Provider | Source-inspected capability | Product decision / outstanding proof |
|---|---|---|
| **TPDB** | `/movies`, `/scenes`, performer-to-movies/scenes endpoints; paged search, tags, studios, release dates, duration input; a movie's `scenes[]` and a scene's `movies[]` | Primary movie source and movie/scene relationships. Bearer token required. Account-tier access, coverage, rate limits, exact filter serialization, and Whisparr import compatibility need credentialed checks. |
| **StashDB** | `queryScenes` with performer/studio/tag criteria and paging; performer-scoped scene queries; published date/duration/popularity/trending sort keys | Primary scene graph. READ-capable API key required for direct discovery. Hosted account policy, limits, and meaningful ranking data must be checked. |
| **TMDB** | Technically provides movies, credits, genres, and adult-inclusive queries | No default integration. [API terms, section 1.C][tmdb-terms] restrict applications involving pornographic content. Treat written provider permission covering this application as a prerequisite, including any proposed "mainstream-only enrichment" within it. |

Evidence: [TPDB OpenAPI v3.24.747][tpdb-spec] and [StashDB's stash-box schema][stash-schema], inspected during planning. An API declaration proves an operation exists, not that the intended account can use it or that its catalog has the desired coverage.

Two corrections to the earlier discussion:

- **StashDB is not local Stash.** The inspected stash-box schema exposes no first-class Movie/Group catalog. Local Stash's grouping features do not establish a hosted StashDB movie API. TPDB provides the verified movie/scene membership needed here.
- **`include_adult` is not usage permission.** Do not work around TMDB's application restrictions through Whisparr's metadata proxy. Existing IDs may remain identity references; active TMDB content support is a separate permission decision. Earlier Seerr-specific TMDB advice is not a valid provider strategy for this new product.

### Whisparr's role: resolution and delivery, not the discovery database

Source baseline: Whisparr **Eros**, commit `cc3fb2ab`; confirm the deployed build during M0. The older Sonarr-shaped V2 is not the target.

- External text/ID lookups exist for scenes, movies, performers, and studios. However, there is no equivalent of a paged, globally filterable Seerr discovery catalog. `/movie/listByPerformerForeignId` lists already-known local items, not a performer's worldwide filmography.
- Direct provider APIs therefore supply browsing and filters. Whisparr's `/tag` contains local management tags, not the metadata tag taxonomy. Its internal hosted metadata endpoints are not a supported public discovery contract for this app.
- Resolve a TPDB feature with `GET /api/v3/movie/lookup/tpdb?tpdbId=...`; resolve a StashDB scene through `GET /api/v3/lookup/scene?term=stash:<uuid>`. Preserve the returned resource's identity and verify the expected item kind before `POST /api/v3/movie`, which accepts both movies and scenes.
- Whisparr's mapper emits a numeric-string `foreignId` for TMDB movies, `tpdbId:<id>` for TPDB movies, and a StashDB UUID for scenes. These are external delivery identifiers, not application primary keys. Preserve `tpdbId` and other relevant resource fields too; never guess a prefix from a title or submit just a TMDB ID.
- Text movie search follows Whisparr's configured movie metadata source. Dedicated ID lookup and add-time metadata resolution have their own paths; a successful lookup alone does not establish a valid add or prove that changing the global source fixes it. Test the exact resource against the intended TPDB configuration without silently changing the existing server.
- Reading a performer page must not add/monitor that performer or run refresh commands that can bulk-add their catalog. Requesting a selected item is the only acquisition action in this browsing flow.

Evidence: [lookup controllers][whisparr-search], [movie ID lookup][whisparr-lookup], [add-time metadata resolution][whisparr-add], [foreign-ID mapping][whisparr-skyhook], and [performer external-ID fields][whisparr-performer]. Returned cross-IDs can bridge the graph, but their population and accuracy remain M0 fixtures, not an assumed universal crosswalk.

### Proposed domain language

- **Movie:** a feature/release that can be requested as a whole.
- **Scene:** an individually cataloged and requestable scene; not a TV episode by implication.
- **Performer:** a credited person, with names and provider-scoped identities.
- **Studio:** a production label/site, with a parent relationship only where supplied.
- **Tag:** a provider's descriptive topic. A TMDB genre and a StashDB tag are not automatically the same taxonomy.
- **Request:** a user's intent to acquire a movie or scene.
- **Whisparr item:** the exact external item submitted/monitored by a particular server.
- **Playable item:** a matched Jellyfin item that the current user is allowed to access.

### Storage rules

Use an application-owned ID for each catalog entity. A shared `MediaItem` with kind `movie` or `scene` serves one request flow; keep separate Performer, Studio, credits, tags, and verified scene-in-movie relationships. The old proposal for parallel SceneRequest tables was containment within Seerr, not the best design for a new app.

- Preserve external references as **provider + entity kind + external ID**, not one universal ID string. Enforce uniqueness in the database.
- TMDB IDs, TPDB IDs, StashDB UUIDs, Whisparr foreign IDs, and Jellyfin item IDs remain distinct values.
- Keep provider provenance and explicit/manual identity links. Do not run fuzzy-title matching as an automatic merge or download decision.
- Preserve the supported Whisparr lookup resource/identity through submission, including `foreignId` and media kind. Do not build another mostly-Radarr payload and hope.
- Keep Whisparr mappings and Jellyfin mappings separate from catalog identity.
- Mark an otherwise discoverable item as not currently requestable if no supported Whisparr resolution exists. A provider outage is an unavailable check, not proof that a title does not exist.
- Cache details/relationships as they are used; do not require downloading entire catalogs before the application can work.

## Filters and search semantics

Desired controls, exposed only where the selected provider supports them:

| Control | Expected surface | Rule |
|---|---|---|
| Performer(s) | Movies and scenes | Use provider IDs/credits; never rely on display-name equality |
| Studio/site | Movies and scenes | Parent-studio inclusion must be explicit |
| Genre | Movies | Preserve the source taxonomy |
| Include/exclude tags | Primarily scenes; movies if supported | Define ANY/ALL/exclude semantics instead of translating loosely |
| Release date/year | Both | Distinguish release date from provider-record creation time |
| Duration | Both where supplied | Missing values remain unknown |
| Available / requested / missing | Both | Application/Jellyfin state, not provider metadata |
| Sort | Both | Only real provider sort keys or complete local result sets |

Concrete limits from the inspected schemas:

- StashDB supports tag ANY/ALL/exclusion criteria, but has no scene duration-range criterion; it can sort by duration.
- TPDB exposes tag ANY/ALL inclusion, not a documented exclusion parameter on `/movies` or `/scenes`. It exposes a duration input; a duration-operation parameter exists in shared components but is not referenced by the inspected `/movies` operation. Do not promise a min/max slider until actual semantics are proven.
- Neither shared genres nor one cross-provider popularity score exists. Use provider-native tags/categories where genres are absent. Unsupported controls remain visibly unavailable; do not invent mappings.

A multi-provider search must not promise globally ranked, globally filtered results if it only fetched a page from each source. Start with provider-backed shelves and explicit source sections/tabs, combining only verified duplicates. Available/requested views can query the complete locally tracked collection. Applying local-state filters to remote discovery requires bounded page scanning with an explicit continuation and scope; an empty scanned page is not proof of an empty catalog. Unsupported filters are unavailable with an explanation, never silently ignored.

Tags/genres can drive browse pages and related-content rails. Personal recommendations and follow-a-performer automation are later additions, not prerequisites for actor-driven discovery.

## Jellyfin: users, access, availability, playback

### Import and login

- Setup connects a configured Jellyfin server and imports user identities by stable Jellyfin user ID, not username/email.
- Importing a user does **not** grant access to this app. Administrator selects allowed accounts and grants requester/moderator/admin rights explicitly. Do not automatically admit every household account or mirror Jellyfin administrators into app administrators.
- Authenticate against Jellyfin; never persist a user's password. Use server-side sessions and keep integration secrets/tokens out of browser storage and logs.
- Check application grants on every protected request so app revocation takes effect immediately. Revalidate the Jellyfin identity/token during session validation and before privileged actions; removed/disabled accounts lose access, and an unavailable authorization check cannot authorize a new request.
- Restrict privileged library enumeration to configured libraries. Before exposing an item's availability or watch link, check access through the current user's Jellyfin context, including item-level parental/tag restrictions and playback policy, not only folder membership. Never turn an administrator's visibility into a user's visibility.
- Authenticate catalog/image routes, sanitize provider descriptions, validate upstream responses and image URLs, and scope caches by authorization where results differ by user. Provider/API keys stay server-side; arbitrary user-supplied URLs must not become an open image proxy.

### Availability and watching

- Whisparr downloaded/imported state does not imply that Jellyfin has scanned the file or that the requesting user can play it.
- Match by exact external identifiers when plugins supply them. Otherwise correlate Whisparr's exact file path with Jellyfin items through explicit, configurable container path mappings. Title-only matches go to administrator review, never automatic Available.
- Provider-ID/plugin coverage and path mapping on the actual installation are release gates, especially for scenes.
- Show Open in Jellyfin only for a matched accessible item with playback permitted; exclude virtual/placeholders. Use Jellyfin's web detail link, such as `/web/index.html#!/details?id=<itemId>&serverId=<serverId>`, with no credentials embedded. Jellyfin owns login, playback, transcoding, clients, and watched state.
- Handle imported-but-not-yet-scanned items, missing files, rescans, and multiple files/editions without inventing success.

Source-inspected starting points are `GET /Users` for administrator-driven import, `POST /Users/AuthenticateByName` for login, and library item enumeration with `ProviderIds`, `Path`, and media-source fields. Current source does not provide a universal provider-ID equality query that solves scene matching for us. Validate these against the installed Jellyfin version; retain exact mappings and recheck them after rescans. See [Jellyfin user policy documentation][jellyfin-users] and the pinned controller references below.

## Request lifecycle and reliability

Track **request decision**, **Whisparr acquisition**, and **Jellyfin availability** separately. A useful display progression is:

Requested -> Awaiting approval -> Approved -> Submitted/monitoring -> Downloading -> Downloaded, awaiting Jellyfin -> Available in Jellyfin.

Declined/cancelled requests and acquisition failures are explicit outcomes. A title being monitored with no release found is not a failed download.

Submission rechecks authorization, identity, Whisparr configuration, and existing monitored/library items. Database uniqueness and transactional claims prevent concurrent approvals creating duplicate work. If a submission times out after Whisparr might have accepted it, reconcile by its exact identity before retrying. Do not interpret every HTTP 400 as an already-existing item.

Cancelling a request removes that user's acquisition intent; it must not delete a shared Whisparr/Jellyfin item or another requester's files. Any destructive library operation remains in Whisparr/Jellyfin, outside this app's request cancellation.

Synchronize state with bounded background polling using Whisparr's APIs and Jellyfin scans. Start with one application process and persistent database state; no Redis/message broker is needed merely to implement this workflow. Existing external items can be adopted instead of re-requested. New app requests attach to existing acquisitions without claiming ownership of another user's private request history.

Notifications are private by default; request titles/artwork must not accidentally go to a family-wide webhook. A single optional configured notifier can follow the working request loop; a notification-provider matrix is not core scope.

## Implementation approach

Use the familiar, already-present TypeScript/React/Next.js, Tailwind, and accessible Headless UI foundation. SQLite plus the existing TypeORM toolchain is adequate for this deployment. Review and retain useful generic UI/Jellyfin plumbing under MIT; create a fresh domain model and focused routes. Do not switch to Prisma/Redis/Rust merely because Omnibus uses them.

Keep a small number of deep modules: catalog/provider reads and identities; requests/Whisparr delivery; Jellyfin access/availability; user-facing UI. Catalog reads return normalized entities, source/page scope, supported filters, and explicit partial errors. Requests consume resolved media IDs, not provider payloads supplied by the browser. Jellyfin returns per-user access and exact item mappings, not an unqualified global Available flag. The two genuinely different metadata sources justify concrete adapters and a small normalized interface, not a configurable universal plugin platform.

Initial deployment: one Whisparr Eros instance and one Jellyfin instance, one application container, one separate persistent data volume. Keep actual server IDs on delivery/library mappings. Broader multi-server routing is outside the current brief, not an excuse to hardcode library paths, credentials, or timeouts.

## Repository reuse and rename

1. Preserve current working integration at a legacy branch/tag. Observed planning base: `e9583980`. Keep its commit history and deployment image/digest recoverable.
2. Develop the independent app on a `next` branch in this same repository. Fresh application schema and fresh data directory; no mutation of the current Seerr database or shared config volume.
3. Choose the final product name, then rename the GitHub repository with `gh repo rename` and update `origin`. GitHub redirects repository/git URLs, but workflows, badges, package metadata, image publishing, and deployment references still need an explicit audit. Replace inherited upstream release automation before publishing standalone images.
4. Keep `upstream` pointing at `seerr-team/seerr` as a reference, as previously requested. It is no longer a routine merge source for a separate product. Cherry-pick only reviewed, relevant fixes.
5. Publish the independent app under its own image identity. Do not silently replace the image deployed as the family's current Seerr or reuse its database volume. Preserve a rollback image/config backup before cutover.
6. Promote the standalone branch to the default only after release gates pass. Preserve the legacy branch/tag rather than maintaining both applications in the new runtime.

Use a discreet, factual repository description. No public rename or rebranding is performed until the proposed direction/name is discussed.

## Delivery milestones and acceptance gates

### M0: prove the provider and playback contracts

Use the actual target Whisparr build and administrator-provided provider/Jellyfin credentials. Prove a TPDB feature without requiring TMDB, a StashDB scene, and a performer linked across both providers with movie/scene traversal. Exercise usable paging/filters, TPDB movie/scene membership, and a Jellyfin-matched playable item. Include missing cross-IDs, duplicate names/aliases, absent artwork, provider outage, and conflicting records.

Confirm TPDB account-tier access/terms and StashDB hosted access/limits. Test the real TPDB feature and StashDB scene import resources; a generic connection test is insufficient. TMDB adds no prerequisite to this release: investigate it only if permission for this application is obtained. If TPDB movie coverage or import compatibility fails, return with that evidence and alternatives rather than silently shipping a scene-only product.

Gate: record which providers/relationships are supported, which require explicit links, and which identities can be imported. A failed mapping changes the design here, not after the whole UI has shipped. Mutating import checks use explicitly selected test items/config with search disabled where possible; discovery traffic alone must not start downloads.

#### M0 execution record

- Branches created: `next` for implementation; `legacy/seerr-whisparr` preserves the existing integration. `main`, repository identity, and `upstream` remain unchanged.
- Read-only checks on 2026-09-10: the target Whisparr responds to authenticated `/api/v3/system/status` and reports version `3.4.0.1387`. Its import-list configuration contains no lists from which existing provider credentials could be reused.
- Target Jellyfin reports version `12.0.0`. Its existing integration key successfully authenticates `/Users` with standard `Authorization: MediaBrowser ... Token="..."`. The legacy `X-Emby-Token` header returned 401 with that same key; use the standard header during implementation.
- Direct TPDB `/movies?per_page=1` returns HTTP 401 without a token; a StashDB `queryScenes` GraphQL query returns `not authorized`. No TPDB/StashDB credential is configured in this checkout's environment or local configuration.
- The restricted SSH account cannot read the existing Stash configuration. That restriction was respected; no permissions or authentication settings were changed.
- **Blocker:** provide a TPDB API token and a READ-capable StashDB API key. The already-ignored `.env.local` is the proposed local handoff: `TPDB_API_TOKEN` and `STASHDB_API_KEY`. Alternatively, identify an authorized existing credential file. Do not commit credentials or paste them into the plan.
- Movie/scene discovery coverage, provider links, filter behavior, and controlled imports are still unproven. No add, monitor, download, or library mutation was performed. M1-M6 remain dependent on the M0 evidence gate; they are not completed or replaced with scaffolding.

### M1: preserve the repo and establish the independent app

Legacy checkpoint, `next` branch, fresh storage, explicit account grants, Jellyfin login/import, and application shell with new navigation/branding.

Gate: original Seerr remains untouched and operational; an ungranted imported user cannot access catalog APIs or images; an allowed user can log in. Initial real-data movie/scene cards establish the visual baseline early.

### M2: implement provider-aligned catalog identities

Concrete provider reads, provenance, movie/scene/performer/studio/tag relationships, bounded caching, Whisparr resolution, exact external mappings, and administrator handling for unresolved links.

Gate: movie and scene records can exist without TMDB IDs; duplicate names do not merge; mapped identities round-trip to the right external item; source failures never manufacture empty success.

### M3: deliver discovery, details, performer traversal, and filters

Discover shelves, Movies/Scenes browsing, global search, performer pages with both media tabs, studio/tag routes, details, mobile interaction, and provider-aware filtering/pagination.

Gate: from a performer, browse and filter both supported movies and scenes, open details, and return with filters/scroll intact. New releases, library additions, and rankings are accurately labeled. All specified loading/empty/error/accessibility states receive visual verification.

### M4: implement request and approval end to end

Single movie/scene request flow, permissions, approval/decline, Whisparr lookup/add with exact identity, duplicate prevention, retry/reconciliation, queue progress, and useful errors.

Gate: both a movie and a scene travel from discovery to Whisparr; concurrent requests and ambiguous timeouts do not create duplicate imports; restart preserves request state.

### M5: finish Jellyfin availability and watch handoff

Library mapping, path translation where necessary, per-user visibility, post-import scan reconciliation, missing-file handling, and Open in Jellyfin.

Gate: the same requested movie and scene become playable in Jellyfin for an authorized user; users denied that library get no playable link; a downloaded-but-unscanned item remains distinct from Available.

### M6: release and cutover

Run the end-to-end acceptance journeys and keep small regression checks for actual authorization, identity, filter, and submission hazards. Verify backup/restore, production container startup, configuration documentation, licensing/attribution, neutral public screenshots, and new image publishing. Complete the GitHub rename/link audit and deploy beside the original Seerr before making it the adult catalog's entry point.

Gate: all requested product surfaces work together; legacy app rollback is documented; no outstanding metadata assumptions are hidden behind mocked success. The initial release is not complete at a search-only or movie-only milestone.

## Explicit non-goals

No internal video player/transcoder, direct indexer/download-client orchestration, local Stash media-manager requirement, invented TV/season mappings, wholesale provider mirroring, automated fuzzy identity merges, recommendation/ML system, or Seerr-wide feature-parity checklist. Jellyfin, Whisparr, and metadata providers continue doing their existing jobs.

## Discussion decisions

1. Final neutral product/repo name before the GitHub rename.
2. Accept TPDB + StashDB as the proposed baseline, subject to M0 account/coverage/import proof. TMDB remains excluded unless permission covering this application is obtained; it is not the fallback for an unsuccessful TPDB experiment.
3. Which Jellyfin users and libraries to allow. Default: imported users are not admitted until selected; no family-wide auto-access.

The architectural recommendation is firm enough to discuss now. Credential-gated coverage, provider crosswalks, and playable scene matching remain experiments, not promises.

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

This plan separates source-inspected capabilities from proposed design and installation-specific acceptance gates. It does not claim a live authenticated TPDB/StashDB/Jellyfin integration or a successful Whisparr import was exercised during planning.

[tpdb-spec]: https://api.theporndb.net/specs?openapi.json
[stash-schema]: https://github.com/stashapp/stash-box/blob/b4b8aef21372e3843240e3260c5123443239f2fb/graphql/schema/schema.graphql
[stash-scenes]: https://github.com/stashapp/stash-box/blob/b4b8aef21372e3843240e3260c5123443239f2fb/graphql/schema/types/scene.graphql
[tmdb-terms]: https://www.themoviedb.org/api-terms-of-use
[whisparr-search]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Search/SearchController.cs
[whisparr-lookup]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Movies/MovieLookupController.cs
[whisparr-add]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/NzbDrone.Core/Movies/AddMovieService.cs
[whisparr-skyhook]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/NzbDrone.Core/MetadataSource/SkyHook/SkyHookProxy.cs
[whisparr-performer]: https://github.com/Whisparr/Whisparr/blob/cc3fb2abcf60f7c0048eb0294015d291b82bde08/src/Whisparr.Api.V3/Performers/PerformerResource.cs
[jellyfin-users]: https://jellyfin.org/docs/general/server/users/
