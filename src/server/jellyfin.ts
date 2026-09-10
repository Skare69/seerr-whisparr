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
  ExternalUser,
  IntegrationConfig,
  Library,
  LibraryItem,
  LibraryPage,
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
  SortName?: string;
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
  },
): Promise<{ items: BaseItemDto[]; total: number }> {
  const params: Record<string, string> = {
    includeItemTypes: "Movie,Video,MusicVideo",
    fields:
      "PrimaryImageAspectRatio,Overview,ProductionYear,RuntimeTicks,MediaSources,LocationType,SortName",
    startIndex: String(opts.startIndex),
    limit: String(opts.limit),
  };
  if (opts.parentId) params.parentId = opts.parentId;
  if (opts.ids) params.ids = opts.ids;
  if (opts.search) params.searchTerm = opts.search;
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

// Exact membership proof: the item must be returned by a user-token query
// scoped to BOTH the item id and one granted library folder. This is folder
// proof, never a title/type guess, and the user token enforces the caller's
// own item-level access on every call.
async function findGrantedItem(
  config: IntegrationConfig,
  userToken: string,
  user: ExternalUser,
  account: Account,
  itemId: string,
): Promise<BaseItemDto> {
  for (const libraryId of effectiveLibraries(config, account)) {
    const { items } = await fetchItems(config, userToken, user.id, {
      parentId: libraryId,
      ids: itemId,
      startIndex: 0,
      limit: 1,
      search: "",
    });
    const found = items[0];
    if (found) return found;
  }
  throw new AppError(
    404,
    "item_not_found",
    "That item is not available to this account.",
  );
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
