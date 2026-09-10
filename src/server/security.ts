import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionGrant } from "../lib/contracts.ts";
import { AppError } from "./http.ts";

const COOKIE_NAME = "velvarr_session";

// Login attempt limiter: one process-global bucket plus one per account name,
// fixed five-minute windows. ponytail: in-memory only, resets on restart —
// durable counters only if abuse survives process restarts.
const WINDOW_MS = 5 * 60_000;
const GLOBAL_LIMIT = 30;
const ACCOUNT_LIMIT = 5;
const MAX_BUCKETS = 1024;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

// Shared by guardMutation and sessionCookie so cookie flags and origin checks
// can never disagree.
function configuredOrigin(): string {
  return (process.env.VELVARR_ORIGIN || "http://127.0.0.1:5577").replace(
    /\/+$/,
    "",
  );
}

function consumeBucket(key: string, limit: number, now: number): void {
  const current = buckets.get(key);
  if (!current || now - current.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  if (current.count >= limit) {
    throw new AppError(
      429,
      "too_many_attempts",
      "too many attempts; try again later",
    );
  }
  current.count += 1;
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
    }
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function enforceOriginConfig(): URL {
  let url: URL;
  try {
    url = new URL(configuredOrigin());
  } catch {
    throw new AppError(
      500,
      "bad_origin_config",
      "VELVARR_ORIGIN is not a valid URL",
    );
  }
  if (
    url.protocol !== "https:" &&
    !isLoopbackHost(url.hostname) &&
    process.env.VELVARR_ALLOW_HTTP !== "1"
  ) {
    throw new AppError(
      500,
      "unsafe_origin",
      "non-loopback HTTP origins require explicit VELVARR_ALLOW_HTTP=1",
    );
  }
  return url;
}

export function guardMutation(request: Request): void {
  const configured = enforceOriginConfig();
  const header = request.headers.get("origin");
  if (!header) {
    throw new AppError(403, "origin_missing", "missing Origin header");
  }
  let got: URL;
  try {
    got = new URL(header);
  } catch {
    throw new AppError(403, "origin_mismatch", "origin not allowed");
  }
  if (got.origin !== configured.origin) {
    throw new AppError(403, "origin_mismatch", "origin not allowed");
  }
}

export function verifySetupSecret(value: unknown): void {
  const expected = process.env.VELVARR_SETUP_SECRET;
  if (
    typeof value !== "string" ||
    !expected ||
    expected.length < 32 ||
    !timingSafeEqual(
      createHash("sha256").update(value).digest(),
      createHash("sha256").update(expected).digest(),
    )
  ) {
    throw new AppError(403, "setup_secret_invalid", "setup secret is invalid");
  }
}

export function consumeLoginAttempt(name: string): void {
  const now = Date.now();
  consumeBucket("global", GLOBAL_LIMIT, now);
  consumeBucket(
    `account:${typeof name === "string" ? name.trim().toLowerCase() : ""}`,
    ACCOUNT_LIMIT,
    now,
  );
}

export function sessionCookie(grant?: SessionGrant): string {
  const secure = configuredOrigin().startsWith("https://") ? "; Secure" : "";
  if (!grant) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }
  const maxAge = Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1000));
  return `${COOKIE_NAME}=${grant.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
