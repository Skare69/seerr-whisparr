// API regression tests: privilege, CSRF, session, library denial, outage honesty.
// Runs handlers directly against local fixture servers. No real network, no real providers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";

// Isolated environment BEFORE importing route/storage modules.
process.env.VELVARR_DATA_DIR = mkdtempSync(join(tmpdir(), "velvarr-api-test-"));
process.env.VELVARR_SECRET_KEY = "ab".repeat(32);
process.env.VELVARR_SETUP_SECRET = "setup-secret-".repeat(4);
process.env.VELVARR_ORIGIN = "http://127.0.0.1:5577";
delete process.env.TPDB_API_TOKEN;
delete process.env.STASHDB_API_KEY;

const ORIGIN = process.env.VELVARR_ORIGIN;

// --- fixture identities (32-hex Jellyfin-style IDs) ---

const SERVER_ID = "c".repeat(32);
const OWNER_ID = "d".repeat(32);
const MEMBER_ID = "e".repeat(32);
const MEMBER2_ID = "4".repeat(32);
const DISABLED_ID = "f0".repeat(16);
const OUTSIDER_ID = "6".repeat(32);
const NOGRANT_ID = "7".repeat(32);
const MOVIES_LIB = "a".repeat(32);
const SHOWS_LIB = "b".repeat(32);
const ITEM_MOVIE = "1".repeat(32);
const ITEM_SHOW = "2".repeat(32);

interface FxUser {
  id: string;
  name: string;
  admin: boolean;
  disabled: boolean;
  remote: boolean;
  playback: boolean;
}

const fx = {
  adminKey: "jf-admin-key-9",
  serverId: SERVER_ID,
  tokenCounter: 0,
  users: [
    {
      id: OWNER_ID,
      name: "owner",
      admin: true,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: MEMBER_ID,
      name: "member",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: MEMBER2_ID,
      name: "member2",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: DISABLED_ID,
      name: "wrecked",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: OUTSIDER_ID,
      name: "outsider",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
    {
      id: NOGRANT_ID,
      name: "nogrants",
      admin: false,
      disabled: false,
      remote: true,
      playback: true,
    },
  ] as FxUser[],
  tokens: new Map<string, string>(), // access token -> user id
  impersonate: null as string | null, // force /Users/Me identity for regression testing

  fail: { items: 0, views: 0, me401: 0 },
  libraries: [
    { id: MOVIES_LIB, name: "Movies", type: "movies" },
    { id: SHOWS_LIB, name: "Shows", type: "homevideos" },
  ],
  grants: new Map<string, string[]>(), // user id -> allowed library ids (missing entry = unrestricted)
  items: [
    { Id: ITEM_MOVIE, Name: "Alpha Movie", libraryId: MOVIES_LIB },
    { Id: ITEM_SHOW, Name: "Beta Show", libraryId: SHOWS_LIB },
  ],
};

// Sequential tests share session cookies through this module state.
let owner = "";
let member = "";

const PNG_1PX = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function jfUser(user: FxUser) {
  return {
    Id: user.id,
    Name: user.name,
    Policy: {
      IsAdministrator: user.admin,
      IsDisabled: user.disabled,
      EnableRemoteAccess: user.remote,
      EnableMediaPlayback: user.playback,
    },
  };
}

function jfItem(item: (typeof fx.items)[number]) {
  return {
    Id: item.Id,
    Name: item.Name,
    ProductionYear: 2020,
    Overview: `Overview of ${item.Name}`,
    RunTimeTicks: 6_000_000_000,
    LocationType: "FileSystem",
    MediaType: "Video",
    ImageTags: { Primary: "primary" },
    Path: `/media/${item.Id}.mkv`,
    MediaSources: [
      {
        Id: item.Id,
        Path: `/media/${item.Id}.mkv`,
        Protocol: "File",
        SupportsDirectPlay: true,
      },
    ],
  };
}

function grantsFor(userId: string | undefined): string[] | null {
  if (!userId) return null;
  const entry = fx.grants.get(userId);
  return entry ? entry : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function jellyfinHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fixture");
  const p = url.pathname;
  const token = /Token="([^"]*)"/.exec(
    String(req.headers.authorization ?? ""),
  )?.[1];
  const userId = token ? (fx.tokens.get(token) ?? null) : null;

  if (p === "/System/Info/Public")
    return json(res, 200, { Id: fx.serverId, ServerName: "FixtureJF" });
  if (p === "/Users/AuthenticateByName" && req.method === "POST") {
    const body = await readBody(req);
    const match = fx.users.find(
      (entry) =>
        entry.name === body.Username && body.Pw === `pass-${entry.name}`,
    );
    if (!match || match.disabled) return json(res, 401, {});
    fx.tokenCounter += 1;
    const access = `jf-${match.id}-${fx.tokenCounter}`;
    fx.tokens.set(access, match.id);
    return json(res, 200, {
      User: jfUser(match),
      AccessToken: access,
      ServerId: fx.serverId,
    });
  }
  if (p === "/Users/Me") {
    if (fx.fail.me401 > 0) {
      fx.fail.me401 -= 1;
      return json(res, 401, {});
    }
    const effectiveId = fx.impersonate ?? userId;
    const effective = fx.users.find((entry) => entry.id === effectiveId);
    if (!effective) return json(res, 401, {});
    return json(res, 200, jfUser(effective));
  }
  if (p === "/Users") {
    if (token !== fx.adminKey) return json(res, 401, {});
    return json(res, 200, fx.users.map(jfUser));
  }
  if (/^\/Users\/[^/]+\/Views$/.test(p) || p === "/Library/MediaFolders") {
    if (fx.fail.views > 0) {
      fx.fail.views -= 1;
      return json(res, 500, {});
    }
    const grants = grantsFor(userId ?? undefined);
    const libs = grants
      ? fx.libraries.filter((lib) => grants.includes(lib.id))
      : fx.libraries;
    return json(res, 200, {
      Items: libs.map((lib) => ({
        Id: lib.id,
        Name: lib.name,
        CollectionType: lib.type,
      })),
      TotalRecordCount: libs.length,
    });
  }
  // listLibraryItems always queries /Users/{id}/Items with camelCase params.
  if (/^\/Users\/[0-9a-f]{32}\/Items$/.test(p)) {
    if (fx.fail.items > 0) {
      fx.fail.items -= 1;
      return json(res, 500, {});
    }
    const grants = grantsFor(userId ?? undefined);
    const parentId = url.searchParams.get("parentId");
    if (parentId && grants && !grants.includes(parentId))
      return json(res, 404, {});
    let list = fx.items.filter(
      (item) => !grants || grants.includes(item.libraryId),
    );
    if (parentId) list = list.filter((item) => item.libraryId === parentId);
    const search = url.searchParams.get("searchTerm");
    if (search)
      list = list.filter((item) =>
        item.Name.toLowerCase().includes(search.toLowerCase()),
      );
    const ids = url.searchParams.get("ids");
    if (ids) list = list.filter((item) => ids.split(",").includes(item.Id));
    const start = Number(url.searchParams.get("startIndex") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? list.length);
    return json(res, 200, {
      Items: list.slice(start, start + limit).map(jfItem),
      TotalRecordCount: list.length,
    });
  }
  // getLibraryItem proves playback with a real PlaybackInfo verdict.
  if (/^\/Items\/[0-9a-f]{32}\/PlaybackInfo$/.test(p) && req.method === "GET") {
    const itemId = /Items\/([0-9a-f]{32})\/PlaybackInfo/.exec(p)?.[1];
    const item = fx.items.find((entry) => entry.Id === itemId);
    if (!item) return json(res, 404, {});
    return json(res, 200, { MediaSources: jfItem(item).MediaSources });
  }
  if (/^\/(?:Users\/[^/]+\/)?Items\/[0-9a-f]{32}\/Images\/Primary$/.test(p)) {
    const itemId = /Items\/([0-9a-f]{32})\/Images/.exec(p)?.[1];
    const item = fx.items.find((entry) => entry.Id === itemId);
    const grants = grantsFor(userId ?? undefined);
    if (!item || (grants && !grants.includes(item.libraryId)))
      return json(res, 404, {});
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PNG_1PX));
    return;
  }
  json(res, 404, {});
}

const whisparrKey = "wh-fixture-key";

async function whisparrHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fixture");
  if (req.headers["x-api-key"] !== whisparrKey) return json(res, 401, {});
  if (url.pathname === "/api/v3/system/status")
    return json(res, 200, { version: "3.4.0.1387", appName: "Whisparr" });
  if (url.pathname === "/api/v3/rootfolder")
    return json(res, 200, [{ id: 1, path: "/movies" }]);
  if (url.pathname === "/api/v3/qualityprofile")
    return json(res, 200, [{ id: 1, name: "HD" }]);
  json(res, 404, {});
}

async function differentServerHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  json(res, 200, { Id: "dead".repeat(8), ServerName: "OtherServer" });
}

// --- harness ---

let jellyfinServer: Server;
let whisparrServer: Server;
let otherServer: Server;
let jellyfinUrl: string;
let whisparrUrl: string;
let otherServerUrl: string;

type Handler = (
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) => Promise<Response>;
let api: { GET: Handler; POST: Handler; PATCH: Handler };
let closeStorage: () => void;

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; url: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    server: Server;
    url: string;
  }>();
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  });
  return promise;
}

function segments(pathname: string): string[] {
  return pathname
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => decodeURIComponent(part));
}

async function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  init: { origin?: string | null; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.origin = origin;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(ORIGIN + path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const handler =
    method === "GET" ? api.GET : method === "POST" ? api.POST : api.PATCH;
  return handler(request, {
    params: Promise.resolve({ path: segments(new URL(path, ORIGIN).pathname) }),
  });
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function loginAs(name: string): Promise<string> {
  const res = await call("POST", "/api/login", {
    body: { username: name, password: `pass-${name}` },
  });
  const text = await res.text();
  assert.equal(
    res.status,
    200,
    `login as ${name} failed: ${res.status} ${text}`,
  );
  const cookie = cookieOf(res);
  assert.match(cookie, /^velvarr_session=/);
  return cookie;
}

async function errorShape(
  response: Response,
  minStatus = 400,
): Promise<{ code: string; message: string }> {
  assert.ok(
    response.status >= minStatus,
    `expected status >= ${minStatus}, got ${response.status}`,
  );
  const body = (await response.json()) as {
    error?: { code?: unknown; message?: unknown };
  };
  assert.ok(
    body.error &&
      typeof body.error.code === "string" &&
      typeof body.error.message === "string",
  );
  return body.error as { code: string; message: string };
}

// --- tests ---

before(async () => {
  ({ server: jellyfinServer, url: jellyfinUrl } =
    await listen(jellyfinHandler));
  ({ server: whisparrServer, url: whisparrUrl } =
    await listen(whisparrHandler));
  ({ server: otherServer, url: otherServerUrl } = await listen(
    differentServerHandler,
  ));
  // Dynamic import required: the env block above must exist before storage binds,
  // and the [...path] bracket directory is not addressable as a static ESM specifier.
  const routeHref = pathToFileURL(
    fileURLToPath(
      new URL("../src/app/api/[...path]/route.ts", import.meta.url),
    ),
  ).href;
  api = (await import(routeHref)) as {
    GET: Handler;
    POST: Handler;
    PATCH: Handler;
  };
  const storageHref = pathToFileURL(
    fileURLToPath(new URL("../src/server/storage.ts", import.meta.url)),
  ).href;
  ({ closeStorage } = (await import(storageHref)) as {
    closeStorage: () => void;
  });
});

after(() => {
  for (const server of [jellyfinServer, whisparrServer, otherServer]) {
    server.closeAllConnections?.();
    server.close();
  }
  closeStorage();
});

test("public surface: health, status, unknown routes", async () => {
  const health = await call("GET", "/api/health");
  assert.deepEqual(await health.json(), { ok: true });

  const status = await call("GET", "/api/status");
  assert.deepEqual(await status.json(), {
    initialized: false,
    setupReady: true,
  });

  const unknown = await call("GET", "/api/nope");
  assert.equal(unknown.status, 404);
  assert.ok(((await unknown.json()) as { error: object }).error);

  const wrongMethod = await call("GET", "/api/login");
  assert.equal(wrongMethod.status, 404);

  const traversal = await call("GET", "/api/library/../../status");
  assert.notEqual(traversal.status, 200);
});

test("mutations are origin protected (CSRF)", async () => {
  const missing = await call("POST", "/api/setup/inspect", {
    origin: null,
    body: {},
  });
  await errorShape(missing, 403);
  const foreign = await call("POST", "/api/setup/inspect", {
    origin: "https://evil.example",
    body: {},
  });
  await errorShape(foreign, 403);
  const setupForeign = await call("POST", "/api/setup", {
    origin: "https://evil.example",
    body: {},
  });
  await errorShape(setupForeign, 403);
  const loginForeign = await call("POST", "/api/login", {
    origin: "https://evil.example",
    body: {},
  });
  await errorShape(loginForeign, 403);
});

const inspectBody = () => ({
  setupSecret: process.env.VELVARR_SETUP_SECRET,
  username: "owner",
  password: "pass-owner",
  jellyfinUrl,
  jellyfinExternalUrl: jellyfinUrl,
  jellyfinApiKey: fx.adminKey,
});

test("setup inspect validates secret, authenticates, returns real selection", async () => {
  const badSecret = await call("POST", "/api/setup/inspect", {
    body: {
      ...inspectBody(),
      setupSecret: "wrong-secret-wrong-secret-wrong-secret!",
    },
  });
  await errorShape(badSecret);

  const unknownUser = await call("POST", "/api/setup/inspect", {
    body: { ...inspectBody(), username: "ghost", password: "pass-ghost" },
  });
  await errorShape(unknownUser);

  const ok = await call("POST", "/api/setup/inspect", { body: inspectBody() });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    user: { id: string; name: string };
    libraries: { id: string }[];
  };
  assert.deepEqual(body.user, { id: OWNER_ID, name: "owner" });
  assert.deepEqual(
    body.libraries.map((lib) => lib.id).sort(),
    [MOVIES_LIB, SHOWS_LIB].sort(),
  );
  assert.equal(ok.headers.get("set-cookie"), null);
  assert.equal(JSON.stringify(body).includes("pass-owner"), false);
  assert.equal(JSON.stringify(body).includes(fx.adminKey), false);
});

test("setup commit is atomic, one-time, and race cannot overwrite config", async () => {
  const missingLibs = await call("POST", "/api/setup", {
    body: { ...inspectBody(), libraryIds: [] },
  });
  await errorShape(missingLibs);

  const unknownLib = await call("POST", "/api/setup", {
    body: { ...inspectBody(), libraryIds: ["9".repeat(32)] },
  });
  await errorShape(unknownLib);

  const whisparrNoKey = await call("POST", "/api/setup", {
    body: {
      ...inspectBody(),
      libraryIds: [MOVIES_LIB],
      whisparrUrl: whisparrUrl,
    },
  });
  await errorShape(whisparrNoKey);

  const stillFresh = await call("GET", "/api/status");
  assert.equal(
    ((await stillFresh.json()) as { initialized: boolean }).initialized,
    false,
  );

  const ok = await call("POST", "/api/setup", {
    body: { ...inspectBody(), libraryIds: [MOVIES_LIB, SHOWS_LIB] },
  });
  assert.equal(ok.status, 200);
  owner = cookieOf(ok);
  assert.match(owner, /^velvarr_session=/);
  const account = (await ok.json()) as {
    account: { id: string; isOwner: boolean; role: string; enabled: boolean };
  };
  assert.deepEqual(
    {
      id: account.account.id,
      isOwner: account.account.isOwner,
      role: account.account.role,
      enabled: account.account.enabled,
    },
    { id: OWNER_ID, isOwner: true, role: "admin", enabled: true },
  );

  const afterInit = await call("GET", "/api/status");
  assert.deepEqual(await afterInit.json(), {
    initialized: true,
    setupReady: true,
  });

  // Wrong setup race: a competing commit after initialization must fail without touching config.
  const race = await call("POST", "/api/setup", {
    body: {
      ...inspectBody(),
      username: "member2",
      password: "pass-member2",
      libraryIds: [SHOWS_LIB],
    },
  });
  await errorShape(race, 409);
  assert.equal(cookieOf(race), "");

  const integrations = await call("GET", "/api/admin/integrations", {
    cookie: owner,
  });
  const shape = (await integrations.json()) as {
    jellyfin: { url: string; serverId: string; apiKeyConfigured: boolean };
  };
  assert.equal(shape.jellyfin.url, jellyfinUrl);
  assert.equal(shape.jellyfin.serverId, SERVER_ID);
  assert.equal(shape.jellyfin.apiKeyConfigured, true);
  assert.equal(JSON.stringify(shape).includes(fx.adminKey), false);
});

test("session requirement and honest provider status", async () => {
  const anon = await call("GET", "/api/me");
  assert.equal(anon.status, 401);

  const garbage = await call("GET", "/api/me", {
    cookie: "velvarr_session=nonsense",
  });
  assert.equal(garbage.status, 401);

  const me = await call("GET", "/api/me", { cookie: owner });
  assert.equal(me.status, 200);
  const body = (await me.json()) as {
    account: { name: string; isOwner: boolean };
    providers: Record<string, string>;
  };
  assert.equal(body.account.name, "owner");
  assert.equal(body.account.isOwner, true);
  assert.deepEqual(body.providers, {
    tpdb: "not_configured",
    stashdb: "not_configured",
  });
});

test("admin import creates disabled grantless accounts; privilege boundary holds", async () => {
  const anon = await call("GET", "/api/admin/users");
  assert.equal(anon.status, 401);

  const imported = await call("POST", "/api/admin/users/import", {
    cookie: owner,
  });
  assert.equal(imported.status, 200);
  const body = (await imported.json()) as {
    accounts: {
      id: string;
      enabled: boolean;
      libraryIds: string[];
      role: string;
    }[];
  };
  assert.ok(body.accounts.length >= 5);
  for (const account of body.accounts) {
    if (account.id !== OWNER_ID) {
      assert.equal(account.enabled, false);
      assert.deepEqual(account.libraryIds, []);
      assert.equal(account.role, "requester");
    }
  }
  assert.equal(JSON.stringify(body).includes(fx.adminKey), false);

  // Re-import must not re-enable or duplicate.
  await call("POST", "/api/admin/users/import", { cookie: owner });
  const listed = await call("GET", "/api/admin/users", { cookie: owner });
  const listedBody = (await listed.json()) as {
    accounts: { id: string; enabled: boolean }[];
    libraries: { id: string }[];
  };
  assert.equal(listedBody.accounts.length, fx.users.length);
  assert.deepEqual(
    listedBody.libraries.map((lib) => lib.id).sort(),
    [MOVIES_LIB, SHOWS_LIB].sort(),
  );
  assert.equal(
    listedBody.accounts.find((account) => account.id === MEMBER_ID)?.enabled,
    false,
  );

  // Login while locally disabled is denied.
  const disabledLogin = await call("POST", "/api/login", {
    body: { username: "member", password: "pass-member" },
  });
  await errorShape(disabledLogin, 403);

  // Grant member the Movies library and enable.
  fx.grants.set(MEMBER_ID, [MOVIES_LIB]);
  const patched = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: [MOVIES_LIB] },
  });
  assert.equal(patched.status, 200);
  assert.equal(
    ((await patched.json()) as { account: { enabled: boolean } }).account
      .enabled,
    true,
  );

  // Owner protection.
  const disableOwner = await call("PATCH", `/api/admin/users/${OWNER_ID}`, {
    cookie: owner,
    body: { enabled: false, role: "admin", libraryIds: [] },
  });
  await errorShape(disableOwner, 403);
  const demoteOwner = await call("PATCH", `/api/admin/users/${OWNER_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "moderator", libraryIds: [] },
  });
  await errorShape(demoteOwner, 403);
  const badLibrary = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: ["9".repeat(32)] },
  });
  await errorShape(badLibrary);
  member = await loginAs("member");
  const memberAdmin = await call("GET", "/api/admin/users", { cookie: member });
  await errorShape(memberAdmin, 403);
  const memberImport = await call("POST", "/api/admin/users/import", {
    cookie: member,
  });
  await errorShape(memberImport, 403);
  const memberEscalate = await call("PATCH", `/api/admin/users/${MEMBER_ID}`, {
    cookie: member,
    body: { enabled: true, role: "admin", libraryIds: [MOVIES_LIB, SHOWS_LIB] },
  });
  await errorShape(memberEscalate, 403);
  const memberIntegrations = await call("PATCH", "/api/admin/integrations", {
    cookie: member,
    body: {
      password: "pass-member",
      jellyfinUrl,
      jellyfinExternalUrl: jellyfinUrl,
    },
  });
  await errorShape(memberIntegrations, 403);
  const memberWhisparr = await call("GET", "/api/admin/whisparr", {
    cookie: member,
  });
  await errorShape(memberWhisparr, 403);
});

test("request and body validation bounds", async () => {
  for (const query of [
    "limit=61",
    "limit=0",
    "limit=abc",
    "start=-1",
    `search=${"x".repeat(201)}`,
    "start=100001",
  ]) {
    const res = await call("GET", `/api/library?${query}`, { cookie: member });
    await errorShape(res);
  }
  const huge = await call("POST", "/api/login", {
    body: { username: "x".repeat(40000), password: "y" },
  });
  await errorShape(huge, 413);
  const badId = await call("GET", "/api/images/not-an-id", { cookie: member });
  await errorShape(badId);
  const traversalId = await call("GET", "/api/library/zzzz", {
    cookie: member,
  });
  await errorShape(traversalId);
});

test("library access is bounded by grants; no path leakage; protected images", async () => {
  const libs = await call("GET", "/api/libraries", { cookie: member });
  const libsBody = (await libs.json()) as { libraries: { id: string }[] };
  assert.deepEqual(
    libsBody.libraries.map((lib) => lib.id),
    [MOVIES_LIB],
  );

  const page = await call("GET", "/api/library", { cookie: member });
  assert.equal(page.status, 200);
  const pageBody = (await page.json()) as {
    items: { id: string }[];
    total: number;
  };
  assert.deepEqual(
    pageBody.items.map((item) => item.id),
    [ITEM_MOVIE],
  );
  assert.equal(pageBody.total, 1);

  const deniedLib = await call("GET", `/api/library?libraryId=${SHOWS_LIB}`, {
    cookie: member,
  });
  await errorShape(deniedLib, 403);

  const grantedLib = await call("GET", `/api/library?libraryId=${MOVIES_LIB}`, {
    cookie: member,
  });
  assert.equal(grantedLib.status, 200);

  const search = await call("GET", "/api/library?search=alpha", {
    cookie: member,
  });
  assert.equal(((await search.json()) as { total: number }).total, 1);

  const deniedItem = await call("GET", `/api/library/${ITEM_SHOW}`, {
    cookie: member,
  });
  // Denied must be an explicit error, never an empty success.
  await errorShape(deniedItem, 403);

  const item = await call("GET", `/api/library/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(item.status, 200);
  const itemText = await item.text();
  assert.equal(
    itemText.includes("/media/"),
    false,
    "server paths must never reach the browser",
  );
  assert.ok((JSON.parse(itemText) as { item: { name: string } }).item.name);

  const image = await call("GET", `/api/images/${ITEM_MOVIE}`, {
    cookie: member,
  });
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type") ?? "", /^image\//);
  assert.match(image.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.ok((await image.arrayBuffer()).byteLength > 0);

  const deniedImage = await call("GET", `/api/images/${ITEM_SHOW}`, {
    cookie: member,
  });
  await errorShape(deniedImage, 403);

  const anonImage = await call("GET", `/api/images/${ITEM_MOVIE}`);
  assert.equal(anonImage.status, 401);
});

test("empty grant list never means all libraries", async () => {
  fx.grants.set(NOGRANT_ID, []);
  const enabled = await call("PATCH", `/api/admin/users/${NOGRANT_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: [] },
  });
  assert.equal(enabled.status, 200);
  const cookie = await loginAs("nogrants");

  fx.fail.items = 9;
  const page = await call("GET", "/api/library", { cookie });
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), {
    items: [],
    total: 0,
    start: 0,
    limit: 24,
  });
  const libs = await call("GET", "/api/libraries", { cookie });
  assert.deepEqual(await libs.json(), { libraries: [] });
});

test("outages are errors, never empty successes; transient failures keep sessions", async () => {
  fx.fail.views = 2; // one failure per call: both owner and member must see the outage
  const libsFail = await call("GET", "/api/libraries", { cookie: owner });
  await errorShape(libsFail, 500);
  const memberLibsFail = await call("GET", "/api/libraries", {
    cookie: member,
  });
  await errorShape(memberLibsFail, 500);

  fx.fail.items = 1;
  const pageFail = await call("GET", "/api/library", { cookie: member });
  await errorShape(pageFail, 500);

  // Session must survive transient upstream failure.
  fx.fail.me401 = 0;
  const stillIn = await call("GET", "/api/me", { cookie: member });
  assert.equal(stillIn.status, 200);

  // Unconfigured whisparr reports honestly as configured:false, not an outage.
  const whisparr = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(whisparr.status, 200);
  assert.equal(
    ((await whisparr.json()) as { configured: boolean }).configured,
    false,
  );
});

test("identity regressions: foreign identity, upstream invalidation, remote denial", async () => {
  const enable = await call("PATCH", `/api/admin/users/${MEMBER2_ID}`, {
    cookie: owner,
    body: { enabled: true, role: "requester", libraryIds: [] },
  });
  assert.equal(enable.status, 200);
  let cookie = await loginAs("member2");

  // Remote-disabled upstream account is rejected.
  const member2 = fx.users.find((user) => user.id === MEMBER2_ID)!;
  member2.remote = false;
  const remote = await call("GET", "/api/me", { cookie });
  assert.equal(remote.status, 403);
  member2.remote = true;
  // Permission denial does not revoke: still signed in after policy restored.
  assert.equal((await call("GET", "/api/me", { cookie })).status, 200);

  // Upstream identity swap (stolen token mapping to a different user) revokes.
  fx.impersonate = OUTSIDER_ID;
  assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
  fx.impersonate = null;
  assert.equal(
    (await call("GET", "/api/me", { cookie })).status,
    401,
    "revocation must persist",
  );

  cookie = await loginAs("member2");

  // Proven upstream 401 invalidates the stored token.
  fx.fail.me401 = 1;
  assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
  cookie = await loginAs("member2");

  // Upstream disabled account: rejected and session revoked.
  member2.disabled = true;
  assert.equal((await call("GET", "/api/me", { cookie })).status, 403);
  member2.disabled = false;
  assert.equal(
    (await call("GET", "/api/me", { cookie })).status,
    401,
    "disabled identity must revoke session",
  );
  cookie = await loginAs("member2");
  assert.equal((await call("GET", "/api/me", { cookie })).status, 200);
});

test("integration rotation: fresh password auth, pinned server, whisparr add/remove", async () => {
  const wrongPassword = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "wrong-password",
      jellyfinUrl,
      jellyfinExternalUrl: jellyfinUrl,
    },
  });
  await errorShape(wrongPassword, 403);

  // Same server, new external URL: allowed, grants preserved.
  const external = `${jellyfinUrl}/media`;
  const rotated = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "pass-owner",
      jellyfinUrl,
      jellyfinExternalUrl: external,
      jellyfinApiKey: "",
    },
  });
  assert.equal(rotated.status, 200);
  const rotatedBody = (await rotated.json()) as {
    jellyfin: { externalUrl: string; libraryIds: string[] };
  };
  assert.equal(rotatedBody.jellyfin.externalUrl, external);
  assert.deepEqual(
    rotatedBody.jellyfin.libraryIds.sort(),
    [MOVIES_LIB, SHOWS_LIB].sort(),
  );

  // Different server identity rejected.
  const other = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "pass-owner",
      jellyfinUrl: otherServerUrl,
      jellyfinExternalUrl: otherServerUrl,
    },
  });
  await errorShape(other);

  // Member grants survive rotation.
  const memberLibs = await call("GET", "/api/libraries", { cookie: member });
  assert.deepEqual(
    (
      (await memberLibs.json()) as { libraries: { id: string }[] }
    ).libraries.map((lib) => lib.id),
    [MOVIES_LIB],
  );

  // Whisparr: add, preserve on omission, remove explicitly.
  const addWhisparr = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "pass-owner",
      jellyfinUrl,
      jellyfinExternalUrl: external,
      whisparrUrl: whisparrUrl,
      whisparrApiKey: whisparrKey,
    },
  });
  assert.equal(addWhisparr.status, 200);

  const status = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as {
    configured: boolean;
    version?: string;
    rootFolders?: unknown[];
  };
  assert.equal(statusBody.configured, true);
  assert.equal(statusBody.version, "3.4.0.1387");
  assert.ok(Array.isArray(statusBody.rootFolders));

  const omit = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "pass-owner",
      jellyfinUrl,
      jellyfinExternalUrl: external,
    },
  });
  assert.equal(omit.status, 200);
  const preserved = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(
    ((await preserved.json()) as { configured: boolean }).configured,
    true,
  );

  const remove = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "pass-owner",
      jellyfinUrl,
      jellyfinExternalUrl: external,
      whisparrUrl: "",
    },
  });
  assert.equal(remove.status, 200);
  const gone = await call("GET", "/api/admin/whisparr", { cookie: owner });
  assert.equal(
    ((await gone.json()) as { configured: boolean }).configured,
    false,
  );
});

test("login admission: outsider denied, logout revokes immediately", async () => {
  const outsider = await call("POST", "/api/login", {
    body: { username: "outsider", password: "pass-outsider" },
  });
  await errorShape(outsider, 403);

  const foreign = await call("POST", "/api/logout", {
    origin: "https://evil.example",
    cookie: member,
  });
  await errorShape(foreign, 403);
  assert.equal((await call("GET", "/api/me", { cookie: member })).status, 200);

  const out = await call("POST", "/api/logout", { cookie: member, body: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true });
  assert.match(out.headers.get("set-cookie") ?? "", /velvarr_session=/);
  assert.equal((await call("GET", "/api/me", { cookie: member })).status, 401);
});
