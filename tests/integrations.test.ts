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
      const query = queryOf(url);
      const found =
        query.get("ids") === ITEM_ID && query.get("parentId") === LIB_B;
      return sendJson(res, 200, {
        Items: found ? [ITEM_DTO] : [],
        TotalRecordCount: found ? 1 : 0,
      });
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
    // PlaybackInfo ran under the caller's own user token.
    assert.ok((playbackAuth() ?? "").includes(`Token="${TOKEN}"`));
    // No upstream Paths leak, and ungranted LIB_C was never queried.
    assert.equal(JSON.stringify(item).includes("/mnt/secret"), false);
    assert.equal(
      fx.log.some((r) => queryOf(r.url).get("parentId") === LIB_C),
      false,
    );
  });
});

test("getLibraryItem denies items that live outside granted libraries", async () => {
  const { handler } = membershipHandler();
  await withFixture(handler, async (fx) => {
    // Upstream keeps the item in LIB_B, but grants cover LIB_A only: the
    // proof query never touches LIB_B, so the item stays unreachable.
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
  });
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
        const query = queryOf(req.url ?? "");
        const found =
          query.get("ids") === ITEM_ID && query.get("parentId") === LIB_A;
        return sendJson(res, 200, {
          Items: found ? [ITEM_DTO] : [],
          TotalRecordCount: found ? 1 : 0,
        });
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
        const query = queryOf(req.url ?? "");
        const member =
          query.get("ids") === ITEM_ID && query.get("parentId") === LIB_A;
        return sendJson(res, 200, {
          Items: member ? [ITEM_DTO] : [],
          TotalRecordCount: member ? 1 : 0,
        });
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
