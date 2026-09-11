// Whisparr integration. Reads (status, resolution, adoption, observation) are
// always allowed. Writes are exclusively the delivery add path and are gated
// on config.whisparr.delivery being present, enabled, and fully specified;
// a missing or disabled delivery is an explicit blocked condition, never a
// silent no-op. Every other mutation (commands, monitoring edits, scans,
// deletes) is out of scope and never issued.

import { AppError, requestJson } from "./http.ts";
import type {
  IntegrationConfig,
  MediaKind,
  MediaReference,
  RemovalLevel,
} from "../lib/contracts.ts";

export interface WhisparrStatus {
  configured: boolean;
  version?: string;
  appName?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
}

interface StatusDto {
  version?: unknown;
  appName?: unknown;
}

interface RootFolderDto {
  id?: unknown;
  path?: unknown;
}

interface QualityProfileDto {
  id?: unknown;
  name?: unknown;
}

export async function getWhisparrStatus(
  config: IntegrationConfig,
): Promise<WhisparrStatus> {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) {
    return { configured: false };
  }
  // All three reads are plain GETs against the v3 API with the key header;
  // any upstream failure rejects so routes can report a genuine outage.
  const [status, rootFolders, profiles] = await Promise.all([
    requestJson<StatusDto>(
      whisparr.url,
      "/api/v3/system/status",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
    requestJson<RootFolderDto[]>(
      whisparr.url,
      "/api/v3/rootfolder",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
    requestJson<QualityProfileDto[]>(
      whisparr.url,
      "/api/v3/qualityprofile",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
  ]);
  return {
    configured: true,
    version:
      typeof status?.version === "string"
        ? status.version.slice(0, 64)
        : undefined,
    appName:
      typeof status?.appName === "string"
        ? status.appName.slice(0, 64)
        : undefined,
    rootFolders: (Array.isArray(rootFolders) ? rootFolders : [])
      .filter((r) => Number.isInteger(r?.id) && typeof r?.path === "string")
      .map((r) => ({ id: r.id as number, path: r.path as string })),
    profiles: (Array.isArray(profiles) ? profiles : [])
      .filter((p) => Number.isInteger(p?.id) && typeof p?.name === "string")
      .map((p) => ({ id: p.id as number, name: p.name as string })),
  };
}

// --- shared validation ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical external provider identity: lowercase dashed UUID. Accepts the
 * dashed or compact hex form so stored identities compare equal either way. */
export function canonicalProviderId(value: unknown): string {
  const compact =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/-/g, "")
      : "";
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new AppError(400, "invalid_id", "Invalid provider id.");
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

interface WhisparrEndpoint {
  url: string;
  apiKey: string;
}

function requireWhisparr(config: IntegrationConfig): WhisparrEndpoint {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) {
    throw new AppError(400, "not_configured", "Whisparr is not configured.");
  }
  return { url: whisparr.url, apiKey: whisparr.apiKey };
}

export interface WhisparrDeliveryTarget {
  rootFolderPath: string;
  qualityProfileId: number;
  searchOnAdd: boolean;
}

/** Delivery gate: every write path funnels through here. Absent, disabled,
 * or incompletely specified delivery is a hard blocked condition. */
function requireDelivery(config: IntegrationConfig): WhisparrDeliveryTarget {
  const delivery = config?.whisparr?.delivery;
  const root = delivery?.rootFolderPath;
  if (
    !delivery ||
    delivery.enabled !== true ||
    typeof root !== "string" ||
    root.length < 1 ||
    root.length > 1024 ||
    root !== root.trim() ||
    /[\u0000-\u001f]/.test(root) ||
    !Number.isInteger(delivery.qualityProfileId) ||
    delivery.qualityProfileId <= 0
  ) {
    throw new AppError(
      409,
      "delivery_disabled",
      "Whisparr delivery is disabled or incomplete.",
    );
  }
  return {
    rootFolderPath: delivery.rootFolderPath,
    qualityProfileId: delivery.qualityProfileId,
    searchOnAdd: delivery.searchOnAdd === true,
  };
}

/** A MediaReference this module can work with: TPDB movies and StashDB
 * scenes only, with the provider and kind in their canonical pairing. */
function requireMediaReference(ref: MediaReference): {
  kind: MediaKind;
  id: string;
} {
  const kind = ref?.kind;
  const provider = ref?.provider;
  const valid =
    (kind === "movie" && provider === "tpdb") ||
    (kind === "scene" && provider === "stashdb");
  if (!valid) {
    throw new AppError(400, "invalid_reference", "media reference is invalid");
  }
  return { kind, id: canonicalProviderId(ref.id) };
}

// --- upstream DTOs ---

interface MovieResourceDto {
  id?: unknown;
  /** Whisparr declares "movie" | "scene" | "studio" | "performer" on stored
   * resources; lookup results carry it too. Absent on some builds. */
  itemType?: unknown;
  title?: unknown;
  monitored?: unknown;
  hasFile?: unknown;
  movieFileId?: unknown;
  movieFile?: unknown;
  sizeOnDisk?: unknown;
  path?: unknown;
  /** ISO-8601 stored `added` timestamp; the removal retry guard compares it. */
  added?: unknown;
  foreignId?: unknown;
  tmdbId?: unknown;
  tpdbId?: unknown;
  stashId?: unknown;
  /** Lookup results only, when the build reveals it: the identity sits on
   * Whisparr's import-exclusion list. Absent means unknown, never false. */
  isExcluded?: unknown;
  statistics?: {
    movieFileCount?: unknown;
    sizeOnDisk?: unknown;
  } & Record<string, unknown>;
}

interface QueueRecordDto {
  movieId?: unknown;
  movie?: { id?: unknown };
}

interface QueuePageDto {
  records?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Stored identity and kind of a Whisparr movie/scene resource, read from
 * the routing fields Whisparr itself keeps (declared ItemType cross-checked
 * against ForeignId shape, TpdbId, StashId). Cross-ids never participate: an
 * item routes to exactly one metadata source. */
function identityOf(
  dto: MovieResourceDto,
): { itemType: MediaKind; identity: string } | null {
  const tpdbId = asString(dto.tpdbId);
  const foreignId = asString(dto.foreignId)?.toLowerCase() ?? "";
  let itemType: MediaKind;
  let identity: string;
  if (tpdbId !== undefined || foreignId.startsWith("tpdbid:")) {
    itemType = "movie";
    identity = tpdbId ?? foreignId.slice("tpdbid:".length);
  } else {
    const stashId = asString(dto.stashId);
    if (stashId !== undefined) {
      itemType = "scene";
      identity = stashId;
    } else if (
      foreignId !== "" &&
      dto.tmdbId === 0 &&
      UUID_RE.test(foreignId)
    ) {
      // StashDB scenes are stored with a bare UUID ForeignId and no TmdbId.
      itemType = "scene";
      identity = foreignId;
    } else {
      return null;
    }
  }
  if (identity === "") return null;
  // A declared itemType counts only when it agrees with the routing shape.
  const declared = asString(dto.itemType)?.toLowerCase();
  if ((declared === "movie" || declared === "scene") && declared !== itemType) {
    return null;
  }
  return { itemType, identity };
}

// --- resolution (lookup) ---

export interface WhisparrResolved {
  itemType: MediaKind;
  /** The exact provider UUID that was requested, verified against the
   * upstream response. Never a wrapper id. */
  identity: string;
  title: string;
  /** True only when the lookup response itself reveals an import
   * exclusion; absent means the API did not say. */
  importExcluded?: boolean;
}

function asMovieResources(dto: unknown): MovieResourceDto[] {
  if (Array.isArray(dto)) return dto as MovieResourceDto[];
  if (dto && typeof dto === "object") return [dto as MovieResourceDto];
  return [];
}

/** Prove the upstream returned exactly the requested kind and identity.
 * A mismatch is a hard error, never a best-effort guess. */
function assertResolved(
  dtos: MovieResourceDto[],
  kind: MediaKind,
  id: string,
): MovieResourceDto {
  const matches = dtos.filter((dto) => {
    const routed = identityOf(dto);
    return (
      routed !== null &&
      routed.itemType === kind &&
      routed.identity.toLowerCase() === id
    );
  });
  if (matches.length !== 1) {
    throw new AppError(
      502,
      "identity_mismatch",
      "Whisparr did not resolve the requested identity.",
    );
  }
  return matches[0]!;
}

/** Resolve a MediaReference to a Whisparr-resolvable item without mutating
 * anything. TPDB movies use the typed tpdbId lookup; StashDB scenes use the
 * term lookup with the stash: prefix. The scene-wrapper lookup path is not
 * used, so wrapper ids can never leak in as stored item ids. */
export async function resolveWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrResolved> {
  const whisparr = requireWhisparr(config);
  const { kind, id } = requireMediaReference(ref);
  const dto =
    kind === "movie"
      ? await requestJson<unknown>(
          whisparr.url,
          `/api/v3/movie/lookup/tpdb?tpdbId=${encodeURIComponent(id)}`,
          whisparr.apiKey,
          { service: "whisparr" },
        )
      : await requestJson<unknown>(
          whisparr.url,
          `/api/v3/movie/lookup?term=${encodeURIComponent(`stash:${id}`)}`,
          whisparr.apiKey,
          { service: "whisparr" },
        );
  const match = assertResolved(asMovieResources(dto), kind, id);
  const title = asString(match.title)?.trim();
  if (!title) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Whisparr resolved the identity without a usable title.",
    );
  }
  return {
    itemType: kind,
    identity: id,
    title,
    ...(match.isExcluded === true ? { importExcluded: true } : {}),
  };
}

// --- stored payload construction ---

/** Server-owned POST /api/v3/movie body. Nothing is spread from lookup
 * responses; routing fields carry exactly one metadata source. */
export interface WhisparrMoviePayload {
  title: string;
  foreignId: string;
  tmdbId: 0;
  tpdbId?: string;
  rootFolderPath: string;
  qualityProfileId: number;
  monitored: true;
  addOptions: { searchForMovie: boolean; addMethod: "Manual" };
}

/** Build the validated add payload. `title` must come from a verified lookup,
 * never from browser input. TPDB movies route via ForeignId prefix plus
 * TpdbId (TmdbId 0); StashDB scenes carry a bare UUID ForeignId with no
 * TpdbId, so GetMetadata falls through to GetSceneInfo(ForeignId). */
export function buildMoviePayload(
  ref: MediaReference,
  title: string,
  delivery: WhisparrDeliveryTarget,
): WhisparrMoviePayload {
  const { kind, id } = requireMediaReference(ref);
  const cleanTitle =
    typeof title === "string" ? title.trim().slice(0, 300) : "";
  if (!cleanTitle) {
    throw new AppError(400, "invalid_title", "A title is required to add.");
  }
  return {
    title: cleanTitle,
    foreignId: kind === "movie" ? `tpdbId:${id}` : id,
    tmdbId: 0,
    ...(kind === "movie" ? { tpdbId: id } : {}),
    rootFolderPath: delivery.rootFolderPath,
    qualityProfileId: delivery.qualityProfileId,
    monitored: true,
    addOptions: {
      searchForMovie: delivery.searchOnAdd,
      addMethod: "Manual",
    },
  };
}

// --- adoption and reconciliation ---

export interface WhisparrItem {
  /** Stored Whisparr item id. Only ever taken from a stored resource, never
   * from a lookup wrapper. */
  whisparrId: number;
  itemType: MediaKind;
  identity: string;
  title?: string;
  monitored: boolean;
  /** Stored library path; Jellyfin matching maps this through pathMappings. */
  path: string;
  hasFile: boolean;
  sizeOnDisk?: number;
  /** Present only when the API reveals import exclusion. */
  importExcluded?: boolean;
  /** File count from stored statistics; 0 when none is reported. */
  fileCount?: number;
  /** Stored ISO-8601 `added` timestamp; absent when the build omits it. */
  added?: string;
}

function mapStoredItem(dto: MovieResourceDto): WhisparrItem {
  const routed = identityOf(dto);
  const id = dto.id;
  const path = asString(dto.path);
  if (
    routed === null ||
    !Number.isInteger(id) ||
    (id as number) <= 0 ||
    !path
  ) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Whisparr returned an unusable stored item.",
    );
  }
  const statsSize =
    typeof dto.statistics?.sizeOnDisk === "number"
      ? dto.statistics.sizeOnDisk
      : undefined;
  const sizeOnDisk =
    typeof dto.sizeOnDisk === "number" ? dto.sizeOnDisk : statsSize;
  const imported =
    dto.hasFile === true ||
    (typeof dto.movieFileId === "number" && dto.movieFileId > 0) ||
    dto.movieFile != null ||
    (typeof dto.statistics?.movieFileCount === "number" &&
      dto.statistics.movieFileCount > 0);
  const rawCount = dto.statistics?.movieFileCount;
  const fileCount =
    typeof rawCount === "number" && Number.isInteger(rawCount)
      ? rawCount
      : // No statistics on an imported item: at least one file must exist.
        imported
        ? 1
        : 0;
  const added = asString(dto.added);
  return {
    whisparrId: id as number,
    itemType: routed.itemType,
    identity: canonicalProviderId(routed.identity),
    title: asString(dto.title)?.trim(),
    monitored: dto.monitored === true,
    path,
    hasFile: imported,
    fileCount,
    ...(added !== undefined ? { added } : {}),
    ...(sizeOnDisk !== undefined ? { sizeOnDisk } : {}),
    ...(dto.isExcluded === true ? { importExcluded: true } : {}),
  };
}

/** Exact-identity stored-resource lookup: GET /api/v3/movie?tpdbId=|stashId=.
 * Returns the raw stored resource (unmapped), or null when the identity is
 * provably absent. Conflicting matches are a hard error. */
async function findStoredMovieDto(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<MovieResourceDto | null> {
  const whisparr = requireWhisparr(config);
  const { kind, id } = requireMediaReference(ref);
  const field = kind === "movie" ? "tpdbId" : "stashId";
  const rows = await requestJson<unknown>(
    whisparr.url,
    `/api/v3/movie?${field}=${encodeURIComponent(id)}`,
    whisparr.apiKey,
    { service: "whisparr" },
  );
  if (!Array.isArray(rows)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Whisparr returned an unexpected stored-item listing.",
    );
  }
  const matches = (rows as MovieResourceDto[]).filter((dto) => {
    const routed = identityOf(dto);
    return (
      routed !== null &&
      routed.itemType === kind &&
      routed.identity.toLowerCase() === id
    );
  });
  if (matches.length > 1) {
    throw new AppError(
      502,
      "identity_mismatch",
      "Whisparr returned conflicting items for the requested identity.",
    );
  }
  const [match] = matches;
  return match ?? null;
}

/** Exact-identity adoption lookup: GET /api/v3/movie?tpdbId=|stashId=.
 * Returns the stored item, or null when the identity is provably absent. */
export async function findWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrItem | null> {
  const dto = await findStoredMovieDto(config, ref);
  return dto === null ? null : mapStoredItem(dto);
}

/** Stored item by Whisparr id. A proven 404 is authoritative absence (null);
 * every other failure propagates as sanitized AppError. */
export async function getWhisparrItem(
  config: IntegrationConfig,
  whisparrId: number,
): Promise<WhisparrItem | null> {
  const whisparr = requireWhisparr(config);
  if (!Number.isInteger(whisparrId) || whisparrId <= 0) {
    throw new AppError(400, "invalid_id", "Invalid item id.");
  }
  try {
    const dto = await requestJson<unknown>(
      whisparr.url,
      `/api/v3/movie/${whisparrId}`,
      whisparr.apiKey,
      { service: "whisparr" },
    );
    return mapStoredItem(dto as MovieResourceDto);
  } catch (err) {
    if (err instanceof AppError && err.upstreamStatus === 404) return null;
    throw err;
  }
}

// --- observation ---

export type WhisparrObservation =
  | {
      found: true;
      /** monitoring: tracked, nothing grabbed/imported yet — not a failure.
       * downloading: tracked and present in the Whisparr queue.
       * imported: a file is on disk (hasFile/movieFileId/movieFile/
       * statistics). Never derived from isAvailable or the release-status
       * enum: both were observed unrelated to download state. */
      state: "monitoring" | "downloading" | "imported";
      item: WhisparrItem;
    }
  | { found: false };

/** Map a stored item to a persistable observation. Downloading is only
 * claimed when the item appears in the queue; a failed or unrecognized queue
 * read falls back to monitoring rather than inventing a failure. Upstream
 * outages on the identity read itself propagate as AppError so the workflow
 * records a failed check without touching recorded state. */
export async function observeWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrObservation> {
  const item = await findWhisparrItem(config, ref);
  if (item === null) return { found: false };
  if (item.hasFile) return { found: true, state: "imported", item };
  const whisparr = requireWhisparr(config);
  let records: QueueRecordDto[] = [];
  try {
    const queue = await requestJson<QueuePageDto>(
      whisparr.url,
      "/api/v3/queue?page=1&pageSize=200",
      whisparr.apiKey,
      { service: "whisparr" },
    );
    if (Array.isArray(queue?.records))
      records = queue.records as QueueRecordDto[];
  } catch {
    records = [];
  }
  const inQueue = records.some(
    (r) =>
      r.movieId === item.whisparrId ||
      (r.movie && r.movie.id) === item.whisparrId,
  );
  return { found: true, state: inQueue ? "downloading" : "monitoring", item };
}

// --- delivery ---

export type WhisparrDeliveryResult =
  | { outcome: "adopted"; item: WhisparrItem }
  | { outcome: "accepted"; item: WhisparrItem }
  | { outcome: "failed"; reason: string }
  | { outcome: "uncertain"; reason: string };

async function resolveAfterSubmission(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrItem | null | "unknown"> {
  try {
    return await findWhisparrItem(config, ref);
  } catch (err) {
    // A proven 404 is authoritative absence; anything else leaves the
    // submission outcome unknown.
    if (err instanceof AppError && err.upstreamStatus === 404) return null;
    return "unknown";
  }
}

/** Deliver a media reference to Whisparr. Adoption first: an existing exact
 * identity is adopted, never re-added. Adds are the module's only writes and
 * require an enabled, fully specified delivery. After any nontrivial
 * submission outcome the decision is made by an exact-identity re-read, not
 * by guessing from status codes. */
export async function deliverToWhisparr(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrDeliveryResult> {
  const whisparr = requireWhisparr(config);
  const { id } = requireMediaReference(ref);
  // Explicit blocked condition — throws AppError delivery_disabled.
  const delivery = requireDelivery(config);

  const existing = await findWhisparrItem(config, ref);
  if (existing !== null) return { outcome: "adopted", item: existing };

  // Verify the identity is upstream-resolvable and take the title from the
  // verified lookup only.
  const resolved = await resolveWhisparrItem(config, ref);
  if (resolved.importExcluded === true) {
    // The lookup itself revealed the exclusion — a doomed add is skipped so
    // the blocked delivery explains itself instead of surfacing a generic
    // upstream rejection.
    return {
      outcome: "failed",
      reason: "Whisparr reports this identity as import-excluded.",
    };
  }
  const payload = buildMoviePayload(ref, resolved.title, delivery);

  let created: unknown;
  try {
    created = await requestJson<unknown>(
      whisparr.url,
      "/api/v3/movie",
      whisparr.apiKey,
      { service: "whisparr", method: "POST", body: payload },
    );
  } catch (err) {
    const proven = err instanceof AppError ? err.upstreamStatus : undefined;
    if (proven !== undefined && proven >= 400 && proven < 500) {
      // Proven client-side rejection: never inferred as already-exists.
      // A positive exact-identity re-read is proof of adoption; a proven 404
      // is proof of absence.
      const again = await resolveAfterSubmission(config, ref);
      return again !== null && again !== "unknown"
        ? { outcome: "adopted", item: again }
        : { outcome: "failed", reason: "Whisparr rejected the add." };
    }
    // Timeout / 5xx / network: submission outcome unknown — re-resolve.
    const again = await resolveAfterSubmission(config, ref);
    if (again !== "unknown" && again !== null) {
      return { outcome: "accepted", item: again };
    }
    if (again === null) {
      return { outcome: "failed", reason: "Whisparr did not accept the add." };
    }
    return {
      outcome: "uncertain",
      reason: "Whisparr did not confirm the add outcome.",
    };
  }

  // 2xx: accept only a well-formed stored echo carrying the exact identity;
  // anything else falls back to the exact-identity re-read.
  const dto = created as MovieResourceDto;
  const routed = dto && typeof dto === "object" ? identityOf(dto) : null;
  const echoedId = dto?.id;
  if (
    routed !== null &&
    routed.itemType === ref.kind &&
    canonicalProviderId(routed.identity) === id &&
    Number.isInteger(echoedId) &&
    (echoedId as number) > 0
  ) {
    return { outcome: "accepted", item: mapStoredItem(dto) };
  }
  const again = await resolveAfterSubmission(config, ref);
  if (again !== "unknown" && again !== null) {
    return { outcome: "accepted", item: again };
  }
  return {
    outcome: "uncertain",
    reason: "Whisparr accepted the add but did not confirm the stored item.",
  };
}

// --- removal ladder (Velvarr M7) ---
// Explicit, separately callable destructive operations. Nothing here
// escalates on its own: unmonitor is exactly one PUT with monitored false;
// drop is exactly one DELETE whose query flags are the caller's explicit
// booleans (omitted means false — Whisparr's own defaults). Every
// destructive call gates on a configured connection and re-resolves the
// stored item by exact identity immediately before acting; no caller-
// supplied numeric id exists on this API, so a stale id can never select
// the wrong item. Outcome honesty: a proven 404 is already-gone and a
// SUCCESS; timeout, network failure, and proven 5xx are UNCERTAIN (the
// call may or may not have taken effect); any other proven 4xx is a
// definitive failure.

/** External facts observed before a destructive call — what the audit row
 * needs, and what a safe retry compares against. */
export interface WhisparrRemovalFacts {
  whisparrId: number;
  itemType: MediaKind;
  identity: string;
  path: string;
  fileCount: number;
  sizeOnDisk?: number;
  monitored: boolean;
  /** ISO-8601 `added` observed at resolution time. On a retry the caller
   * passes it back as expectAdded so freshly re-added content is never
   * deleted. */
  added?: string;
}

export type WhisparrRemovalResult =
  | { outcome: "done"; facts: WhisparrRemovalFacts }
  /** Success: the identity is provably absent, so the requested end state
   * already holds. facts is null when absence was proven before any call. */
  | { outcome: "already_gone"; facts: WhisparrRemovalFacts | null }
  /** The destructive call's effect could not be proven (timeout, network
   * failure, proven 5xx). facts was captured before the attempt; pass
   * facts.added back as expectAdded on the retry call. */
  | { outcome: "uncertain"; facts: WhisparrRemovalFacts; reason: string }
  /** Retry guard: the identity now resolves to an item whose `added`
   * differs from the captured attempt — possibly freshly re-added content.
   * Refused; nothing was sent. */
  | { outcome: "refused"; facts: WhisparrRemovalFacts; reason: string }
  /** Proven non-404 4xx rejection (a generic 400 is a failure, never
   * already-gone). */
  | { outcome: "failed"; facts: WhisparrRemovalFacts | null; reason: string };

function removalFacts(item: WhisparrItem): WhisparrRemovalFacts {
  return {
    whisparrId: item.whisparrId,
    itemType: item.itemType,
    identity: item.identity,
    path: item.path,
    fileCount: item.fileCount ?? (item.hasFile ? 1 : 0),
    ...(item.sizeOnDisk !== undefined ? { sizeOnDisk: item.sizeOnDisk } : {}),
    monitored: item.monitored,
    ...(item.added !== undefined ? { added: item.added } : {}),
  };
}

/** Same-instant comparison for the retry guard. A missing or unparsable
 * current timestamp can never be proven equal to the captured one, so the
 * guard refuses — comparison failure must never enable a delete. */
function sameAdded(current: string | undefined, captured: string): boolean {
  if (current === undefined) return false;
  const a = Date.parse(current);
  const b = Date.parse(captured);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
  return current === captured;
}

/** Map a ladder level to the query flags of the single Whisparr DELETE.
 * Higher rungs carry the effects of the rungs below on the one DELETE where
 * the API genuinely combines them: `exclude` adds addImportExclusion and
 * `delete_files` adds deleteFiles on top. `unmonitor` is the separate PUT
 * and `delete_jellyfin_item` is a Jellyfin-side operation, so neither maps
 * to a Whisparr DELETE (null). */
export function whisparrRemovalFlags(
  level: RemovalLevel,
): { deleteFiles: boolean; addImportExclusion: boolean } | null {
  switch (level) {
    case "drop":
      return { deleteFiles: false, addImportExclusion: false };
    case "exclude":
      return { deleteFiles: false, addImportExclusion: true };
    case "delete_files":
      return { deleteFiles: true, addImportExclusion: true };
    case "unmonitor":
    case "delete_jellyfin_item":
      return null;
    default:
      throw new AppError(400, "invalid_level", "Unknown removal level.");
  }
}

/** Map a destructive-call failure to an honest outcome. A proven 404 means
 * the item is already gone — SUCCESS. Any other proven 4xx is definitive
 * rejection. A 2xx whose response payload was unreadable still proves the
 * server accepted the call (status checks run before body parsing), so it
 * is done. Timeout, network failure, and proven 5xx leave the effect
 * genuinely unknown — uncertain, never guessed in either direction. */
function removalCallOutcome(
  err: unknown,
  facts: WhisparrRemovalFacts,
): WhisparrRemovalResult {
  if (!(err instanceof AppError)) throw err;
  if (err.upstreamStatus === 404) return { outcome: "already_gone", facts };
  if (
    err.code === "upstream_bad_response" &&
    err.upstreamStatus === undefined
  ) {
    return { outcome: "done", facts };
  }
  if (err.upstreamStatus !== undefined && err.upstreamStatus < 500) {
    return { outcome: "failed", facts, reason: err.message };
  }
  return { outcome: "uncertain", facts, reason: err.message };
}

/** Shared preflight for every destructive call: a configured connection,
 * a validated reference, and an exact-identity re-resolution immediately
 * before acting. Absent identity is already-gone. When expectAdded is
 * supplied (a retry after an uncertain attempt), an item whose `added`
 * differs from the captured attempt is freshly re-added content: refuse
 * rather than act on it. Preflight failures throw — no destructive call
 * was issued, so there is nothing to report as uncertain. */
async function resolveForRemoval(
  config: IntegrationConfig,
  ref: MediaReference,
  expectAdded: string | undefined,
): Promise<
  | {
      proceed: true;
      whisparr: WhisparrEndpoint;
      dto: MovieResourceDto;
      item: WhisparrItem;
    }
  | { proceed: false; result: WhisparrRemovalResult }
> {
  const whisparr = requireWhisparr(config);
  requireMediaReference(ref);
  const dto = await findStoredMovieDto(config, ref);
  if (dto === null) {
    return { proceed: false, result: { outcome: "already_gone", facts: null } };
  }
  const item = mapStoredItem(dto);
  if (expectAdded !== undefined && !sameAdded(item.added, expectAdded)) {
    return {
      proceed: false,
      result: {
        outcome: "refused",
        facts: removalFacts(item),
        reason:
          "The identity now resolves to an item added after the captured attempt; refusing to act on possibly re-added content.",
      },
    };
  }
  return { proceed: true, whisparr, dto, item };
}

/** Ladder rung 1: unmonitor. Exactly one PUT /api/v3/movie/{id} carrying
 * the stored resource with monitored false. Never deletes — no DELETE is
 * ever issued by this function. */
export async function unmonitorWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
  options: { expectAdded?: string; timeoutMs?: number } = {},
): Promise<WhisparrRemovalResult> {
  const pre = await resolveForRemoval(config, ref, options.expectAdded);
  if (!pre.proceed) return pre.result;
  // Round-trip the stored resource with only monitored flipped: Whisparr's
  // PUT replaces the resource, so a partial body would wipe stored fields.
  const body: MovieResourceDto = { ...pre.dto, monitored: false };
  try {
    await requestJson<unknown>(
      pre.whisparr.url,
      `/api/v3/movie/${pre.item.whisparrId}`,
      pre.whisparr.apiKey,
      {
        service: "whisparr",
        method: "PUT",
        body,
        timeoutMs: options.timeoutMs,
      },
    );
  } catch (err) {
    return removalCallOutcome(err, removalFacts(pre.item));
  }
  return {
    outcome: "done",
    facts: { ...removalFacts(pre.item), monitored: false },
  };
}

/** Ladder rungs 2-4: drop. Exactly one DELETE /api/v3/movie/{id} whose
 * query flags are the caller's explicit booleans; omitted flags are false,
 * matching Whisparr's own defaults, so a plain drop never deletes files
 * and never adds an import exclusion. Files are deleted only when
 * deleteFiles was explicitly chosen. */
export async function dropWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
  options: {
    deleteFiles?: boolean;
    addImportExclusion?: boolean;
    expectAdded?: string;
    timeoutMs?: number;
  } = {},
): Promise<WhisparrRemovalResult> {
  const deleteFiles = options.deleteFiles === true;
  const addImportExclusion = options.addImportExclusion === true;
  const pre = await resolveForRemoval(config, ref, options.expectAdded);
  if (!pre.proceed) return pre.result;
  const facts = removalFacts(pre.item);
  const query = `deleteFiles=${deleteFiles}&addImportExclusion=${addImportExclusion}`;
  try {
    await requestJson<unknown>(
      pre.whisparr.url,
      `/api/v3/movie/${pre.item.whisparrId}?${query}`,
      pre.whisparr.apiKey,
      { service: "whisparr", method: "DELETE", timeoutMs: options.timeoutMs },
    );
  } catch (err) {
    return removalCallOutcome(err, facts);
  }
  return { outcome: "done", facts };
}
