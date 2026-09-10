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

import { AppError, requestJson, requestBytes } from "./http.ts";
import type { CatalogDetail, CatalogReference } from "../lib/contracts.ts";

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
    ...(studioName !== undefined ? { studio: { name: studioName } } : {}),
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
  const studioName = cleanString(
    (r.studio as Record<string, unknown> | null | undefined)?.name,
    MAX.name,
  );
  const details = cleanString(r.details, MAX.description);
  const duration = cleanDuration(r.duration);
  const links = stashLinks(r.urls);
  return {
    reference: { provider: "stashdb", kind: "scene", id },
    title,
    ...(details !== undefined ? { description: details } : {}),
    ...(isIsoDate(r.date) ? { releaseDate: r.date } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(studioName !== undefined ? { studio: { name: studioName } } : {}),
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

/** Paged search query. Filters are explicit per provider+kind; combinations
 * the upstream cannot express are rejected rather than silently ignored.
 * `performer` on tpdb movie/scene is the canonical TPDB performer UUID and
 * switches to the filmography route (no query/year filters there); on a
 * stashdb scene it uses the performers INCLUDES criterion. */
export type CatalogSearchQuery =
  | {
      provider: "tpdb";
      kind: "movie";
      query?: string;
      year?: number;
      performer?: string;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "scene";
      query?: string;
      year?: number;
      performer?: string;
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
      provider: "stashdb";
      kind: "scene";
      query?: string;
      performer?: string;
      page?: number;
      perPage?: number;
    }
  | { provider: "stashdb"; kind: "performer"; query: string };

export interface CatalogSearchPage {
  provider: "tpdb" | "stashdb";
  kind: "movie" | "scene" | "performer";
  page: number;
  perPage: number;
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

interface TpdbListBody {
  data?: unknown;
  links?: { next?: unknown };
  meta?: { total?: unknown };
}

function parseTpdbPage(
  kind: "movie" | "scene" | "performer",
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

function tpdbQuery(base: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
}

/** Paged catalog search. Never merges results across providers; every item is
 * source-labeled via its CatalogReference. */
export async function searchCatalog(
  query: CatalogSearchQuery,
): Promise<CatalogSearchPage> {
  // StashDB performer search is the one genuinely unpaged shape:
  // searchPerformers takes no page arguments and caps at ~10 rows. It is
  // dispatched before the paging defaults so every remaining query variant
  // genuinely accepts page/perPage.
  if (query.provider === "stashdb" && query.kind === "performer") {
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
    if (query.performer !== undefined) {
      // Filmography traversal via the canonical performer. The route supports
      // paging only; query/year filters are rejected, not ignored.
      if (
        cleanQueryTerm(query.query) !== undefined ||
        cleanYear(query.year) !== undefined
      ) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB filmography paging cannot be combined with query or year filters.",
        );
      }
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
    const path = tpdbQuery({
      q: cleanQueryTerm(query.query),
      year: cleanYear(query.year),
      page,
      per_page: perPage,
    });
    const body = await tpdbGet<TpdbListBody>(
      query.kind === "movie" ? `/movies${path}` : `/scenes${path}`,
    );
    return parseTpdbPage(
      query.kind,
      body,
      (row) => tpdbMediaDetail(query.kind, row),
      page,
      perPage,
    );
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
  const res = (await stashQuery(
    "query($f: SceneQueryInput!) { queryScenes(input: $f) { count scenes { id title code details date duration urls { url type } studio { id name } tags { id name } performers { as performer { id name deleted images { url } } } } } }",
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
  return {
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
          : tpdbMediaDetail("scene", body?.data);
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
      "query($id: ID!) { findScene(id: $id) { id title code details date duration urls { url type } studio { id name } tags { id name } performers { as performer { id name deleted aliases images { url } urls { url type } } } } }",
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
  throw new AppError(400, "invalid_reference", "Unknown catalog kind.");
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
