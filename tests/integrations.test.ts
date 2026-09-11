// Integration-layer regression tests: isolated 127.0.0.1 HTTP fixtures only.
// No real network, no real credentials. Covers base-URL prefix/scheme rules,
// redirect denial, upstream error mapping, Jellyfin user-token scoping and
// library-membership denial, image bounds, aggregate pagination, credential-
// free watch links, and read-only Whisparr status mapping.

import http from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AppError,
  requestBytes,
  requestJson,
  validateBaseUrl,
} from "../src/server/http.ts";
import {
  authenticate,
  getLibraryImage,
  getLibraryItem,
  getServer,
  listLibraries,
  listLibraryItems,
  listRecentlyAddedItems,
  listUsers,
  normalizeItemId,
  validateUser,
} from "../src/server/jellyfin.ts";
import { getWhisparrStatus } from "../src/server/whisparr.ts";
import type { Account, IntegrationConfig } from "../src/lib/contracts.ts";

// --- constants and fixture helpers ---

const SERVER_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const ME_ID = "b".repeat(32);
const TOKEN = "u".repeat(32);
const ADMIN_KEY = "a".repeat(32);
const WH_KEY = "w".repeat(32);
const LIB_A = "aa11".repeat(8);
const LIB_B = "bb22".repeat(8);
const LIB_C = "cc33".repeat(8);
const ITEM_ID = "d".repeat(32);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_LIMIT = 8 * 1024 * 1024;

const ME = {
  Id: dashed(ME_ID),
  Name: "bob",
  Policy: {
    IsAdministrator: false,
    IsDisabled: false,
    EnableRemoteAccess: true,
    EnableMediaPlayback: true,
  },
};

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type FixtureHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void;

interface Fixture {
  origin: string;
  log: RecordedRequest[];
  close: () => Promise<void>;
}

function dashed(id: string): string {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
}

function hexId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function sendBytes(
  res: http.ServerResponse,
  status: number,
  bytes: Buffer,
  contentType: string,
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(bytes);
}

function pathOf(url: string): string {
  return (url.split("?")[0] ?? "").toLowerCase();
}

function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

function appError(status: number, code: string): (err: unknown) => boolean {
  return (err) =>
    err instanceof AppError && err.status === status && err.code === code;
}

function jellyfinConfig(
  origin: string,
  libraryIds: string[],
): IntegrationConfig {
  return {
    jellyfin: {
      url: origin,
      externalUrl: `${origin}/jf`,
      apiKey: ADMIN_KEY,
      serverId: SERVER_ID,
      libraryIds,
    },
  };
}

function whisparrConfig(origin: string): IntegrationConfig {
  return {
    jellyfin: {
      url: origin,
      externalUrl: origin,
      apiKey: ADMIN_KEY,
      serverId: SERVER_ID,
      libraryIds: [],
    },
    whisparr: { url: origin, apiKey: WH_KEY },
  };
}

function account(libraryIds: string[]): Account {
  return {
    id: "acct-1",
    name: "bob",
    role: "requester",
    enabled: true,
    libraryIds,
    isOwner: false,
    autoApprove: false,
  };
}

function startFixture(handler: FixtureHandler): Promise<Fixture> {
  const { promise, resolve, reject } = Promise.withResolvers<Fixture>();
  const log: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      log.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      try {
        handler(req, res, body);
      } catch (err) {
        sendJson(res, 500, { fixtureError: String(err) });
      }
    });
  });
  server.on("error", reject);
  server.on("clientError", (_err, socket) => socket.destroy());
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({
      origin: `http://127.0.0.1:${address.port}`,
      log,
      close: () => {
        server.closeAllConnections();
        const done = Promise.withResolvers<void>();
        server.close(() => done.resolve());
        return done.promise;
      },
    });
  });
  return promise;
}

async function withFixture(
  handler: FixtureHandler,
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const fx = await startFixture(handler);
  try {
    await run(fx);
  } finally {
    await fx.close();
  }
}

// Standard Jellyfin routes: /Users/Me identity plus per-library paged item
// lists with optional search filtering.
function itemsByParentHandler(
  byParent: Record<string, unknown[]>,
): FixtureHandler {
  return (req, res) => {
    const url = req.url ?? "";
    if (pathOf(url) === "/users/me") return sendJson(res, 200, ME);
    if (pathOf(url) === `/users/${ME_ID}/items`) {
      const query = queryOf(url);
      const parent = query.get("parentId") ?? "";
      const search = (query.get("searchTerm") ?? "").toLowerCase();
      let items = byParent[parent] ?? [];
      if (search) {
        items = items.filter((item) =>
          String((item as { Name?: string }).Name)
            .toLowerCase()
            .includes(search),
        );
      }
      const startIndex = Number(query.get("startIndex") ?? 0);
      const limit = Number(query.get("limit") ?? 10);
      return sendJson(res, 200, {
        Items: items.slice(startIndex, startIndex + limit),
        TotalRecordCount: items.length,
      });
    }
    sendJson(res, 404, {});
  };
}

function movieItem(n: number, name: string): Record<string, unknown> {
  return {
    Id: dashed(hexId(n)),
    Name: name,
    SortName: name,
    Type: "Movie",
    LocationType: "FileSystem",
  };
}

// --- validateBaseUrl ---

test("validateBaseUrl preserves reverse-proxy prefixes and strips trailing slashes", () => {
  assert.equal(
    validateBaseUrl("https://media.example.com/jellyfin/"),
    "https://media.example.com/jellyfin",
  );
  assert.equal(
    validateBaseUrl("https://media.example.com/jf///"),
    "https://media.example.com/jf",
  );
  assert.equal(
    validateBaseUrl("https://media.example.com"),
    "https://media.example.com",
  );
  assert.equal(
    validateBaseUrl("http://127.0.0.1:8096"),
    "http://127.0.0.1:8096",
  );
  assert.equal(
    validateBaseUrl("http://localhost:8096/jellyfin/"),
    "http://localhost:8096/jellyfin",
  );
});

test("validateBaseUrl rejects query strings, fragments, userinfo, and bad schemes", () => {
  assert.throws(
    () => validateBaseUrl("https://media.example.com/?a=b"),
    appError(400, "invalid_url"),
  );
  assert.throws(
    () => validateBaseUrl("https://media.example.com/#frag"),
    appError(400, "invalid_url"),
  );
  assert.throws(
    () => validateBaseUrl("https://user:pass@media.example.com"),
    appError(400, "invalid_url"),
  );
  assert.throws(
    () => validateBaseUrl("ftp://media.example.com"),
    appError(400, "invalid_url"),
  );
  assert.throws(
    () => validateBaseUrl("https://media.example.com/\\evil"),
    appError(400, "invalid_url"),
  );
  assert.throws(
    () => validateBaseUrl("not a url"),
    appError(400, "invalid_url"),
  );
});

test("validateBaseUrl allows private HTTP only through VELVARR_ALLOW_HTTP=1", () => {
  const previous = process.env.VELVARR_ALLOW_HTTP;
  try {
    delete process.env.VELVARR_ALLOW_HTTP;
    assert.throws(
      () => validateBaseUrl("http://192.168.1.50:8096/jf/"),
      appError(400, "invalid_url"),
    );
    process.env.VELVARR_ALLOW_HTTP = "1";
    assert.equal(
      validateBaseUrl("http://192.168.1.50:8096/jf/"),
      "http://192.168.1.50:8096/jf",
    );
    // The flag covers trusted private addresses only, never public hosts.
    assert.throws(
      () => validateBaseUrl("http://media.example.com"),
      appError(400, "invalid_url"),
    );
  } finally {
    if (previous === undefined) delete process.env.VELVARR_ALLOW_HTTP;
    else process.env.VELVARR_ALLOW_HTTP = previous;
  }
});

// --- requestJson transport ---

test("requestJson sends the MediaBrowser header and parses JSON bodies", async () => {
  await withFixture(
    (req, res, body) => {
      sendJson(res, 200, {
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        echo: JSON.parse(body || "{}"),
      });
    },
    async (fx) => {
      const out = await requestJson<{
        auth: string;
        contentType: string;
        echo: { a: number };
      }>(fx.origin, "/echo", TOKEN, { method: "POST", body: { a: 1 } });
      assert.equal(
        out.auth,
        `MediaBrowser Client="Velvarr", Device="Server", DeviceId="velvarr", Version="0.1.0", Token="${TOKEN}"`,
      );
      assert.equal(out.contentType, "application/json");
      assert.deepEqual(out.echo, { a: 1 });
    },
  );
});

test("requestJson authenticates Whisparr with X-Api-Key, not Jellyfin auth", async () => {
  await withFixture(
    (req, res) => {
      sendJson(res, 200, {
        key: req.headers["x-api-key"],
        auth: req.headers.authorization ?? null,
      });
    },
    async (fx) => {
      const out = await requestJson<{ key: string; auth: string | null }>(
        fx.origin,
        "/api/v3/system/status",
        WH_KEY,
        { service: "whisparr" },
      );
      assert.equal(out.key, WH_KEY);
      assert.equal(out.auth, null);
    },
  );
});

test("requestJson rejects header-injecting tokens before any request", async () => {
  await withFixture(
    (req, res) => sendJson(res, 200, { ok: true }),
    async (fx) => {
      await assert.rejects(
        requestJson(fx.origin, "/x", "bad\nEVIL: 1"),
        appError(400, "invalid_token"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/x", 'bad"path1'),
        appError(400, "invalid_token"),
      );
      assert.equal(fx.log.length, 0);
    },
  );
});

test("requestJson distinguishes auth, forbidden, missing, outage, and timeout", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/unauth")
        return sendJson(res, 401, { detail: "secret detail" });
      if (path === "/forbid") return sendJson(res, 403, {});
      if (path === "/missing") return sendJson(res, 404, {});
      if (path === "/boom") return sendJson(res, 500, { stack: "internal" });
      if (path === "/text")
        return sendBytes(res, 200, Buffer.from("hi"), "text/plain");
      if (path === "/hop")
        return void res
          .writeHead(302, { location: "http://evil.example/steal" })
          .end();
      if (path === "/huge")
        return sendJson(res, 200, { pad: "x".repeat(2 * 1024 * 1024 + 16) });
      if (path === "/slow") return; // never responds; the client aborts
      sendJson(res, 200, { ok: true });
    },
    async (fx) => {
      await assert.rejects(
        requestJson(fx.origin, "/unauth", TOKEN),
        appError(401, "upstream_auth"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/forbid", TOKEN),
        appError(403, "upstream_forbidden"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/missing", TOKEN),
        appError(404, "upstream_not_found"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/boom", TOKEN),
        appError(502, "upstream_unavailable"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/text", TOKEN),
        appError(502, "upstream_bad_response"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/hop", TOKEN),
        appError(502, "upstream_unavailable"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/huge", TOKEN),
        appError(502, "upstream_bad_response"),
      );
      await assert.rejects(
        requestJson(fx.origin, "/slow", TOKEN, { timeoutMs: 100 }),
        appError(504, "upstream_timeout"),
      );
      // Sanitized errors never echo upstream URLs or bodies.
      for (const recorded of fx.log) {
        assert.ok(!recorded.url.includes("evil.example"));
      }
    },
  );
});

test("provider transports use Bearer for TPDB and ApiKey for StashDB", async () => {
  await withFixture(
    (req, res) => {
      sendJson(res, 200, {
        auth: req.headers.authorization ?? null,
        apiKey: req.headers.apikey ?? null,
      });
    },
    async (fx) => {
      const tpdb = await requestJson<{
        auth: string | null;
        apiKey: string | null;
      }>(fx.origin, "/tpdb", TOKEN, { service: "tpdb" });
      assert.equal(tpdb.auth, `Bearer ${TOKEN}`);
      assert.equal(tpdb.apiKey, null);
      const stashdb = await requestJson<{
        auth: string | null;
        apiKey: string | null;
      }>(fx.origin, "/stashdb", TOKEN, { service: "stashdb" });
      assert.equal(stashdb.auth, null);
      assert.equal(stashdb.apiKey, TOKEN);
    },
  );
});

test("credential-free provider artwork sends no credential header", async () => {
  await withFixture(
    (req, res) => sendBytes(res, 200, PNG_BYTES, "image/png"),
    async (fx) => {
      for (const service of ["tpdb", "stashdb"] as const) {
        fx.log.length = 0;
        const out = await requestBytes(fx.origin, "/poster.jpg", "", {
          service,
        });
        assert.equal(out.contentType, "image/png");
        assert.ok(Buffer.from(out.bytes).equals(PNG_BYTES));
        assert.equal(fx.log.length, 1);
        assert.equal(fx.log[0]?.headers.authorization, undefined);
        assert.equal(fx.log[0]?.headers.apikey, undefined);
      }
    },
  );
});

test("proven provider rejection carries upstreamStatus; timeout and resets do not", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/tpdb401") return sendJson(res, 401, { detail: "bad key" });
      if (path === "/bad400") return sendJson(res, 400, { error: "nope" });
      if (path === "/reset") return void res.socket?.destroy();
      if (path === "/hang") return; // never responds; the client aborts
      sendJson(res, 200, { ok: true });
    },
    async (fx) => {
      // A metadata provider credential failure is a proven upstream 401,
      // never session expiry: distinct code, and the upstream body is not
      // echoed into the sanitized message.
      await assert.rejects(
        requestJson(fx.origin, "/tpdb401", TOKEN, { service: "tpdb" }),
        (err: unknown) =>
          err instanceof AppError &&
          err.status === 401 &&
          err.code === "upstream_auth" &&
          err.upstreamStatus === 401 &&
          err.message.includes("TPDB") &&
          !err.message.includes("bad key"),
      );
      // Whisparr HTTP 400 is a proven rejection, never re-labeled success.
      await assert.rejects(
        requestJson(fx.origin, "/bad400", WH_KEY, { service: "whisparr" }),
        (err: unknown) =>
          err instanceof AppError &&
          err.status === 502 &&
          err.code === "upstream_unavailable" &&
          err.upstreamStatus === 400,
      );
      // Connection reset: genuine uncertainty — same code, no proven status.
      await assert.rejects(
        requestJson(fx.origin, "/reset", TOKEN),
        (err: unknown) =>
          err instanceof AppError &&
          err.status === 502 &&
          err.code === "upstream_unavailable" &&
          err.upstreamStatus === undefined,
      );
      await assert.rejects(
        requestJson(fx.origin, "/hang", TOKEN, { timeoutMs: 100 }),
        (err: unknown) =>
          err instanceof AppError &&
          err.status === 504 &&
          err.code === "upstream_timeout" &&
          err.upstreamStatus === undefined,
      );
    },
  );
});

test("provider redirects are never followed to credential-capturing targets", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/bounce") {
        return void res.writeHead(302, { location: `/steal?t=${TOKEN}` }).end();
      }
      sendJson(res, 200, { ok: true });
    },
    async (fx) => {
      await assert.rejects(
        requestJson(fx.origin, "/bounce", TOKEN, { service: "tpdb" }),
        appError(502, "upstream_unavailable"),
      );
      // Exactly one request was made: /steal was never contacted, so the
      // bearer token can never leak through a redirect.
      assert.equal(fx.log.length, 1);
      assert.equal(pathOf(fx.log[0]?.url ?? ""), "/bounce");
    },
  );
});

test("overall deadline fires while a stalled response body streams", async () => {
  await withFixture(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
      // Never end(): the body stalls after headers; the deadline must fire.
    },
    async (fx) => {
      const started = Date.now();
      await assert.rejects(
        requestJson(fx.origin, "/stall", TOKEN, { timeoutMs: 150 }),
        appError(504, "upstream_timeout"),
      );
      // Far below the 15s default: proves the deadline covers body reads.
      assert.ok(Date.now() - started < 5_000);
    },
  );
});

// --- Jellyfin identity ---

test("getServer reads public info and canonicalizes the server id", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/system/info/public") {
        return sendJson(res, 200, {
          Id: dashed(SERVER_ID),
          ServerName: "Jellyfin",
          Version: "12.0.0",
        });
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const server = await getServer(fx.origin);
      assert.deepEqual(server, { id: SERVER_ID, name: "Jellyfin" });
    },
  );
});

test("authenticate posts AuthenticateByName without a token header and maps the user", async () => {
  await withFixture(
    (req, res, body) => {
      if (
        req.method === "POST" &&
        pathOf(req.url ?? "") === "/users/authenticatebyname"
      ) {
        const parsed = JSON.parse(body) as { Username?: string; Pw?: string };
        assert.deepEqual(parsed, { Username: "bob", Pw: "secret" });
        assert.equal(
          (req.headers.authorization ?? "").includes("Token="),
          false,
        );
        return sendJson(res, 200, {
          User: {
            Id: dashed(ME_ID),
            Name: "bob",
            Policy: {
              IsAdministrator: false,
              IsDisabled: false,
              EnableRemoteAccess: true,
              EnableMediaPlayback: true,
            },
          },
          AccessToken: TOKEN,
        });
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const { user, token } = await authenticate(fx.origin, "bob", "secret");
      assert.deepEqual(user, {
        id: ME_ID,
        name: "bob",
        isDisabled: false,
        enableRemoteAccess: true,
        enableMediaPlayback: true,
        isAdministrator: false,
      });
      assert.equal(token, TOKEN);
    },
  );
});

test("authenticate rejects results without an access token", async () => {
  await withFixture(
    (req, res) => {
      if (
        req.method === "POST" &&
        pathOf(req.url ?? "") === "/users/authenticatebyname"
      ) {
        return sendJson(res, 200, { User: ME });
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      await assert.rejects(
        authenticate(fx.origin, "bob", "secret"),
        appError(401, "upstream_auth"),
      );
    },
  );
});

test("validateUser maps the live token identity and propagates rejection", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/users/me") {
        // Wrong tokens are rejected by the fixture, as the real server would.
        if ((req.headers.authorization ?? "").includes(`Token="${TOKEN}"`))
          return sendJson(res, 200, ME);
        return sendJson(res, 401, {});
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const user = await validateUser(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
      );
      assert.equal(user.id, ME_ID);
      assert.equal(user.enableRemoteAccess, true);
      assert.equal(user.enableMediaPlayback, true);
      await assert.rejects(
        validateUser(jellyfinConfig(fx.origin, [LIB_A]), "wrongtoken123"),
        appError(401, "upstream_auth"),
      );
    },
  );
});

test("validateUser is conservative when the server omits the user policy", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/users/me")
        return sendJson(res, 200, { Id: dashed(ME_ID), Name: "x" });
      sendJson(res, 404, {});
    },
    async (fx) => {
      const user = await validateUser(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
      );
      assert.deepEqual(user, {
        id: ME_ID,
        name: "x",
        isDisabled: false,
        enableRemoteAccess: false,
        enableMediaPlayback: false,
        isAdministrator: false,
      });
    },
  );
});

test("listUsers uses the integration key and skips malformed rows", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/users") {
        assert.ok(
          (req.headers.authorization ?? "").includes(`Token="${ADMIN_KEY}"`),
        );
        return sendJson(res, 200, [
          ME,
          { Id: "not-a-uuid", Name: "broken" },
          {
            Id: dashed(hexId(9)),
            Name: "carol",
            Policy: { IsAdministrator: true, IsDisabled: false },
          },
        ]);
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const users = await listUsers(jellyfinConfig(fx.origin, []));
      assert.deepEqual(
        users.map((u) => u.id),
        [ME_ID, hexId(9)],
      );
      assert.equal(users[1]?.isAdministrator, true);
    },
  );
});

// --- libraries and items ---

test("listLibraries keeps only movie/video/mixed views with canonical ids", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, ME);
      if (path === `/users/${ME_ID}/views`) {
        return sendJson(res, 200, {
          Items: [
            { Id: dashed(LIB_A), Name: "Movies", CollectionType: "movies" },
            { Id: dashed(LIB_B), Name: "Videos", CollectionType: null },
            { Id: dashed(LIB_C), Name: "TV", CollectionType: "tvshows" },
            { Id: dashed(hexId(3)), Name: "Music", CollectionType: "music" },
            { Id: "garbage", Name: "Broken" },
            {
              Id: dashed(LIB_A),
              Name: "Movies again",
              CollectionType: "movies",
            },
          ],
          TotalRecordCount: 6,
        });
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const libraries = await listLibraries(
        jellyfinConfig(fx.origin, []),
        TOKEN,
      );
      assert.deepEqual(libraries, [
        { id: LIB_A, name: "Movies" },
        { id: LIB_B, name: "Videos" },
      ]);
    },
  );
});

test("listLibraries never turns an upstream outage into an empty library", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/users/me") return sendJson(res, 200, ME);
      sendJson(res, 500, { message: "database locked" });
    },
    async (fx) => {
      await assert.rejects(
        listLibraries(jellyfinConfig(fx.origin, []), TOKEN),
        appError(502, "upstream_unavailable"),
      );
    },
  );
});

test("listLibraryItems maps a real page with playability and safe watch links", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, ME);
      if (path === `/users/${ME_ID}/items`) {
        const query = queryOf(req.url ?? "");
        assert.equal(query.get("parentId"), LIB_A);
        assert.equal(query.get("sortBy"), "SortName");
        assert.equal(query.get("recursive"), "true");
        return sendJson(res, 200, {
          Items: [
            {
              Id: dashed(ITEM_ID),
              Name: "Alpha",
              Type: "Movie",
              ProductionYear: 2001,
              Overview: "synopsis",
              RunTimeTicks: 600,
              ImageTags: { Primary: "tag" },
              LocationType: "FileSystem",
              Path: "/mnt/secret/alpha.mkv",
              SortName: "alpha",
              MediaSources: [{ Id: "ms1", SupportsDirectPlay: true }],
            },
          ],
          TotalRecordCount: 1,
        });
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const page = await listLibraryItems(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        {
          start: 0,
          limit: 24,
          search: "",
        },
      );
      assert.equal(page.total, 1);
      assert.equal(page.start, 0);
      assert.deepEqual(page.items[0], {
        id: ITEM_ID,
        name: "Alpha",
        kind: "movie",
        year: 2001,
        overview: "synopsis",
        durationTicks: 600,
        image: `/api/images/${ITEM_ID}`,
        canPlay: true,
        watchUrl: `${fx.origin}/jf/web/index.html#!/details?id=${ITEM_ID}&serverId=${SERVER_ID}`,
      });
      // Upstream Paths never leak into browser records.
      assert.equal(JSON.stringify(page.items).includes("/mnt/secret"), false);
      // Watch links are credential-free with the external prefix preserved.
      const watchUrl = page.items[0].watchUrl ?? "";
      assert.equal(/key|token|api/i.test(watchUrl), false);
      assert.ok(watchUrl.startsWith(`${fx.origin}/jf/web/index.html`));
    },
  );
});

test("listLibraryItems marks items unplayable when the user policy denies playback", async () => {
  const noPlayback = {
    ...ME,
    Policy: { ...ME.Policy, EnableMediaPlayback: false },
  };
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, noPlayback);
      if (path === `/users/${ME_ID}/items`) {
        return sendJson(res, 200, {
          Items: [
            {
              Id: dashed(ITEM_ID),
              Name: "Alpha",
              Type: "Movie",
              LocationType: "FileSystem",
              MediaSources: [{ Id: "ms1", SupportsDirectPlay: true }],
            },
          ],
          TotalRecordCount: 1,
        });
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const page = await listLibraryItems(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        {
          start: 0,
          limit: 24,
          search: "",
        },
      );
      const item = page.items[0];
      assert.ok(item);
      assert.equal(item.canPlay, false);
      assert.equal("watchUrl" in item, false);
    },
  );
});

test("empty library grants yield an empty page without any upstream call", async () => {
  await withFixture(
    (req, res) => sendJson(res, 200, {}),
    async (fx) => {
      const page = await listLibraryItems(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([]),
        {
          start: 0,
          limit: 24,
          search: "",
        },
      );
      assert.deepEqual(page, { items: [], total: 0, start: 0, limit: 24 });
      assert.equal(fx.log.length, 0);
    },
  );
});

test("listLibraryItems denies libraries outside the grant intersection", async () => {
  await withFixture(
    (req, res) => sendJson(res, 200, {}),
    async (fx) => {
      await assert.rejects(
        listLibraryItems(
          jellyfinConfig(fx.origin, [LIB_A]),
          TOKEN,
          account([LIB_A]),
          {
            start: 0,
            limit: 24,
            search: "",
            libraryId: LIB_C,
          },
        ),
        appError(403, "library_denied"),
      );
      assert.equal(fx.log.length, 0);
    },
  );
});

test("cross-library pagination merges into one stable global order", async () => {
  const byParent: Record<string, unknown[]> = {
    [LIB_A]: [movieItem(1, "a"), movieItem(3, "c"), movieItem(5, "e")],
    [LIB_B]: [movieItem(2, "b"), movieItem(4, "d")],
  };
  await withFixture(itemsByParentHandler(byParent), async (fx) => {
    const config = jellyfinConfig(fx.origin, [LIB_A, LIB_B]);
    const grants = account([LIB_A, LIB_B]);
    const page0 = await listLibraryItems(config, TOKEN, grants, {
      start: 0,
      limit: 2,
      search: "",
    });
    assert.deepEqual(
      page0.items.map((i) => i.name),
      ["a", "b"],
    );
    assert.equal(page0.total, 5);
    const page1 = await listLibraryItems(config, TOKEN, grants, {
      start: 2,
      limit: 2,
      search: "",
    });
    assert.deepEqual(
      page1.items.map((i) => i.name),
      ["c", "d"],
    );
    const page2 = await listLibraryItems(config, TOKEN, grants, {
      start: 4,
      limit: 2,
      search: "",
    });
    assert.deepEqual(
      page2.items.map((i) => i.name),
      ["e"],
    );
    // Searches merge across libraries with honest totals too.
    const found = await listLibraryItems(config, TOKEN, grants, {
      start: 0,
      limit: 10,
      search: "d",
    });
    assert.deepEqual(
      found.items.map((i) => i.name),
      ["d"],
    );
    assert.equal(found.total, 1);
  });
});

test("cross-library merge refills per-library chunks for deep pages", async () => {
  const libraryA = Array.from({ length: 70 }, (_v, index) =>
    movieItem(index + 1, `g${String(index + 1).padStart(2, "0")}`),
  );
  await withFixture(
    itemsByParentHandler({ [LIB_A]: libraryA, [LIB_B]: [] }),
    async (fx) => {
      const page = await listLibraryItems(
        jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
        TOKEN,
        account([LIB_A, LIB_B]),
        {
          start: 65,
          limit: 3,
          search: "",
        },
      );
      assert.deepEqual(
        page.items.map((i) => i.name),
        ["g66", "g67", "g68"],
      );
      assert.equal(page.total, 70);
      assert.ok(fx.log.some((r) => queryOf(r.url).get("startIndex") === "60"));
    },
  );
});

// --- item detail and membership proof ---

const ITEM_DTO = {
  Id: dashed(ITEM_ID),
  Name: "Secret Movie",
  Type: "Movie",
  LocationType: "FileSystem",
  Path: "/mnt/secret/x.mkv",
  ImageTags: { Primary: "tag" },
  SortName: "secret movie",
};

function membershipHandler(): {
  handler: FixtureHandler;
  playbackAuth: () => string | undefined;
} {
  let playbackAuthorization: string | undefined;
  const handler: FixtureHandler = (req, res) => {
    const url = req.url ?? "";
    const path = pathOf(url);
    if (path === "/users/me") return sendJson(res, 200, ME);
    if (path === `/users/${ME_ID}/items`) {
      // The lab Jellyfin 12.0.0 ignores parentId whenever ids is present,
      // so this stub returns the item for ANY ids query — exactly like the
      // real build. Membership must therefore come from the ancestor chain.
      const found = queryOf(url).get("ids") === ITEM_ID;
      return sendJson(res, 200, {
        Items: found ? [ITEM_DTO] : [],
        TotalRecordCount: found ? 1 : 0,
      });
    }
    if (path === `/items/${ITEM_ID}/ancestors`) {
      // The item lives in LIB_B.
      return sendJson(res, 200, [
        {
          Id: dashed(LIB_B),
          Name: "Adult Movies",
          Type: "CollectionFolder",
        },
      ]);
    }
    if (path === `/items/${ITEM_ID}/playbackinfo`) {
      playbackAuthorization = req.headers.authorization;
      return sendJson(res, 200, {
        MediaSources: [
          { Id: "ms1", SupportsDirectPlay: false, SupportsDirectStream: true },
        ],
      });
    }
    sendJson(res, 404, {});
  };
  return { handler, playbackAuth: () => playbackAuthorization };
}

test("getLibraryItem proves membership under a granted library before detail", async () => {
  const { handler, playbackAuth } = membershipHandler();
  await withFixture(handler, async (fx) => {
    const item = await getLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      TOKEN,
      account([LIB_A, LIB_B]),
      ITEM_ID,
    );
    assert.equal(item.id, ITEM_ID);
    assert.equal(item.canPlay, true);
    assert.equal(
      item.watchUrl,
      `${fx.origin}/jf/web/index.html#!/details?id=${ITEM_ID}&serverId=${SERVER_ID}`,
    );
    // PlaybackInfo and the ancestor proof both ran under the caller's own
    // user token; ungranted LIB_C was never part of any check.
    assert.ok((playbackAuth() ?? "").includes(`Token="${TOKEN}"`));
    assert.equal(JSON.stringify(item).includes("/mnt/secret"), false);
    const ancestorsQuery = fx.log.find(
      (r) => pathOf(r.url) === `/items/${ITEM_ID}/ancestors`,
    );
    assert.ok(ancestorsQuery, "expected the ancestor membership probe");
    assert.ok(
      (ancestorsQuery.headers.authorization ?? "").includes(`Token="${TOKEN}"`),
    );
    assert.equal(
      fx.log.some((r) => queryOf(r.url).get("parentId") === LIB_C),
      false,
    );
  });
});

test("getLibraryItem denies items that live outside granted libraries", async () => {
  const { handler } = membershipHandler();
  await withFixture(handler, async (fx) => {
    // Regression for the lab Jellyfin 12.0.0, which ignores parentId when
    // ids is present: the fixture returns the item for ANY ids query, so the
    // old ids+parentId proof wrongly granted access here. Only the ancestor
    // chain (item lives in LIB_B, grants cover LIB_A) can deny it.
    await assert.rejects(
      getLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        ITEM_ID,
      ),
      appError(404, "item_not_found"),
    );
    assert.equal(
      fx.log.some((r) => r.url.includes("playbackinfo")),
      false,
    );
    assert.equal(
      fx.log.some((r) => queryOf(r.url).get("parentId") === LIB_B),
      false,
    );
    // The denial came from the ancestor chain, not from query scoping.
    assert.ok(
      fx.log.some((r) => pathOf(r.url) === `/items/${ITEM_ID}/ancestors`),
    );
  });
});

test("getLibraryItem reports an ancestors outage as an upstream error", async () => {
  // A genuine outage during the membership proof is an error — never a
  // silent allow and never a fabricated denial.
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, ME);
      if (path === `/users/${ME_ID}/items`) {
        const found = queryOf(req.url ?? "").get("ids") === ITEM_ID;
        return sendJson(res, 200, {
          Items: found ? [ITEM_DTO] : [],
          TotalRecordCount: found ? 1 : 0,
        });
      }
      if (path === `/items/${ITEM_ID}/ancestors`)
        return sendJson(res, 500, { message: "boom" });
      sendJson(res, 404, {});
    },
    async (fx) => {
      await assert.rejects(
        getLibraryItem(
          jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
          TOKEN,
          account([LIB_A, LIB_B]),
          ITEM_ID,
        ),
        appError(502, "upstream_unavailable"),
      );
    },
  );
});

test("getLibraryItem denies empty grant sets without upstream calls", async () => {
  const { handler } = membershipHandler();
  await withFixture(handler, async (fx) => {
    const before = fx.log.length;
    await assert.rejects(
      getLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([]),
        ITEM_ID,
      ),
      appError(404, "item_not_found"),
    );
    assert.equal(fx.log.length, before);
  });
});

// --- images ---

test("getLibraryImage returns authorized raster bytes with allowlisted MIME", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, ME);
      if (path === `/users/${ME_ID}/items`) {
        // Real-build mimicry: ids wins, parentId is ignored.
        const found = queryOf(req.url ?? "").get("ids") === ITEM_ID;
        return sendJson(res, 200, {
          Items: found ? [ITEM_DTO] : [],
          TotalRecordCount: found ? 1 : 0,
        });
      }
      if (path === `/items/${ITEM_ID}/ancestors`) {
        return sendJson(res, 200, [
          { Id: dashed(LIB_A), Name: "Adult Movies", Type: "CollectionFolder" },
        ]);
      }
      if (path === `/items/${ITEM_ID}/images/primary`) {
        return sendBytes(res, 200, PNG_BYTES, "image/png");
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const image = await getLibraryImage(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        ITEM_ID,
      );
      assert.equal(image.contentType, "image/png");
      assert.ok(Buffer.from(image.bytes).equals(PNG_BYTES));
    },
  );
});

test("getLibraryImage reauthorizes membership first and enforces bounds", async () => {
  // Ordered image behaviors across sequential calls: SVG, oversize, valid PNG.
  const imageBehaviors: Array<(res: http.ServerResponse) => void> = [
    (res) =>
      sendBytes(
        res,
        200,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        "image/svg+xml",
      ),
    (res) => sendBytes(res, 200, Buffer.alloc(IMAGE_LIMIT + 1, 7), "image/png"),
    (res) => sendBytes(res, 200, PNG_BYTES, "image/png"),
  ];
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, ME);
      if (path === `/users/${ME_ID}/items`) {
        const member = queryOf(req.url ?? "").get("ids") === ITEM_ID;
        return sendJson(res, 200, {
          Items: member ? [ITEM_DTO] : [],
          TotalRecordCount: member ? 1 : 0,
        });
      }
      if (path === `/items/${ITEM_ID}/ancestors`) {
        return sendJson(res, 200, [
          { Id: dashed(LIB_A), Name: "Adult Movies", Type: "CollectionFolder" },
        ]);
      }
      if (path === `/items/${ITEM_ID}/images/primary`) {
        const next = imageBehaviors.shift();
        if (next) return next(res);
        return sendBytes(res, 200, PNG_BYTES, "image/png");
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      const config = jellyfinConfig(fx.origin, [LIB_A]);
      const grants = account([LIB_A]);
      // A non-member id is denied before any image bytes are fetched.
      await assert.rejects(
        getLibraryImage(config, TOKEN, grants, "e".repeat(32)),
        appError(404, "item_not_found"),
      );
      const afterDenial = fx.log.length;
      assert.ok(fx.log.some((r) => r.url.includes("e".repeat(32))));
      assert.equal(
        fx.log.some((r) => r.url.includes("/images/")),
        false,
      );
      // SVG is refused even when upstream serves it.
      await assert.rejects(
        getLibraryImage(config, TOKEN, grants, ITEM_ID),
        appError(502, "image_type"),
      );
      // Oversized images are refused without delivery.
      await assert.rejects(
        getLibraryImage(config, TOKEN, grants, ITEM_ID),
        appError(502, "upstream_bad_response"),
      );
      // Within bounds and allowlisted, the bytes flow.
      const image = await getLibraryImage(config, TOKEN, grants, ITEM_ID);
      const imageFetches = fx.log.filter((r) =>
        pathOf(r.url).includes("/images/"),
      );
      // Reauthorization ran before every single image fetch.
      const membershipQueries = fx.log.filter(
        (r) =>
          pathOf(r.url) === `/users/${ME_ID}/items` &&
          queryOf(r.url).get("ids") === ITEM_ID,
      );
      assert.equal(imageFetches.length, 3);
      assert.ok(membershipQueries.length >= 3);
      assert.ok(fx.log.length > afterDenial);
    },
  );
});

test("getLibraryImage rejects items without a primary image before fetching", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (path === "/users/me") return sendJson(res, 200, ME);
      if (path === `/users/${ME_ID}/items`) {
        return sendJson(res, 200, {
          Items: [{ ...ITEM_DTO, ImageTags: {} }],
          TotalRecordCount: 1,
        });
      }
      if (path === `/items/${ITEM_ID}/ancestors`) {
        return sendJson(res, 200, [
          { Id: dashed(LIB_A), Name: "Adult Movies", Type: "CollectionFolder" },
        ]);
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      await assert.rejects(
        getLibraryImage(
          jellyfinConfig(fx.origin, [LIB_A]),
          TOKEN,
          account([LIB_A]),
          ITEM_ID,
        ),
        appError(404, "image_not_found"),
      );
      assert.equal(
        fx.log.some((r) => r.url.includes("/images/")),
        false,
      );
    },
  );
});

// --- Whisparr ---

test("getWhisparrStatus is unconfigured without Whisparr credentials", async () => {
  const status = await getWhisparrStatus(
    jellyfinConfig("http://127.0.0.1:8096", []),
  );
  assert.deepEqual(status, { configured: false });
});

test("getWhisparrStatus maps read-only status, root folders, and profiles", async () => {
  await withFixture(
    (req, res) => {
      const path = pathOf(req.url ?? "");
      if (req.method !== "GET") return sendJson(res, 405, {});
      if (path === "/api/v3/system/status")
        return sendJson(res, 200, {
          appName: "Whisparr",
          version: "3.4.0.1387",
          branch: "eros",
        });
      if (path === "/api/v3/rootfolder") {
        return sendJson(res, 200, [
          { id: 1, path: "/data/media", freeSpace: 5, unmappedFolders: [] },
          { id: "bad" },
          { path: "/no-id" },
        ]);
      }
      if (path === "/api/v3/qualityprofile")
        return sendJson(res, 200, [{ id: 7, name: "HD", cutoff: 1 }]);
      sendJson(res, 404, {});
    },
    async (fx) => {
      const status = await getWhisparrStatus(whisparrConfig(fx.origin));
      assert.deepEqual(status, {
        configured: true,
        version: "3.4.0.1387",
        appName: "Whisparr",
        rootFolders: [{ id: 1, path: "/data/media" }],
        profiles: [{ id: 7, name: "HD" }],
      });
      // Strictly read-only: GETs only, key header on every call.
      assert.ok(fx.log.every((r) => r.method === "GET"));
      assert.ok(fx.log.every((r) => r.headers["x-api-key"] === WH_KEY));
      assert.deepEqual(fx.log.map((r) => pathOf(r.url)).sort(), [
        "/api/v3/qualityprofile",
        "/api/v3/rootfolder",
        "/api/v3/system/status",
      ]);
    },
  );
});

test("getWhisparrStatus reports genuine upstream outages", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/rootfolder")
        return sendJson(res, 500, { message: "boom" });
      sendJson(res, 200, {});
    },
    async (fx) => {
      await assert.rejects(
        getWhisparrStatus(whisparrConfig(fx.origin)),
        appError(502, "upstream_unavailable"),
      );
    },
  );
});

// --- id canonicalization ---

test("normalizeItemId canonicalizes external UUIDs and rejects everything else", () => {
  assert.equal(
    normalizeItemId("A1B2C3D4-E5F6-0789-ABCD-EF0123456789"),
    "a1b2c3d4e5f60789abcdef0123456789",
  );
  assert.equal(normalizeItemId("a".repeat(32)), "a".repeat(32));
  assert.throws(() => normalizeItemId("nope"), appError(400, "invalid_id"));
  assert.throws(() => normalizeItemId(undefined), appError(400, "invalid_id"));
  assert.throws(
    () => normalizeItemId(`${"a".repeat(31)}g`),
    appError(400, "invalid_id"),
  );
});

// --- M2 availability: per-user resolvePlaybackAccess ---
// Disjoint block owned by M2Availability. All fixtures are local 127.0.0.1
// HTTP stubs; every verdict must run under the caller's user token and never
// mutate the server (GET only, user token only).

import { resolvePlaybackAccess } from "../src/server/jellyfin.ts";
import type { PlaybackAccess } from "../src/lib/contracts.ts";

const AV_PID = hexId(0x101);
const AV_PATH = hexId(0x102);
const AV_ED1 = hexId(0x103);
const AV_ED2 = hexId(0x104);
const AV_DENY = hexId(0x105);
const AV_OUTSIDE = hexId(0x106);
const AV_SEQ = hexId(0x107);
const AV_SIM = hexId(0x108);
const AV_PHANTOM = hexId(0x109);

interface AvEntry {
  item: Record<string, unknown>;
  lib: string;
}

function avItem(o: {
  id: string;
  name: string;
  year?: number;
  providerIds?: Record<string, string>;
  path?: string;
  locationType?: string;
}): Record<string, unknown> {
  const path = o.path ?? "";
  return {
    Id: dashed(o.id),
    Name: o.name,
    Type: "Movie",
    ...(o.year ? { ProductionYear: o.year } : {}),
    LocationType: o.locationType ?? "FileSystem",
    ProviderIds: o.providerIds ?? {},
    ...(path ? { Path: path } : {}),
    ...(path
      ? {
          MediaSources: [
            {
              Id: "src1",
              Path: path,
              Size: 21_000,
              SupportsDirectPlay: true,
              SupportsDirectStream: true,
              SupportsTranscoding: true,
            },
          ],
        }
      : { MediaSources: [] }),
  };
}

function avEntries(): AvEntry[] {
  return [
    {
      lib: LIB_A,
      item: avItem({
        id: AV_PID,
        name: "Provider Movie",
        year: 2024,
        providerIds: { Tmdb: "6789", Tpdb: "tpdb-movie-uuid" },
        path: "C:\\media\\movies\\Provider Movie\\Provider Movie.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_PATH,
        name: "Path Movie",
        year: 2020,
        path: "C:\\media\\movies\\Path Movie (2020)\\Path Movie (2020).mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_ED1,
        name: "Edition Split",
        year: 2019,
        path: "C:\\media\\movies\\Edition Split\\Edition A.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_ED2,
        name: "Edition Split",
        year: 2019,
        path: "C:\\media\\movies\\Edition Split\\Edition B.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_DENY,
        name: "Empty File Movie",
        providerIds: { Tpdb: "tpdb-deny-uuid" },
        path: "C:\\media\\movies\\Empty File Movie\\Empty File Movie.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_OUTSIDE,
        name: "Ungranted Movie",
        providerIds: { Tpdb: "tpdb-outside-uuid" },
        path: "C:\\media\\movies\\Ungranted Movie\\Ungranted Movie.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_SEQ,
        name: "Path Movie (2020) Sequel",
        year: 2023,
        path: "C:\\media\\movies\\Path Movie (2020) Sequel\\Sequel.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_SIM,
        name: "Similar Title",
        year: 2021,
        path: "C:\\media\\movies\\Similar Title\\Similar Title.mkv",
      }),
    },
    {
      lib: LIB_A,
      item: avItem({
        id: AV_PHANTOM,
        name: "Phantom Movie",
        providerIds: { Tpdb: "tpdb-phantom-uuid" },
        locationType: "Virtual",
      }),
    },
  ];
}

function avConfig(origin: string, libraryIds: string[]): IntegrationConfig {
  return {
    ...jellyfinConfig(origin, libraryIds),
    whisparr: {
      url: origin,
      apiKey: WH_KEY,
      pathMappings: [
        {
          whisparrPrefix: "X:\\Media\\Movies",
          jellyfinPrefix: "C:\\media\\movies",
        },
      ],
    },
  };
}

function avHandler(opts: {
  entries: AvEntry[];
  me?: Record<string, unknown>;
  meStatus?: number;
  sweepStatus?: number;
  /** compact item id -> PlaybackInfo MediaSources override. */
  playback?: Record<string, unknown[]>;
  /** Status forced for every /Items/{id}/Ancestors probe. */
  ancestorsStatus?: number;
  /** Status forced for every /Items/{id}/PlaybackInfo probe. */
  playbackStatus?: number;
}): FixtureHandler {
  return (req, res) => {
    const path = pathOf(req.url ?? "");
    const q = queryOf(req.url ?? "");
    if (path === "/users/me") {
      if (opts.meStatus) return sendJson(res, opts.meStatus, {});
      return sendJson(res, 200, opts.me ?? ME);
    }
    if (path === `/users/${ME_ID}/items`) {
      if (opts.sweepStatus) return sendJson(res, opts.sweepStatus, {});
      const items = opts.entries.map((e) => e.item);
      return sendJson(res, 200, {
        Items: items,
        TotalRecordCount: items.length,
      });
    }
    const anc = path.match(/^\/items\/([0-9a-f]{32})\/ancestors$/);
    if (anc) {
      if (opts.ancestorsStatus) return sendJson(res, opts.ancestorsStatus, {});
      const entry = opts.entries.find(
        (e) => String(e.item.Id).replace(/-/g, "") === (anc[1] ?? ""),
      );
      if (!entry) return sendJson(res, 404, {});
      // The item's library folder is its only meaningful ancestor here.
      return sendJson(res, 200, [
        {
          Id: dashed(entry.lib),
          Name: "Adult Library",
          Type: "CollectionFolder",
        },
      ]);
    }
    const info = path.match(/^\/items\/([0-9a-f]{32})\/playbackinfo$/);
    if (info) {
      if (opts.playbackStatus) return sendJson(res, opts.playbackStatus, {});
      const sources = opts.playback?.[info[1] ?? ""] ?? [
        {
          Id: "src1",
          Size: 21_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: true,
        },
      ];
      return sendJson(res, 200, { MediaSources: sources });
    }
    sendJson(res, 404, {});
  };
}

function avItemId(verdict: PlaybackAccess): string {
  return verdict.outcome === "available" ? verdict.item.id : "";
}

function avSweepRequest(fx: Fixture): RecordedRequest {
  const sweep = fx.log.find((r) => pathOf(r.url) === `/users/${ME_ID}/items`);
  assert.ok(sweep, "expected a user-token candidate sweep request");
  return sweep;
}

test("resolvePlaybackAccess matches exactly by provider id and links only playable items", async () => {
  await withFixture(avHandler({ entries: avEntries() }), async (fx) => {
    const verdict = await resolvePlaybackAccess(
      avConfig(fx.origin, [LIB_A]),
      TOKEN,
      account([LIB_A]),
      { provider: "tpdb", kind: "movie", id: "tpdb-movie-uuid" },
    );
    const watchUrl = `${fx.origin}/jf/web/index.html#!/details?id=${AV_PID}&serverId=${SERVER_ID}`;
    assert.deepEqual(verdict, {
      outcome: "available",
      item: {
        id: AV_PID,
        name: "Provider Movie",
        kind: "movie",
        year: 2024,
        canPlay: true,
        watchUrl,
      },
      watchUrl,
    });
    // Security posture: the sweep is a user-token GET that asks for
    // ProviderIds and Path (no provider-id filter exists on this build).
    const sweep = avSweepRequest(fx);
    const fields = queryOf(sweep.url).get("fields") ?? "";
    assert.ok(fields.includes("ProviderIds"));
    assert.ok(fields.includes("Path"));
    const auth = String(sweep.headers.authorization ?? "");
    assert.ok(auth.includes(`Token="${TOKEN}"`));
    assert.ok(!auth.includes(ADMIN_KEY));
    assert.equal(sweep.body, "");
    assert.ok(
      fx.log.every((r) => r.method === "GET"),
      "read-only",
    );
  });
});

test("resolvePlaybackAccess matches by mapped path with full components only", async () => {
  await withFixture(avHandler({ entries: avEntries() }), async (fx) => {
    const cfg = avConfig(fx.origin, [LIB_A]);
    const grants = account([LIB_A]);
    // Forward-slash Whisparr path maps onto the Windows Jellyfin path.
    assert.equal(
      avItemId(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-unmapped-uuid",
          whisparrPath: "X:/Media/Movies/Path Movie (2020)",
        }),
      ),
      AV_PATH,
    );
    // Windows-style mappings are case-insensitive on components.
    assert.equal(
      avItemId(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-unmapped-uuid",
          whisparrPath: "x:\\MEDIA\\MOVIES\\Path Movie (2020)",
        }),
      ),
      AV_PATH,
    );
    // A suffix inside one component is never a substring match.
    assert.deepEqual(
      await resolvePlaybackAccess(cfg, TOKEN, grants, {
        provider: "tpdb",
        kind: "movie",
        id: "tpdb-unmapped-uuid",
        whisparrPath: "X:\\Media\\Movies\\Path Movie (2020) x",
      }),
      { outcome: "missing" },
    );
    // The Sequel item is its own exact match, not a collision.
    assert.equal(
      avItemId(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-unmapped-uuid",
          whisparrPath: "X:\\Media\\Movies\\Path Movie (2020) Sequel",
        }),
      ),
      AV_SEQ,
    );
  });
});

test("resolvePlaybackAccess reports ambiguity instead of guessing", async () => {
  await withFixture(avHandler({ entries: avEntries() }), async (fx) => {
    const cfg = avConfig(fx.origin, [LIB_A]);
    // Two editions share one mapped folder: ambiguous, never a guess.
    assert.deepEqual(
      await resolvePlaybackAccess(cfg, TOKEN, account([LIB_A]), {
        provider: "tpdb",
        kind: "movie",
        id: "tpdb-unmapped-uuid",
        whisparrPath: "X:\\Media\\Movies\\Edition Split",
      }),
      {
        outcome: "ambiguous",
        reason: "Multiple Jellyfin items match this identity.",
      },
    );
    // Title/year agreement alone is also ambiguous for review.
    assert.deepEqual(
      await resolvePlaybackAccess(cfg, TOKEN, account([LIB_A]), {
        provider: "tpdb",
        kind: "movie",
        id: "tpdb-unknown-uuid",
        title: "Similar Title",
        year: 2021,
      }),
      {
        outcome: "ambiguous",
        reason: "Title/year similarity only; administrator review required.",
      },
    );
  });
});

test("resolvePlaybackAccess denies playback for policy, empty, and placeholder items", async () => {
  await withFixture(
    avHandler({
      entries: avEntries(),
      me: {
        ...ME,
        Policy: { ...ME.Policy, EnableMediaPlayback: false },
      },
    }),
    async (fx) => {
      const cfg = avConfig(fx.origin, [LIB_A]);
      assert.deepEqual(
        await resolvePlaybackAccess(cfg, TOKEN, account([LIB_A]), {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-movie-uuid",
        }),
        {
          outcome: "denied",
          reason: "Playback is disabled for this Jellyfin user.",
        },
      );
    },
  );
  await withFixture(
    avHandler({
      entries: avEntries(),
      playback: {
        // Zero-length media: proven present but unplayable.
        [AV_DENY]: [
          {
            Id: "src1",
            Size: 0,
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: true,
          },
        ],
      },
    }),
    async (fx) => {
      const cfg = avConfig(fx.origin, [LIB_A]);
      const grants = account([LIB_A]);
      assert.deepEqual(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-deny-uuid",
        }),
        {
          outcome: "denied",
          reason: "No playable media source (file missing or empty).",
        },
      );
      assert.deepEqual(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-phantom-uuid",
        }),
        {
          outcome: "denied",
          reason: "The matched item is a placeholder without media.",
        },
      );
    },
  );
});

test("resolvePlaybackAccess reports absent items as missing", async () => {
  await withFixture(avHandler({ entries: avEntries() }), async (fx) => {
    assert.deepEqual(
      await resolvePlaybackAccess(
        avConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        {
          provider: "tpdb",
          kind: "scene",
          id: "tpdb-nothing",
        },
      ),
      { outcome: "missing" },
    );
  });
});

test("resolvePlaybackAccess reports outages as unavailable and propagates auth failures", async () => {
  await withFixture(
    avHandler({ entries: avEntries(), sweepStatus: 500 }),
    async (fx) => {
      const verdict = await resolvePlaybackAccess(
        avConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        { provider: "tpdb", kind: "movie", id: "tpdb-movie-uuid" },
      );
      assert.equal(verdict.outcome, "unavailable");
      if (verdict.outcome !== "unavailable") return assert.fail("unreachable");
      assert.ok(verdict.reason !== undefined && verdict.reason.length > 0);
    },
  );
  await withFixture(
    avHandler({ entries: avEntries(), meStatus: 401 }),
    async (fx) => {
      await assert.rejects(
        resolvePlaybackAccess(
          avConfig(fx.origin, [LIB_A]),
          TOKEN,
          account([LIB_A]),
          {
            provider: "tpdb",
            kind: "movie",
            id: "tpdb-movie-uuid",
          },
        ),
        appError(401, "upstream_auth"),
      );
    },
  );
});

test("resolvePlaybackAccess enforces grant scope before availability", async () => {
  await withFixture(avHandler({ entries: avEntries() }), async (fx) => {
    // Empty grants deny without contacting Jellyfin at all.
    assert.deepEqual(
      await resolvePlaybackAccess(avConfig(fx.origin, []), TOKEN, account([]), {
        provider: "tpdb",
        kind: "movie",
        id: "tpdb-outside-uuid",
      }),
      {
        outcome: "denied",
        reason: "No libraries are granted to this account.",
      },
    );
    assert.equal(fx.log.length, 0, "empty grants must not touch upstream");
    // Visible to the user's token but outside the account's grants:
    // denied, never missing.
    assert.deepEqual(
      await resolvePlaybackAccess(
        avConfig(fx.origin, [LIB_B]),
        TOKEN,
        account([LIB_B]),
        {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-outside-uuid",
        },
      ),
      {
        outcome: "denied",
        reason: "The matched item is outside this account's granted libraries.",
      },
    );
  });
});

// --- M2 delivery: Whisparr resolution, adoption, observation, gated adds ---
// Disjoint block owned by M2Delivery. Fixture-local helpers; every flow is
// GET-only except the explicitly POSTed add path, which is only ever pointed
// at the local stub.

import {
  buildMoviePayload,
  deliverToWhisparr,
  findWhisparrItem,
  getWhisparrItem,
  observeWhisparrItem,
  resolveWhisparrItem,
  type WhisparrDeliveryTarget,
} from "../src/server/whisparr.ts";
import type { WhisparrDelivery } from "../src/lib/contracts.ts";

const MOVIE_UUID = dashed(hexId(0x2a1));
const SCENE_UUID = dashed(hexId(0x2b2));
const OTHER_UUID = dashed(hexId(0x2c3));

const DELIVERY: WhisparrDelivery = {
  enabled: true,
  rootFolderPath: "/data/xxx",
  qualityProfileId: 7,
  searchOnAdd: true,
};
function deliveryConfig(
  origin: string,
  delivery?: WhisparrDelivery,
): IntegrationConfig {
  return {
    ...whisparrConfig(origin),
    whisparr: {
      url: origin,
      apiKey: WH_KEY,
      // Absent delivery is the disabled state; gate variants pass a full but
      // invalid/disabled WhisparrDelivery.
      ...(delivery ? { delivery } : {}),
    },
  };
}
const movieRef = { provider: "tpdb", kind: "movie", id: MOVIE_UUID } as const;
const sceneRef = {
  provider: "stashdb",
  kind: "scene",
  id: SCENE_UUID,
} as const;

/** Stored TPDB movie resource, using exactly the fields observed live on
 * GET /api/v3/movie/{id} (rootFolderPath only appears on the unfiltered
 * list, so it is never required on a read). */
function storedMovie(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    itemType: "movie",
    title: "Sample Movie",
    monitored: true,
    hasFile: false,
    movieFileId: 0,
    movieFile: null,
    sizeOnDisk: 0,
    status: "released",
    isAvailable: true,
    path: "/data/xxx/Sample Movie",
    foreignId: `tpdbId:${MOVIE_UUID}`,
    tmdbId: 0,
    tpdbId: MOVIE_UUID,
    statistics: { movieFileCount: 0, sizeOnDisk: 0, releaseGroups: [] },
    ...overrides,
  };
}

/** Stored StashDB scene resource: bare UUID ForeignId, no tpdbId key. */
function storedScene(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    itemType: "scene",
    title: "Sample Scene",
    monitored: true,
    hasFile: false,
    movieFileId: 0,
    movieFile: null,
    sizeOnDisk: 0,
    status: "released",
    isAvailable: true,
    path: "/data/xxx/Sample Scene",
    foreignId: SCENE_UUID,
    tmdbId: 0,
    stashId: SCENE_UUID,
    statistics: { movieFileCount: 0, sizeOnDisk: 0, releaseGroups: [] },
    ...overrides,
  };
}

/** Lookup results carry no stored id and no path — they are never stored
 * items and must never be spread into an add body. */
function lookupMovie(overrides: Record<string, unknown> = {}) {
  return {
    itemType: "movie",
    title: "Sample Movie",
    foreignId: `tpdbId:${MOVIE_UUID}`,
    tmdbId: 0,
    tpdbId: MOVIE_UUID,
    ...overrides,
  };
}

function lookupScene(overrides: Record<string, unknown> = {}) {
  return {
    itemType: "scene",
    title: "Sample Scene",
    foreignId: SCENE_UUID,
    tmdbId: 0,
    stashId: SCENE_UUID,
    ...overrides,
  };
}

/** Test-side mirror of the documented Whisparr AddMovieService.GetMetadata
 * precedence: numeric ForeignId -> TmdbId>0 -> TpdbId -> ForeignId
 * "tpdbid:" prefix -> GetSceneInfo(ForeignId). Used to prove the constructed
 * payloads route to the intended metadata source. */
function metadataSource(payload: {
  foreignId: string;
  tmdbId: number;
  tpdbId?: string;
}): "tmdb-numeric" | "tmdb" | "tpdb" | "scene" {
  if (/^-?\d+$/.test(payload.foreignId)) return "tmdb-numeric";
  if (payload.tmdbId > 0) return "tmdb";
  if (payload.tpdbId) return "tpdb";
  if (/^tpdbid:/i.test(payload.foreignId)) return "tpdb";
  return "scene";
}

// --- resolution ---

test("resolveWhisparrItem verifies the movie identity from the typed tpdb lookup", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie/lookup/tpdb")
        return sendJson(res, 200, lookupMovie());
      sendJson(res, 404, {});
    },
    async (fx) => {
      assert.deepEqual(
        await resolveWhisparrItem(deliveryConfig(fx.origin), movieRef),
        {
          itemType: "movie",
          identity: MOVIE_UUID,
          title: "Sample Movie",
        },
      );
      assert.equal(fx.log.length, 1);
      assert.equal(fx.log[0]!.method, "GET");
      assert.equal(fx.log[0]!.headers["x-api-key"], WH_KEY);
      assert.equal(pathOf(fx.log[0]!.url), "/api/v3/movie/lookup/tpdb");
      assert.equal(queryOf(fx.log[0]!.url).get("tpdbId"), MOVIE_UUID);
    },
  );
});

test("resolveWhisparrItem matches the exact stash scene among lookup results", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie/lookup")
        return sendJson(res, 200, [
          lookupScene({
            foreignId: OTHER_UUID,
            stashId: OTHER_UUID,
            title: "x",
          }),
          lookupScene(),
        ]);
      sendJson(res, 404, {});
    },
    async (fx) => {
      assert.deepEqual(
        await resolveWhisparrItem(deliveryConfig(fx.origin), sceneRef),
        {
          itemType: "scene",
          identity: SCENE_UUID,
          title: "Sample Scene",
        },
      );
      assert.equal(queryOf(fx.log[0]!.url).get("term"), `stash:${SCENE_UUID}`);
    },
  );
});

test("resolveWhisparrItem treats identity and kind mismatches as hard errors", async () => {
  const wrongIdentity = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    if (pathOf(req.url ?? "") === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupMovie({ tpdbId: OTHER_UUID }));
    sendJson(res, 404, {});
  };
  const wrongKind = (req: http.IncomingMessage, res: http.ServerResponse) => {
    // A scene-shaped resource cannot satisfy a movie reference.
    if (pathOf(req.url ?? "") === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupScene());
    sendJson(res, 404, {});
  };
  await withFixture(wrongIdentity, async (fx) => {
    await assert.rejects(
      resolveWhisparrItem(deliveryConfig(fx.origin, DELIVERY), movieRef),
      appError(502, "identity_mismatch"),
    );
  });
  await withFixture(wrongKind, async (fx) => {
    await assert.rejects(
      resolveWhisparrItem(deliveryConfig(fx.origin, DELIVERY), movieRef),
      appError(502, "identity_mismatch"),
    );
  });
});

test("resolveWhisparrItem surfaces import exclusion only when the API reveals it", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie/lookup/tpdb")
        return sendJson(res, 200, lookupMovie({ isExcluded: true }));
      sendJson(res, 404, {});
    },
    async (fx) => {
      const resolved = await resolveWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(resolved.importExcluded, true);
    },
  );
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie/lookup/tpdb")
        return sendJson(res, 200, lookupMovie());
      sendJson(res, 404, {});
    },
    async (fx) => {
      const resolved = await resolveWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal("importExcluded" in resolved, false);
    },
  );
});

// --- adoption reads ---

test("findWhisparrItem and getWhisparrItem read stored items by exact identity", async () => {
  await withFixture(
    (req, res) => {
      const p = pathOf(req.url ?? "");
      if (p === "/api/v3/movie") {
        const query = queryOf(req.url ?? "");
        if (query.get("tpdbId") === MOVIE_UUID)
          return sendJson(res, 200, [storedMovie()]);
        if (query.get("stashId") === SCENE_UUID)
          return sendJson(res, 200, [storedScene()]);
        return sendJson(res, 200, []);
      }
      if (p === "/api/v3/movie/2") return sendJson(res, 200, storedMovie());
      if (p === "/api/v3/movie/3") return sendJson(res, 200, storedScene());
      sendJson(res, 404, {});
    },
    async (fx) => {
      const movie = await findWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(movie?.whisparrId, 2);
      assert.equal(movie?.itemType, "movie");
      assert.equal(movie?.identity, MOVIE_UUID);
      assert.equal(movie?.path, "/data/xxx/Sample Movie");
      const scene = await findWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        sceneRef,
      );
      assert.equal(scene?.whisparrId, 3);
      assert.equal(scene?.itemType, "scene");
      // 200 + [] is authoritative absence, never an error.
      const other = { ...movieRef, id: OTHER_UUID };
      assert.equal(
        await findWhisparrItem(deliveryConfig(fx.origin, DELIVERY), other),
        null,
      );
      const byId = await getWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        2,
      );
      assert.equal(byId?.identity, MOVIE_UUID);
    },
  );
  // Conflicting duplicates are an upstream inconsistency, not a pick.
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie")
        return sendJson(res, 200, [storedMovie(), storedMovie({ id: 9 })]);
      sendJson(res, 404, {});
    },
    async (fx) => {
      await assert.rejects(
        findWhisparrItem(deliveryConfig(fx.origin, DELIVERY), movieRef),
        appError(502, "identity_mismatch"),
      );
    },
  );
});

test("getWhisparrItem treats a proven 404 as absence and reports outages", async () => {
  await withFixture(
    (req, res) => {
      const p = pathOf(req.url ?? "");
      if (p === "/api/v3/movie/2") return sendJson(res, 200, storedMovie());
      if (p === "/api/v3/movie/404") return sendJson(res, 404, {});
      sendJson(res, 500, {});
    },
    async (fx) => {
      assert.equal(
        (await getWhisparrItem(deliveryConfig(fx.origin, DELIVERY), 2))
          ?.whisparrId,
        2,
      );
      assert.equal(
        await getWhisparrItem(deliveryConfig(fx.origin, DELIVERY), 404),
        null,
      );
      await assert.rejects(
        getWhisparrItem(deliveryConfig(fx.origin, DELIVERY), 5),
        appError(502, "upstream_unavailable"),
      );
    },
  );
});

// --- observation mapping ---

test("observeWhisparrItem maps monitoring, downloading, and imported from real fields", async () => {
  const queueFixture = { reads: 0 };
  await withFixture(
    (req, res) => {
      const p = pathOf(req.url ?? "");
      if (p === "/api/v3/movie") {
        if (queryOf(req.url ?? "").get("tpdbId") === MOVIE_UUID)
          return sendJson(res, 200, [storedMovie()]);
        return sendJson(res, 200, []);
      }
      if (p === "/api/v3/queue") {
        // First read: empty queue (monitoring). Second read: the item is
        // queued (downloading).
        queueFixture.reads += 1;
        return sendJson(
          res,
          200,
          queueFixture.reads > 1
            ? {
                page: 1,
                pageSize: 200,
                totalRecords: 1,
                records: [
                  { movieId: 2, movie: { id: 2, title: "Sample Movie" } },
                ],
              }
            : { page: 1, pageSize: 200, totalRecords: 0, records: [] },
        );
      }
      sendJson(res, 404, {});
    },
    async (fx) => {
      // Monitoring with no release is not failure.
      const idle = await observeWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.deepEqual(
        {
          state: idle.found ? idle.state : null,
          monitored: idle.found ? idle.item.monitored : null,
        },
        { state: "monitoring", monitored: true },
      );
      // Queue presence (by movieId or nested movie.id) means downloading.
      const busy = await observeWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(busy.found && busy.state, "downloading");
      // Unknown identity is simply not found.
      const missing = await observeWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        {
          ...movieRef,
          id: OTHER_UUID,
        },
      );
      assert.deepEqual(missing, { found: false });
    },
  );
  // A file on disk means imported — the queue is not even consulted.
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie")
        return sendJson(res, 200, [
          storedMovie({ hasFile: true, movieFileId: 7 }),
        ]);
      sendJson(res, 404, {});
    },
    async (fx) => {
      const imported = await observeWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(imported.found && imported.state, "imported");
      assert.equal(
        fx.log.some((r) => r.url.includes("/queue")),
        false,
      );
    },
  );
  // An unreadable queue falls back to monitoring, never a fabricated failure.
  await withFixture(
    (req, res) => {
      const p = pathOf(req.url ?? "");
      if (p === "/api/v3/movie") return sendJson(res, 200, [storedMovie()]);
      if (p === "/api/v3/queue") return sendJson(res, 500, {});
      sendJson(res, 404, {});
    },
    async (fx) => {
      const degraded = await observeWhisparrItem(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(degraded.found && degraded.state, "monitoring");
    },
  );
});

// --- delivery gating and add path ---

test("delivery requires an enabled and complete delivery config and makes no calls otherwise", async () => {
  const variants: Record<string, WhisparrDelivery | undefined> = {
    absent: undefined,
    disabled: { ...DELIVERY, enabled: false },
    badRoot: { ...DELIVERY, rootFolderPath: " /data/xxx" },
    badProfile: { ...DELIVERY, qualityProfileId: 0 },
  };
  for (const [name, delivery] of Object.entries(variants)) {
    await withFixture(
      () => {
        throw new Error("no upstream call may happen for a gated delivery");
      },
      async (fx) => {
        await assert.rejects(
          deliverToWhisparr(deliveryConfig(fx.origin, delivery), movieRef),
          appError(409, "delivery_disabled"),
        );
        assert.equal(fx.log.length, 0, `${name} must block before any request`);
      },
    );
  }
});

test("deliverToWhisparr adopts an existing exact identity without adding", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/api/v3/movie")
        return sendJson(res, 200, [storedMovie()]);
      sendJson(res, 404, {});
    },
    async (fx) => {
      const result = await deliverToWhisparr(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(result.outcome, "adopted");
      assert.ok(
        fx.log.every((r) => r.method === "GET"),
        "adoption never POSTs",
      );
      assert.equal(fx.log.length, 1);
    },
  );
});

test("deliverToWhisparr sends an exact server-owned payload and accepts the stored echo", async () => {
  const posted: string[] = [];
  const handler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ) => {
    const p = pathOf(req.url ?? "");
    if (req.method === "POST" && p === "/api/v3/movie") {
      posted.push(body);
      return sendJson(res, 201, storedMovie());
    }
    if (p === "/api/v3/movie") return sendJson(res, 200, []);
    if (p === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupMovie());
    sendJson(res, 404, {});
  };
  await withFixture(handler, async (fx) => {
    const result = await deliverToWhisparr(
      deliveryConfig(fx.origin, DELIVERY),
      movieRef,
    );
    assert.equal(result.outcome, "accepted");
    assert.equal(result.outcome === "accepted" && result.item.whisparrId, 2);
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(posted[0]!), {
      title: "Sample Movie",
      foreignId: `tpdbId:${MOVIE_UUID}`,
      tmdbId: 0,
      tpdbId: MOVIE_UUID,
      rootFolderPath: "/data/xxx",
      qualityProfileId: 7,
      monitored: true,
      addOptions: { searchForMovie: true, addMethod: "Manual" },
    });
    assert.deepEqual(
      fx.log.map((r) => `${r.method} ${pathOf(r.url)}`),
      [
        "GET /api/v3/movie",
        "GET /api/v3/movie/lookup/tpdb",
        "POST /api/v3/movie",
      ],
    );
  });
});

test("scene payloads carry a bare UUID ForeignId with no tpdbId and route to scene lookup", async () => {
  const posted: string[] = [];
  await withFixture(
    (req: http.IncomingMessage, res: http.ServerResponse, body: string) => {
      const p = pathOf(req.url ?? "");
      if (req.method === "POST" && p === "/api/v3/movie") {
        posted.push(body);
        return sendJson(res, 201, storedScene());
      }
      if (p === "/api/v3/movie") return sendJson(res, 200, []);
      if (p === "/api/v3/movie/lookup")
        return sendJson(res, 200, [lookupScene()]);
      sendJson(res, 404, {});
    },
    async (fx) => {
      const result = await deliverToWhisparr(
        deliveryConfig(fx.origin, { ...DELIVERY, searchOnAdd: false }),
        sceneRef,
      );
      assert.equal(result.outcome, "accepted");
      assert.deepEqual(JSON.parse(posted[0]!), {
        title: "Sample Scene",
        foreignId: SCENE_UUID,
        tmdbId: 0,
        rootFolderPath: "/data/xxx",
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: false, addMethod: "Manual" },
      });
      assert.equal(queryOf(fx.log[1]!.url).get("term"), `stash:${SCENE_UUID}`);
    },
  );
});

test("payload routing holds under the documented precedence, not by accident", () => {
  // Precedence order: numeric ForeignId, then TmdbId>0, then TpdbId, then
  // the tpdbid: prefix, then scene lookup.
  assert.equal(
    metadataSource({ foreignId: "12345", tmdbId: 5, tpdbId: MOVIE_UUID }),
    "tmdb-numeric",
  );
  assert.equal(
    metadataSource({
      foreignId: `tpdbId:${MOVIE_UUID}`,
      tmdbId: 9,
      tpdbId: MOVIE_UUID,
    }),
    "tmdb",
  );
  assert.equal(
    metadataSource({
      foreignId: `tpdbId:${MOVIE_UUID}`,
      tmdbId: 0,
      tpdbId: MOVIE_UUID,
    }),
    "tpdb",
  );
  assert.equal(
    metadataSource({ foreignId: `tpdbId:${MOVIE_UUID}`, tmdbId: 0 }),
    "tpdb",
  );
  assert.equal(metadataSource({ foreignId: SCENE_UUID, tmdbId: 0 }), "scene");
  // The builder emits exactly one routing source per kind.
  assert.equal(
    metadataSource(buildMoviePayload(movieRef, "Sample Movie", DELIVERY)),
    "tpdb",
  );
  assert.equal(
    metadataSource(buildMoviePayload(sceneRef, "Sample Scene", DELIVERY)),
    "scene",
  );
});

test("deliverToWhisparr explains a revealed import exclusion instead of adding", async () => {
  await withFixture(
    (req, res) => {
      const p = pathOf(req.url ?? "");
      if (p === "/api/v3/movie") return sendJson(res, 200, []);
      if (p === "/api/v3/movie/lookup/tpdb")
        return sendJson(res, 200, lookupMovie({ isExcluded: true }));
      sendJson(res, 404, {});
    },
    async (fx) => {
      const result = await deliverToWhisparr(
        deliveryConfig(fx.origin, DELIVERY),
        movieRef,
      );
      assert.equal(result.outcome, "failed");
      assert.ok(
        result.outcome === "failed" &&
          result.reason.includes("import-excluded"),
      );
      assert.equal(
        fx.log.some((r) => r.method === "POST"),
        false,
      );
    },
  );
});

test("rejected adds fail without already-exists guessing; uncertain adds re-resolve first", async () => {
  // Proven 400: absence after re-read fails; nothing is guessed.
  const rejected = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = pathOf(req.url ?? "");
    if (req.method === "POST" && p === "/api/v3/movie")
      return sendJson(res, 400, {});
    if (p === "/api/v3/movie") return sendJson(res, 200, []);
    if (p === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupMovie());
    sendJson(res, 404, {});
  };
  await withFixture(rejected, async (fx) => {
    const result = await deliverToWhisparr(
      deliveryConfig(fx.origin, DELIVERY),
      movieRef,
    );
    assert.equal(result.outcome, "failed");
    assert.ok(
      fx.log.filter((r) => r.method === "GET" && r.url.includes("tpdbId="))
        .length >= 2,
      "the identity is re-read before deciding",
    );
  });
  // Timeout-class 500 whose identity re-read finds the item: accepted.
  const recovered = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = pathOf(req.url ?? "");
    if (req.method === "POST" && p === "/api/v3/movie")
      return sendJson(res, 500, {});
    if (p === "/api/v3/movie") {
      // First adoption read: absent. Re-read after the failed submission:
      // present.
      recovered.reads += 1;
      return sendJson(res, 200, recovered.reads > 1 ? [storedMovie()] : []);
    }
    if (p === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupMovie());
    sendJson(res, 404, {});
  };
  recovered.reads = 0;
  await withFixture(recovered, async (fx) => {
    const result = await deliverToWhisparr(
      deliveryConfig(fx.origin, DELIVERY),
      movieRef,
    );
    assert.equal(result.outcome, "accepted");
  });
  // 500 whose re-read proves absence: failed.
  const absent = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = pathOf(req.url ?? "");
    if (req.method === "POST" && p === "/api/v3/movie")
      return sendJson(res, 500, {});
    if (p === "/api/v3/movie") return sendJson(res, 200, []);
    if (p === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupMovie());
    sendJson(res, 404, {});
  };
  await withFixture(absent, async (fx) => {
    const result = await deliverToWhisparr(
      deliveryConfig(fx.origin, DELIVERY),
      movieRef,
    );
    assert.equal(result.outcome, "failed");
  });
  // 500 whose re-read stays broken: uncertain, never fabricated.
  const opaque = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = pathOf(req.url ?? "");
    if (req.method === "POST" && p === "/api/v3/movie")
      return sendJson(res, 500, {});
    if (p === "/api/v3/movie") {
      // First adoption read succeeds; the re-read after the failed
      // submission stays broken, so the outcome stays unknown.
      opaque.reads += 1;
      if (opaque.reads === 1) return sendJson(res, 200, []);
    }
    if (p === "/api/v3/movie/lookup/tpdb")
      return sendJson(res, 200, lookupMovie());
    sendJson(res, 500, {});
  };
  opaque.reads = 0;
  await withFixture(opaque, async (fx) => {
    const result = await deliverToWhisparr(
      deliveryConfig(fx.origin, DELIVERY),
      movieRef,
    );
    assert.equal(result.outcome, "uncertain");
  });
});

// --- M3 Discover: per-user recently added in Jellyfin ---
// Disjoint block owned by M3Jellyfin. Same local 127.0.0.1 fixtures as the
// list path; the fixture hands back items in server DateCreated-descending
// order, exactly what the lab Jellyfin 12.0.0 returns for
// sortBy=DateCreated&sortOrder=Descending with parentId-only scoping
// (verified live: filters correctly when ids is absent, DateCreated present
// when requested in fields).

function datedItem(
  n: number,
  name: string,
  dateCreated: string,
): Record<string, unknown> {
  return { ...movieItem(n, name), DateCreated: dateCreated };
}

test("listRecentlyAddedItems orders by the server's recently-added ordering", async () => {
  // Server order (DateCreated desc) is Zulu > Mike > Alpha; SortName would
  // put Alpha first, so name order proves the requested ordering won.
  const items = [
    datedItem(0x331, "Zulu", "2026-09-03T10:00:00.000Z"),
    datedItem(0x332, "Mike", "2026-09-02T10:00:00.000Z"),
    datedItem(0x333, "Alpha", "2026-09-01T10:00:00.000Z"),
  ];
  await withFixture(itemsByParentHandler({ [LIB_A]: items }), async (fx) => {
    const result = await listRecentlyAddedItems(
      jellyfinConfig(fx.origin, [LIB_A]),
      TOKEN,
      account([LIB_A]),
      2,
    );
    assert.deepEqual(
      result.map((item) => item.name),
      ["Zulu", "Mike"],
    );
    const itemsCalls = fx.log.filter(
      (r) => r.method === "GET" && pathOf(r.url) === `/users/${ME_ID}/items`,
    );
    assert.equal(itemsCalls.length, 1);
    const query = queryOf(itemsCalls[0]?.url ?? "");
    assert.equal(query.get("sortBy"), "DateCreated");
    assert.equal(query.get("sortOrder"), "Descending");
    assert.equal(query.get("parentId"), LIB_A);
    assert.equal(query.get("limit"), "2");
    assert.equal(query.get("recursive"), "true");
    assert.equal(query.get("ids"), null);
  });
});

test("listRecentlyAddedItems restricts results to granted libraries", async () => {
  const byParent: Record<string, unknown[]> = {
    [LIB_A]: [datedItem(0x341, "Old A", "2026-09-01T10:00:00.000Z")],
    [LIB_B]: [
      datedItem(0x342, "New B", "2026-09-03T10:00:00.000Z"),
      datedItem(0x343, "Mid B", "2026-09-02T10:00:00.000Z"),
    ],
    [LIB_C]: [datedItem(0x344, "Never C", "2026-09-04T10:00:00.000Z")],
  };
  await withFixture(itemsByParentHandler(byParent), async (fx) => {
    // Configured A/B/C, granted A/B: C items exist upstream but must never
    // be queried, and A+B merge into one DateCreated-descending order.
    const result = await listRecentlyAddedItems(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B, LIB_C]),
      TOKEN,
      account([LIB_A, LIB_B]),
      5,
    );
    assert.deepEqual(
      result.map((item) => item.name),
      ["New B", "Mid B", "Old A"],
    );
    const queriedParents = fx.log
      .filter((r) => pathOf(r.url) === `/users/${ME_ID}/items`)
      .map((r) => queryOf(r.url).get("parentId"))
      .sort();
    assert.deepEqual(queriedParents, [LIB_A, LIB_B]);
  });
});

test("recently-added shelf with empty grants makes zero upstream calls", async () => {
  await withFixture(
    (req, res) => sendJson(res, 200, {}),
    async (fx) => {
      const result = await listRecentlyAddedItems(
        jellyfinConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([]),
        10,
      );
      assert.deepEqual(result, []);
      assert.equal(fx.log.length, 0);
    },
  );
});

test("recently-added shelf reports an upstream outage as an error, not an empty shelf", async () => {
  await withFixture(
    (req, res) => {
      if (pathOf(req.url ?? "") === "/users/me") return sendJson(res, 200, ME);
      sendJson(res, 500, {});
    },
    async (fx) => {
      await assert.rejects(
        listRecentlyAddedItems(
          jellyfinConfig(fx.origin, [LIB_A]),
          TOKEN,
          account([LIB_A]),
          10,
        ),
        appError(502, "upstream_unavailable"),
      );
    },
  );
});

test("recently-added items carry playability and watch links matching the list path", async () => {
  const playable = {
    ...movieItem(0x351, "Feature"),
    DateCreated: "2026-09-02T10:00:00.000Z",
    ProductionYear: 2024,
    Overview: "A lab feature.",
    RunTimeTicks: 6000000000,
    ImageTags: { Primary: "primary" },
    MediaSources: [{ Id: "ms1", SupportsDirectPlay: true }],
  };
  const inert = {
    ...movieItem(0x352, "Placeholder"),
    DateCreated: "2026-09-03T10:00:00.000Z",
    LocationType: "Virtual",
  };
  await withFixture(
    itemsByParentHandler({ [LIB_A]: [playable, inert] }),
    async (fx) => {
      const config = jellyfinConfig(fx.origin, [LIB_A]);
      const grants = account([LIB_A]);
      const shelf = await listRecentlyAddedItems(config, TOKEN, grants, 10);
      const page = await listLibraryItems(config, TOKEN, grants, {
        start: 0,
        limit: 24,
        search: "",
      });
      const byId = (items: { id: string }[]) =>
        [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // Identical mapping pipeline: same items, same playability, same links.
      assert.deepEqual(byId(shelf), byId(page.items));
      const feature = shelf.find((item) => item.name === "Feature");
      assert.ok(feature);
      assert.equal(feature.canPlay, true);
      assert.equal(
        feature.watchUrl,
        `${fx.origin}/jf/web/index.html#!/details?id=${feature.id}&serverId=${SERVER_ID}`,
      );
    },
  );
});

// --- M4 availability hardening: revalidation, multi-source, distinct
// --- outcomes, remote policy (hazard table rows 3, 4, 9, 10). Uses the M2
// --- availability fixtures above, unchanged.

const AV_MULTI = hexId(0x10a);
const AV_STUB = hexId(0x10b);

function avSource(
  size: number | undefined,
  playable: boolean,
): Record<string, unknown> {
  return {
    Id: `src-${size ?? "none"}-${playable}`,
    ...(size === undefined ? {} : { Size: size }),
    SupportsDirectPlay: playable,
    SupportsDirectStream: playable,
    SupportsTranscoding: playable,
  };
}

function avSourcesEntry(o: {
  id: string;
  name: string;
  providerId: string;
  sources: Record<string, unknown>[];
}): AvEntry {
  return {
    lib: LIB_A,
    item: {
      Id: dashed(o.id),
      Name: o.name,
      Type: "Movie",
      LocationType: "FileSystem",
      ProviderIds: { Tpdb: o.providerId },
      MediaSources: o.sources,
    },
  };
}

test("resolvePlaybackAccess revalidates a stale persisted path against the live item", async () => {
  await withFixture(avHandler({ entries: avEntries() }), async (fx) => {
    const cfg = avConfig(fx.origin, [LIB_A]);
    const grants = account([LIB_A]);
    // Persisted path points at a folder that no longer exists on any live
    // item, but the provider id still matches: the exact id match wins and
    // the stale path is never trusted.
    assert.equal(
      avItemId(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-movie-uuid",
          whisparrPath: "X:\\Media\\Movies\\Vanished Movie",
        }),
      ),
      AV_PID,
    );
    // Stale path, unknown provider id, title/year agrees with a live item:
    // similarity is ambiguous for review, never an available match.
    assert.deepEqual(
      await resolvePlaybackAccess(cfg, TOKEN, grants, {
        provider: "tpdb",
        kind: "movie",
        id: "tpdb-unknown-uuid",
        whisparrPath: "X:\\Media\\Movies\\Vanished Movie",
        title: "Path Movie",
        year: 2020,
      }),
      {
        outcome: "ambiguous",
        reason: "Title/year similarity only; administrator review required.",
      },
    );
    // Stale path with no other signal: proven absent, not available.
    assert.deepEqual(
      await resolvePlaybackAccess(cfg, TOKEN, grants, {
        provider: "tpdb",
        kind: "movie",
        id: "tpdb-unknown-uuid",
        whisparrPath: "X:\\Media\\Movies\\Vanished Movie",
      }),
      { outcome: "missing" },
    );
  });
  // The edition's file was renamed under a folder that still holds two
  // editions: the persisted file-level path no longer matches anything, and
  // title agreement alone stays ambiguous.
  const renamed = avEntries();
  const editionA = renamed.find((e) => e.item.Id === dashed(AV_ED1));
  assert.ok(editionA);
  editionA.item = {
    ...editionA.item,
    Path: "C:\\media\\movies\\Edition Split\\Edition C.mkv",
    MediaSources: [
      {
        Id: "src1",
        Path: "C:\\media\\movies\\Edition Split\\Edition C.mkv",
        Size: 21_000,
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
      },
    ],
  };
  await withFixture(avHandler({ entries: renamed }), async (fx) => {
    assert.deepEqual(
      await resolvePlaybackAccess(
        avConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-unknown-uuid",
          whisparrPath: "X:\\Media\\Movies\\Edition Split\\Edition A.mkv",
          title: "Edition Split",
          year: 2019,
        },
      ),
      {
        outcome: "ambiguous",
        reason: "Title/year similarity only; administrator review required.",
      },
    );
  });
});

test("resolvePlaybackAccess judges every source and denies placeholder-only items", async () => {
  await withFixture(
    avHandler({
      entries: [
        avSourcesEntry({
          id: AV_MULTI,
          name: "Multi Source Movie",
          providerId: "tpdb-multi-uuid",
          sources: [avSource(0, true), avSource(21_000, true)],
        }),
        avSourcesEntry({
          id: AV_STUB,
          name: "Stub Source Movie",
          providerId: "tpdb-stub-uuid",
          sources: [
            avSource(0, true),
            avSource(undefined, true),
            avSource(21_000, false),
          ],
        }),
      ],
      playback: {
        [AV_MULTI]: [avSource(0, true), avSource(21_000, true)],
        [AV_STUB]: [
          avSource(0, true),
          avSource(undefined, true),
          avSource(21_000, false),
        ],
      },
    }),
    async (fx) => {
      const cfg = avConfig(fx.origin, [LIB_A]);
      const grants = account([LIB_A]);
      // Several sources, one genuinely playable: available. Never decided by
      // the first source alone.
      assert.equal(
        (
          await resolvePlaybackAccess(cfg, TOKEN, grants, {
            provider: "tpdb",
            kind: "movie",
            id: "tpdb-multi-uuid",
          })
        ).outcome,
        "available",
      );
      // Only zero-length, size-less, and undeliverable sources: denied,
      // never available on the strength of the first entry.
      assert.deepEqual(
        await resolvePlaybackAccess(cfg, TOKEN, grants, {
          provider: "tpdb",
          kind: "movie",
          id: "tpdb-stub-uuid",
        }),
        {
          outcome: "denied",
          reason: "No playable media source (file missing or empty).",
        },
      );
    },
  );
  // The media source vanished upstream: PlaybackInfo reports none, so the
  // exact match can no longer produce a stale 'available'.
  await withFixture(
    avHandler({
      entries: [
        avSourcesEntry({
          id: AV_MULTI,
          name: "Multi Source Movie",
          providerId: "tpdb-multi-uuid",
          sources: [avSource(21_000, true)],
        }),
      ],
      playback: { [AV_MULTI]: [] },
    }),
    async (fx) => {
      assert.deepEqual(
        await resolvePlaybackAccess(
          avConfig(fx.origin, [LIB_A]),
          TOKEN,
          account([LIB_A]),
          { provider: "tpdb", kind: "movie", id: "tpdb-multi-uuid" },
        ),
        {
          outcome: "denied",
          reason: "No playable media source (file missing or empty).",
        },
      );
    },
  );
});

test("resolvePlaybackAccess denies remote-restricted and disabled accounts", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { ...ME.Policy, EnableRemoteAccess: false },
      "Remote access is disabled for this Jellyfin user.",
    ],
    // Conservative: a missing remote-access policy never grants playback.
    [
      { IsAdministrator: false, IsDisabled: false, EnableMediaPlayback: true },
      "Remote access is disabled for this Jellyfin user.",
    ],
    [{ ...ME.Policy, IsDisabled: true }, "This Jellyfin account is disabled."],
  ];
  for (const [policy, reason] of cases) {
    await withFixture(
      avHandler({
        entries: avEntries(),
        me: { ...ME, Policy: policy },
      }),
      async (fx) => {
        assert.deepEqual(
          await resolvePlaybackAccess(
            avConfig(fx.origin, [LIB_A]),
            TOKEN,
            account([LIB_A]),
            { provider: "tpdb", kind: "movie", id: "tpdb-movie-uuid" },
          ),
          { outcome: "denied", reason },
        );
      },
    );
  }
});

test("resolvePlaybackAccess keeps proven rejections, outages, and auth deaths distinct", async () => {
  // Ancestors outage on an exactly matched item: 'unavailable', never
  // folded into 'denied' or 'missing'.
  await withFixture(
    avHandler({ entries: avEntries(), ancestorsStatus: 500 }),
    async (fx) => {
      const verdict = await resolvePlaybackAccess(
        avConfig(fx.origin, [LIB_A]),
        TOKEN,
        account([LIB_A]),
        { provider: "tpdb", kind: "movie", id: "tpdb-movie-uuid" },
      );
      assert.equal(verdict.outcome, "unavailable");
      if (verdict.outcome !== "unavailable") return assert.fail("unreachable");
      assert.ok(verdict.reason !== undefined && verdict.reason.length > 0);
    },
  );
  // PlaybackInfo outage on an exactly matched item: also 'unavailable'.
  await withFixture(
    avHandler({ entries: avEntries(), playbackStatus: 500 }),
    async (fx) => {
      assert.equal(
        (
          await resolvePlaybackAccess(
            avConfig(fx.origin, [LIB_A]),
            TOKEN,
            account([LIB_A]),
            { provider: "tpdb", kind: "movie", id: "tpdb-movie-uuid" },
          )
        ).outcome,
        "unavailable",
      );
    },
  );
  // Token revoked after identity resolution: the caller-visible 401
  // propagates as an auth rejection, never as missing or unavailable.
  await withFixture(
    avHandler({ entries: avEntries(), ancestorsStatus: 401 }),
    async (fx) => {
      await assert.rejects(
        resolvePlaybackAccess(
          avConfig(fx.origin, [LIB_A]),
          TOKEN,
          account([LIB_A]),
          { provider: "tpdb", kind: "movie", id: "tpdb-movie-uuid" },
        ),
        appError(401, "upstream_auth"),
      );
    },
  );
});
