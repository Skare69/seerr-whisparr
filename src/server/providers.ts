// Metadata provider catalog reads: TPDB (movies, scenes, performers) and
// StashDB (scenes, performers). Strictly read-only; returns validated
// CatalogDetail records and paged search results. No provider payload or
// image bytes are ever persisted — providers publish no caching/artwork
// terms, so every fetch is pass-through for one authorized request.
//
// Upstream shapes verified live 2026-09-10:
// - TPDB rows are flat objects (no JSON:API attributes wrapper). Release date
//   is `date` (YYYY-MM-DD); `created`/`last_updated` are record timestamps and
//   are never mapped to releaseDate.
// - TPDB listings report a FAKE total (capped at 10000) unless a countable
//   filter is applied (q, performer filmography); title-only filters still hit
//   the cap. `meta.links.next` is the only trustworthy continuation signal.
// - TPDB movie/scene credits embed the canonical parent performer
//   (performers[].parent, UUID id + numeric _id); filmography routes
//   /performers/{id}/{movies,scenes} accept both UUID and numeric _id.
// - TPDB 404 (including malformed ids) means not found; anything else that
//   fails is an outage with upstreamStatus set by the transport.
// - StashDB scene listing root is queryScenes(input: SceneQueryInput!) — NOT
//   findScenes. findScene/findPerformer return data null at HTTP 200 for
//   missing ids (authoritative absence); schema failures surface as 422.
// - searchPerformers(term) returns a real count but at most ~10 rows and has
//   no paging; its result set is complete-but-capped by the provider.
// - StashDB serves performer images from stashdb.org/images/<uuid>; TPDB
//   normalizes all artwork onto cdn.theporndb.net / thumb.theporndb.net.
//   Raw `image` fields on TPDB rows point at unbounded studio CDNs and are
//   deliberately never emitted or proxied.
// - Verified live 2026-09-11: TPDB /sites rows are {uuid, id (numeric),
//   name, url, description?, logo/poster/favicon on cdn.theporndb.net,
//   nested network/parent site rows}; /sites/{id} accepts uuid or numeric
//   id, but scene/movie `site_id` filters accept only the NUMERIC id (a
//   uuid 422s). /tags rows are {id (numeric), uuid, name}. TPDB
//   tags[]/tag_and (and performer) filter params were observed accepting
//   requests but returning zero rows live on 2026-09-11 — passed through
//   as-is; the provider owns their results. site_id-filtered listings
//   reported real totals; title-only q still hits the fake 10000 cap.
// - StashDB searchStudio(term, limit) and searchTag(term, limit) return
//   flat [Studio]/[Tag] lists with no count (unpaged, provider-capped);
//   queryScenes accepts studios/tags criteria with INCLUDES/EXCLUDES plus
//   sort/direction (TRENDING and POPULARITY verified live). SceneQueryInput
//   also takes parentStudio (a plain ID string, verified live 2026-09-11 —
//   scenes under that studio's child rows; mutually exclusive with studios,
//   which is a MultiIDCriterionInput). StudioSortEnum
//   has no trending order, so studio search exposes no sort at all. StashDB
//   studio records carry explicit provider URLs, but cross-provider linking
//   stays performer-level only — studios are never merged across providers.

import { AppError, requestJson, requestBytes } from "./http.ts";
import type {
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  MediaKind,
} from "../lib/contracts.ts";

// --- credentials and bases: read from the environment at call time; values
// are never logged, echoed, or placed in URLs ---

function tpdbGet<T>(path: string): Promise<T> {
  const token = process.env.TPDB_API_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    throw notConfigured("tpdb");
  }
  const base =
    typeof process.env.TPDB_BASE_URL === "string" &&
    process.env.TPDB_BASE_URL.trim() !== ""
      ? process.env.TPDB_BASE_URL
      : "https://api.theporndb.net";
  return requestJson<T>(base, path, token, { service: "tpdb" });
}

function notConfigured(provider: "tpdb" | "stashdb"): AppError {
  return new AppError(
    503,
    "provider_not_configured",
    `${provider === "tpdb" ? "TPDB" : "StashDB"} credentials are not configured.`,
  );
}

async function stashQuery(
  query: string,
  variables: Record<string, unknown>,
  dataKey: string,
): Promise<unknown> {
  const token = process.env.STASHDB_API_KEY;
  if (typeof token !== "string" || token.trim() === "") {
    throw notConfigured("stashdb");
  }
  const base =
    typeof process.env.STASHDB_BASE_URL === "string" &&
    process.env.STASHDB_BASE_URL.trim() !== ""
      ? process.env.STASHDB_BASE_URL
      : "https://stashdb.org";
  const body = await requestJson<{
    data?: Record<string, unknown> | null;
    errors?: unknown;
  }>(base, "/graphql", token, {
    service: "stashdb",
    method: "POST",
    body: { query, variables },
  });
  // HTTP-level failures (401 auth, 422 schema, 5xx outage) already surfaced
  // by the transport with upstreamStatus. data:null at HTTP 200 is the
  // authoritative absence signal for find* queries.
  if (
    body === null ||
    typeof body !== "object" ||
    body.data === null ||
    body.data === undefined
  ) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable response.",
    );
  }
  const value = body.data[dataKey];
  return value === undefined ? null : value;
}

// --- shared normalizers: reject bad upstream data, never invent values ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parts = v.split("-").map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const d = parts[2] ?? 0;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return (
    utc.getUTCFullYear() === y &&
    utc.getUTCMonth() === m - 1 &&
    utc.getUTCDate() === d
  );
}

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function cleanDuration(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const s = Math.round(v);
  return s >= 1 && s <= 86_400 ? s : undefined; // absurd durations are dropped
}

function httpsUrl(v: unknown): string | undefined {
  const s = cleanString(v, 2048);
  if (s === undefined) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password
      ? s
      : undefined;
  } catch {
    return undefined;
  }
}

const MAX = {
  credits: 50,
  tags: 50,
  aliases: 25,
  related: 50,
  links: 30,
  title: 300,
  description: 6000,
  name: 200,
};

function dedupeBy<T>(rows: T[], key: (row: T) => string | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (k === undefined || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

// --- artwork: provider-hosted images only, pass-through, never persisted ---

// Allowlist derived from live records 2026-09-10: every provider-normalized
// artwork URL observed (TPDB posters/background/image/thumbnail/face, StashDB
// performer images) resolves to one of these hosts. Studio-hosted `image`
// fields (gammacdn, clips4sale, karups, adultempire, ...) are unbounded and
// intentionally excluded, so emitted imageUrl values are always proxyable.
const PROVIDER_IMAGE_HOSTS: Record<string, true> = {
  "cdn.theporndb.net": true,
  "thumb.theporndb.net": true,
  "stashdb.org": true,
};

const RASTER_IMAGE_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
  "image/avif": true,
};

export const IMAGE_BYTE_CAP = 8 * 1024 * 1024;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

export type ImageUrlCheck =
  { ok: true; service: "tpdb" | "stashdb" } | { ok: false; reason: string };

/** Pure gate: is this URL a provider-hosted raster artwork source? Loopback
 * plain http is accepted only as the local test fixture seam (mirrors the
 * lab-HTTP stance in http.ts); production hosts must be https. */
export function isProviderImageUrl(url: string): ImageUrlCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  if (u.protocol !== "https:" && !isLoopbackHost(u.hostname)) {
    return { ok: false, reason: "artwork URLs must be https" };
  }
  if (u.username || u.password || u.hash) {
    return { ok: false, reason: "artwork URLs must not carry credentials" };
  }
  if (
    PROVIDER_IMAGE_HOSTS[u.hostname] !== true &&
    !isLoopbackHost(u.hostname)
  ) {
    return {
      ok: false,
      reason: `host ${u.hostname} is not a provider artwork host`,
    };
  }
  return {
    ok: true,
    service: u.hostname.endsWith("theporndb.net") ? "tpdb" : "stashdb",
  };
}

function servableImage(v: unknown): string | undefined {
  const s = httpsUrl(v);
  return s !== undefined && isProviderImageUrl(s).ok ? s : undefined;
}

/** Fetch artwork bytes for a URL previously seen on a validated provider
 * record. Never sends provider credentials, never follows redirects (the
 * transport errors on 3xx), never persists anything. */
export async function fetchProviderArtwork(
  url: string,
  options: { timeoutMs?: number; sizeLimit?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const check = isProviderImageUrl(url);
  if (!check.ok) {
    throw new AppError(
      400,
      "invalid_artwork_url",
      `Rejected artwork URL: ${check.reason}.`,
    );
  }
  const u = new URL(url);
  // ponytail: requestBytes rejoins origin+pathname, dropping any query string;
  // provider artwork URLs carry none today — a future query-bearing URL fails
  // visibly at the CDN instead of silently changing what is served.
  const { bytes, contentType } = await requestBytes(u.origin, u.pathname, "", {
    service: check.service,
    timeoutMs: options.timeoutMs,
    sizeLimit: options.sizeLimit ?? IMAGE_BYTE_CAP,
  });
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (RASTER_IMAGE_TYPES[mime] !== true) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Artwork content type is not a raster image.",
    );
  }
  return { bytes, contentType };
}

// --- TPDB mapping ---

interface TpdbPerson {
  id?: unknown;
  name?: unknown;
  image?: unknown;
  thumbnail?: unknown;
  face?: unknown;
  parent?: TpdbPerson | null;
}

/** Credits resolve canonical identity through performers[].parent.id (the
 * canonical performer UUID), falling back to the row id itself. Deduplicated
 * by provider id, never by name. */
function tpdbCredits(rows: unknown): CatalogCreditAcc[] {
  if (!Array.isArray(rows)) return [];
  const mapped: CatalogCreditAcc[] = [];
  for (const row of rows.slice(0, MAX.credits * 2)) {
    const person = (row ?? {}) as TpdbPerson;
    const canonical = person.parent ?? person;
    const id = isUuid(canonical.id)
      ? canonical.id
      : isUuid(person.id)
        ? person.id
        : undefined;
    const name =
      cleanString(person.name, MAX.name) ??
      cleanString(canonical.name, MAX.name);
    if (id === undefined || name === undefined) continue;
    const imageUrl =
      servableImage(canonical.image) ?? servableImage(person.image);
    mapped.push({
      reference: { provider: "tpdb", kind: "performer", id },
      name,
      ...(imageUrl !== undefined ? { imageUrl } : {}),
    });
  }
  return dedupeBy(mapped, (c) => c.reference.id).slice(0, MAX.credits);
}

interface CatalogCreditAcc {
  reference: CatalogReference;
  name: string;
  imageUrl?: string;
}

function tpdbTags(rows: unknown): { id: string; name: string }[] {
  if (!Array.isArray(rows)) return [];
  const out: { id: string; name: string }[] = [];
  for (const row of rows.slice(0, MAX.tags * 2)) {
    const t = (row ?? {}) as { id?: unknown; uuid?: unknown; name?: unknown };
    const name = cleanString(t.name, 120);
    const id = isUuid(t.uuid)
      ? t.uuid
      : isUuid(t.id)
        ? t.id
        : typeof t.id === "number" && Number.isInteger(t.id)
          ? String(t.id)
          : undefined;
    if (id === undefined || name === undefined) continue;
    out.push({ id, name });
  }
  return dedupeBy(out, (t) => t.id).slice(0, MAX.tags);
}

function tpdbRelated(
  rows: unknown,
  kind: "movie" | "scene",
): CatalogReference[] {
  if (!Array.isArray(rows)) return [];
  const refs: CatalogReference[] = [];
  for (const row of rows.slice(0, MAX.related * 2)) {
    const id = (row as { id?: unknown } | null)?.id;
    if (isUuid(id)) refs.push({ provider: "tpdb", kind, id });
  }
  return dedupeBy(refs, (r) => r.id).slice(0, MAX.related);
}

function tpdbMediaDetail(
  kind: "movie" | "scene",
  row: unknown,
): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const title = cleanString(r.title, MAX.title);
  if (!isUuid(id) || title === undefined) return undefined;
  const site = r.site as Record<string, unknown> | null | undefined;
  const studioName = cleanString(site?.name, MAX.name);
  const siteUuid = (site as { uuid?: unknown } | null | undefined)?.uuid;
  const description = cleanString(r.description, MAX.description);
  const duration = cleanDuration(r.duration);
  const imageUrl =
    servableImage((r.posters as Record<string, unknown> | null)?.full) ??
    servableImage((r.background as Record<string, unknown> | null)?.large);
  const sourceUrl = httpsUrl(r.url);
  return {
    reference: { provider: "tpdb", kind, id },
    title,
    ...(description !== undefined ? { description } : {}),
    // release date only from `date`; `created`/`last_updated` are record
    // timestamps and deliberately never mapped here.
    ...(isIsoDate(r.date) ? { releaseDate: r.date } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(studioName !== undefined
      ? {
          studio: {
            name: studioName,
            ...(isUuid(siteUuid)
              ? {
                  reference: {
                    provider: "tpdb",
                    kind: "studio",
                    id: siteUuid,
                  },
                }
              : {}),
          },
        }
      : {}),
    credits: tpdbCredits(r.performers),
    tags: tpdbTags(r.tags),
    // Movies embed their scenes; scenes embed their movies.
    related: tpdbRelated(
      kind === "movie" ? r.scenes : r.movies,
      kind === "movie" ? "scene" : "movie",
    ),
    links:
      sourceUrl !== undefined
        ? [
            {
              url: sourceUrl,
              ...(studioName !== undefined ? { label: studioName } : {}),
            },
          ]
        : [],
    aliases: [],
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

function tpdbPerformerDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = cleanString(r.name, MAX.name);
  if (!isUuid(id) || name === undefined) return undefined;
  const extras = (r.extras ?? {}) as Record<string, unknown>;
  const links: { url: string; label?: string }[] = [];
  if (extras.links !== null && typeof extras.links === "object") {
    for (const [label, url] of Object.entries(
      extras.links as Record<string, unknown>,
    )) {
      const u = httpsUrl(url);
      if (u === undefined) continue;
      links.push({ url: u, label: cleanString(label, 60) });
      if (links.length >= MAX.links) break;
    }
  }
  const imageUrl =
    servableImage(r.image) ??
    servableImage(r.thumbnail) ??
    servableImage(r.face);
  const aliases = (Array.isArray(r.aliases) ? r.aliases : [])
    .map((a) => cleanString(a, 120))
    .filter((a): a is string => a !== undefined)
    .slice(0, MAX.aliases);
  const bio = cleanString(r.bio, MAX.description);
  return {
    reference: { provider: "tpdb", kind: "performer", id },
    title: name,
    ...(bio !== undefined ? { description: bio } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    credits: [],
    tags: [],
    related: [],
    links,
    aliases,
  };
}

/** TPDB site (studio) rows: {uuid, id (numeric), name, url, description?,
 * logo/poster on cdn.theporndb.net, nested network/parent site rows}. The
 * uuid is the canonical identity; numeric id only as a fallback. The parent
 * relationship is mapped only from provider-supplied parent/network rows —
 * never invented. Favicon is provider-hosted but deliberately not used. */
function tpdbStudioDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = isUuid(r.uuid)
    ? r.uuid
    : typeof r.id === "number" && Number.isInteger(r.id)
      ? String(r.id)
      : undefined;
  const name = cleanString(r.name, MAX.name);
  if (id === undefined || name === undefined) return undefined;
  const imageUrl = servableImage(r.poster) ?? servableImage(r.logo);
  const description = cleanString(r.description, MAX.description);
  const sourceUrl = httpsUrl(r.url);
  const parent = r.parent ?? r.network;
  const parentRow = (parent ?? null) as Record<string, unknown> | null;
  const parentName = cleanString(parentRow?.name, MAX.name);
  const parentId = isUuid(parentRow?.uuid)
    ? parentRow.uuid
    : typeof parentRow?.id === "number" && Number.isInteger(parentRow.id)
      ? String(parentRow.id)
      : undefined;
  return {
    reference: { provider: "tpdb", kind: "studio", id },
    title: name,
    ...(description !== undefined ? { description } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(parentName !== undefined && parentId !== undefined
      ? {
          studio: {
            name: parentName,
            reference: { provider: "tpdb", kind: "studio", id: parentId },
          },
        }
      : {}),
    credits: [],
    tags: [],
    related: [],
    links: sourceUrl !== undefined ? [{ url: sourceUrl, label: name }] : [],
    aliases: [],
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

// --- StashDB mapping ---

interface StashScenePerformer {
  as?: unknown;
  performer?: {
    id?: unknown;
    name?: unknown;
    deleted?: unknown;
    images?: { url?: unknown }[] | null;
  } | null;
}

function stashImageUrl(images: unknown): string | undefined {
  if (!Array.isArray(images)) return undefined;
  for (const img of images.slice(0, 5)) {
    const url = servableImage((img as { url?: unknown } | null)?.url);
    if (url !== undefined) return url;
  }
  return undefined;
}

function stashLinks(rows: unknown): { url: string; label?: string }[] {
  if (!Array.isArray(rows)) return [];
  const out: { url: string; label?: string }[] = [];
  for (const row of rows.slice(0, MAX.links * 2)) {
    const r = (row ?? {}) as { url?: unknown; type?: unknown };
    const url = httpsUrl(r.url);
    if (url === undefined) continue;
    out.push({ url, label: cleanString(r.type, 60) });
  }
  return dedupeBy(out, (l) => l.url).slice(0, MAX.links);
}

function stashCredits(rows: unknown): CatalogCreditAcc[] {
  if (!Array.isArray(rows)) return [];
  const out: CatalogCreditAcc[] = [];
  for (const row of rows.slice(0, MAX.credits * 2)) {
    const entry = (row ?? {}) as StashScenePerformer;
    const p = entry.performer;
    const id = p === null || p === undefined ? undefined : p.id;
    if (!isUuid(id) || p?.deleted === true) continue;
    const name =
      cleanString(entry.as, MAX.name) ?? cleanString(p?.name, MAX.name);
    if (id === undefined || name === undefined) continue;
    const imageUrl = stashImageUrl(p?.images);
    out.push({
      reference: { provider: "stashdb", kind: "performer", id },
      name,
      ...(imageUrl !== undefined ? { imageUrl } : {}),
    });
  }
  return dedupeBy(out, (c) => c.reference.id).slice(0, MAX.credits);
}

function stashSceneDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const title =
    cleanString(r.title, MAX.title) ?? cleanString(r.code, MAX.title);
  if (!isUuid(id) || title === undefined) return undefined;
  const studio = r.studio as Record<string, unknown> | null | undefined;
  const studioName = cleanString(studio?.name, MAX.name);
  const studioId = studio?.id;
  const details = cleanString(r.details, MAX.description);
  const duration = cleanDuration(r.duration);
  const imageUrl = stashImageUrl(r.images);
  const links = stashLinks(r.urls);
  return {
    reference: { provider: "stashdb", kind: "scene", id },
    title,
    ...(details !== undefined ? { description: details } : {}),
    ...(isIsoDate(r.date) ? { releaseDate: r.date } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(studioName !== undefined
      ? {
          studio: {
            name: studioName,
            ...(isUuid(studioId)
              ? {
                  reference: {
                    provider: "stashdb",
                    kind: "studio",
                    id: studioId,
                  },
                }
              : {}),
          },
        }
      : {}),
    credits: stashCredits(r.performers),
    tags: tpdbTags(r.tags), // StashDB tags share the TPDB {id, name} shape
    related: [],
    links,
    aliases: [],
  };
}

function stashPerformerDetail(row: unknown): CatalogDetail | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = cleanString(r.name, MAX.name);
  if (!isUuid(id) || name === undefined) return undefined;
  const aliases = (Array.isArray(r.aliases) ? r.aliases : [])
    .map((a) => cleanString(a, 120))
    .filter((a): a is string => a !== undefined)
    .slice(0, MAX.aliases);
  const imageUrl = stashImageUrl(r.images);
  const links = stashLinks(r.urls);
  return {
    reference: { provider: "stashdb", kind: "performer", id },
    title: name,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    credits: [],
    tags: [],
    related: [],
    links,
    aliases,
  };
}

/** StashDB Studio: {id, name, deleted, urls, images, parent, child_studios}.
 * Deleted rows are unusable everywhere (authoritative absence), so they never
 * map; the parent studio is mapped only when the provider supplies one. */
function stashStudioDetail(
  row: unknown,
): (CatalogDetail & { childStudioCount?: number }) | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id;
  const name = cleanString(r.name, MAX.name);
  if (!isUuid(id) || name === undefined) return undefined;
  if (r.deleted === true) return undefined;
  const parent = r.parent as Record<string, unknown> | null | undefined;
  const parentName = cleanString(parent?.name, MAX.name);
  const parentId = parent?.id;
  const imageUrl = stashImageUrl(r.images);
  const links = stashLinks(r.urls);
  // Provider-supplied structural hint only: an absent child_studios field
  // stays absent (unknown), a supplied empty list is a real zero. Never
  // invented for providers that do not expose one.
  const childStudioCount = Array.isArray(r.child_studios)
    ? r.child_studios.filter((c) => {
        if (c === null || typeof c !== "object" || !("id" in c)) return false;
        return isUuid(c.id);
      }).length
    : undefined;
  return {
    reference: { provider: "stashdb", kind: "studio", id },
    title: name,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(parentName !== undefined && isUuid(parentId)
      ? {
          studio: {
            name: parentName,
            reference: { provider: "stashdb", kind: "studio", id: parentId },
          },
        }
      : {}),
    ...(childStudioCount !== undefined ? { childStudioCount } : {}),
    credits: [],
    tags: [],
    related: [],
    links,
    aliases: [],
  };
}

// --- public interface ---

export type ProviderVerification =
  | { provider: "tpdb" | "stashdb"; configured: false }
  | {
      provider: "tpdb" | "stashdb";
      configured: true;
      verified: true;
      account: string;
    };

/** One cheap authenticated read-only call: TPDB GET /user, StashDB `me`.
 * Not-configured is returned, never faked; outages and auth failures throw
 * AppError so callers never confuse them with an empty catalog. */
export async function getProviderStatus(
  provider: "tpdb" | "stashdb",
): Promise<ProviderVerification> {
  try {
    if (provider === "tpdb") {
      const res = await tpdbGet<{ data?: { name?: unknown } }>("/user");
      const name = cleanString(res?.data?.name, 120);
      return {
        provider,
        configured: true,
        verified: true,
        account: name ?? "unknown",
      };
    }
    const res = (await stashQuery(
      "query { me { id name roles } }",
      {},
      "me",
    )) as { name?: unknown } | null;
    if (res === null || typeof res !== "object") {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable identity response.",
      );
    }
    const name = cleanString(res.name, 120);
    return {
      provider,
      configured: true,
      verified: true,
      account: name ?? "unknown",
    };
  } catch (err) {
    // Not-configured is returned, never thrown: callers distinguish it from
    // outages and auth failures, which still surface as AppError.
    if (err instanceof AppError && err.code === "provider_not_configured") {
      return { provider, configured: false };
    }
    throw err;
  }
}

/** Normalized sort vocabulary. Only orders the providers genuinely implement
 * appear here; the page surfaces the exact upstream order that was applied. */
export type CatalogSortKey =
  | "relevance"
  | "recency"
  | "duration"
  | "title"
  | "date"
  | "created"
  | "updated"
  | "trending"
  | "popularity";

export type CatalogSortDirection = "asc" | "desc";

export interface AppliedSort {
  key: CatalogSortKey;
  /** Absent only for TPDB relevance, which has no direction upstream. */
  direction?: CatalogSortDirection;
  /** The exact upstream order token that was sent. */
  upstream: string;
}

/** Resolves a requested sort for a provider+kind to the exact upstream order.
 * Throws the explicit invalid-query error for any order the provider does not
 * implement — trending and popularity are StashDB scene-only; TPDB has
 * neither. TPDB recency maps to release recency (recently_released /
 * former_released); its created/updated RECORD orders are deliberately not
 * aliased onto release recency. */
export function resolveSort(
  provider: CatalogProvider,
  kind: MediaKind,
  sort: CatalogSortKey,
  direction?: CatalogSortDirection,
): AppliedSort {
  if (kind !== "movie" && kind !== "scene") {
    throw new AppError(
      400,
      "invalid_search",
      "Sorts apply to movie and scene search only.",
    );
  }
  if (provider === "tpdb") {
    if (sort === "relevance") {
      if (direction !== undefined) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB relevance order takes no direction.",
        );
      }
      return { key: sort, upstream: "most_relevant" };
    }
    if (sort === "recency") {
      const dir = direction ?? "desc";
      return {
        key: sort,
        direction: dir,
        upstream: dir === "desc" ? "recently_released" : "former_released",
      };
    }
    if (sort === "duration") {
      const dir = direction ?? "desc";
      return {
        key: sort,
        direction: dir,
        upstream: dir === "desc" ? "duration_desc" : "duration_asc",
      };
    }
    throw new AppError(
      400,
      "invalid_search",
      `TPDB implements no ${sort} order; only relevance, recency, and duration exist.`,
    );
  }
  if (kind !== "scene") {
    throw new AppError(
      400,
      "invalid_search",
      "StashDB has no movie entity; sorts apply to scene search only.",
    );
  }
  const stashdbSceneSorts: Record<
    | "title"
    | "date"
    | "duration"
    | "trending"
    | "popularity"
    | "created"
    | "updated",
    string
  > = {
    title: "TITLE",
    date: "DATE",
    duration: "DURATION",
    trending: "TRENDING",
    popularity: "POPULARITY",
    created: "CREATED_AT",
    updated: "UPDATED_AT",
  };
  if (sort === "relevance" || sort === "recency") {
    throw new AppError(
      400,
      "invalid_search",
      `StashDB implements no ${sort} order for scenes; relevance and recency are TPDB-only.`,
    );
  }
  const upstream = stashdbSceneSorts[sort];
  return { key: sort, direction: direction ?? "desc", upstream };
}

/** Paged search query. Filters are explicit per provider+kind; combinations
 * the upstream cannot express are rejected rather than silently ignored.
 * `performer` on tpdb movie/scene is the canonical TPDB performer UUID and
 * switches to the filmography route (paging only there); on a stashdb scene
 * it uses the performers INCLUDES criterion. `studio` filters by the
 * provider's own studio id (TPDB resolves a site UUID to its numeric
 * site_id; StashDB uses the studios INCLUDES criterion); `tags`/`tagsAll`/
 * `tagsExclude` stay provider-native tag ids. `sort`/`direction` map through
 * resolveSort to each provider's real orders — unsupported combinations
 * throw. Studio and performer searches take no filters. */
export type CatalogSearchQuery =
  | {
      provider: "tpdb";
      kind: "movie";
      query?: string;
      year?: number;
      performer?: string;
      studio?: string;
      tags?: string[];
      tagsAll?: string[];
      /** Bounded release-date filter, TPDB-native `date` + `date_operation`.
       * Only the operator strings TPDB actually accepts are exposed (<=, <, =,
       * >, >= verified live 2026-09-11; word forms are upstream 422). Rejected
       * explicitly for every other provider+kind — StashDB scenes have their
       * own date criterion with modifiers, which is never emulated here. */
      releaseDate?: {
        cutoff: string;
        operation: ReleaseDateOperation;
      };
      sort?: CatalogSortKey;
      direction?: CatalogSortDirection;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "scene";
      query?: string;
      year?: number;
      performer?: string;
      studio?: string;
      tags?: string[];
      tagsAll?: string[];
      releaseDate?: {
        cutoff: string;
        operation: ReleaseDateOperation;
      };
      sort?: CatalogSortKey;
      direction?: CatalogSortDirection;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "performer";
      query: string;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "studio";
      query: string;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "stashdb";
      kind: "scene";
      query?: string;
      performer?: string;
      studio?: string;
      /** Only real on a StashDB scene search paired with `studio`. Omitted or
       * "exact" keeps the studios INCLUDES criterion (this studio only);
       * "withChildren" issues the parentStudio criterion instead so scenes
       * living under child studios are included. Rejected for TPDB (no
       * equivalent criterion), other kinds, or a missing studio. */
      studioMode?: "exact" | "withChildren";
      tags?: string[];
      tagsExclude?: string[];
      sort?: CatalogSortKey;
      direction?: CatalogSortDirection;
      page?: number;
      perPage?: number;
    }
  | { provider: "stashdb"; kind: "performer"; query: string }
  | { provider: "stashdb"; kind: "studio"; query: string };
/** TPDB date_operation values verified live 2026-09-11 on /movies and
 * /scenes: only these operator strings; every word form (lte, before, ...)
 * is an upstream 422. `date` without an operation is an exact-match filter,
 * so the route and this provider always emit the pair together. */
export type ReleaseDateOperation = "<" | "<=" | "=" | ">" | ">=";

const RELEASE_DATE_OPS: readonly ReleaseDateOperation[] = [
  "<",
  "<=",
  "=",
  ">",
  ">=",
];

function isReleaseDateOperation(v: unknown): v is ReleaseDateOperation {
  return (
    typeof v === "string" &&
    RELEASE_DATE_OPS.some((operation) => operation === v)
  );
}

/** Validates the bounded release-date filter: a real calendar cutoff date
 * paired with an upstream-accepted operation. Anything else is an explicit
 * 400, never a silently dropped bound. */
function cleanReleaseDate(
  v: unknown,
): { cutoff: string; operation: ReleaseDateOperation } | undefined {
  if (v === undefined) return undefined;
  const raw =
    typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : undefined;
  const cutoff = raw?.cutoff;
  const operation = raw?.operation;
  if (!isIsoDate(cutoff) || !isReleaseDateOperation(operation)) {
    throw new AppError(
      400,
      "invalid_search",
      "releaseDate requires an ISO cutoff date (YYYY-MM-DD) and an operation of <, <=, =, >, or >=.",
    );
  }
  return { cutoff, operation };
}

export interface CatalogSearchPage {
  provider: "tpdb" | "stashdb";
  kind: "movie" | "scene" | "performer" | "studio";
  page: number;
  perPage: number;
  /** Present only when the query requested a sort: the exact order the
   * provider applied, so shelves can be labeled truthfully. */
  sort?: AppliedSort;
  /** True only when the provider offers a real next page. */
  hasMore: boolean;
  /** Present only when the provider's count is genuinely real. TPDB's
   * unfiltered (and title-only-filtered) listings report a fake 10000 cap;
   * those surface as totalCountKnown: false with no total. */
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
}

const DEFAULT_PER_PAGE = 24;
const TPDB_FAKE_TOTAL = 10000;

function cleanQueryTerm(v: unknown): string | undefined {
  return cleanString(v, 200);
}

function cleanYear(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2100
    ? v
    : undefined;
}

function requireTpdbPerformerId(v: unknown): string {
  if (!isUuid(v)) {
    throw new AppError(
      400,
      "invalid_reference",
      "TPDB filmography requires a canonical TPDB performer UUID.",
    );
  }
  return v;
}

function requireStashPerformerId(v: unknown): string {
  if (!isUuid(v)) {
    throw new AppError(
      400,
      "invalid_reference",
      "StashDB scene filters require a StashDB performer UUID.",
    );
  }
  return v;
}

function requireStashStudioId(v: unknown): string {
  if (!isUuid(v)) {
    throw new AppError(
      400,
      "invalid_reference",
      "StashDB scene studio filters require a StashDB studio UUID.",
    );
  }
  return v;
}

/** Tag filter ids stay provider-native: UUIDs on both providers, deduplicated,
 * capped. An empty array is a no-op filter, not an unsupported one. */
function cleanTagIds(
  v: unknown,
  provider: "TPDB" | "StashDB",
): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new AppError(
      400,
      "invalid_search",
      `Tag filters must be arrays of ${provider} tag UUIDs.`,
    );
  }
  const ids: string[] = [];
  for (const entry of v.slice(0, 25)) {
    const s = cleanString(entry, 64);
    if (s === undefined || !isUuid(s)) {
      throw new AppError(
        400,
        "invalid_search",
        `${provider} tag filters require ${provider} tag UUIDs.`,
      );
    }
    if (!ids.includes(s)) ids.push(s);
  }
  return ids.length > 0 ? ids : undefined;
}

/** Runtime guard for variants whose type already omits filter fields: JSON
 * callers can smuggle fields in, and an unsupported filter must never be
 * silently dropped. */
function rejectUnusedFilters(
  raw: Record<string, unknown>,
  message: string,
): void {
  for (const field of [
    "studio",
    "tags",
    "tagsAll",
    "tagsExclude",
    "sort",
    "direction",
  ]) {
    if (raw[field] !== undefined) {
      throw new AppError(400, "invalid_search", message);
    }
  }
}

/** TPDB filters scenes/movies by NUMERIC site_id (verified live 2026-09-11:
 * a uuid is rejected upstream), while site identity everywhere else is the
 * uuid. A uuid filter value is resolved once through /sites/{uuid}; a numeric
 * string passes straight through. */
async function resolveTpdbStudioFilter(
  v: unknown,
): Promise<string | undefined> {
  const s = cleanString(v, 64);
  if (s === undefined) return undefined;
  if (/^\d+$/.test(s)) return s;
  if (isUuid(s)) {
    const body = await tpdbGet<{ data?: { id?: unknown } }>(`/sites/${s}`);
    const row = (body?.data ?? null) as { id?: unknown } | null;
    if (typeof row?.id === "number" && Number.isInteger(row.id)) {
      return String(row.id);
    }
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB returned an unusable site record.",
    );
  }
  throw new AppError(
    400,
    "invalid_reference",
    "TPDB studio filters require a TPDB site UUID or numeric site id.",
  );
}

interface TpdbListBody {
  data?: unknown;
  links?: { next?: unknown };
  meta?: { total?: unknown };
}

function parseTpdbPage(
  kind: "movie" | "scene" | "performer" | "studio",
  body: TpdbListBody,
  map: (row: unknown) => CatalogDetail | undefined,
  page: number,
  perPage: number,
): CatalogSearchPage {
  if (!Array.isArray(body.data)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB returned an unusable listing.",
    );
  }
  const items = dedupeBy(
    body.data
      .slice(0, perPage * 2)
      .map(map)
      .filter((d): d is CatalogDetail => d !== undefined),
    (d) => `${d.reference.kind}:${d.reference.id}`,
  );
  // rows > 0 AND a provider-issued next link: TPDB clamps beyond-end pages
  // and emits no next link there, so this terminates even under fake totals.
  const hasMore = items.length > 0 && typeof body.links?.next === "string";
  const rawTotal = body.meta?.total;
  const totalReal =
    typeof rawTotal === "number" &&
    Number.isInteger(rawTotal) &&
    rawTotal >= 1 &&
    rawTotal < TPDB_FAKE_TOTAL;
  return {
    provider: "tpdb",
    kind,
    page,
    perPage,
    hasMore,
    ...(totalReal ? { total: rawTotal } : {}),
    totalCountKnown: totalReal,
    items,
  };
}

function tpdbQuery(
  base: Record<string, string | number | string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(`${k}[]`, item);
      continue;
    }
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
}

/** Paged catalog search. Never merges results across providers; every item is
 * source-labeled via its CatalogReference. */
export async function searchCatalog(
  query: CatalogSearchQuery,
): Promise<CatalogSearchPage> {
  // StashDB performer and studio searches are the genuinely unpaged shapes:
  // searchPerformers/searchStudio take no page arguments and cap rows. They
  // are dispatched before the paging defaults so every remaining query
  // variant genuinely accepts page/perPage.
  const raw = query as Record<string, unknown>;
  // studioMode is real only on a StashDB scene search paired with a studio
  // filter. Every other carrier — TPDB (no parentStudio criterion), other
  // kinds, or a missing studio — is rejected before any upstream request;
  // parent inclusion is never emulated by widening another provider's query.
  if (raw.studioMode !== undefined) {
    if (query.provider !== "stashdb" || query.kind !== "scene") {
      throw new AppError(
        400,
        "invalid_search",
        "studioMode is only supported on StashDB scene searches.",
      );
    }
    if (query.studio === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "studioMode requires a studio filter.",
      );
    }
  }
  // releaseDate is real only on TPDB movie/scene searches (upstream `date` +
  // `date_operation`). Every other carrier is rejected before any upstream
  // request — a bound is never silently dropped, and StashDB's date criterion
  // with modifiers is never emulated through it.
  if (raw.releaseDate !== undefined) {
    if (
      query.provider !== "tpdb" ||
      (query.kind !== "movie" && query.kind !== "scene")
    ) {
      throw new AppError(
        400,
        "invalid_search",
        "releaseDate is only supported on TPDB movie and scene searches.",
      );
    }
  }
  if (query.provider === "stashdb" && query.kind === "performer") {
    rejectUnusedFilters(
      raw,
      "StashDB performer search supports only a query term.",
    );
    const q = cleanQueryTerm(query.query);
    if (q === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "StashDB performer search requires a query term.",
      );
    }
    const res = (await stashQuery(
      "query($t: String!) { searchPerformers(term: $t) { count performers { id name deleted images { url } } } }",
      { t: q },
      "searchPerformers",
    )) as { count?: unknown; performers?: unknown } | null;
    if (res === null || typeof res !== "object") {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable performer search.",
      );
    }
    const items = dedupeBy(
      (Array.isArray(res.performers) ? res.performers : [])
        .slice(0, 50)
        .map(stashPerformerDetail)
        .filter((d): d is CatalogDetail => d !== undefined),
      (d) => d.reference.id,
    );
    const rawCount: unknown = res.count;
    const totalReal =
      typeof rawCount === "number" &&
      Number.isInteger(rawCount) &&
      rawCount >= 1;
    return {
      provider: "stashdb",
      kind: "performer",
      page: 1,
      perPage: items.length,
      // ponytail: searchPerformers exposes no paging — the provider caps the
      // result at ~10 rows; when count exceeds items, the remainder is
      // genuinely unreachable through this API.
      hasMore: false,
      ...(totalReal ? { total: rawCount } : {}),
      totalCountKnown: totalReal,
      items,
    };
  }

  if (query.provider === "stashdb" && query.kind === "studio") {
    rejectUnusedFilters(
      raw,
      "StashDB studio search supports only a query term.",
    );
    const q = cleanQueryTerm(query.query);
    if (q === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "StashDB studio search requires a query term.",
      );
    }
    const res = await stashQuery(
      "query($t: String!) { searchStudio(term: $t, limit: 25) { id name deleted parent { id name } images { url } urls { url type } } }",
      { t: q },
      "searchStudio",
    );
    if (!Array.isArray(res)) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable studio search.",
      );
    }
    const items = dedupeBy(
      res
        .slice(0, 50)
        .map(stashStudioDetail)
        .filter((d): d is CatalogDetail => d !== undefined),
      (d) => d.reference.id,
    );
    return {
      provider: "stashdb",
      kind: "studio",
      page: 1,
      perPage: items.length,
      // ponytail: searchStudio exposes neither paging nor a count — the
      // provider caps the result (limit above); anything beyond it is
      // genuinely unreachable through this API.
      hasMore: false,
      totalCountKnown: false,
      items,
    };
  }

  const page =
    typeof query.page === "number" &&
    Number.isInteger(query.page) &&
    query.page >= 1
      ? query.page
      : 1;
  const perPage =
    typeof query.perPage === "number" &&
    Number.isInteger(query.perPage) &&
    query.perPage >= 1 &&
    query.perPage <= 100
      ? query.perPage
      : DEFAULT_PER_PAGE;

  if (query.provider === "tpdb") {
    if (query.kind === "performer") {
      rejectUnusedFilters(
        raw,
        "TPDB performer search supports only query, page, and perPage.",
      );
      const q = cleanQueryTerm(query.query);
      if (q === undefined) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB performer search requires a query term.",
        );
      }
      const body = await tpdbGet<TpdbListBody>(
        `/performers${tpdbQuery({ q, page, per_page: perPage })}`,
      );
      return parseTpdbPage(
        "performer",
        body,
        tpdbPerformerDetail,
        page,
        perPage,
      );
    }
    if (query.kind === "studio") {
      rejectUnusedFilters(
        raw,
        "TPDB studio search supports only query, page, and perPage.",
      );
      const q = cleanQueryTerm(query.query);
      if (q === undefined) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB studio search requires a query term.",
        );
      }
      const body = await tpdbGet<TpdbListBody>(
        `/sites${tpdbQuery({ q, page, per_page: perPage })}`,
      );
      return parseTpdbPage("studio", body, tpdbStudioDetail, page, perPage);
    }
    if (query.performer !== undefined) {
      // Filmography traversal via the canonical performer. The route supports
      // paging only; query/year filters are rejected, not ignored.
      if (
        cleanQueryTerm(query.query) !== undefined ||
        cleanYear(query.year) !== undefined ||
        query.releaseDate !== undefined
      ) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB filmography paging cannot be combined with query, year, release-date, studio, tag, or sort filters.",
        );
      }
      rejectUnusedFilters(
        raw,
        "TPDB filmography paging cannot be combined with studio, tag, or sort filters.",
      );
      const id = requireTpdbPerformerId(query.performer);
      const body = await tpdbGet<TpdbListBody>(
        `/performers/${id}/${query.kind}s${tpdbQuery({ page, per_page: perPage })}`,
      );
      return parseTpdbPage(
        query.kind,
        body,
        (row) => tpdbMediaDetail(query.kind, row),
        page,
        perPage,
      );
    }
    if (query.direction !== undefined && query.sort === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "direction requires an explicit sort.",
      );
    }
    const sort =
      query.sort !== undefined
        ? resolveSort("tpdb", query.kind, query.sort, query.direction)
        : undefined;
    const includeTags = cleanTagIds(query.tags, "TPDB");
    const allTags = cleanTagIds(query.tagsAll, "TPDB");
    if (includeTags !== undefined && allTags !== undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "Choose either tags (any-of) or tagsAll (all-of); TPDB exposes one tag criterion per query.",
      );
    }
    const studioFilter = await resolveTpdbStudioFilter(query.studio);
    const releaseDate = cleanReleaseDate(query.releaseDate);
    const path = tpdbQuery({
      q: cleanQueryTerm(query.query),
      year: cleanYear(query.year),
      date: releaseDate?.cutoff,
      date_operation: releaseDate?.operation,
      tags: includeTags ?? allTags,
      site_id: studioFilter,
      tag_and: allTags !== undefined ? 1 : undefined,
      orderBy: sort?.upstream,
      page,
      per_page: perPage,
    });
    const body = await tpdbGet<TpdbListBody>(
      query.kind === "movie" ? `/movies${path}` : `/scenes${path}`,
    );
    const result = parseTpdbPage(
      query.kind,
      body,
      (row) => tpdbMediaDetail(query.kind, row),
      page,
      perPage,
    );
    return sort !== undefined ? { ...result, sort } : result;
  }

  const input: Record<string, unknown> = { page, per_page: perPage };
  const q = cleanQueryTerm(query.query);
  if (q !== undefined) input.text = q;
  if (query.performer !== undefined) {
    input.performers = {
      value: [requireStashPerformerId(query.performer)],
      modifier: "INCLUDES",
    };
  }
  if (query.studio !== undefined) {
    // Verified live 2026-09-11: SceneQueryInput.studios is a MultiIDCriterionInput
    // (INCLUDES = this studio only), while parentStudio is a plain ID string —
    // scenes under that studio's child rows. The two are mutually exclusive.
    const studioId = requireStashStudioId(query.studio);
    if (query.studioMode === "withChildren") {
      input.parentStudio = studioId;
    } else {
      input.studios = { value: [studioId], modifier: "INCLUDES" };
    }
  }
  const includeTags = cleanTagIds(query.tags, "StashDB");
  const excludeTags = cleanTagIds(query.tagsExclude, "StashDB");
  if (includeTags !== undefined && excludeTags !== undefined) {
    throw new AppError(
      400,
      "invalid_search",
      "StashDB exposes one tag criterion per query; combine include and exclude lists client-side.",
    );
  }
  if (includeTags !== undefined) {
    input.tags = { value: includeTags, modifier: "INCLUDES" };
  }
  if (excludeTags !== undefined) {
    input.tags = { value: excludeTags, modifier: "EXCLUDES" };
  }
  let sort: AppliedSort | undefined;
  if (query.sort !== undefined) {
    sort = resolveSort("stashdb", "scene", query.sort, query.direction);
    input.sort = sort.upstream;
    input.direction = sort.direction === "asc" ? "ASC" : "DESC";
  } else if (query.direction !== undefined) {
    throw new AppError(
      400,
      "invalid_search",
      "direction requires an explicit sort.",
    );
  }
  const res = (await stashQuery(
    "query($f: SceneQueryInput!) { queryScenes(input: $f) { count scenes { id title code details date duration images { url } urls { url type } studio { id name } tags { id name } performers { as performer { id name deleted images { url } } } } } }",
    { f: input },
    "queryScenes",
  )) as { count?: unknown; scenes?: unknown } | null;
  if (res === null || typeof res !== "object" || !Array.isArray(res.scenes)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable scene listing.",
    );
  }
  const items = dedupeBy(
    res.scenes
      .slice(0, perPage * 2)
      .map(stashSceneDetail)
      .filter((d): d is CatalogDetail => d !== undefined),
    (d) => d.reference.id,
  );
  const rawCount: unknown = res.count;
  const totalReal =
    typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 1;
  const result: CatalogSearchPage = {
    provider: "stashdb",
    kind: "scene",
    page,
    perPage,
    // StashDB counts are always real, so page*perPage < count is a true
    // continuation signal.
    hasMore: items.length > 0 && totalReal && page * perPage < rawCount,
    ...(totalReal ? { total: rawCount } : {}),
    totalCountKnown: totalReal,
    items,
  };
  return sort !== undefined ? { ...result, sort } : result;
}

/** Full provider detail for one catalog entity. Returns null only for an
 * authoritative provider-side absence (TPDB 404, StashDB data null); outages
 * and auth failures throw AppError with upstreamStatus set. */
export async function getCatalogDetail(
  reference: CatalogReference,
): Promise<CatalogDetail | null> {
  const provider = reference?.provider;
  const kind = reference?.kind;
  const id = reference?.id;
  if (provider !== "tpdb" && provider !== "stashdb") {
    throw new AppError(400, "invalid_reference", "Unknown catalog provider.");
  }
  if (!isUuid(id)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Provider catalog ids must be UUIDs.",
    );
  }
  if (provider === "stashdb" && kind === "movie") {
    throw new AppError(
      400,
      "invalid_reference",
      "StashDB has no movie entity; movies are TPDB-only.",
    );
  }

  if (provider === "tpdb") {
    const path =
      kind === "movie"
        ? `/movies/${id}`
        : kind === "scene"
          ? `/scenes/${id}`
          : kind === "studio"
            ? `/sites/${id}`
            : `/performers/${id}`;
    let body: { data?: unknown };
    try {
      body = await tpdbGet<{ data?: unknown }>(path);
    } catch (err) {
      if (err instanceof AppError && err.upstreamStatus === 404) return null;
      throw err;
    }
    const detail =
      kind === "performer"
        ? tpdbPerformerDetail(body?.data)
        : kind === "movie"
          ? tpdbMediaDetail("movie", body?.data)
          : kind === "scene"
            ? tpdbMediaDetail("scene", body?.data)
            : tpdbStudioDetail(body?.data);
    // A record whose id differs from the requested one is unusable for this
    // reference even when individually well-formed.
    if (detail === undefined || detail.reference.id !== id) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB returned an unusable record.",
      );
    }
    return detail;
  }

  if (kind === "scene") {
    const row = await stashQuery(
      "query($id: ID!) { findScene(id: $id) { id title code details date duration images { url } urls { url type } studio { id name } tags { id name } performers { as performer { id name deleted aliases images { url } urls { url type } } } } }",
      { id },
      "findScene",
    );
    if (row === null) return null;
    const detail = stashSceneDetail(row);
    if (detail === undefined) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable scene record.",
      );
    }
    return detail;
  }
  if (kind === "performer") {
    const row = await stashQuery(
      "query($id: ID!) { findPerformer(id: $id) { id name deleted aliases urls { url type } images { url } } }",
      { id },
      "findPerformer",
    );
    if (row === null) return null;
    if ((row as { deleted?: unknown }).deleted === true) {
      return null; // deleted performers are authoritatively gone
    }
    const detail = stashPerformerDetail(row);
    if (detail === undefined) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable performer record.",
      );
    }
    return detail;
  }
  if (kind === "studio") {
    const row = await stashQuery(
      "query($id: ID!) { findStudio(id: $id) { id name deleted urls { url type } images { url } parent { id name } child_studios { id } } }",
      { id },
      "findStudio",
    );
    if (
      typeof row === "object" &&
      row !== null &&
      "deleted" in row &&
      row.deleted === true
    ) {
      return null; // deleted studios are authoritatively gone
    }
    if (row === null) return null;
    const detail = stashStudioDetail(row);
    if (detail === undefined) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable studio record.",
      );
    }
    return detail;
  }
  throw new AppError(400, "invalid_reference", "Unknown catalog kind.");
}

/** Tag lookup for filter pickers: provider-native {id, name} pairs for a
 * search term. TPDB /tags and StashDB searchTag; ids are never mapped across
 * providers. First page/limit only — enough to build a filter list. */
export async function searchCatalogTags(
  provider: CatalogProvider,
  term: string,
): Promise<{ id: string; name: string }[]> {
  const q = cleanQueryTerm(term);
  if (q === undefined) {
    throw new AppError(
      400,
      "invalid_search",
      "Tag lookup requires a search term.",
    );
  }
  if (provider === "tpdb") {
    const body = await tpdbGet<TpdbListBody>(
      `/tags${tpdbQuery({ q, per_page: MAX.tags })}`,
    );
    if (!Array.isArray(body?.data)) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB returned an unusable tag listing.",
      );
    }
    return tpdbTags(body.data);
  }
  const res = await stashQuery(
    "query($t: String!) { searchTag(term: $t, limit: 50) { id name } }",
    { t: q },
    "searchTag",
  );
  if (!Array.isArray(res)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable tag search.",
    );
  }
  const out: { id: string; name: string }[] = [];
  for (const row of res.slice(0, MAX.tags)) {
    if (row === null || typeof row !== "object") continue;
    const name = "name" in row ? cleanString(row.name, 120) : undefined;
    if ("id" in row && isUuid(row.id) && name !== undefined) {
      out.push({ id: row.id, name });
    }
  }
  return dedupeBy(out, (t) => t.id);
}

// --- cross-provider performer identity ---

const TPDB_PERFORMER_LINK_RE =
  /^https:\/\/(?:www\.)?theporndb\.net\/performers\/([0-9a-f-]{36})\/?$/i;
const STASH_PERFORMER_LINK_RE =
  /^https:\/\/(?:www\.)?stashdb\.org\/performers\/([0-9a-f-]{36})\/?$/i;

/** Explicit cross-provider identity for a performer detail, taken only from
 * provider-published URLs on the record itself. Never fuzzy-name matching;
 * identity is performer-level only and scenes are never linked across
 * providers. Returns exactly one of linked / unlinkedReason. */
export function crossProviderLink(detail: CatalogDetail): {
  linked?: CatalogReference;
  unlinkedReason?: string;
} {
  if (detail.reference.kind !== "performer") {
    return {
      unlinkedReason:
        "cross-provider identity is performer-level only; scenes are never linked across providers",
    };
  }
  const fromTpdb = detail.reference.provider === "tpdb";
  const re = fromTpdb ? STASH_PERFORMER_LINK_RE : TPDB_PERFORMER_LINK_RE;
  for (const link of detail.links) {
    const m = re.exec(link.url);
    const linkedId = m?.[1];
    if (linkedId !== undefined && isUuid(linkedId)) {
      return {
        linked: {
          provider: fromTpdb ? "stashdb" : "tpdb",
          kind: "performer",
          id: linkedId.toLowerCase(),
        },
      };
    }
  }
  return {
    unlinkedReason: `no explicit ${
      fromTpdb ? "StashDB" : "TPDB"
    } performer URL on the ${fromTpdb ? "TPDB" : "StashDB"} performer record`,
  };
}
