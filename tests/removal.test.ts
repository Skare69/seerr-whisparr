// M7 removal tests: Jellyfin user-token-only item deletion against isolated
// 127.0.0.1 HTTP fixtures. No real network, no real credentials, no real
// media touched — every request stays on loopback. Proves: the delete runs
// under the requester's own token and never the integration API key, a user
// whose policy lacks EnableContentDeletion is denied before any DELETE,
// ungranted-library items are refused before any DELETE, a proven 404 is
// success, a proven 401/403 is denial, and 5xx/timeout are uncertain.

import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { deleteLibraryItem } from "../src/server/jellyfin.ts";
import { AppError } from "../src/server/http.ts";
import type { Account, IntegrationConfig } from "../src/lib/contracts.ts";

// --- fixture constants and helpers (mirrors integrations.test.ts) ---

const SERVER_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const ME_ID = "b".repeat(32);
const USER_TOKEN = "u".repeat(32);
const ADMIN_KEY = "a".repeat(32);
const LIB_A = "aa11".repeat(8);
const LIB_B = "bb22".repeat(8);
const LIB_C = "cc33".repeat(8);
const ITEM_ID = "d".repeat(32);

const ME_CAN_DELETE = {
  Id: ME_ID,
  Name: "bob",
  Policy: {
    IsAdministrator: false,
    IsDisabled: false,
    EnableRemoteAccess: true,
    EnableMediaPlayback: true,
    EnableContentDeletion: true,
  },
};

const ME_NO_DELETE = {
  ...ME_CAN_DELETE,
  Policy: { ...ME_CAN_DELETE.Policy, EnableContentDeletion: false },
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

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function pathOf(url: string): string {
  return (url.split("?")[0] ?? "").toLowerCase();
}

function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
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

function account(libraryIds: string[]): Account {
  return {
    id: "acct-1",
    name: "bob",
    role: "requester",
    enabled: true,
    libraryIds,
    isOwner: false,
    autoApprove: false,
    canRemove: false,
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

// Standard removal fixture: /Users/Me identity, ids-scoped item visibility
// (the lab build ignores parentId alongside ids), the ancestor chain placing
// the item in LIB_B, and a DELETE route with scripted status.
function removalHandler(opts: {
  me?: Record<string, unknown>;
  ancestors?: unknown[];
  deleteStatus?: number;
  deleteDelayMs?: number;
}): FixtureHandler {
  return (req, res) => {
    const url = req.url ?? "";
    const path = pathOf(url);
    if (path === "/users/me") {
      return sendJson(res, 200, opts.me ?? ME_CAN_DELETE);
    }
    if (path === `/users/${ME_ID}/items`) {
      const found = queryOf(url).get("ids") === ITEM_ID;
      return sendJson(res, 200, {
        Items: found
          ? [
              {
                Id: dashed(ITEM_ID),
                Name: "Lab Movie",
                Type: "Movie",
                LocationType: "FileSystem",
                Path: "/mnt/lab/movie.mkv",
                MediaSources: [
                  { Id: "ms1", Path: "/mnt/lab/movie.mkv", Size: 1500 },
                  { Id: "ms2", Path: "/mnt/lab/extra.mkv", Size: 500 },
                ],
              },
            ]
          : [],
        TotalRecordCount: found ? 1 : 0,
      });
    }
    if (path === `/items/${ITEM_ID}/ancestors`) {
      return sendJson(
        res,
        200,
        opts.ancestors ?? [
          { Id: dashed(LIB_A), Name: "Root", Type: "Folder" },
          { Id: dashed(LIB_B), Name: "Movies", Type: "CollectionFolder" },
        ],
      );
    }
    if (path === `/items/${ITEM_ID}` && req.method === "DELETE") {
      const status = opts.deleteStatus ?? 204;
      // Real wall-clock delay is the only way to exercise the transport's
      // own AbortController deadline; fake timers cannot stall a socket.
      if (opts.deleteDelayMs) {
        setTimeout(() => sendJson(res, status, {}), opts.deleteDelayMs);
        return;
      }
      return sendJson(res, status, {});
    }
    sendJson(res, 404, {});
  };
}

// The admin key must never travel in ANY request this code makes, under any
// header name or encoding.
function assertNoAdminKey(fx: Fixture): void {
  for (const r of fx.log) {
    const serialized = JSON.stringify(r.headers).toLowerCase();
    assert.equal(
      serialized.includes(ADMIN_KEY),
      false,
      `admin key leaked in request ${r.method} ${r.url}: ${serialized}`,
    );
    assert.equal(r.headers["x-api-key"], undefined);
  }
}

function deleteRequests(fx: Fixture): RecordedRequest[] {
  return fx.log.filter(
    (r) => r.method === "DELETE" && pathOf(r.url) === `/items/${ITEM_ID}`,
  );
}

// --- happy path: delete under the requester's own token ---

test("deleteLibraryItem deletes under the user token and returns audit facts", async () => {
  await withFixture(removalHandler({}), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_B]),
      { token: USER_TOKEN },
      account([LIB_B]),
      ITEM_ID,
    );
    assert.deepEqual(outcome, {
      status: "removed",
      facts: {
        itemId: ITEM_ID,
        name: "Lab Movie",
        libraryId: LIB_B,
        libraryName: "Movies",
        paths: ["/mnt/lab/movie.mkv", "/mnt/lab/extra.mkv"],
        size: 2000,
      },
      watchLinkInvalid: true,
    });
    // Exactly one DELETE, authenticated ONLY by the requester's own token in
    // the MediaBrowser authorization header.
    const deletes = deleteRequests(fx);
    assert.equal(deletes.length, 1);
    const auth = deletes[0]!.headers.authorization ?? "";
    assert.match(auth, /^MediaBrowser Client="Velvarr"/);
    assert.ok(auth.includes(`Token="${USER_TOKEN}"`));
    assert.equal(deletes[0]!.headers["x-api-key"], undefined);
    assertNoAdminKey(fx);
  });
});

// --- policy denial before any DELETE ---

test("deleteLibraryItem names the missing EnableContentDeletion and never deletes", async () => {
  await withFixture(removalHandler({ me: ME_NO_DELETE }), async (fx) => {
    await assert.rejects(
      deleteLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
        { token: USER_TOKEN },
        account([LIB_A, LIB_B]),
        ITEM_ID,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 403);
        assert.equal(err.code, "deletion_forbidden");
        assert.match(err.message, /EnableContentDeletion/);
        return true;
      },
    );
    assert.equal(deleteRequests(fx).length, 0);
    assertNoAdminKey(fx);
  });
});

// --- grant scope enforced before any DELETE ---

test("deleteLibraryItem refuses items outside granted libraries before deleting", async () => {
  await withFixture(
    removalHandler({ ancestors: [{ Id: dashed(LIB_C), Name: "Other" }] }),
    async (fx) => {
      await assert.rejects(
        deleteLibraryItem(
          jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
          { token: USER_TOKEN },
          account([LIB_A, LIB_B]),
          ITEM_ID,
        ),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 404);
          assert.equal(err.code, "item_not_found");
          return true;
        },
      );
      assert.equal(deleteRequests(fx).length, 0);
      assertNoAdminKey(fx);
    },
  );
});

test("deleteLibraryItem denies empty grants with zero upstream calls", async () => {
  await withFixture(removalHandler({}), async (fx) => {
    await assert.rejects(
      deleteLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A]),
        { token: USER_TOKEN },
        account([]),
        ITEM_ID,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "item_not_found");
        return true;
      },
    );
    assert.equal(fx.log.length, 0);
  });
});

// --- outcome semantics ---

test("deleteLibraryItem treats a proven 404 as already-gone success", async () => {
  await withFixture(removalHandler({ deleteStatus: 404 }), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      { token: USER_TOKEN },
      account([LIB_A, LIB_B]),
      ITEM_ID,
    );
    assert.ok(outcome.status === "already_gone");
    assert.equal(outcome.watchLinkInvalid, true);
    assertNoAdminKey(fx);
  });
});

test("deleteLibraryItem reports a proven 401/403 as denial", async () => {
  for (const status of [401, 403]) {
    await withFixture(removalHandler({ deleteStatus: status }), async (fx) => {
      const outcome = await deleteLibraryItem(
        jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
        { token: USER_TOKEN },
        account([LIB_A, LIB_B]),
        ITEM_ID,
      );
      assert.equal(outcome.status, "denied");
      assert.ok(outcome.reason.length > 0);
      assertNoAdminKey(fx);
    });
  }
});

test("deleteLibraryItem reports a 5xx as uncertain", async () => {
  await withFixture(removalHandler({ deleteStatus: 500 }), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      { token: USER_TOKEN },
      account([LIB_A, LIB_B]),
      ITEM_ID,
    );
    assert.equal(outcome.status, "uncertain");
    assertNoAdminKey(fx);
  });
});

test("deleteLibraryItem reports a timeout as uncertain", async () => {
  await withFixture(removalHandler({ deleteDelayMs: 5_000 }), async (fx) => {
    const outcome = await deleteLibraryItem(
      jellyfinConfig(fx.origin, [LIB_A, LIB_B]),
      { token: USER_TOKEN },
      account([LIB_A, LIB_B]),
      ITEM_ID,
      50,
    );
    assert.equal(outcome.status, "uncertain");
    assertNoAdminKey(fx);
  });
});
