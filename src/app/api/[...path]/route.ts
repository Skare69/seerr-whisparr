import type {
  Account,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  ExternalUser,
  IntegrationConfig,
  Library,
  MediaKind,
  MediaReference,
  ProviderStatus,
  Role,
  WhisparrPathMapping,
} from "../../../lib/contracts.ts";
import {
  bootstrap,
  cancelRequest,
  createRequest,
  createSession,
  decideRequest,
  getAcquisitionByReference,
  getAccount,
  getConfig,
  getSession,
  importAccounts,
  isInitialized,
  listAccounts,
  listRequests,
  revokeSession,
  saveConfig,
  updateAccount,
  upsertCatalogRecord,
} from "../../../server/storage.ts";
import {
  consumeLoginAttempt,
  guardMutation,
  sessionCookie,
  verifySetupSecret,
} from "../../../server/security.ts";
import { AppError, validateBaseUrl } from "../../../server/http.ts";
import {
  authenticate,
  getLibraryImage,
  getLibraryItem,
  getServer,
  listLibraries,
  listLibraryItems,
  listUsers,
  resolvePlaybackAccess,
  validateUser,
} from "../../../server/jellyfin.ts";
import {
  crossProviderLink,
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  isProviderImageUrl,
  searchCatalog,
  type CatalogSearchQuery,
  type CatalogSortDirection,
  type CatalogSortKey,
} from "../../../server/providers.ts";
import { getWhisparrStatus } from "../../../server/whisparr.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

const BODY_LIMIT_BYTES = 32 * 1024;
const JELLYFIN_ID =
  /^(?:[0-9a-f]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

interface AuthContext {
  config: IntegrationConfig;
  account: Account;
  token: string;
  rawSessionToken: string;
}

// --- response + parsing helpers ---

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return json(
      { error: { code: err.code, message: err.message } },
      err.status,
    );
  }
  return json(
    { error: { code: "internal", message: "Internal server error." } },
    500,
  );
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_LIMIT_BYTES) {
    throw new AppError(413, "payload_too_large", "Request body exceeds 32KiB.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(
      400,
      "invalid_body",
      "Request body must be a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}

function fieldText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value;
}

function fieldUrl(body: Record<string, unknown>, key: string): string {
  return validateBaseUrl(fieldText(body, key, 2048));
}

function fieldBool(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== "boolean")
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return body[key] as boolean;
}

function fieldRole(body: Record<string, unknown>, key: string): Role {
  const value = body[key];
  if (value !== "admin" && value !== "moderator" && value !== "requester") {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value;
}

function fieldIds(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !JELLYFIN_ID.test(id))
  ) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value as string[];
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return value;
}

function requireId(raw: string): string {
  if (!JELLYFIN_ID.test(raw))
    throw new AppError(400, "invalid_id", "Invalid identifier.");
  return raw;
}

function optionalBool(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return value;
}

function queryInt(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw))
    throw new AppError(400, "invalid_query", `Invalid ${key}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError(400, "invalid_query", `Invalid ${key}.`);
  return value;
}

function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === "velvarr_session") {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

// --- environment-derived status ---

function setupReady(): boolean {
  return (
    /^[0-9a-fA-F]{64}$/.test(process.env.VELVARR_SECRET_KEY ?? "") &&
    (process.env.VELVARR_SETUP_SECRET ?? "").length >= 32
  );
}

// --- session / authorization ---

async function requireSession(request: Request): Promise<AuthContext> {
  const rawSessionToken = readSessionToken(request);
  if (!rawSessionToken)
    throw new AppError(401, "unauthenticated", "Sign in required.");
  const session = getSession(rawSessionToken);
  if (!session) throw new AppError(401, "unauthenticated", "Sign in required.");
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  let user: ExternalUser;
  try {
    user = await validateUser(config, session.jellyfinToken);
  } catch (err) {
    // Proven upstream rejection invalidates the session; transient failures block without deleting state.
    if (err instanceof AppError && (err.status === 401 || err.status === 403)) {
      revokeSession(rawSessionToken);
      throw new AppError(401, "session_revoked", "Session is no longer valid.");
    }
    throw err;
  }
  if (user.id !== session.account.id) {
    revokeSession(rawSessionToken);
    throw new AppError(401, "session_revoked", "Session is no longer valid.");
  }
  if (user.isDisabled) {
    revokeSession(rawSessionToken);
    throw new AppError(403, "account_disabled", "This account is disabled.");
  }
  if (!user.enableRemoteAccess) {
    throw new AppError(
      403,
      "remote_denied",
      "Remote access is disabled for this account.",
    );
  }
  return {
    config,
    account: session.account,
    token: session.jellyfinToken,
    rawSessionToken,
  };
}

async function requireAdmin(request: Request): Promise<AuthContext> {
  const ctx = await requireSession(request);
  if (ctx.account.role !== "admin")
    throw new AppError(403, "forbidden", "Administrator access required.");
  return ctx;
}

// --- setup ---

interface SetupFields {
  username: string;
  password: string;
  jellyfinUrl: string;
  jellyfinExternalUrl: string;
  jellyfinApiKey: string;
}

function setupFields(body: Record<string, unknown>): SetupFields {
  return {
    username: fieldText(body, "username", 200),
    password: fieldText(body, "password", 512),
    jellyfinUrl: fieldUrl(body, "jellyfinUrl"),
    jellyfinExternalUrl: fieldUrl(body, "jellyfinExternalUrl"),
    jellyfinApiKey: fieldText(body, "jellyfinApiKey", 512),
  };
}

// Authenticates the explicitly selected user, proves the admin integration key
// enumerates the same server, and fetches real accessible libraries. Retains nothing.
async function verifySetupSelection(fields: SetupFields): Promise<{
  user: ExternalUser;
  token: string;
  serverId: string;
  libraries: Library[];
}> {
  const server = await getServer(fields.jellyfinUrl);
  const { user, token } = await authenticate(
    fields.jellyfinUrl,
    fields.username,
    fields.password,
  );
  const candidate: IntegrationConfig = {
    jellyfin: {
      url: fields.jellyfinUrl,
      externalUrl: fields.jellyfinExternalUrl,
      apiKey: fields.jellyfinApiKey,
      serverId: server.id,
      libraryIds: [],
    },
  };
  const users = await listUsers(candidate);
  if (!users.some((entry) => entry.id === user.id)) {
    throw new AppError(
      400,
      "identity_mismatch",
      "Selected user was not found on this server.",
    );
  }
  const libraries = await listLibraries(candidate, token);
  return { user, token, serverId: server.id, libraries };
}

async function setupInspect(request: Request): Promise<Response> {
  guardMutation(request);
  if (isInitialized())
    throw new AppError(
      409,
      "already_initialized",
      "Setup is already complete.",
    );
  const body = await readJson(request);
  verifySetupSecret(body.setupSecret);
  const fields = setupFields(body);
  consumeLoginAttempt(fields.username);
  const selection = await verifySetupSelection(fields);
  return json({
    user: { id: selection.user.id, name: selection.user.name },
    libraries: selection.libraries,
  });
}

async function setupCommit(request: Request): Promise<Response> {
  guardMutation(request);
  if (isInitialized())
    throw new AppError(
      409,
      "already_initialized",
      "Setup is already complete.",
    );
  const body = await readJson(request);
  verifySetupSecret(body.setupSecret);
  const fields = setupFields(body);
  consumeLoginAttempt(fields.username);
  const libraryIds = fieldIds(body, "libraryIds");
  if (libraryIds.length === 0)
    throw new AppError(400, "invalid_field", "Select at least one library.");
  const whisparrUrl = optionalText(body, "whisparrUrl", 2048);
  const whisparrApiKey = optionalText(body, "whisparrApiKey", 512);
  let whisparr: { url: string; apiKey: string } | undefined;
  if (whisparrUrl !== undefined && whisparrUrl !== "") {
    if (!whisparrApiKey)
      throw new AppError(
        400,
        "invalid_field",
        "Whisparr API key is required with a Whisparr URL.",
      );
    whisparr = { url: validateBaseUrl(whisparrUrl), apiKey: whisparrApiKey };
  }
  const selection = await verifySetupSelection(fields);
  if (
    !libraryIds.every((id) =>
      selection.libraries.some((library) => library.id === id),
    )
  ) {
    throw new AppError(
      400,
      "invalid_field",
      "Selected libraries are not accessible on this server.",
    );
  }
  const config: IntegrationConfig = {
    jellyfin: {
      url: fields.jellyfinUrl,
      externalUrl: fields.jellyfinExternalUrl,
      apiKey: fields.jellyfinApiKey,
      serverId: selection.serverId,
      libraryIds,
    },
    ...(whisparr ? { whisparr } : {}),
  };
  const grant = bootstrap(config, selection.user, selection.token);
  return json({ account: grant.account }, 200, {
    "set-cookie": sessionCookie(grant),
  });
}

// --- auth routes ---

async function login(request: Request): Promise<Response> {
  guardMutation(request);
  const body = await readJson(request);
  const username = fieldText(body, "username", 200);
  const password = fieldText(body, "password", 512);
  consumeLoginAttempt(username);
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  const { user, token } = await authenticate(
    config.jellyfin.url,
    username,
    password,
  );
  const account = getAccount(user.id);
  if (!account)
    throw new AppError(
      403,
      "not_admitted",
      "This account has not been admitted to Velvarr.",
    );
  if (!account.enabled)
    throw new AppError(403, "account_disabled", "This account is disabled.");
  if (user.isDisabled)
    throw new AppError(403, "account_disabled", "This account is disabled.");
  if (!user.enableRemoteAccess) {
    throw new AppError(
      403,
      "remote_denied",
      "Remote access is disabled for this account.",
    );
  }
  const grant = createSession(account.id, token);
  return json({ account: grant.account }, 200, {
    "set-cookie": sessionCookie(grant),
  });
}

async function logout(request: Request): Promise<Response> {
  guardMutation(request);
  await readJson(request);
  const raw = readSessionToken(request);
  if (raw) revokeSession(raw);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(undefined) });
}

// --- user routes ---

async function me(request: Request): Promise<Response> {
  const ctx = await requireSession(request);
  const [tpdb, stashdb] = await Promise.all([
    providerPresence("tpdb"),
    providerPresence("stashdb"),
  ]);
  return json({
    account: ctx.account,
    providers: { tpdb, stashdb } satisfies ProviderStatus,
  });
}

// Coarse per-user signal: does a provider integration exist at all. Real
// verification (verified flag + account) lives on the admin providers route;
// here an outage must never claim a configured provider vanished, and an
// unconfigured provider must never pretend otherwise.
async function providerPresence(
  provider: "tpdb" | "stashdb",
): Promise<ProviderStatus["tpdb"]> {
  try {
    return (await getProviderStatus(provider)).configured
      ? "not_verified"
      : "not_configured";
  } catch {
    return "not_verified";
  }
}

async function libraries(request: Request): Promise<Response> {
  const ctx = await requireSession(request);
  const views = await listLibraries(ctx.config, ctx.token);
  const grants = new Set(ctx.account.libraryIds);
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  return json({
    libraries: views.filter(
      (library) => grants.has(library.id) && configured.has(library.id),
    ),
  });
}

async function libraryPage(request: Request): Promise<Response> {
  const ctx = await requireSession(request);
  const url = new URL(request.url);
  const start = queryInt(url, "start", 0, 0, 100000);
  const limit = queryInt(url, "limit", 24, 1, 60);
  const search = url.searchParams.get("search") ?? "";
  if (search.length > 200)
    throw new AppError(400, "invalid_query", "Invalid search.");
  const grants = new Set(ctx.account.libraryIds);
  let libraryId: string | undefined;
  const requested = url.searchParams.get("libraryId");
  if (requested !== null) {
    requireId(requested);
    if (
      !grants.has(requested) ||
      !ctx.config.jellyfin.libraryIds.includes(requested)
    ) {
      throw new AppError(
        403,
        "forbidden",
        "Library is not granted to this account.",
      );
    }
    libraryId = requested;
  }
  // Empty grant list never means all libraries.
  if (grants.size === 0) return json({ items: [], total: 0, start, limit });
  const page = await listLibraryItems(ctx.config, ctx.token, ctx.account, {
    start,
    limit,
    search,
    ...(libraryId !== undefined ? { libraryId } : {}),
  });
  return json(page);
}

async function libraryItem(request: Request, id: string): Promise<Response> {
  const ctx = await requireSession(request);
  const item = await getLibraryItem(
    ctx.config,
    ctx.token,
    ctx.account,
    requireId(id),
  );
  return json({ item });
}

async function libraryImage(request: Request, id: string): Promise<Response> {
  const ctx = await requireSession(request);
  const image = await getLibraryImage(
    ctx.config,
    ctx.token,
    ctx.account,
    requireId(id),
  );
  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// --- admin routes ---

function integrationsShape(config: IntegrationConfig) {
  return {
    jellyfin: {
      url: config.jellyfin.url,
      externalUrl: config.jellyfin.externalUrl,
      serverId: config.jellyfin.serverId,
      libraryIds: config.jellyfin.libraryIds,
      apiKeyConfigured: config.jellyfin.apiKey.length > 0,
    },
    whisparr: config.whisparr
      ? {
          url: config.whisparr.url,
          apiKeyConfigured: config.whisparr.apiKey.length > 0,
          delivery: config.whisparr.delivery ?? null,
          pathMappings: config.whisparr.pathMappings ?? [],
        }
      : null,
  };
}

async function adminUsers(ctx: AuthContext): Promise<Response> {
  const views = await listLibraries(ctx.config, ctx.token);
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  return json({
    accounts: listAccounts(),
    libraries: views.filter((library) => configured.has(library.id)),
  });
}

async function adminImport(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  guardMutation(request);
  await readJson(request);
  const imported = importAccounts(await listUsers(ctx.config));
  return json({ accounts: imported });
}

async function adminUpdateUser(
  request: Request,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  guardMutation(request);
  const body = await readJson(request);
  const target = getAccount(requireId(id));
  if (!target) throw new AppError(404, "not_found", "Account not found.");
  const enabled = fieldBool(body, "enabled");
  const role = fieldRole(body, "role");
  const libraryIds = fieldIds(body, "libraryIds");
  const autoApprove = optionalBool(body, "autoApprove");
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  if (libraryIds.some((libraryId) => !configured.has(libraryId))) {
    throw new AppError(400, "invalid_field", "Unknown library selected.");
  }
  if (target.isOwner && (!enabled || role !== "admin")) {
    throw new AppError(
      403,
      "forbidden",
      "The owner account cannot be disabled or demoted.",
    );
  }
  const account = updateAccount(target.id, {
    enabled,
    role,
    libraryIds,
    ...(autoApprove !== undefined ? { autoApprove } : {}),
  });
  return json({ account });
}

async function adminUpdateIntegrations(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  guardMutation(request);
  const body = await readJson(request);
  const password = fieldText(body, "password", 512);
  const jellyfinUrl = fieldUrl(body, "jellyfinUrl");
  const jellyfinExternalUrl = fieldUrl(body, "jellyfinExternalUrl");
  // Fresh password authentication of the current administrator against the current URL.
  // A rejected re-auth is a privilege denial for this action, not a lapsed session,
  // so it must surface as 403 identity_mismatch rather than upstream_auth 401.
  let user: ExternalUser;
  try {
    ({ user } = await authenticate(
      ctx.config.jellyfin.url,
      ctx.account.name,
      password,
    ));
  } catch (err) {
    if (err instanceof AppError && (err.status === 401 || err.status === 403)) {
      throw new AppError(
        403,
        "identity_mismatch",
        "Credentials do not match this administrator account.",
      );
    }
    throw err;
  }
  if (user.id !== ctx.account.id) {
    throw new AppError(
      403,
      "identity_mismatch",
      "Credentials do not match this administrator account.",
    );
  }
  const jellyfinApiKey = optionalText(body, "jellyfinApiKey", 512);
  const apiKey =
    jellyfinApiKey !== undefined && jellyfinApiKey !== ""
      ? jellyfinApiKey
      : ctx.config.jellyfin.apiKey;
  const server = await getServer(jellyfinUrl);
  if (server.id !== ctx.config.jellyfin.serverId) {
    throw new AppError(
      400,
      "server_mismatch",
      "Jellyfin server identity cannot change, only its address.",
    );
  }
  const jellyfin = {
    url: jellyfinUrl,
    externalUrl: jellyfinExternalUrl,
    apiKey,
    serverId: ctx.config.jellyfin.serverId,
    libraryIds: ctx.config.jellyfin.libraryIds,
  };
  // Prove the prospective key still enumerates users as the administrator key.
  await listUsers({ jellyfin });
  let whisparr = ctx.config.whisparr;
  const whisparrUrl = optionalText(body, "whisparrUrl", 2048);
  if (whisparrUrl !== undefined) {
    if (whisparrUrl === "") {
      whisparr = undefined;
    } else {
      const whisparrApiKey = optionalText(body, "whisparrApiKey", 512);
      const key =
        whisparrApiKey !== undefined && whisparrApiKey !== ""
          ? whisparrApiKey
          : whisparr?.apiKey;
      if (!key)
        throw new AppError(
          400,
          "invalid_field",
          "Whisparr API key is required with a Whisparr URL.",
        );
      whisparr = { url: validateBaseUrl(whisparrUrl), apiKey: key };
    }
  }
  // Delivery and pathMappings: validated here, stored only with a Whisparr
  // connection; omitted keys preserve what is already configured.
  let delivery = whisparr?.delivery;
  let pathMappings = whisparr?.pathMappings;
  const nextDelivery = body.delivery;
  if (nextDelivery !== undefined) {
    if (
      nextDelivery === null ||
      typeof nextDelivery !== "object" ||
      Array.isArray(nextDelivery)
    ) {
      throw new AppError(
        400,
        "invalid_field",
        "Invalid Whisparr delivery settings.",
      );
    }
    const d = nextDelivery as Record<string, unknown>;
    if (
      typeof d.enabled !== "boolean" ||
      typeof d.rootFolderPath !== "string" ||
      d.rootFolderPath.length > 1024 ||
      typeof d.qualityProfileId !== "number" ||
      !Number.isInteger(d.qualityProfileId) ||
      d.qualityProfileId < 1 ||
      typeof d.searchOnAdd !== "boolean" ||
      (d.enabled && d.rootFolderPath === "")
    ) {
      throw new AppError(
        400,
        "invalid_field",
        "Invalid Whisparr delivery settings.",
      );
    }
    delivery = {
      enabled: d.enabled,
      rootFolderPath: d.rootFolderPath,
      qualityProfileId: d.qualityProfileId,
      searchOnAdd: d.searchOnAdd,
    };
  }
  const nextMappings = body.pathMappings;
  if (nextMappings !== undefined) {
    if (!Array.isArray(nextMappings) || nextMappings.length > 50) {
      throw new AppError(
        400,
        "invalid_field",
        "Invalid Whisparr path mappings.",
      );
    }
    const mapped: WhisparrPathMapping[] = [];
    for (const entry of nextMappings) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new AppError(
          400,
          "invalid_field",
          "Invalid Whisparr path mappings.",
        );
      }
      const e = entry as Record<string, unknown>;
      if (
        typeof e.whisparrPrefix !== "string" ||
        e.whisparrPrefix === "" ||
        e.whisparrPrefix.length > 1024 ||
        typeof e.jellyfinPrefix !== "string" ||
        e.jellyfinPrefix === "" ||
        e.jellyfinPrefix.length > 1024
      ) {
        throw new AppError(
          400,
          "invalid_field",
          "Invalid Whisparr path mappings.",
        );
      }
      mapped.push({
        whisparrPrefix: e.whisparrPrefix,
        jellyfinPrefix: e.jellyfinPrefix,
      });
    }
    pathMappings = mapped;
  }
  if ((nextDelivery !== undefined || nextMappings !== undefined) && !whisparr) {
    throw new AppError(
      400,
      "invalid_field",
      "Whisparr must be configured to set delivery settings.",
    );
  }
  if (whisparr) {
    whisparr = {
      ...whisparr,
      ...(delivery ? { delivery } : {}),
      ...(pathMappings ? { pathMappings } : {}),
    };
  }
  const config: IntegrationConfig = {
    jellyfin,
    ...(whisparr ? { whisparr } : {}),
  };
  saveConfig(config);
  return json(integrationsShape(config));
}

async function adminWhisparr(ctx: AuthContext): Promise<Response> {
  return json(await getWhisparrStatus(ctx.config));
}

// --- catalog, requests, availability ---

const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCatalogProvider(raw: string | null): CatalogProvider {
  if (raw === "tpdb" || raw === "stashdb") return raw;
  throw new AppError(400, "invalid_reference", "Unknown catalog provider.");
}
function parseCatalogKind(
  provider: "stashdb",
  raw: string,
): "scene" | "performer" | "studio";
function parseCatalogKind(provider: "tpdb", raw: string): CatalogKind;
function parseCatalogKind(provider: CatalogProvider, raw: string): CatalogKind;
function parseCatalogKind(provider: CatalogProvider, raw: string): CatalogKind {
  if (provider === "tpdb") {
    if (
      raw === "movie" ||
      raw === "scene" ||
      raw === "performer" ||
      raw === "studio"
    ) {
      return raw;
    }
    throw new AppError(400, "invalid_reference", "Unknown catalog kind.");
  }
  if (raw === "scene" || raw === "performer" || raw === "studio") return raw;
  throw new AppError(
    400,
    "invalid_reference",
    "StashDB hosts scenes, performers, and studios only.",
  );
}

// External provider identity for catalog routes, validated before any
// upstream call. Ids are canonical provider UUIDs, never the application's
// own catalog record id.
function parseCatalogReference(
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): CatalogReference {
  const provider = parseCatalogProvider(providerRaw);
  const kind = parseCatalogKind(provider, kindRaw);
  if (!PROVIDER_UUID.test(idRaw)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Provider catalog ids must be UUIDs.",
    );
  }
  return { provider, kind, id: idRaw.toLowerCase() };
}

// CatalogReference is requestable media only when its kind is movie/scene;
// a performer is catalog-only and must never reach createRequest,
// getAcquisitionByReference, or the availability hints. Runtime check,
// never a cast.
function isMediaReference(
  reference: CatalogReference,
): reference is MediaReference {
  return reference.kind === "movie" || reference.kind === "scene";
}

function parseMediaReference(
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): MediaReference {
  const reference = parseCatalogReference(providerRaw, kindRaw, idRaw);
  if (!isMediaReference(reference)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Performers and studios are not requestable media.",
    );
  }
  return reference;
}

function sameMedia(a: MediaReference, b: MediaReference): boolean {
  return (
    a.provider === b.provider &&
    a.kind === b.kind &&
    a.id.toLowerCase() === b.id.toLowerCase()
  );
}

// Shared provider-independent scalar validation for catalog search. The
// per-provider builders below explicitly reject filter combinations their
// provider cannot express — never silently ignored downstream.
interface CatalogSearchParams {
  q: string | null;
  year: number | undefined;
  performer: string | null;
  studio: string | null;
  tags: string[] | undefined;
  tagsAll: string[] | undefined;
  tagsExclude: string[] | undefined;
  sort: CatalogSortKey | undefined;
  direction: CatalogSortDirection | undefined;
  page: number;
  perPage: number;
}

// Runtime check, never a cast: the vocabulary mirrors providers'
// CatalogSortKey so an unknown sort is the route's explicit 400.
function isCatalogSortKey(v: string): v is CatalogSortKey {
  switch (v) {
    case "relevance":
    case "recency":
    case "duration":
    case "title":
    case "date":
    case "created":
    case "updated":
    case "trending":
    case "popularity":
      return true;
    default:
      return false;
  }
}

// Tag lists arrive repeatable (?tags=a&tags=b) or comma-separated
// (?tags=a,b). Ids stay provider-native; only shape is validated here —
// uuid-ness and provider acceptance stay the provider's explicit errors.
function tagList(params: URLSearchParams, key: string): string[] | undefined {
  const ids = params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (ids.length === 0) return undefined;
  if (ids.some((id) => id.length > 64)) {
    throw new AppError(400, "invalid_query", `Invalid ${key} filter id.`);
  }
  if (ids.length > 25) {
    throw new AppError(400, "invalid_query", `Too many ${key} ids.`);
  }
  return [...new Set(ids)];
}

// Sorts each provider+kind genuinely implements, mirroring resolveSort in
// providers.ts so an unsupported order is rejected here with the route's
// invalid_query error before any upstream call.
const SORT_SUPPORT: Partial<
  Record<
    CatalogProvider,
    Partial<Record<CatalogKind, readonly CatalogSortKey[]>>
  >
> = {
  tpdb: {
    movie: ["relevance", "recency", "duration"],
    scene: ["relevance", "recency", "duration"],
  },
  stashdb: {
    scene: [
      "title",
      "date",
      "duration",
      "trending",
      "popularity",
      "created",
      "updated",
    ],
  },
};

function supportedSort(
  provider: CatalogProvider,
  kind: CatalogKind,
  sort: CatalogSortKey | undefined,
  direction: CatalogSortDirection | undefined,
): { sort?: CatalogSortKey; direction?: CatalogSortDirection } {
  if (sort === undefined) {
    if (direction !== undefined) {
      throw new AppError(
        400,
        "invalid_query",
        "direction requires an explicit sort.",
      );
    }
    return {};
  }
  const supported = SORT_SUPPORT[provider]?.[kind];
  if (supported === undefined || !supported.includes(sort)) {
    throw new AppError(
      400,
      "invalid_query",
      `No ${sort} order for ${provider} ${kind} search.`,
    );
  }
  return direction !== undefined ? { sort, direction } : { sort };
}

function catalogSearchParams(
  url: URL,
  params: URLSearchParams,
): CatalogSearchParams {
  const q = params.get("q");
  if (q !== null && (q.length === 0 || q.length > 200))
    throw new AppError(400, "invalid_query", "Invalid q.");
  const yearRaw = params.get("year");
  if (
    yearRaw !== null &&
    (!/^\d{4}$/.test(yearRaw) ||
      Number(yearRaw) < 1870 ||
      Number(yearRaw) > 2100)
  ) {
    throw new AppError(400, "invalid_query", "Invalid year.");
  }
  const performer = params.get("performer");
  if (performer !== null && (performer === "" || performer.length > 128))
    throw new AppError(400, "invalid_query", "Invalid performer.");
  const studio = params.get("studio");
  if (studio !== null && (studio === "" || studio.length > 64))
    throw new AppError(400, "invalid_query", "Invalid studio filter.");
  const sortRaw = params.get("sort");
  let sort: CatalogSortKey | undefined;
  if (sortRaw !== null) {
    if (!isCatalogSortKey(sortRaw)) {
      throw new AppError(400, "invalid_query", "Unknown sort.");
    }
    sort = sortRaw;
  }
  const directionRaw = params.get("direction");
  let direction: CatalogSortDirection | undefined;
  if (directionRaw !== null) {
    if (directionRaw !== "asc" && directionRaw !== "desc") {
      throw new AppError(
        400,
        "invalid_query",
        "direction must be asc or desc.",
      );
    }
    direction = directionRaw;
  }
  return {
    q,
    year: yearRaw !== null ? Number(yearRaw) : undefined,
    performer,
    studio,
    tags: tagList(params, "tags"),
    tagsAll: tagList(params, "tagsAll"),
    tagsExclude: tagList(params, "tagsExclude"),
    sort,
    direction,
    page: params.has("page") ? queryInt(url, "page", 1, 1, 10000) : 1,
    perPage: params.has("perPage") ? queryInt(url, "perPage", 24, 1, 100) : 24,
  };
}

// Builds the providers CatalogSearchQuery union from the query string. One
// builder per provider so each provider+kind pair constructs exactly its
// own valid union variant.
function catalogSearchQuery(url: URL): CatalogSearchQuery {
  const params = url.searchParams;
  const provider = parseCatalogProvider(params.get("provider"));
  const kindRaw = params.get("kind");
  if (kindRaw === null)
    throw new AppError(400, "invalid_query", "kind is required.");
  if (provider === "stashdb") {
    // The overload types stashdb kinds as "scene" | "performer" | "studio":
    // StashDB has no movie entity, and parseCatalogKind already rejects
    // movie here with an explicit 400.
    return stashdbSearchQuery(params, parseCatalogKind(provider, kindRaw), url);
  }
  return tpdbSearchQuery(params, parseCatalogKind(provider, kindRaw), url);
}

// StashDB: unpaged performer and studio searches (query only) and scene
// search with optional query/performer/studio/tag filters; year and tagsAll
// are not supported.
function stashdbSearchQuery(
  params: URLSearchParams,
  kind: "scene" | "performer" | "studio",
  url: URL,
): CatalogSearchQuery {
  const s = catalogSearchParams(url, params);
  if (s.tagsAll !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "tagsAll is a TPDB-only filter; StashDB scenes expose tags and tagsExclude.",
    );
  }
  if (s.tags !== undefined && s.tagsExclude !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "StashDB exposes one tag criterion per query; combine include and exclude lists client-side.",
    );
  }
  if (kind !== "scene") {
    if (s.q === null) {
      throw new AppError(400, "invalid_query", `${kind} search requires q.`);
    }
    if (
      s.performer !== null ||
      s.studio !== null ||
      s.tags !== undefined ||
      s.tagsExclude !== undefined
    ) {
      throw new AppError(
        400,
        "invalid_query",
        `StashDB ${kind} search supports only a query term.`,
      );
    }
    if (s.sort !== undefined || s.direction !== undefined) {
      throw new AppError(
        400,
        "invalid_query",
        `StashDB ${kind} search supports no sort.`,
      );
    }
    if (params.has("page") || params.has("perPage")) {
      throw new AppError(
        400,
        "invalid_query",
        `StashDB ${kind} search is not paged.`,
      );
    }
    return { provider: "stashdb", kind, query: s.q };
  }
  if (s.year !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "StashDB scene search does not support year.",
    );
  }
  return {
    provider: "stashdb",
    kind,
    ...(s.q !== null ? { query: s.q } : {}),
    ...(s.performer !== null ? { performer: s.performer } : {}),
    ...(s.studio !== null ? { studio: s.studio } : {}),
    ...(s.tags !== undefined ? { tags: s.tags } : {}),
    ...(s.tagsExclude !== undefined ? { tagsExclude: s.tagsExclude } : {}),
    ...supportedSort("stashdb", kind, s.sort, s.direction),
    page: s.page,
    perPage: s.perPage,
  };
}

// TPDB hosts movies, scenes, performers, and studios (sites); performer and
// studio searches require q and take no other filters.
function tpdbSearchQuery(
  params: URLSearchParams,
  kind: CatalogKind,
  url: URL,
): CatalogSearchQuery {
  const s = catalogSearchParams(url, params);
  if (s.tagsExclude !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "tagsExclude is a StashDB-only filter; TPDB exposes tags and tagsAll.",
    );
  }
  if (s.tags !== undefined && s.tagsAll !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "Choose either tags (any-of) or tagsAll (all-of); TPDB exposes one tag criterion per query.",
    );
  }
  if (kind === "performer" || kind === "studio") {
    if (s.q === null) {
      throw new AppError(400, "invalid_query", `${kind} search requires q.`);
    }
    if (
      s.performer !== null ||
      s.year !== undefined ||
      s.studio !== null ||
      s.tags !== undefined ||
      s.tagsAll !== undefined
    ) {
      throw new AppError(
        400,
        "invalid_query",
        `TPDB ${kind} search supports only query, page, and perPage.`,
      );
    }
    if (s.sort !== undefined || s.direction !== undefined) {
      throw new AppError(
        400,
        "invalid_query",
        `TPDB ${kind} search supports no sort.`,
      );
    }
    return {
      provider: "tpdb",
      kind,
      query: s.q,
      page: s.page,
      perPage: s.perPage,
    };
  }
  const filters = {
    ...(s.q !== null ? { query: s.q } : {}),
    ...(s.year !== undefined ? { year: s.year } : {}),
    ...(s.performer !== null ? { performer: s.performer } : {}),
    ...(s.studio !== null ? { studio: s.studio } : {}),
    ...(s.tags !== undefined ? { tags: s.tags } : {}),
    ...(s.tagsAll !== undefined ? { tagsAll: s.tagsAll } : {}),
    ...supportedSort("tpdb", kind, s.sort, s.direction),
  };
  // Each kind gets exactly its own union variant; the wide literal that used
  // to sit here is what broke when CatalogKind gained "studio".
  if (kind === "movie") {
    return {
      provider: "tpdb",
      kind,
      ...filters,
      page: s.page,
      perPage: s.perPage,
    };
  }
  return {
    provider: "tpdb",
    kind,
    ...filters,
    page: s.page,
    perPage: s.perPage,
  };
}

async function catalogSearch(request: Request): Promise<Response> {
  await requireSession(request);
  // Pass-through page: total/totalCountKnown report exactly what the
  // provider attests (a capped TPDB total surfaces as totalCountKnown:
  // false), and an outage propagates as an error, never an empty page.
  return json(await searchCatalog(catalogSearchQuery(new URL(request.url))));
}

async function catalogDetail(
  request: Request,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): Promise<Response> {
  const ctx = await requireSession(request);
  const reference = parseCatalogReference(providerRaw, kindRaw, idRaw);
  const detail = await getCatalogDetail(reference);
  if (!detail) {
    throw new AppError(
      404,
      "catalog_not_found",
      "This item is not in the provider catalog.",
    );
  }
  const record = upsertCatalogRecord(detail);
  const media: MediaReference | null = isMediaReference(reference)
    ? reference
    : null;
  // Only the caller's own intent and the shared (user-anonymous) acquisition
  // state; never another user's request history.
  const mine = media
    ? (listRequests(ctx.account).find(
        (r) => r.accountId === ctx.account.id && sameMedia(r.media, media),
      ) ?? null)
    : null;
  const acquisition = media ? getAcquisitionByReference(media) : null;
  return json({
    detail,
    link: crossProviderLink(detail),
    catalogRecord: record,
    myRequest: mine && {
      id: mine.id,
      decision: mine.decision,
      createdAt: mine.createdAt,
      decidedAt: mine.decidedAt,
    },
    acquisition: acquisition && {
      state: acquisition.state,
      lastError: acquisition.lastError,
      updatedAt: acquisition.updatedAt,
    },
  });
}

// Artwork proxy: provider-hosted URLs only, byte-capped pass-through,
// private/no-store, nothing persisted, and no Velvarr or provider
// credentials ever reach the image host (fetchProviderArtwork sends none).
async function catalogImage(request: Request): Promise<Response> {
  await requireSession(request);
  const target = new URL(request.url).searchParams.get("url");
  if (target === null || target === "") {
    throw new AppError(400, "invalid_query", "url is required.");
  }
  const check = isProviderImageUrl(target);
  if (!check.ok) {
    throw new AppError(
      400,
      "invalid_artwork_url",
      `Rejected artwork URL: ${check.reason}.`,
    );
  }
  const { bytes, contentType } = await fetchProviderArtwork(target);
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// Creates one user's request intent from a server-validated MediaReference.
// A browser-supplied resolved payload is never trusted. With the autoApprove
// grant the request is decided approved immediately so shared acquisition
// work is enqueued; otherwise it stays pending for a moderator. No Whisparr
// call happens anywhere on this path.
async function createRequestRoute(request: Request): Promise<Response> {
  guardMutation(request);
  const ctx = await requireSession(request);
  const media = (await readJson(request)).media;
  if (media === null || typeof media !== "object" || Array.isArray(media)) {
    throw new AppError(400, "invalid_field", "Invalid media reference.");
  }
  const m = media as Record<string, unknown>;
  if (
    (m.provider !== "tpdb" && m.provider !== "stashdb") ||
    (m.kind !== "movie" && m.kind !== "scene") ||
    typeof m.id !== "string" ||
    !PROVIDER_UUID.test(m.id)
  ) {
    throw new AppError(400, "invalid_field", "Invalid media reference.");
  }
  const record = createRequest(ctx.account.id, {
    provider: m.provider,
    kind: m.kind,
    id: m.id.toLowerCase(),
  });
  if (ctx.account.autoApprove) {
    return json(
      {
        request: decideRequest(ctx.account, record.id, "approved"),
        autoApproved: true,
      },
      201,
    );
  }
  return json({ request: record }, 201);
}

async function listRequestsRoute(request: Request): Promise<Response> {
  const ctx = await requireSession(request);
  // Storage role-filters: a requester sees only their own history.
  return json({ requests: listRequests(ctx.account) });
}

async function decideRequestRoute(
  request: Request,
  id: string,
): Promise<Response> {
  guardMutation(request);
  const ctx = await requireSession(request);
  const decision = (await readJson(request)).decision;
  const requestId = requireId(id);
  if (decision === "approved" || decision === "declined") {
    return json({
      request: decideRequest(ctx.account, requestId, decision),
    });
  }
  if (decision === "cancelled") {
    return json({ request: cancelRequest(ctx.account, requestId) });
  }
  throw new AppError(
    400,
    "invalid_field",
    "decision must be approved, declined, or cancelled.",
  );
}

// Per-user playback verdict for one external identity. Runs under THIS
// caller's Jellyfin token; hints are the validated reference plus the
// shared acquisition's persisted Whisparr facts when present. This is a
// read route: no Whisparr call ever happens here.
async function availability(
  request: Request,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): Promise<Response> {
  const ctx = await requireSession(request);
  const media = parseMediaReference(providerRaw, kindRaw, idRaw);
  const acquisition = getAcquisitionByReference(media);
  const verdict = await resolvePlaybackAccess(
    ctx.config,
    ctx.token,
    ctx.account,
    {
      provider: media.provider,
      kind: media.kind,
      id: media.id,
      ...(acquisition?.whisparrPath
        ? { whisparrPath: acquisition.whisparrPath }
        : {}),
      ...(acquisition?.whisparrTitle
        ? { title: acquisition.whisparrTitle }
        : {}),
    },
  );
  return json(verdict);
}

// Real provider verification for the admin UI: configured:false stays
// honest, and an outage or auth failure throws rather than masquerading as
// an empty or unverified catalog.
async function adminProviders(ctx: AuthContext): Promise<Response> {
  const [tpdb, stashdb] = await Promise.all([
    getProviderStatus("tpdb"),
    getProviderStatus("stashdb"),
  ]);
  return json({ providers: [tpdb, stashdb] });
}

// --- dispatch ---

async function routeRequest(
  request: Request,
  segments: string[],
  method: string,
): Promise<Response> {
  if (segments[0] !== "api")
    throw new AppError(404, "not_found", "Unknown route.");
  const root = segments[1];
  const a = segments[2];
  const b = segments[3];
  if (method === "GET") {
    if (root === "status" && segments.length === 2)
      return json({ initialized: isInitialized(), setupReady: setupReady() });
    if (root === "health" && segments.length === 2) return json({ ok: true });
    if (root === "me" && segments.length === 2) return me(request);
    if (root === "libraries" && segments.length === 2)
      return libraries(request);
    if (root === "library" && segments.length === 2)
      return libraryPage(request);
    if (root === "library" && segments.length === 3)
      return libraryItem(request, segments[2]!);
    if (root === "images" && segments.length === 3)
      return libraryImage(request, segments[2]!);
    if (root === "catalog" && a === "search" && segments.length === 3)
      return catalogSearch(request);
    if (root === "catalog" && a === "image" && segments.length === 3)
      return catalogImage(request);
    if (root === "catalog" && segments.length === 5)
      return catalogDetail(request, a!, b!, segments[4]!);
    if (root === "requests" && segments.length === 2)
      return listRequestsRoute(request);
    if (root === "availability" && segments.length === 5)
      return availability(request, a!, b!, segments[4]!);
    if (root === "admin" && a === "users" && segments.length === 3)
      return adminUsers(await requireAdmin(request));
    if (root === "admin" && a === "integrations" && segments.length === 3) {
      return json(integrationsShape((await requireAdmin(request)).config));
    }
    if (root === "admin" && a === "whisparr" && segments.length === 3)
      return adminWhisparr(await requireAdmin(request));
    if (root === "admin" && a === "providers" && segments.length === 3)
      return adminProviders(await requireAdmin(request));
  } else if (method === "POST") {
    if (root === "setup" && a === "inspect" && segments.length === 3)
      return setupInspect(request);
    if (root === "setup" && segments.length === 2) return setupCommit(request);
    if (root === "login" && segments.length === 2) return login(request);
    if (root === "logout" && segments.length === 2) return logout(request);
    if (
      root === "admin" &&
      a === "users" &&
      b === "import" &&
      segments.length === 4
    ) {
      const ctx = await requireAdmin(request);
      return adminImport(request, ctx);
    }
    if (root === "requests" && segments.length === 2)
      return createRequestRoute(request);
  } else if (method === "PATCH") {
    if (root === "admin" && a === "users" && segments.length === 4) {
      return adminUpdateUser(
        request,
        await requireAdmin(request),
        segments[3]!,
      );
    }
    if (root === "requests" && segments.length === 3)
      return decideRequestRoute(request, segments[2]!);
    if (root === "admin" && a === "integrations" && segments.length === 3) {
      return adminUpdateIntegrations(request, await requireAdmin(request));
    }
  }
  throw new AppError(404, "not_found", "Unknown route.");
}

// Segments come from the request URL, not `context.params`: Next strips the
// static `/api` prefix from a catch-all's params, so trusting params made every
// route 404 in a real server while direct-handler tests passed.
async function dispatch(request: Request, method: string): Promise<Response> {
  try {
    const segments = new URL(request.url).pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    return await routeRequest(request, segments, method);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  return dispatch(request, "GET");
}

export async function POST(request: Request): Promise<Response> {
  return dispatch(request, "POST");
}

export async function PATCH(request: Request): Promise<Response> {
  return dispatch(request, "PATCH");
}
