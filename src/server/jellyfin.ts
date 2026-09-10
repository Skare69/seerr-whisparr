// Jellyfin integration. Every user-visible query (libraries, items, images,
// playback info) runs under the caller's own Jellyfin user token; the
// integration API key is used only for the administrator user inventory.
// No legacy configuration reads, no administrator fallback for user data,
// and upstream failures are always errors — never empty successes.

import {
  AppError,
  requestJson,
  requestBytes,
  validateBaseUrl,
} from "./http.ts";
import type {
  Account,
  CatalogProvider,
  ExternalUser,
  IntegrationConfig,
  Library,
  LibraryItem,
  LibraryPage,
  MediaKind,
  PlaybackAccess,
  WhisparrPathMapping,
} from "../lib/contracts.ts";

// --- upstream DTO shapes (only the fields we consume) ---

interface UserPolicy {
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
  EnableRemoteAccess?: boolean;
  EnableMediaPlayback?: boolean;
}

interface UserDto {
  Id?: string;
  Name?: string;
  Policy?: UserPolicy;
}

interface MediaSource {
  Id?: string;
  Path?: string;
  Size?: number;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
}

interface BaseItemDto {
  Id?: string;
  Name?: string;
  Type?: string;
  CollectionType?: string | null;
  ProductionYear?: number;
  Overview?: string;
  RunTimeTicks?: number;
  LocationType?: string;
  Path?: string;
  ProviderIds?: Record<string, string>;
  SortName?: string;
  DateCreated?: string;
  ImageTags?: Record<string, string>;
  MediaSources?: MediaSource[];
}

interface QueryResult {
  Items?: BaseItemDto[];
  TotalRecordCount?: number;
}

interface PlaybackInfoResponse {
  MediaSources?: MediaSource[];
}

// Library view collection types worth exposing: movie, video, and mixed
// folders. TV, music, books, and playlists are out of product scope for M1.
const LIBRARY_COLLECTION_TYPES: Record<string, true> = {
  movies: true,
  musicvideos: true,
  homevideos: true,
  boxsets: true,
};

// Raster-only MIME allowlist for artwork; SVG and anything else is refused.
const IMAGE_MIME_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
};

// Cross-library merge chunk size; bounds per-library paging work.
const MERGE_CHUNK = 60;

const IMAGE_BYTE_LIMIT = 8 * 1024 * 1024;

// Canonicalizes Jellyfin GUIDs: 32- or 36-hex input accepted, lowercase
// compact 32-hex output. Rejects anything else before it can reach a path.
export function normalizeItemId(value: unknown): string {
  const compact = String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new AppError(400, "invalid_id", "Invalid item id.");
  }
  return compact;
}

function requireJellyfinConfig(config: IntegrationConfig): void {
  const jellyfin = config?.jellyfin;
  if (!jellyfin?.url || !jellyfin.apiKey || !jellyfin.serverId) {
    throw new AppError(400, "not_configured", "Jellyfin is not configured.");
  }
}

// Conservative mapping: a permission must be explicitly true to count.
// A missing policy denies remote access, playback, and admin powers.
function mapUser(dto: UserDto): ExternalUser {
  const policy = dto?.Policy ?? {};
  return {
    id: normalizeItemId(dto?.Id),
    name: String(dto?.Name ?? "").slice(0, 200),
    isDisabled: policy.IsDisabled === true,
    enableRemoteAccess: policy.EnableRemoteAccess === true,
    enableMediaPlayback: policy.EnableMediaPlayback === true,
    isAdministrator: policy.IsAdministrator === true,
  };
}

async function getCurrentUser(
  config: IntegrationConfig,
  userToken: string,
): Promise<ExternalUser> {
  const me = await requestJson<UserDto>(
    config.jellyfin.url,
    "/Users/Me",
    userToken,
    { service: "jellyfin" },
  );
  return mapUser(me);
}

export async function getServer(
  url: string,
): Promise<{ id: string; name: string }> {
  const info = await requestJson<{ Id?: string; ServerName?: string }>(
    url,
    "/System/Info/Public",
    "",
    {
      service: "jellyfin",
    },
  );
  return {
    id: normalizeItemId(info?.Id),
    name: String(info?.ServerName ?? "").slice(0, 200),
  };
}

export async function authenticate(
  url: string,
  username: string,
  password: string,
): Promise<{ user: ExternalUser; token: string }> {
  const name = typeof username === "string" ? username.trim() : "";
  if (
    !name ||
    name.length > 200 ||
    typeof password !== "string" ||
    password.length > 200
  ) {
    throw new AppError(
      400,
      "invalid_credentials",
      "Username and password are required.",
    );
  }
  const result = await requestJson<{ User?: UserDto; AccessToken?: string }>(
    url,
    "/Users/AuthenticateByName",
    "",
    {
      method: "POST",
      body: { Username: name, Pw: password },
      service: "jellyfin",
    },
  );
  const token =
    typeof result?.AccessToken === "string" ? result.AccessToken : "";
  if (!token || !result?.User) {
    throw new AppError(
      401,
      "upstream_auth",
      "Jellyfin rejected these credentials.",
    );
  }
  return { user: mapUser(result.User), token };
}

export async function validateUser(
  config: IntegrationConfig,
  userToken: string,
): Promise<ExternalUser> {
  requireJellyfinConfig(config);
  if (!userToken) {
    throw new AppError(
      401,
      "upstream_auth",
      "A Jellyfin user session is required.",
    );
  }
  return getCurrentUser(config, userToken);
}

export async function listUsers(
  config: IntegrationConfig,
): Promise<ExternalUser[]> {
  requireJellyfinConfig(config);
  const users = await requestJson<UserDto[]>(
    config.jellyfin.url,
    "/Users",
    config.jellyfin.apiKey,
    {
      service: "jellyfin",
    },
  );
  const out: ExternalUser[] = [];
  for (const dto of Array.isArray(users) ? users : []) {
    try {
      out.push(mapUser(dto));
    } catch {
      // Skip entries without a canonical id; one malformed row must not
      // erase the rest of the inventory.
    }
  }
  return out;
}

export async function listLibraries(
  config: IntegrationConfig,
  userToken: string,
): Promise<Library[]> {
  requireJellyfinConfig(config);
  const me = await getCurrentUser(config, userToken);
  const views = await requestJson<QueryResult>(
    config.jellyfin.url,
    `/Users/${me.id}/Views`,
    userToken,
    {
      service: "jellyfin",
    },
  );
  const seen = new Set<string>();
  const out: Library[] = [];
  for (const dto of views?.Items ?? []) {
    const collectionType = dto?.CollectionType ?? "";
    if (collectionType && LIBRARY_COLLECTION_TYPES[collectionType] !== true)
      continue;
    let id: string;
    try {
      id = normalizeItemId(dto?.Id);
    } catch {
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(dto?.Name ?? "").slice(0, 300) });
  }
  return out;
}

// Intersection of configured and account-granted libraries, canonicalized.
function effectiveLibraries(
  config: IntegrationConfig,
  account: Account,
): string[] {
  const configured = new Set<string>();
  for (const id of config.jellyfin.libraryIds) {
    try {
      configured.add(normalizeItemId(id));
    } catch {
      // A malformed configured id is inert, not unrestricted.
    }
  }
  const granted = new Set<string>();
  for (const id of account.libraryIds) {
    try {
      if (configured.has(normalizeItemId(id))) granted.add(normalizeItemId(id));
    } catch {
      // Ignore malformed grant ids.
    }
  }
  return [...granted];
}

// Single home of the library-membership guarantee: some ancestor of the
// item must be one of this account's granted (configured-intersected)
// library folders. Every compared id goes through normalizeItemId.
function hasGrantedAncestor(
  config: IntegrationConfig,
  account: Account,
  ancestors: unknown,
): boolean {
  const grantedLibraries = new Set(effectiveLibraries(config, account));
  return Array.isArray(ancestors)
    ? ancestors.some((a) => {
        try {
          return grantedLibraries.has(normalizeItemId(a?.Id));
        } catch {
          return false;
        }
      })
    : false;
}

// Credential-free browser link against the external web base, preserving any
// reverse-proxy prefix. Undefined when the external URL is unusable.
function watchUrlFor(
  config: IntegrationConfig,
  itemId: string,
): string | undefined {
  let base: string;
  try {
    base = validateBaseUrl(config.jellyfin.externalUrl);
  } catch {
    return undefined;
  }
  return `${base}/web/index.html#!/details?id=${itemId}&serverId=${config.jellyfin.serverId}`;
}

function mapLibraryItem(
  dto: BaseItemDto,
  user: ExternalUser,
  config: IntegrationConfig,
  mediaSources: MediaSource[] | undefined,
): LibraryItem {
  const id = normalizeItemId(dto?.Id);
  const hasPrimaryImage = Boolean(dto?.ImageTags?.Primary);
  const location = dto?.LocationType;
  // A playable, non-placeholder item needs: playback permission, a real file
  // location, and at least one source Jellyfin can actually deliver.
  const canPlay =
    user.enableMediaPlayback &&
    location !== "Virtual" &&
    (mediaSources ?? dto?.MediaSources ?? []).some(
      (s) =>
        s.SupportsDirectPlay === true ||
        s.SupportsDirectStream === true ||
        s.SupportsTranscoding === true,
    );
  return {
    id,
    name: String(dto?.Name ?? "").slice(0, 500),
    kind: String(dto?.Type ?? "unknown").toLowerCase(),
    ...(dto?.ProductionYear ? { year: dto.ProductionYear } : {}),
    ...(dto?.Overview ? { overview: String(dto.Overview).slice(0, 4000) } : {}),
    ...(dto?.RunTimeTicks ? { durationTicks: dto.RunTimeTicks } : {}),
    ...(hasPrimaryImage ? { image: `/api/images/${id}` } : {}),
    canPlay,
    ...(canPlay ? { watchUrl: watchUrlFor(config, id) } : {}),
  };
}

function itemsPath(userId: string, params: Record<string, string>): string {
  const query = new URLSearchParams({
    sortBy: "SortName",
    sortOrder: "Ascending",
    recursive: "true",
    ...params,
  });
  return `/Users/${userId}/Items?${query.toString()}`;
}

async function fetchItems(
  config: IntegrationConfig,
  userToken: string,
  userId: string,
  opts: {
    parentId?: string;
    ids?: string;
    startIndex: number;
    limit: number;
    search: string;
    // Extra /Items fields for identity matching (ProviderIds, Path).
    extraFields?: string;
    // Sort override; unset keeps itemsPath's SortName/Ascending default.
    sortBy?: string;
    sortOrder?: string;
  },
): Promise<{ items: BaseItemDto[]; total: number }> {
  const params: Record<string, string> = {
    includeItemTypes: "Movie,Video,MusicVideo",
    fields:
      "PrimaryImageAspectRatio,Overview,ProductionYear,RuntimeTicks,MediaSources,LocationType,SortName" +
      (opts.extraFields ? `,${opts.extraFields}` : ""),
    startIndex: String(opts.startIndex),
    limit: String(opts.limit),
  };
  if (opts.parentId) params.parentId = opts.parentId;
  if (opts.ids) params.ids = opts.ids;
  if (opts.search) params.searchTerm = opts.search;
  if (opts.sortBy) params.sortBy = opts.sortBy;
  if (opts.sortOrder) params.sortOrder = opts.sortOrder;
  const res = await requestJson<QueryResult>(
    config.jellyfin.url,
    itemsPath(userId, params),
    userToken,
    {
      service: "jellyfin",
    },
  );
  const items = Array.isArray(res?.Items) ? res.Items : [];
  const total = Number.isInteger(res?.TotalRecordCount)
    ? (res?.TotalRecordCount as number)
    : items.length;
  return { items, total };
}

function compareItems(a: BaseItemDto, b: BaseItemDto): number {
  const keyA = `${(a.SortName || a.Name || "").toLowerCase()}\u0000${String(a.Id ?? "")}`;
  const keyB = `${(b.SortName || b.Name || "").toLowerCase()}\u0000${String(b.Id ?? "")}`;
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  return 0;
}

// Recently-added order: server DateCreated descending, id tiebreak for a
// stable total order. An item without a parseable date sorts oldest.
function compareByDateCreatedDesc(a: BaseItemDto, b: BaseItemDto): number {
  const ta = Date.parse(String(a.DateCreated ?? "")) || 0;
  const tb = Date.parse(String(b.DateCreated ?? "")) || 0;
  if (tb !== ta) return tb - ta;
  const ia = String(a.Id ?? "");
  const ib = String(b.Id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// ponytail: cross-library pages are a k-way merge of per-library SortName
// streams, so aggregate pagination stays globally ordered and never skips or
// duplicates items. Cost is O(start+limit) upstream rows per library; if that
// ever matters, move the cursor state into a per-request cache.
async function mergeAcrossLibraries(
  config: IntegrationConfig,
  userToken: string,
  user: ExternalUser,
  libraryIds: string[],
  start: number,
  limit: number,
  search: string,
): Promise<LibraryPage> {
  interface Cursor {
    libraryId: string;
    items: BaseItemDto[];
    pos: number;
    fetched: number;
    total: number;
    done: boolean;
  }
  const cursors: Cursor[] = [];
  let total = 0;
  await Promise.all(
    libraryIds.map(async (libraryId) => {
      const first = await fetchItems(config, userToken, user.id, {
        parentId: libraryId,
        startIndex: 0,
        limit: MERGE_CHUNK,
        search,
      });
      const fetched = first.items.length;
      cursors.push({
        libraryId,
        items: first.items,
        pos: 0,
        fetched,
        total: first.total,
        done: fetched < MERGE_CHUNK || fetched >= first.total,
      });
      total += first.total;
    }),
  );

  const refill = async (cursor: Cursor): Promise<void> => {
    const next = await fetchItems(config, userToken, user.id, {
      parentId: cursor.libraryId,
      startIndex: cursor.fetched,
      limit: MERGE_CHUNK,
      search,
    });
    cursor.items = next.items;
    cursor.pos = 0;
    cursor.fetched += next.items.length;
    if (next.items.length < MERGE_CHUNK || cursor.fetched >= cursor.total)
      cursor.done = true;
  };

  const picked: BaseItemDto[] = [];
  let skipped = 0;
  while (picked.length < limit) {
    let best: { cursor: Cursor; dto: BaseItemDto } | null = null;
    for (const cursor of cursors) {
      if (cursor.pos >= cursor.items.length && !cursor.done)
        await refill(cursor);
      const head = cursor.items[cursor.pos];
      if (!head) continue;
      if (!best || compareItems(head, best.dto) < 0)
        best = { cursor, dto: head };
    }
    if (!best) break;
    best.cursor.pos += 1;
    if (skipped < start) {
      skipped += 1;
      continue;
    }
    picked.push(best.dto);
  }

  return {
    items: picked.map((dto) => mapLibraryItem(dto, user, config, undefined)),
    total,
    start,
    limit,
  };
}

export async function listLibraryItems(
  config: IntegrationConfig,
  userToken: string,
  account: Account,
  query: { start: number; limit: number; search: string; libraryId?: string },
): Promise<LibraryPage> {
  requireJellyfinConfig(config);
  const start = Number(query.start);
  const limit = Number(query.limit);
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start > 100_000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 60
  ) {
    throw new AppError(400, "invalid_query", "Invalid pagination parameters.");
  }
  const search =
    typeof query.search === "string" ? query.search.trim().slice(0, 200) : "";

  // An empty grant set is a configured fact, not a reason to widen scope:
  // it yields an empty page without touching Jellyfin at all.
  const libraryIds = effectiveLibraries(config, account);
  if (libraryIds.length === 0) return { items: [], total: 0, start, limit };

  // A request for a library outside the grant intersection is refused before
  // any upstream traffic, and an empty grant set never widens to all
  // libraries.
  let scopedLibraryId: string | undefined;
  if (query.libraryId !== undefined) {
    scopedLibraryId = normalizeItemId(query.libraryId);
    if (!libraryIds.includes(scopedLibraryId)) {
      throw new AppError(
        403,
        "library_denied",
        "That library is not available to this account.",
      );
    }
  }

  const user = await getCurrentUser(config, userToken);

  if (scopedLibraryId !== undefined) {
    const page = await fetchItems(config, userToken, user.id, {
      parentId: scopedLibraryId,
      startIndex: start,
      limit,
      search,
    });
    return {
      items: page.items.map((dto) =>
        mapLibraryItem(dto, user, config, undefined),
      ),
      total: page.total,
      start,
      limit,
    };
  }

  return mergeAcrossLibraries(
    config,
    userToken,
    user,
    libraryIds,
    start,
    limit,
    search,
  );
}

// Discover shelf: the account's most recently added library items, ordered by
// the server's own recently-added ordering (DateCreated descending) — never
// reinterpreted as trending or popular, which this server does not provide.
// Runs entirely under the caller's user token so item-level policy applies,
// scoped to the intersection of configured and granted libraries. Bounded:
// limit (1..60, capped per library at limit itself), one small page per
// granted library, no unbounded sweep. Empty grants return empty without any
// upstream call, and upstream failures propagate as errors — never an empty
// shelf.
export async function listRecentlyAddedItems(
  config: IntegrationConfig,
  userToken: string,
  account: Account,
  limit: number,
): Promise<LibraryItem[]> {
  requireJellyfinConfig(config);
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    throw new AppError(400, "invalid_query", "Invalid pagination parameters.");
  }
  const libraryIds = effectiveLibraries(config, account);
  if (libraryIds.length === 0) return [];
  const user = await getCurrentUser(config, userToken);
  const pages = await Promise.all(
    libraryIds.map((libraryId) =>
      fetchItems(config, userToken, user.id, {
        parentId: libraryId,
        startIndex: 0,
        limit: n,
        search: "",
        sortBy: "DateCreated",
        sortOrder: "Descending",
        extraFields: "DateCreated",
      }),
    ),
  );
  return pages
    .flatMap((page) => page.items)
    .sort(compareByDateCreatedDesc)
    .slice(0, n)
    .map((dto) => mapLibraryItem(dto, user, config, undefined));
}

// Exact membership proof: the item must be visible to the caller's user
// token AND its ancestor chain must contain a granted library folder. This
// is folder proof, never a title/type guess, and the user token enforces the
// caller's own item-level access on every call.
// ponytail: never reintroduce ids+parentId query scoping here — the lab
// Jellyfin 12.0.0 silently ignores parentId whenever ids is present, so only
// the ancestor chain (GET /Items/{id}/Ancestors) proves library membership
// on that build.
async function findGrantedItem(
  config: IntegrationConfig,
  userToken: string,
  user: ExternalUser,
  account: Account,
  itemId: string,
): Promise<BaseItemDto> {
  const { items } = await fetchItems(config, userToken, user.id, {
    ids: itemId,
    startIndex: 0,
    limit: 1,
    search: "",
  });
  const dto = items[0];
  if (!dto) {
    throw new AppError(
      404,
      "item_not_found",
      "That item is not available to this account.",
    );
  }
  // Outages here propagate as upstream errors — never a silent allow and
  // never a fabricated denial.
  const ancestors = await requestJson<BaseItemDto[]>(
    config.jellyfin.url,
    `/Items/${itemId}/Ancestors`,
    userToken,
    { service: "jellyfin" },
  );
  if (!hasGrantedAncestor(config, account, ancestors)) {
    throw new AppError(
      404,
      "item_not_found",
      "That item is not available to this account.",
    );
  }
  return dto;
}

export async function getLibraryItem(
  config: IntegrationConfig,
  userToken: string,
  account: Account,
  id: string,
): Promise<LibraryItem> {
  requireJellyfinConfig(config);
  const itemId = normalizeItemId(id);
  if (effectiveLibraries(config, account).length === 0) {
    // Empty grants deny without any upstream contact.
    throw new AppError(
      404,
      "item_not_found",
      "That item is not available to this account.",
    );
  }
  const user = await getCurrentUser(config, userToken);
  const dto = await findGrantedItem(config, userToken, user, account, itemId);
  // PlaybackInfo is the server's real, user-scoped source verdict; a failure
  // here propagates instead of degrading into a fake "not playable".
  const playback = await requestJson<PlaybackInfoResponse>(
    config.jellyfin.url,
    `/Items/${itemId}/PlaybackInfo?userId=${user.id}&autoOpenLiveStream=false`,
    userToken,
    { service: "jellyfin" },
  );
  return mapLibraryItem(dto, user, config, playback?.MediaSources);
}

export async function getLibraryImage(
  config: IntegrationConfig,
  userToken: string,
  account: Account,
  id: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  requireJellyfinConfig(config);
  const itemId = normalizeItemId(id);
  if (effectiveLibraries(config, account).length === 0) {
    throw new AppError(
      404,
      "item_not_found",
      "That item is not available to this account.",
    );
  }
  const user = await getCurrentUser(config, userToken);
  // Reauthorize item and library membership on EVERY image request.
  const dto = await findGrantedItem(config, userToken, user, account, itemId);
  if (!dto?.ImageTags?.Primary) {
    throw new AppError(
      404,
      "image_not_found",
      "No image is available for that item.",
    );
  }
  const res = await requestBytes(
    config.jellyfin.url,
    `/Items/${itemId}/Images/Primary`,
    userToken,
    {
      service: "jellyfin",
      sizeLimit: IMAGE_BYTE_LIMIT,
    },
  );
  const mime = res.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (IMAGE_MIME_TYPES[mime] !== true) {
    throw new AppError(
      502,
      "image_type",
      "Upstream returned an unsupported image type.",
    );
  }
  return { bytes: res.bytes, contentType: mime };
}

// --- M2 per-user playback resolution ---

/** Identity hints for resolvePlaybackAccess. A MediaReference
 * ({provider, kind, id}) is valid as-is; the remaining fields are optional
 * enrichment from the acquisition record. */
export type PlaybackHints = {
  provider: CatalogProvider;
  kind: MediaKind;
  /** External provider UUID (TPDB movie/scene id, StashDB scene id). */
  id: string;
  /** Whisparr may store a TMDB id for movies. */
  tmdbId?: number;
  title?: string;
  year?: number;
  /** Whisparr's stored movie/scene path, before any path mapping. */
  whisparrPath?: string;
};

interface CandidateItem {
  dto: BaseItemDto;
  paths: string[];
  providerValues: string[];
}

// ponytail: the lab Jellyfin 12.0.0 (verified live) supplies empty
// ProviderIds on items and silently ignores anyProviderIdEquals/providerIds
// query filters, so identity matching must enumerate visible items once per
// resolve and compare in-process. The caps bound that sweep; if a server's
// library outgrows them, add a persisted item index keyed by provider id.
const SWEEP_PAGE = 300;
const SWEEP_MAX_ITEMS = 12_000;

function pathComponents(path: string): string[] {
  return path.split(/[\\/]+/).filter((c) => c.length > 0);
}

function looksWindows(path: string): boolean {
  return path.includes("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

// Full-component prefix test. Never a loose substring: components must line
// up exactly, with case folding only for Windows-style paths.
function samePathPrefix(
  prefix: string[],
  full: string[],
  fold: boolean,
): boolean {
  if (full.length < prefix.length) return false;
  return prefix.every((part, i) =>
    fold
      ? part.toLowerCase() === (full[i] ?? "").toLowerCase()
      : part === full[i],
  );
}

// Maps a Whisparr path through the first matching configured mapping and
// returns comparable components plus the case-fold decision. With no
// matching mapping the path is compared as-is (shared-mount deployments).
function mappedPrefix(
  whisparrPath: string,
  mappings: WhisparrPathMapping[] | undefined,
): { comps: string[]; fold: boolean } {
  const pathComps = pathComponents(whisparrPath);
  for (const mapping of mappings ?? []) {
    const prefixComps = pathComponents(mapping.whisparrPrefix);
    const fold =
      looksWindows(whisparrPath) ||
      looksWindows(mapping.whisparrPrefix) ||
      looksWindows(mapping.jellyfinPrefix);
    if (
      prefixComps.length > 0 &&
      samePathPrefix(prefixComps, pathComps, fold)
    ) {
      return {
        comps: [
          ...pathComponents(mapping.jellyfinPrefix),
          ...pathComps.slice(prefixComps.length),
        ],
        fold,
      };
    }
  }
  return { comps: pathComps, fold: looksWindows(whisparrPath) };
}

function toCandidate(dto: BaseItemDto): CandidateItem {
  const paths = [
    dto.Path ?? "",
    ...(dto.MediaSources ?? []).map((s) => s.Path ?? ""),
  ]
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const providerValues = Object.values(dto.ProviderIds ?? {})
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v.length > 0);
  return { dto, paths, providerValues };
}

function providerIdMatches(
  candidate: CandidateItem,
  hints: PlaybackHints,
): boolean {
  if (candidate.providerValues.includes(hints.id.trim().toLowerCase())) {
    return true;
  }
  return (
    hints.tmdbId !== undefined &&
    hints.tmdbId > 0 &&
    candidate.providerValues.includes(String(hints.tmdbId))
  );
}

function pathMatches(
  candidate: CandidateItem,
  prefix: string[],
  hintFold: boolean,
): boolean {
  return candidate.paths.some((p) =>
    samePathPrefix(prefix, pathComponents(p), hintFold || looksWindows(p)),
  );
}

// Title/year agreement is similarity, never identity; it only ever
// contributes an 'ambiguous' verdict for administrator review.
function titleYearSimilar(dto: BaseItemDto, hints: PlaybackHints): boolean {
  if (!hints.title || !dto.Name) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm(dto.Name) !== norm(hints.title)) return false;
  if (
    hints.year !== undefined &&
    dto.ProductionYear !== undefined &&
    dto.ProductionYear !== hints.year
  ) {
    return false;
  }
  return true;
}

async function sweepVisibleItems(
  config: IntegrationConfig,
  userToken: string,
  userId: string,
): Promise<CandidateItem[]> {
  const out: CandidateItem[] = [];
  for (let start = 0; start < SWEEP_MAX_ITEMS; start += SWEEP_PAGE) {
    const { items } = await fetchItems(config, userToken, userId, {
      startIndex: start,
      limit: SWEEP_PAGE,
      search: "",
      extraFields: "ProviderIds,Path",
    });
    for (const dto of items) out.push(toCandidate(dto));
    if (items.length < SWEEP_PAGE) break;
  }
  return out;
}

// Verdict for one exactly matched candidate. Every call re-runs under the
// user token, so item-level policy applies each time. A visible-but-ungranted
// item is 'denied', never 'missing'; a placeholder or empty file is
// 'denied', never 'available'.
async function verdictForItem(
  config: IntegrationConfig,
  userToken: string,
  user: ExternalUser,
  account: Account,
  candidate: CandidateItem,
): Promise<PlaybackAccess> {
  const itemId = normalizeItemId(candidate.dto.Id);
  if (!user.enableMediaPlayback) {
    return {
      outcome: "denied",
      reason: "Playback is disabled for this Jellyfin user.",
    };
  }
  // Grant proof by ancestry — the only exact folder-membership proof on the
  // lab Jellyfin 12.0.0 (parentId is ignored alongside ids there); shares
  // hasGrantedAncestor with findGrantedItem.
  let ancestors: BaseItemDto[];
  try {
    ancestors = await requestJson<BaseItemDto[]>(
      config.jellyfin.url,
      `/Items/${itemId}/Ancestors`,
      userToken,
      { service: "jellyfin" },
    );
  } catch (err) {
    if (err instanceof AppError && err.upstreamStatus === 404) {
      // Invisible to this user at the item level: denied, never missing.
      return {
        outcome: "denied",
        reason: "The matched item is outside this account's granted libraries.",
      };
    }
    throw err; // the outer catch maps non-auth failures to 'unavailable'
  }
  if (!hasGrantedAncestor(config, account, ancestors)) {
    return {
      outcome: "denied",
      reason: "The matched item is outside this account's granted libraries.",
    };
  }
  const playback = await requestJson<PlaybackInfoResponse>(
    config.jellyfin.url,
    `/Items/${itemId}/PlaybackInfo?userId=${user.id}&autoOpenLiveStream=false`,
    userToken,
    { service: "jellyfin" },
  );
  if (candidate.dto.LocationType === "Virtual") {
    return {
      outcome: "denied",
      reason: "The matched item is a placeholder without media.",
    };
  }
  const sources = playback?.MediaSources ?? candidate.dto.MediaSources ?? [];
  const playable = sources.some(
    (s) =>
      (s.SupportsDirectPlay === true ||
        s.SupportsDirectStream === true ||
        s.SupportsTranscoding === true) &&
      s.Size !== 0,
  );
  if (!playable) {
    return {
      outcome: "denied",
      reason: "No playable media source (file missing or empty).",
    };
  }
  // mapLibraryItem embeds watchUrlFor: the credential-free link is present
  // only when playback is actually permitted, and absent otherwise.
  const item = mapLibraryItem(
    candidate.dto,
    user,
    config,
    playback?.MediaSources,
  );
  if (!item.canPlay) {
    return {
      outcome: "denied",
      reason: "Playback is not permitted for this item.",
    };
  }
  return {
    outcome: "available",
    item,
    ...(item.watchUrl ? { watchUrl: item.watchUrl } : {}),
  };
}

// Per-user availability verdict for one external identity. Runs entirely
// under the caller's Jellyfin user token, reads existing state only, and
// never mutates the server. Matching precedence, strictest first:
// 1. exact ProviderIds match, compared in-process (no server-side filter
//    exists on Jellyfin 12.0.0 — verified live);
// 2. exact Whisparr-to-Jellyfin path correspondence through the configured
//    pathMappings, full components only;
// 3. title/year similarity alone is 'ambiguous', never a guess.
// Auth failures (401, dead user token) propagate; every other upstream
// failure is 'unavailable', so an outage is never reported as 'missing'.
export async function resolvePlaybackAccess(
  config: IntegrationConfig,
  userToken: string,
  account: Account,
  hints: PlaybackHints,
): Promise<PlaybackAccess> {
  requireJellyfinConfig(config);
  if (!hints || typeof hints.id !== "string" || hints.id.trim() === "") {
    throw new AppError(400, "invalid_reference", "A provider id is required.");
  }
  if (effectiveLibraries(config, account).length === 0) {
    return {
      outcome: "denied",
      reason: "No libraries are granted to this account.",
    };
  }
  try {
    const user = await getCurrentUser(config, userToken);
    const candidates = await sweepVisibleItems(config, userToken, user.id);
    const mapped = hints.whisparrPath
      ? mappedPrefix(hints.whisparrPath, config.whisparr?.pathMappings)
      : undefined;
    const exact = candidates.filter(
      (c) =>
        providerIdMatches(c, hints) ||
        (mapped !== undefined && pathMatches(c, mapped.comps, mapped.fold)),
    );
    if (exact.length > 1) {
      return {
        outcome: "ambiguous",
        reason: "Multiple Jellyfin items match this identity.",
      };
    }
    if (exact.length === 1) {
      return await verdictForItem(config, userToken, user, account, exact[0]!);
    }
    if (candidates.some((c) => titleYearSimilar(c.dto, hints))) {
      return {
        outcome: "ambiguous",
        reason: "Title/year similarity only; administrator review required.",
      };
    }
    return { outcome: "missing" };
  } catch (err) {
    if (err instanceof AppError && err.upstreamStatus === 401) throw err;
    if (err instanceof AppError) {
      return { outcome: "unavailable", reason: err.message };
    }
    throw err;
  }
}
