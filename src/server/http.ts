// Shared upstream HTTP layer for the Jellyfin and Whisparr integrations.
// Guarantees: base URLs validated with reverse-proxy path prefixes preserved,
// no redirect following, header-injection-proof tokens, bounded time and
// response size, Content-Type validation, and sanitized errors that never
// carry upstream URLs, tokens, query keys, or response bodies.

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const JSON_LIMIT = 2 * 1024 * 1024;

type Service = "jellyfin" | "whisparr";

function serviceName(service: Service): string {
  return service === "whisparr" ? "Whisparr" : "Jellyfin";
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

function isPrivateHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  return h.endsWith(".local") || h.startsWith("fc") || h.startsWith("fd");
}

// Preserves any reverse-proxy path prefix, strips trailing slashes, and
// rejects query strings, fragments, userinfo, and non-private plain HTTP.
export function validateBaseUrl(value: string): string {
  const invalid = () =>
    new AppError(
      400,
      "invalid_url",
      "A valid integration base URL is required.",
    );
  if (typeof value !== "string") throw invalid();
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\\") || /\s/.test(trimmed)) throw invalid();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw invalid();
  }
  if (u.username || u.password || u.search || u.hash) throw invalid();
  const scheme = u.protocol.slice(0, -1);
  if (scheme === "http") {
    if (!isLoopbackHost(u.hostname)) {
      // ponytail: EnableRemoteAccess-style trusted client-network model does
      // not exist yet, so private HTTP needs the explicit operator escape
      // hatch; public HTTP origins are always rejected.
      if (
        process.env.VELVARR_ALLOW_HTTP !== "1" ||
        !isPrivateHost(u.hostname)
      ) {
        throw new AppError(
          400,
          "invalid_url",
          "Plain HTTP is only allowed for loopback, or for trusted private addresses when VELVARR_ALLOW_HTTP=1.",
        );
      }
    }
  } else if (scheme !== "https") {
    throw invalid();
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function validateToken(token: string): string {
  if (token === "") return "";
  if (
    typeof token !== "string" ||
    !/^[\x21-\x7E]{8,512}$/.test(token) ||
    token.includes('"') ||
    token.includes("\\")
  ) {
    throw new AppError(
      400,
      "invalid_token",
      "The stored integration credential has an invalid format.",
    );
  }
  return token;
}

function validatePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > 2048 ||
    /[\u0000-\u001f\u007f\s\\]/.test(path)
  ) {
    throw new AppError(400, "invalid_path", "Invalid upstream request path.");
  }
  return path;
}

const AUTH_BASE =
  'MediaBrowser Client="Velvarr", Device="Server", DeviceId="velvarr", Version="0.1.0"';

async function send(
  baseUrl: string,
  path: string,
  token: string,
  service: Service,
  method: string,
  body: unknown,
  timeoutMs: number,
  accept: string,
): Promise<Response> {
  const target = validateBaseUrl(baseUrl) + validatePath(path);
  const cleanToken = validateToken(token);
  const headers: Record<string, string> = { Accept: accept };
  if (service === "whisparr") headers["X-Api-Key"] = cleanToken;
  else {
    // Jellyfin MediaBrowser authorization; the Token segment is omitted only
    // for public endpoints and login (AuthenticateByName).
    headers.Authorization =
      cleanToken === "" ? AUTH_BASE : `${AUTH_BASE}, Token="${cleanToken}"`;
  }
  const init: RequestInit = { method, headers, redirect: "error" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect: 'error' — a 3xx from an upstream is a misconfiguration or an
    // attempt to move credentials elsewhere; it is never followed.
    return await fetch(target, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw new AppError(
        504,
        "upstream_timeout",
        `${serviceName(service)} did not respond in time.`,
      );
    }
    throw new AppError(
      502,
      "upstream_unavailable",
      `${serviceName(service)} could not be reached.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requireSuccess(res: Response, service: Service): Promise<void> {
  if (res.status === 401) {
    throw new AppError(
      401,
      "upstream_auth",
      `${serviceName(service)} rejected the stored credentials.`,
    );
  }
  if (res.status === 403) {
    throw new AppError(
      403,
      "upstream_forbidden",
      `${serviceName(service)} denied access to the requested resource.`,
    );
  }
  if (res.status === 404) {
    throw new AppError(
      404,
      "upstream_not_found",
      `The requested ${serviceName(service)} resource was not found.`,
    );
  }
  if (!res.ok) {
    throw new AppError(
      502,
      "upstream_unavailable",
      `${serviceName(service)} reported an unexpected error.`,
    );
  }
}

async function readBounded(
  res: Response,
  limit: number,
  service: Service,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // best-effort cancel only
      }
      throw new AppError(
        502,
        "upstream_bad_response",
        `${serviceName(service)} returned an oversized response.`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  token: string,
  // timeoutMs is an internal/test knob; callers use the 15s default.
  options: {
    method?: string;
    body?: unknown;
    service?: Service;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const service = options.service ?? "jellyfin";
  const res = await send(
    baseUrl,
    path,
    token,
    service,
    options.method ?? "GET",
    options.body,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "application/json",
  );
  await requireSuccess(res, service);
  const contentType = res.headers.get("content-type") ?? "";
  if (!/application\/(?:json|[\w.+-]+\+json)\b/i.test(contentType)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      `${serviceName(service)} returned an unexpected content type.`,
    );
  }
  const bytes = await readBounded(res, JSON_LIMIT, service);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new AppError(
      502,
      "upstream_bad_response",
      `${serviceName(service)} returned malformed JSON.`,
    );
  }
}

export async function requestBytes(
  baseUrl: string,
  path: string,
  token: string,
  options: { service?: Service; timeoutMs?: number; sizeLimit?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const service = options.service ?? "jellyfin";
  const res = await send(
    baseUrl,
    path,
    token,
    service,
    "GET",
    undefined,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "*/*",
  );
  await requireSuccess(res, service);
  const bytes = await readBounded(
    res,
    options.sizeLimit ?? JSON_LIMIT,
    service,
  );
  return { bytes, contentType: (res.headers.get("content-type") ?? "").trim() };
}
