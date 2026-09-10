import type {
  Account,
  ExternalUser,
  IntegrationConfig,
  Library,
  ProviderStatus,
  Role,
} from "../../../lib/contracts.ts";
import {
  bootstrap,
  createSession,
  getAccount,
  getConfig,
  getSession,
  importAccounts,
  isInitialized,
  listAccounts,
  revokeSession,
  saveConfig,
  updateAccount,
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
  validateUser,
} from "../../../server/jellyfin.ts";
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
  return json({
    account: ctx.account,
    providers: {
      tpdb: process.env.TPDB_API_TOKEN ? "not_verified" : "not_configured",
      stashdb: process.env.STASHDB_API_KEY ? "not_verified" : "not_configured",
    } satisfies ProviderStatus,
  });
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
  const account = updateAccount(target.id, { enabled, role, libraryIds });
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
    if (root === "admin" && a === "users" && segments.length === 3)
      return adminUsers(await requireAdmin(request));
    if (root === "admin" && a === "integrations" && segments.length === 3) {
      return json(integrationsShape((await requireAdmin(request)).config));
    }
    if (root === "admin" && a === "whisparr" && segments.length === 3)
      return adminWhisparr(await requireAdmin(request));
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
  } else if (method === "PATCH") {
    if (root === "admin" && a === "users" && segments.length === 4) {
      return adminUpdateUser(
        request,
        await requireAdmin(request),
        segments[3]!,
      );
    }
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
