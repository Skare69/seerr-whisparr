// Acquisition worker tests: durable delivery/reconciliation loop against a
// local HTTP Whisparr fixture and a temp SQLite data dir. No real Whisparr,
// no external network — every write lands on the fixture server only.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Account,
  AcquisitionRecord,
  ExternalUser,
  IntegrationConfig,
  MediaReference,
} from "../src/lib/contracts.ts";
// Imported after env setup because storage reads VELVARR_* at open time —
// the same module-load boundary storage.test.ts exercises.
process.env.VELVARR_SECRET_KEY = "33".repeat(32);
// storage opens lazily but reads VELVARR_DATA_DIR at each open: pin even the
// pre-freshDb window to a throwaway dir so no code path can fall back to the
// repo's ./data default while tests run in parallel with other files.
const bootDir = mkdtempSync(join(tmpdir(), "velvarr-acq-boot-"));
process.env.VELVARR_DATA_DIR = bootDir;

const storage = await import("../src/server/storage.ts");
const acquisition = await import("../src/server/acquisition.ts");

// --- fixture Whisparr -------------------------------------------------

const KEY = "fixture-key";
const EXT_A = "0f0f0f0f-1111-4222-8333-444455556666";
const EXT_B = "11111111-2222-4333-8444-555566667777";
const EXT_C = "22222222-3333-4777-8888-9999aaaabbbb";
const MOVIE_A: MediaReference = { provider: "tpdb", kind: "movie", id: EXT_A };
const MOVIE_B: MediaReference = { provider: "tpdb", kind: "movie", id: EXT_B };
const MOVIE_C: MediaReference = { provider: "tpdb", kind: "movie", id: EXT_C };

let knobs = {
  hasFile: false,
  inQueue: false,
  lookupOk: true,
  downAll: false,
  addStatus: 201,
  failFindAfterAdd: false,
  failFindOnce: 0,
  holdAdd: null as Promise<void> | null,
};
let storedItems = new Map<string, number>();
let nextId = 1;
let calls: { method: string; path: string }[] = [];
let onAdd: (() => void) | null = null;

function dtoFor(ext: string, id: number) {
  return {
    id,
    itemType: "movie",
    title: "Fixture Movie",
    monitored: true,
    hasFile: knobs.hasFile && ext === EXT_A,
    path: `/data/whisparr/${ext.slice(0, 8)}`,
    foreignId: `tpdbId:${ext}`,
    tmdbId: 0,
    tpdbId: ext,
    sizeOnDisk: 0,
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = req.url ?? "";
  calls.push({ method: req.method ?? "", path });
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers["x-api-key"] !== KEY)
    return json(401, { message: "bad key" });
  if (knobs.downAll) return json(503, { message: "down" });
  if (req.method === "GET" && path.startsWith("/api/v3/movie?")) {
    if (knobs.failFindOnce > 0) {
      knobs.failFindOnce--;
      return json(503, { message: "find down" });
    }
    return json(
      200,
      [...storedItems].map(([ext, id]) => dtoFor(ext, id)),
    );
  }
  if (req.method === "GET" && path.startsWith("/api/v3/movie/lookup/")) {
    if (!knobs.lookupOk) return json(200, []);
    const m = /[?&]tpdbId=([0-9a-f-]+)/.exec(path);
    return json(200, m ? [dtoFor(m[1]!, 0)] : []);
  }
  if (req.method === "GET" && path.startsWith("/api/v3/queue")) {
    return json(200, { records: knobs.inQueue ? [{ movieId: 1 }] : [] });
  }
  if (req.method === "POST" && path === "/api/v3/movie") {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw) as { tpdbId?: string };
    const ext = payload.tpdbId ?? EXT_A;
    const wid = nextId++;
    if (knobs.failFindAfterAdd) knobs.failFindOnce = 1;
    if (knobs.addStatus < 400) storedItems.set(ext, wid);
    onAdd?.();
    onAdd = null;
    if (knobs.holdAdd) await knobs.holdAdd;
    json(
      knobs.addStatus,
      knobs.addStatus < 400 ? dtoFor(ext, wid) : { message: "rejected" },
    );
    return;
  }
  json(404, { message: "not found" });
}

const server: Server = createServer((req, res) => {
  void handle(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const FIXTURE_URL = `http://127.0.0.1:${
  (server.address() as AddressInfo).port
}`;

// --- storage setup ----------------------------------------------------

const OWNER: ExternalUser = {
  id: "a".repeat(32),
  name: "Owner",
  isDisabled: false,
  enableRemoteAccess: true,
  enableMediaPlayback: true,
  isAdministrator: true,
};
const FRIEND_ID = "b".repeat(32);
const LOSER_ID = "c".repeat(32);

let dir = "";
let probeDb: DatabaseSync | null = null;

function freshDb(): void {
  acquisition.stopAcquisitionLoop();
  storage.closeStorage();
  probeDb?.close();
  probeDb = null;
  if (dir)
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  dir = mkdtempSync(join(tmpdir(), "velvarr-acquisition-"));
  process.env.VELVARR_DATA_DIR = dir;
  knobs = {
    hasFile: false,
    inQueue: false,
    lookupOk: true,
    downAll: false,
    addStatus: 201,
    failFindAfterAdd: false,
    failFindOnce: 0,
    holdAdd: null,
  };
  storedItems = new Map();
  nextId = 1;
  calls = [];
  onAdd = null;
}

function config(delivery: boolean): IntegrationConfig {
  return {
    jellyfin: {
      url: "http://127.0.0.1:8096/jellyfin",
      externalUrl: "https://media.example.org/jellyfin",
      apiKey: "jf-key",
      serverId: "0123456789abcdef0123456789abcdef",
      libraryIds: [],
    },
    whisparr: {
      url: FIXTURE_URL,
      apiKey: KEY,
      ...(delivery
        ? {
            delivery: {
              enabled: true,
              rootFolderPath: "/data/whisparr",
              qualityProfileId: 1,
              searchOnAdd: true,
            },
          }
        : {}),
    },
  };
}

function boot(): Account {
  freshDb();
  storage.bootstrap(config(true), OWNER, "jf-owner-token");
  storage.importAccounts([
    { ...OWNER, id: FRIEND_ID, name: "Friend", isAdministrator: false },
    { ...OWNER, id: LOSER_ID, name: "Loser", isAdministrator: false },
  ]);
  admit(FRIEND_ID);
  admit(LOSER_ID);
  return storage.getAccount(OWNER.id) as Account;
}

function admit(id: string): Account {
  return storage.updateAccount(id, {
    enabled: true,
    role: "requester",
    libraryIds: [],
  });
}

function approve(accountId: string, media: MediaReference): void {
  const owner = storage.getAccount(OWNER.id) as Account;
  storage.decideRequest(
    owner,
    storage.createRequest(accountId, media).id,
    "approved",
  );
}

const later = (): number => Date.now() + 61_000;

function workId(media: MediaReference): string {
  const found = storage
    .listDueAcquisitions(later(), 100)
    .find((a) => a.media.id === media.id);
  assert.ok(found, `no due acquisition for ${media.id}`);
  return found.id;
}

function probe(id: string): AcquisitionRecord {
  const { record, claimToken } = storage.claimAcquisition(id);
  storage.releaseAcquisitionClaim(id, claimToken);
  return record;
}

function postCount(): number {
  return calls.filter((c) => c.method === "POST").length;
}

/** Raw row read straight from SQLite, usable from inside the fixture's POST
 * handler to observe what the worker had already persisted. */
function rawState(id: string): { state: string; attempt: number } {
  probeDb ??= new DatabaseSync(join(dir, "velvarr.sqlite"));
  return probeDb
    .prepare(
      "SELECT state, attempt_token IS NOT NULL AS attempt FROM acquisitions WHERE id = ?",
    )
    .get(id) as { state: string; attempt: number };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

after(() => {
  acquisition.stopAcquisitionLoop();
  storage.closeStorage();
  probeDb?.close();
  server.close();
  if (dir)
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  rmSync(bootDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});

// --- tests ------------------------------------------------------------

test("attempt is persisted before the POST and a fresh add lands", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  onAdd = () => {
    const row = rawState(id);
    assert.equal(
      row.state,
      "submitting",
      "attempt must be durable at POST time",
    );
    assert.equal(row.attempt, 1, "attempt token persisted before the POST");
  };
  const summary = await acquisition.runDueWork();
  assert.equal(summary.delivered, 1);
  assert.equal(summary.errors, 0);
  assert.equal(postCount(), 1);

  // Reads preceded the write: adoption lookup, then the add.
  const post = calls.findIndex((c) => c.method === "POST");
  assert.ok(
    calls.slice(0, post).some((c) => c.path.startsWith("/api/v3/movie?")),
  );

  const rec = probe(id);
  assert.equal(rec.state, "monitoring");
  assert.ok(rec.submittedAt);
  // Stored item facts persisted with the delivery, not a pass later.
  assert.equal(rec.whisparrId, 1);
  assert.equal(rec.whisparrPath, "/data/whisparr/0f0f0f0f");
  assert.equal(rec.whisparrTitle, "Fixture Movie");
});

test("adoption takes over an existing identity without a duplicate add", async () => {
  const owner = boot();
  storedItems.set(EXT_A, 1);
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  const summary = await acquisition.runDueWork();
  assert.equal(summary.adopted, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(postCount(), 0, "adoption never POSTs");

  const rec = probe(id);
  assert.equal(rec.state, "monitoring");
  assert.equal(rec.whisparrId, 1);
});

test("uncertain outcome is reconciled by identity without a second POST", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  // Add accepted upstream but the POST errors and the immediate re-read
  // fails too: the worker must record uncertainty, not retry blind.
  knobs.addStatus = 500;
  knobs.failFindAfterAdd = true;
  const first = await acquisition.runDueWork();
  assert.equal(first.uncertain, 1);
  assert.equal(postCount(), 1);
  const uncertain = probe(id);
  assert.equal(uncertain.state, "uncertain");
  assert.ok(uncertain.lastError);

  // The identity actually landed upstream. Reconciliation must find it by
  // exact identity and never re-POST.
  storedItems.set(EXT_A, 1);
  const second = await acquisition.runDueWork();
  assert.equal(second.reconciled, 1);
  assert.equal(postCount(), 1, "reconciliation is read-only");

  const rec = probe(id);
  assert.equal(rec.state, "monitoring");
  assert.equal(rec.lastError, null);
  assert.equal(rec.whisparrId, 1);
  assert.equal(rec.whisparrPath, "/data/whisparr/0f0f0f0f");
});

test("a rejected add is failed once and never blind-retried", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  // Proven 400 with proven absence: a failure, never "already exists".
  knobs.addStatus = 400;
  const first = await acquisition.runDueWork();
  assert.equal(first.failed, 1);
  assert.equal(postCount(), 1);
  assert.equal(probe(id).state, "failed");

  // A later pass observes; it does not re-POST the rejected add.
  const second = await acquisition.runDueWork(later());
  assert.equal(second.delivered, 0);
  assert.equal(second.unavailable, 1);
  assert.equal(postCount(), 1, "no blind retry of a failed add");
  assert.equal(probe(id).state, "failed");
});

test("observations track monitoring, downloading, and imported", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);
  await acquisition.runDueWork();
  assert.equal(postCount(), 1);

  const observed = await acquisition.runDueWork(later());
  assert.equal(observed.observed, 1);
  assert.equal(probe(id).state, "monitoring");

  knobs.inQueue = true;
  await acquisition.runDueWork(later());
  assert.equal(probe(id).state, "downloading");

  knobs.hasFile = true;
  await acquisition.runDueWork(later());
  assert.equal(probe(id).state, "imported");
  // Imported is terminal: no longer schedulable.
  assert.equal(
    storage.listDueAcquisitions(later(), 100).some((a) => a.id === id),
    false,
  );
});

test("an outage records a failed check without touching recorded state", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);
  await acquisition.runDueWork();
  const before = probe(id);
  assert.ok(before.lastObservedAt);

  knobs.downAll = true;
  const summary = await acquisition.runDueWork(later());
  assert.equal(summary.unavailable, 1);
  const during = probe(id);
  assert.equal(during.state, "monitoring", "outage never rewrites state");
  assert.equal(
    during.lastObservedAt,
    before.lastObservedAt,
    "outage never overwrites the last successful observation",
  );
  assert.ok(during.lastError);

  knobs.downAll = false;
  await acquisition.runDueWork(later());
  const healed = probe(id);
  assert.equal(healed.state, "monitoring");
  assert.equal(healed.lastError, null);
  assert.ok(healed.lastObservedAt);
});

test("a revoked requester blocks dispatch; an eligible one proceeds", async () => {
  boot();
  approve(FRIEND_ID, MOVIE_A);
  approve(LOSER_ID, MOVIE_A);
  approve(LOSER_ID, MOVIE_B);
  assert.equal(storage.listDueAcquisitions(later(), 100).length, 2);

  storage.updateAccount(LOSER_ID, {
    enabled: false,
    role: "requester",
    libraryIds: [],
  });
  const summary = await acquisition.runDueWork();
  assert.equal(summary.delivered, 1, "eligible requester's approval proceeds");
  assert.equal(summary.blocked, 1, "revoked-only work does not dispatch");
  assert.equal(postCount(), 1);
  const blocked = probe(workId(MOVIE_B));
  assert.equal(blocked.state, "unsent");
  assert.ok(blocked.lastError?.includes("eligible requester"));

  storage.updateAccount(LOSER_ID, {
    enabled: true,
    role: "requester",
    libraryIds: [],
  });
  const healed = await acquisition.runDueWork(later());
  assert.equal(healed.delivered, 1, "re-admitted requester unblocks the work");
  assert.equal(postCount(), 2);
});

test("delivery disabled stays honestly blocked, then resumes when enabled", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  storage.saveConfig(config(false));
  const summary = await acquisition.runDueWork();
  assert.equal(summary.blocked, 1);
  assert.equal(summary.considered, 1);
  assert.equal(postCount(), 0, "disabled delivery never calls Whisparr");
  const blocked = probe(id);
  assert.equal(blocked.state, "unsent");
  assert.ok(blocked.lastError?.includes("delivery"));

  storage.saveConfig(config(true));
  const resumed = await acquisition.runDueWork(later());
  assert.equal(resumed.delivered, 1);
  assert.equal(postCount(), 1);
});

test("no configuration at all performs zero external calls, state untouched", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  // Remove the config row entirely: getConfig() now returns null.
  probeDb ??= new DatabaseSync(join(dir, "velvarr.sqlite"));
  probeDb.prepare("DELETE FROM config").run();

  const before = probe(id);
  const summary = await acquisition.runDueWork();
  assert.equal(summary.blocked, 1);
  assert.equal(calls.length, 0, "unconfigured pass never touches Whisparr");
  const afterRow = probe(id);
  assert.equal(afterRow.state, before.state, "state untouched");
  assert.equal(afterRow.lastError?.includes("unconfigured"), true);
});

test("claim contention skips the item instead of double-sending", async () => {
  boot();
  approve(OWNER.id, MOVIE_A);
  approve(OWNER.id, MOVIE_B);
  const idA = workId(MOVIE_A);
  const idB = workId(MOVIE_B);

  // Deterministic dispatch order: due_at ties break by random UUID id, so
  // pin A as strictly the oldest due work. The first POST is always A's,
  // and the simulated concurrent claim of B lands while the worker has not
  // reached B — never against the worker's own live claim.
  probeDb ??= new DatabaseSync(join(dir, "velvarr.sqlite"));
  probeDb
    .prepare("UPDATE acquisitions SET due_at = due_at - 1000 WHERE id = ?")
    .run(idA);

  // A concurrent worker claims B the moment A's add is in flight. The
  // claim is taken once and its token kept, so a late second add can never
  // re-claim or throw inside the fixture handler.
  const concurrent: { claimToken: string | null } = { claimToken: null };
  onAdd = () => {
    if (concurrent.claimToken === null) {
      concurrent.claimToken = storage.claimAcquisition(idB).claimToken;
    }
  };
  const summary = await acquisition.runDueWork();
  assert.equal(summary.contention, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(postCount(), 1, "contended work is not double-sent");
  assert.equal(probe(idA).state, "monitoring");
  // B was skipped untouched and is still held by the concurrent worker.
  assert.throws(
    () => storage.claimAcquisition(idB),
    (e: { code: string }) => e.code === "already_claimed",
  );
  if (concurrent.claimToken !== null) {
    storage.releaseAcquisitionClaim(idB, concurrent.claimToken);
  }
});

test("passes never overlap and the loop start/stop is exact", async (t) => {
  const owner = boot();
  approve(owner.id, MOVIE_A);

  // Hold the first POST open while a second pass is requested.
  const { promise, resolve } = Promise.withResolvers<void>();
  knobs.holdAdd = promise;
  const first = acquisition.runDueWork();
  const second = await acquisition.runDueWork();
  assert.equal(second.overlap, true, "overlapped pass is skipped, not queued");
  assert.equal(second.considered, 0);
  resolve();
  const done = await first;
  assert.equal(done.delivered, 1);
  assert.equal(postCount(), 1);

  // Periodic loop: one pass per tick, start is idempotent, stop is final.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  approve(owner.id, MOVIE_C);
  acquisition.startAcquisitionLoop();
  acquisition.startAcquisitionLoop();
  await t.mock.timers.tick(10_000);
  await until(() => postCount() === 2);
  assert.equal(
    postCount(),
    2,
    "loop ran exactly one pass despite double start",
  );

  acquisition.stopAcquisitionLoop();
  acquisition.stopAcquisitionLoop();
  await t.mock.timers.tick(300_000);
  await until(() => false);
  assert.equal(postCount(), 2, "stopped loop never passes again");
});
