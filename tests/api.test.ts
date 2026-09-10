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
const TPDB_MOVIE = "2a2b3c4d-0000-0000-0000-000000000001";
const TPDB_MOVIE2 = "2a2b3c4d-0000-0000-0000-000000000002";
const TPDB_MOVIE3 = "2a2b3c4d-0000-0000-0000-000000000003";
const TPDB_MOVIE4 = "2a2b3c4d-0000-0000-0000-000000000004";
const TPDB_PERFORMER = "2a2b3c4d-0000-0000-0000-00000000000f";
const TPDB_STUDIO = "2a2b3c4d-0000-0000-0000-0000000000a1";
const STASH_STUDIO = "3b3c4d5e-0000-0000-0000-0000000000b2";
const TAG_A = "cc000000-0000-0000-0000-000000000001";
const TAG_B = "cc000000-0000-0000-0000-000000000002";

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
  // Membership proof on Jellyfin 12.0.0: ancestors, never query scoping.
  // Jellyfin reports the true library regardless of Velvarr grants; Velvarr
  // compares it against the account's effective libraries.
  if (/^\/Items\/[0-9a-f]{32}\/Ancestors$/.test(p) && req.method === "GET") {
    const itemId = /Items\/([0-9a-f]{32})\/Ancestors/.exec(p)?.[1];
    const item = fx.items.find((entry) => entry.Id === itemId);
    if (!item) return json(res, 404, {});
    return json(res, 200, [
      { Id: item.libraryId, Name: "Fixture library", Type: "CollectionFolder" },
      { Id: "f".repeat(32), Name: "media", Type: "UserRootFolder" },
    ]);
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
let otherServerUrl: string;
let jellyfinUrl: string;
let whisparrUrl: string;
let tpdbServer: Server;
let tpdbUrl: string;
let stashdbServer: Server;
let stashdbUrl: string;

// --- M2 fixtures: TPDB metadata + artwork ---

const tpdbToken = "tpdb-fixture-token";
const tpdbFx = { fail: 0, calls: 0, imageAuth: "unset" };

function tpdbMovieRow(id: string) {
  return {
    id,
    title: `Fixture Movie ${id.slice(-1)}`,
    date: "2024-02-03",
    description: "Fixture description",
    url: `https://theporndb.net/movies/${id}`,
    site: { name: "Fixture Studio" },
    posters: { full: "https://cdn.theporndb.net/fixture-poster.jpg" },
    performers: [],
    tags: [],
    scenes: [],
  };
}
function tpdbSiteRow(id: string) {
  return {
    uuid: id,
    id: 4242,
    name: "Fixture Studio",
    url: "https://fixture-studio.example",
    description: "Fixture studio description",
    poster: "https://cdn.theporndb.net/fixture-poster.jpg",
  };
}

async function tpdbHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fixture");
  const p = url.pathname;
  tpdbFx.calls += 1;
  const auth = String(req.headers.authorization ?? "");
  // Artwork pass-through: no credential may ever arrive here.
  if (p.endsWith(".png") || p.endsWith(".jpg")) {
    tpdbFx.imageAuth = auth;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PNG_1PX));
    return;
  }
  if (tpdbFx.fail > 0) {
    tpdbFx.fail -= 1;
    return json(res, 500, {});
  }
  if (auth !== `Bearer ${tpdbToken}`) return json(res, 401, {});
  if (p === "/user") return json(res, 200, { data: { name: "Fixture TPDB" } });
  if (p === "/movies") {
    // TPDB caps unfiltered totals at the fake 10000 marker; a countable
    // filter (q) yields a real total. Mirrors the live provider behavior.
    const realTotal = url.searchParams.get("q") !== null;
    return json(res, 200, {
      data: [tpdbMovieRow(TPDB_MOVIE)],
      meta: { total: realTotal ? 1 : 10000 },
      links: {},
    });
  }
  if (p === "/scenes") {
    return json(res, 200, {
      data: [tpdbMovieRow(TPDB_MOVIE2)],
      meta: { total: 10000 },
      links: {},
    });
  }
  if (p === "/sites") {
    return json(res, 200, {
      data: [tpdbSiteRow(TPDB_STUDIO)],
      meta: { total: 1 },
      links: {},
    });
  }
  if (p === `/sites/${TPDB_STUDIO}`)
    return json(res, 200, { data: tpdbSiteRow(TPDB_STUDIO) });
  if (p === `/movies/${TPDB_MOVIE}`)
    return json(res, 200, { data: tpdbMovieRow(TPDB_MOVIE) });
  json(res, 404, {});
}

// --- M3 fixtures: StashDB graphql ---

const stashdbKey = "stash-fixture-key";

async function stashdbHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (String(req.headers.apikey ?? "") !== stashdbKey) {
    return json(res, 401, {});
  }
  const body = await readBody(req);
  const query = typeof body.query === "string" ? body.query : "";
  if (query.includes("searchStudio")) {
    return json(res, 200, {
      data: {
        searchStudio: [
          { id: STASH_STUDIO, name: "Fixture Studio", deleted: false },
        ],
      },
    });
  }
  json(res, 200, { data: null });
}

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

type Handler = (
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) => Promise<Response>;
let api: { GET: Handler; POST: Handler; PATCH: Handler };
let closeStorage: () => void;
let getAcquisitionByReference: (media: {
  provider: "tpdb" | "stashdb";
  kind: "movie" | "scene";
  id: string;
}) => { id: string } | null;
let recordAcquisitionObservation: (
  id: string,
  observation: unknown,
  claimToken?: string,
) => unknown;

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
  ({ server: tpdbServer, url: tpdbUrl } = await listen(tpdbHandler));
  ({ server: stashdbServer, url: stashdbUrl } = await listen(stashdbHandler));
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
  ({ closeStorage, getAcquisitionByReference, recordAcquisitionObservation } =
    (await import(storageHref)) as {
      closeStorage: () => void;
      getAcquisitionByReference: (media: {
        provider: "tpdb" | "stashdb";
        kind: "movie" | "scene";
        id: string;
      }) => { id: string } | null;
      recordAcquisitionObservation: (
        id: string,
        observation: unknown,
        claimToken?: string,
      ) => unknown;
    });
});

after(() => {
  for (const server of [
    jellyfinServer,
    whisparrServer,
    tpdbServer,
    otherServer,
    stashdbServer,
  ]) {
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

// --- M2 phase 3: catalog, requests, availability ---
test("catalog search: auth, filter combos, honest totals, outage honesty", async () => {
  const anon = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie",
  );
  assert.equal(anon.status, 401);

  // member's session was revoked by the logout test; re-establish it once
  // for the whole M2 block.
  member = await loginAs("member");

  // Providers read credentials and base at call time; point them at the fixture.
  process.env.TPDB_API_TOKEN = tpdbToken;
  process.env.TPDB_BASE_URL = tpdbUrl;

  // Fake-capped TPDB total: totalCountKnown false, no total leaked.
  const unfiltered = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie",
    {
      cookie: member,
    },
  );
  assert.equal(unfiltered.status, 200);
  const page = (await unfiltered.json()) as {
    totalCountKnown: boolean;
    total?: number;
    hasMore: boolean;
    items: { reference: { provider: string; kind: string; id: string } }[];
  };
  assert.equal(page.totalCountKnown, false);
  assert.equal(page.total, undefined);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.items[0]?.reference, {
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE,
  });

  // Countable filter: real total passes through honestly.
  const filtered = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie&q=Fixture",
    { cookie: member },
  );
  const filteredBody = (await filtered.json()) as {
    totalCountKnown: boolean;
    total?: number;
  };
  assert.equal(filteredBody.totalCountKnown, true);
  assert.equal(filteredBody.total, 1);

  // Unsupported provider+kind+filter combinations: explicit errors, never
  // silent ignores.
  for (const query of [
    "provider=stashdb&kind=movie",
    "provider=stashdb&kind=scene&year=2020",
    "provider=tpdb&kind=movie&year=1800",
    "provider=tpdb&kind=performer",
    "provider=tpdb&kind=performer&q=x&year=2020",
    `provider=tpdb&kind=performer&q=x&performer=${TPDB_PERFORMER}`,
    "provider=stashdb&kind=performer&q=x&page=2",
    "provider=tpdb&kind=scene&performer=",
    "provider=junk&kind=movie",
    "provider=tpdb&kind=movie&page=0",
    "provider=tpdb&kind=movie&perPage=101",
  ]) {
    const res = await call("GET", `/api/catalog/search?${query}`, {
      cookie: member,
    });
    await errorShape(res);
  }

  // Outage: an explicit error, never an empty result set.
  tpdbFx.fail = 1;
  const outage = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=movie",
    {
      cookie: member,
    },
  );
  const err = await errorShape(outage, 500);
  assert.equal(err.code, "upstream_unavailable");
});

test("catalog detail: validation before upstream, absence vs outage, own request only", async () => {
  const anon = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`);
  assert.equal(anon.status, 401);

  // Invalid provider/kind/UUID never reaches the provider.
  const callsBefore = tpdbFx.calls;
  await errorShape(
    await call("GET", "/api/catalog/tpdb/movie/not-a-uuid", { cookie: member }),
  );
  await errorShape(
    await call("GET", `/api/catalog/junk/movie/${TPDB_MOVIE}`, {
      cookie: member,
    }),
  );
  await errorShape(
    await call("GET", `/api/catalog/stashdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    }),
  );
  assert.equal(tpdbFx.calls, callsBefore);

  const detail = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
    cookie: member,
  });
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as {
    detail: { reference: { id: string }; title: string };
    link: { unlinkedReason?: string };
    catalogRecord: { id: string; reference: { id: string } };
    myRequest: { decision: string } | null;
    acquisition: { state: string } | null;
  };
  assert.equal(body.detail.reference.id, TPDB_MOVIE);
  assert.equal(body.detail.title.length > 0, true);
  // Media is never linked across providers; the reason is explicit.
  assert.equal(typeof body.link.unlinkedReason, "string");
  assert.ok(body.catalogRecord.id);
  assert.equal(body.catalogRecord.reference.id, TPDB_MOVIE);
  assert.equal(body.myRequest, null);
  assert.equal(body.acquisition, null);

  // Authoritative absence is 404 with a distinct code; outage is an error.
  const missing = await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE2}`, {
    cookie: member,
  });
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { error: { code: string } }).error.code,
    "catalog_not_found",
  );
  tpdbFx.fail = 1;
  await errorShape(
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    }),
    500,
  );
});

test("catalog artwork proxy: provider-only, no credentials, no-store", async () => {
  const target = encodeURIComponent(`${tpdbUrl}/fixture-artwork.png`);
  const anon = await call("GET", `/api/catalog/image?url=${target}`);
  assert.equal(anon.status, 401);

  // Non-provider hosts and credential-bearing URLs are rejected before fetch.
  await errorShape(
    await call(
      "GET",
      `/api/catalog/image?url=${encodeURIComponent("https://evil.example/art.png")}`,
      { cookie: member },
    ),
  );
  await errorShape(
    await call(
      "GET",
      `/api/catalog/image?url=${encodeURIComponent(
        "https://user:pass@cdn.theporndb.net/art.png",
      )}`,
      { cookie: member },
    ),
  );
  await errorShape(await call("GET", "/api/catalog/image", { cookie: member }));
  assert.equal(tpdbFx.imageAuth, "unset");

  const ok = await call("GET", `/api/catalog/image?url=${target}`, {
    cookie: member,
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /^image\//);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), PNG_1PX);
  // No Velvarr or provider credential reached the image host.
  assert.equal(tpdbFx.imageAuth, "");
});

test("requests: lifecycle, autoApprove, privacy, roles, origin", async () => {
  // Re-establish Whisparr (removed by the rotation test) with delivery settings.
  const readd = await call("PATCH", "/api/admin/integrations", {
    cookie: owner,
    body: {
      password: "pass-owner",
      jellyfinUrl,
      jellyfinExternalUrl: jellyfinUrl,
      whisparrUrl,
      whisparrApiKey: whisparrKey,
      delivery: {
        enabled: true,
        rootFolderPath: "/movies",
        qualityProfileId: 1,
        searchOnAdd: true,
      },
      pathMappings: [
        { whisparrPrefix: "/data/whisparr", jellyfinPrefix: "/media" },
      ],
    },
  });
  assert.equal(readd.status, 200);
  const shape = (await readd.json()) as {
    whisparr: {
      delivery: { enabled: boolean; rootFolderPath: string } | null;
      pathMappings: { whisparrPrefix: string }[];
    };
  };
  assert.equal(shape.whisparr.delivery?.enabled, true);
  assert.equal(shape.whisparr.delivery?.rootFolderPath, "/movies");
  assert.deepEqual(shape.whisparr.pathMappings, [
    { whisparrPrefix: "/data/whisparr", jellyfinPrefix: "/media" },
  ]);

  // Delivery validation: enabled requires a root folder; ids must be positive.
  await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      cookie: owner,
      body: {
        password: "pass-owner",
        jellyfinUrl,
        jellyfinExternalUrl: jellyfinUrl,
        delivery: {
          enabled: true,
          rootFolderPath: "",
          qualityProfileId: 1,
          searchOnAdd: true,
        },
      },
    }),
  );
  await errorShape(
    await call("PATCH", "/api/admin/integrations", {
      cookie: owner,
      body: {
        password: "pass-owner",
        jellyfinUrl,
        jellyfinExternalUrl: jellyfinUrl,
        delivery: {
          enabled: true,
          rootFolderPath: "/movies",
          qualityProfileId: 0,
          searchOnAdd: true,
        },
      },
    }),
  );

  // Real provider verification on the admin surface; unconfigured stays honest.
  const providers = await call("GET", "/api/admin/providers", {
    cookie: owner,
  });
  assert.equal(providers.status, 200);
  const providersBody = (await providers.json()) as {
    providers: {
      provider: string;
      configured: boolean;
      verified?: boolean;
      account?: string;
    }[];
  };
  const tpdb = providersBody.providers.find((p) => p.provider === "tpdb");
  assert.equal(tpdb?.configured, true);
  assert.equal(tpdb?.verified, true);
  assert.equal(tpdb?.account, "Fixture TPDB");
  const stashdb = providersBody.providers.find((p) => p.provider === "stashdb");
  assert.equal(stashdb?.configured, false);
  assert.equal((await call("GET", "/api/admin/providers")).status, 401);

  // Unauthenticated and cross-origin mutations are rejected.
  const media = { provider: "tpdb", kind: "movie", id: TPDB_MOVIE };
  assert.equal(
    (await call("POST", "/api/requests", { body: { media } })).status,
    401,
  );
  await errorShape(
    await call("POST", "/api/requests", {
      origin: null,
      cookie: member,
      body: { media },
    }),
    403,
  );

  // Forged payloads: only the server-validated reference is stored.
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: { media: { provider: "tpdb", kind: "movie", id: "not-a-uuid" } },
    }),
  );
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: {
        media: { provider: "tpdb", kind: "performer", id: TPDB_PERFORMER },
      },
    }),
  );

  // Plain requester: 201 pending.
  const created = await call("POST", "/api/requests", {
    cookie: member,
    body: { media },
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    request: { id: string; decision: string };
    autoApproved?: boolean;
  };
  assert.equal(createdBody.request.decision, "pending");
  assert.equal(createdBody.autoApproved, undefined);
  const memberRequestId = createdBody.request.id;

  // Duplicate active intent is an honest 409.
  const dup = await call("POST", "/api/requests", {
    cookie: member,
    body: { media },
  });
  assert.equal(dup.status, 409);
  assert.equal(
    ((await dup.json()) as { error: { code: string } }).error.code,
    "request_exists",
  );

  // member2 (no grant yet): own request stays pending.
  const m2 = await loginAs("member2");
  const m2Created = await call("POST", "/api/requests", {
    cookie: m2,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE2 } },
  });
  assert.equal(m2Created.status, 201);
  const m2RequestId = ((await m2Created.json()) as { request: { id: string } })
    .request.id;

  // Role enforcement: requesters cannot decide, own or foreign.
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      cookie: member,
      body: { decision: "approved" },
    }),
    403,
  );
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      cookie: m2,
      body: { decision: "approved" },
    }),
    403,
  );

  // Privacy: member2 sees only their own list entry.
  const m2List = await call("GET", "/api/requests", { cookie: m2 });
  assert.deepEqual(
    ((await m2List.json()) as { requests: { id: string }[] }).requests.map(
      (r) => r.id,
    ),
    [m2RequestId],
  );
  // The owner sees all requests.
  const ownerIds = (
    (await (await call("GET", "/api/requests", { cookie: owner })).json()) as {
      requests: { id: string }[];
    }
  ).requests.map((r) => r.id);
  assert.ok(ownerIds.includes(memberRequestId));
  assert.ok(ownerIds.includes(m2RequestId));

  // Detail: the caller's own decision only; no acquisition before approval.
  const detailForMember = await call(
    "GET",
    `/api/catalog/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: member },
  );
  const detailMemberBody = (await detailForMember.json()) as {
    myRequest: { decision: string } | null;
    acquisition: { state: string } | null;
  };
  assert.equal(detailMemberBody.myRequest?.decision, "pending");
  assert.equal(detailMemberBody.acquisition, null);
  const detailForM2 = await call(
    "GET",
    `/api/catalog/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: m2 },
  );
  assert.equal(
    ((await detailForM2.json()) as { myRequest: unknown }).myRequest,
    null,
  );

  // Owner approves: shared acquisition state visible to both viewers, while
  // myRequest stays per-user.
  const approve = await call("PATCH", `/api/requests/${memberRequestId}`, {
    cookie: owner,
    body: { decision: "approved" },
  });
  assert.equal(approve.status, 200);
  const afterBody = (await (
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, {
      cookie: member,
    })
  ).json()) as {
    myRequest: { decision: string } | null;
    acquisition: { state: string } | null;
  };
  assert.equal(afterBody.myRequest?.decision, "approved");
  assert.equal(afterBody.acquisition?.state, "unsent");
  const sharedForM2 = (await (
    await call("GET", `/api/catalog/tpdb/movie/${TPDB_MOVIE}`, { cookie: m2 })
  ).json()) as { acquisition: { state: string } | null };
  assert.equal(sharedForM2.acquisition?.state, "unsent");

  // Owner declines member2's pending request.
  const decline = await call("PATCH", `/api/requests/${m2RequestId}`, {
    cookie: owner,
    body: { decision: "declined" },
  });
  assert.equal(decline.status, 200);
  assert.equal(
    ((await decline.json()) as { request: { decision: string } }).request
      .decision,
    "declined",
  );

  // Cancel: own pending only; a foreign cancel is a bare 404 with no leak.
  const m2Second = await call("POST", "/api/requests", {
    cookie: m2,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE2 } },
  });
  assert.equal(m2Second.status, 201);
  const m2SecondId = ((await m2Second.json()) as { request: { id: string } })
    .request.id;
  const foreignCancel = await call("PATCH", `/api/requests/${m2SecondId}`, {
    cookie: member,
    body: { decision: "cancelled" },
  });
  assert.equal(foreignCancel.status, 404);
  assert.equal(
    ((await foreignCancel.json()) as { error: { code: string } }).error.code,
    "request_not_found",
  );
  assert.equal(
    (
      await call("PATCH", `/api/requests/${m2SecondId}`, {
        cookie: m2,
        body: { decision: "cancelled" },
      })
    ).status,
    200,
  );
  // Storage allows cancelling pending|approved; cancelling an already
  // cancelled request is the faithful 409.
  const cancelAgain = await call("PATCH", `/api/requests/${m2SecondId}`, {
    cookie: m2,
    body: { decision: "cancelled" },
  });
  assert.equal(cancelAgain.status, 409);
  assert.equal(
    ((await cancelAgain.json()) as { error: { code: string } }).error.code,
    "request_not_cancellable",
  );
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      cookie: owner,
      body: { decision: "nope" },
    }),
  );
  assert.equal(
    (
      await call("PATCH", `/api/requests/${memberRequestId}`, {
        body: { decision: "approved" },
      })
    ).status,
    401,
  );
  await errorShape(
    await call("PATCH", `/api/requests/${memberRequestId}`, {
      origin: "https://evil.example",
      cookie: owner,
      body: { decision: "declined" },
    }),
    403,
  );

  // autoApprove grant: the request auto-decides approved and enqueues work.
  // Uses the nogrants account: member2's login bucket is spent, and a grant
  // change revokes the target's sessions by design, so a fresh login is
  // part of the flow.
  const grant = await call("PATCH", `/api/admin/users/${NOGRANT_ID}`, {
    cookie: owner,
    body: {
      enabled: true,
      role: "requester",
      libraryIds: [],
      autoApprove: true,
    },
  });
  assert.equal(grant.status, 200);
  assert.equal(
    ((await grant.json()) as { account: { autoApprove: boolean } }).account
      .autoApprove,
    true,
  );
  const autoCookie = await loginAs("nogrants");
  const auto = await call("POST", "/api/requests", {
    cookie: autoCookie,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE3 } },
  });
  assert.equal(auto.status, 201);
  const autoBody = (await auto.json()) as {
    request: { decision: string };
    autoApproved: boolean;
  };
  assert.equal(autoBody.autoApproved, true);
  assert.equal(autoBody.request.decision, "approved");
  assert.ok(
    getAcquisitionByReference({
      provider: "tpdb",
      kind: "movie",
      id: TPDB_MOVIE3,
    }),
  );
});

test("availability: distinct verdicts under the caller's own token", async () => {
  assert.equal(
    (await call("GET", `/api/availability/tpdb/movie/${TPDB_MOVIE}`)).status,
    401,
  );

  // Worker-equivalent: persist observed Whisparr facts on the shared
  // acquisition; the availability route must read them, never call Whisparr.
  const acq = getAcquisitionByReference({
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE,
  });
  assert.ok(acq);
  recordAcquisitionObservation(acq.id, {
    state: "monitoring",
    item: {
      whisparrId: 77,
      path: `/media/${ITEM_MOVIE}.mkv`,
      title: "Alpha Movie",
    },
  });

  // available: exact path correspondence, granted library, playable source.
  const available = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: member },
  );
  assert.equal(available.status, 200);
  const availableBody = (await available.json()) as {
    outcome: string;
    item?: { id: string };
  };
  assert.equal(availableBody.outcome, "available");
  assert.equal(availableBody.item?.id, ITEM_MOVIE);

  // denied: no granted libraries for this caller.
  fx.grants.set(NOGRANT_ID, []);
  const noGrantCookie = await loginAs("nogrants");
  const denied = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE}`,
    { cookie: noGrantCookie },
  );
  assert.equal(
    ((await denied.json()) as { outcome: string }).outcome,
    "denied",
  );

  // ambiguous: title-only similarity is never upgraded to a guess.
  const acq3Req = await call("POST", "/api/requests", {
    cookie: member,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE3 } },
  });
  assert.equal(acq3Req.status, 201);
  const acq3Id = ((await acq3Req.json()) as { request: { id: string } }).request
    .id;
  await call("PATCH", `/api/requests/${acq3Id}`, {
    cookie: owner,
    body: { decision: "approved" },
  });
  const acq3 = getAcquisitionByReference({
    provider: "tpdb",
    kind: "movie",
    id: TPDB_MOVIE3,
  });
  assert.ok(acq3);
  recordAcquisitionObservation(acq3.id, {
    state: "monitoring",
    item: { title: "Alpha Movie" },
  });
  const ambiguous = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE3}`,
    { cookie: member },
  );
  assert.equal(
    ((await ambiguous.json()) as { outcome: string }).outcome,
    "ambiguous",
  );

  // missing: known identity, nothing on the media server.
  const m4Req = await call("POST", "/api/requests", {
    cookie: member,
    body: { media: { provider: "tpdb", kind: "movie", id: TPDB_MOVIE4 } },
  });
  const m4Id = ((await m4Req.json()) as { request: { id: string } }).request.id;
  await call("PATCH", `/api/requests/${m4Id}`, {
    cookie: owner,
    body: { decision: "approved" },
  });
  const missing = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal(
    ((await missing.json()) as { outcome: string }).outcome,
    "missing",
  );

  // unavailable: an upstream failure is never reported as missing.
  fx.fail.items = 1;
  const unavailable = await call(
    "GET",
    `/api/availability/tpdb/movie/${TPDB_MOVIE4}`,
    { cookie: member },
  );
  assert.equal(
    ((await unavailable.json()) as { outcome: string }).outcome,
    "unavailable",
  );

  // Performers are not requestable/available media.
  await errorShape(
    await call("GET", `/api/availability/tpdb/performer/${TPDB_PERFORMER}`, {
      cookie: member,
    }),
  );
});

// --- M3 phase B: studio kind; browse params wired with explicit rejects ---
test("studio search per provider; studio references refused as media; unsupported combos 400", async () => {
  // Providers read credentials and base at call time; point StashDB at the
  // fixture. Runs after the admin/providers test, which pins stashdb as
  // unconfigured.
  process.env.STASHDB_API_KEY = stashdbKey;
  process.env.STASHDB_BASE_URL = stashdbUrl;

  // TPDB studio search (sites): q required, results are studio references.
  const tpdbStudio = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=studio&q=Fixture",
    { cookie: member },
  );
  assert.equal(tpdbStudio.status, 200);
  const tpdbStudioBody = (await tpdbStudio.json()) as {
    kind: string;
    items: { reference: { provider: string; kind: string; id: string } }[];
  };
  assert.equal(tpdbStudioBody.kind, "studio");
  assert.deepEqual(tpdbStudioBody.items[0]?.reference, {
    provider: "tpdb",
    kind: "studio",
    id: TPDB_STUDIO,
  });

  // StashDB studio search: unpaged, query-only.
  const stashStudio = await call(
    "GET",
    "/api/catalog/search?provider=stashdb&kind=studio&q=Fixture",
    { cookie: member },
  );
  assert.equal(stashStudio.status, 200);
  const stashStudioBody = (await stashStudio.json()) as {
    kind: string;
    page: number;
    items: { reference: { provider: string; kind: string; id: string } }[];
  };
  assert.equal(stashStudioBody.kind, "studio");
  assert.equal(stashStudioBody.page, 1);
  assert.deepEqual(stashStudioBody.items[0]?.reference, {
    provider: "stashdb",
    kind: "studio",
    id: STASH_STUDIO,
  });

  // Studio is browsable on the detail route (TPDB site detail)...
  const detail = await call("GET", `/api/catalog/tpdb/studio/${TPDB_STUDIO}`, {
    cookie: member,
  });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
    detail: { reference: { kind: string; id: string }; title: string };
  };
  assert.equal(detailBody.detail.reference.kind, "studio");
  assert.equal(detailBody.detail.reference.id, TPDB_STUDIO);
  assert.equal(detailBody.detail.title.length > 0, true);

  // ...but a studio reference is never requestable or availability media.
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: { media: { provider: "tpdb", kind: "studio", id: TPDB_STUDIO } },
    }),
  );
  await errorShape(
    await call("GET", `/api/availability/tpdb/studio/${TPDB_STUDIO}`, {
      cookie: member,
    }),
  );
  await errorShape(
    await call("POST", "/api/requests", {
      cookie: member,
      body: {
        media: { provider: "stashdb", kind: "studio", id: STASH_STUDIO },
      },
    }),
  );

  // Unsupported provider+kind+parameter combinations: explicit 400
  // invalid_query, never a silent ignore.
  const rejected = [
    `provider=tpdb&kind=scene&sort=trending`,
    `provider=tpdb&kind=movie&sort=popularity`,
    `provider=stashdb&kind=scene&sort=relevance`,
    `provider=tpdb&kind=movie&tagsExclude=${TAG_A}`,
    `provider=stashdb&kind=scene&tagsAll=${TAG_A}`,
    `provider=stashdb&kind=studio&q=x&page=2`,
    `provider=stashdb&kind=studio&q=x&perPage=10`,
    `provider=stashdb&kind=performer&q=x&sort=title`,
    `provider=tpdb&kind=studio&q=x&tags=${TAG_A}`,
    `provider=tpdb&kind=performer&q=x&sort=recency`,
    `provider=tpdb&kind=movie&sort=bogus`,
    `provider=tpdb&kind=scene&direction=asc`,
    `provider=tpdb&kind=scene&sort=recency&direction=sideways`,
    `provider=tpdb&kind=scene&tags=${TAG_A},${TAG_B}&tagsAll=${TAG_B}`,
  ] as const;
  for (const query of rejected) {
    const res = await call("GET", `/api/catalog/search?${query}`, {
      cookie: member,
    });
    assert.equal(res.status, 400, query);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      "invalid_query",
      query,
    );
  }

  // A supported sort wires through: the page reports the exact applied order.
  const sorted = await call(
    "GET",
    "/api/catalog/search?provider=tpdb&kind=scene&sort=recency&direction=asc",
    { cookie: member },
  );
  assert.equal(sorted.status, 200);
  assert.deepEqual(
    (
      (await sorted.json()) as {
        sort?: { key: string; direction: string; upstream: string };
      }
    ).sort,
    { key: "recency", direction: "asc", upstream: "former_released" },
  );

  // Repeatable and comma-separated tag lists both parse into one filter.
  const tagged = await call(
    "GET",
    `/api/catalog/search?provider=tpdb&kind=scene&tags=${TAG_A}&tags=${TAG_B}`,
    { cookie: member },
  );
  assert.equal(tagged.status, 200);
  const commaed = await call(
    "GET",
    `/api/catalog/search?provider=tpdb&kind=scene&tags=${TAG_A},${TAG_B}`,
    { cookie: member },
  );
  assert.equal(commaed.status, 200);
});
