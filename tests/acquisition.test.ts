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
// No top-level side effects: hoisting this above the env setup is safe.
import { register } from "../src/instrumentation.ts";
import type {
  Account,
  AcquisitionRecord,
  ExternalUser,
  IntegrationConfig,
  MediaReference,
  RemovalLevel,
} from "../src/lib/contracts.ts";
// Imported after env setup because storage reads VELVARR_* at open time —
// the same module-load boundary storage.test.ts exercises.
process.env.VELVARR_SECRET_KEY = "33".repeat(32);
// The removal ladder runs its destructive paths only against this file's
// loopback fixture; the flag gates the storage APIs the tests use.
process.env.VELVARR_ENABLE_REMOVAL = "1";
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
  added: null as string | null,
  mutateStatus: 200,
  holdDelete: null as Promise<void> | null,
  pathOverride: null as string | null,
};
let onAdd: (() => void) | null = null;
let onDelete: (() => void) | null = null;
let storedItems = new Map<string, number>();
let nextId = 1;
let calls: { method: string; path: string }[] = [];

function dtoFor(ext: string, id: number) {
  return {
    id,
    itemType: "movie",
    title: "Fixture Movie",
    monitored: true,
    hasFile: knobs.hasFile && ext === EXT_A,
    path: knobs.pathOverride ?? `/data/whisparr/${ext.slice(0, 8)}`,
    foreignId: `tpdbId:${ext}`,
    sizeOnDisk: 0,
    ...(knobs.added ? { added: knobs.added } : {}),
    tpdbId: ext,
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
  if (
    (req.method === "DELETE" || req.method === "PUT") &&
    /^\/api\/v3\/movie\/\d+/.test(path)
  ) {
    if (knobs.mutateStatus !== 200) {
      return json(knobs.mutateStatus, { message: "mutate rejected" });
    }
    const wid = Number(/\/api\/v3\/movie\/(\d+)/.exec(path)?.[1]);
    if (knobs.holdDelete) await knobs.holdDelete;
    if (req.method === "DELETE") {
      for (const [ext, id] of storedItems) {
        if (id === wid) storedItems.delete(ext);
      }
    }
    onDelete?.();
    onDelete = null;
    return json(200, {});
  }
  json(404, { message: "not found" });
}

const server: Server = createServer((req, res) => {
  void handle(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// The default 5s server-side idle close races undici's pooled keep-alive
// sockets under suite load, surfacing as a transient "could not be
// reached"; keep the loopback fixture's sockets open for the whole run.
server.keepAliveTimeout = 300_000;
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
    pathOverride: null,
    holdAdd: null,
    added: null,
    holdDelete: null,
    mutateStatus: 200,
  };
  storedItems = new Map();
  nextId = 1;
  calls = [];
  onAdd = null;
  onDelete = null;
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

/** Waits for cond() with a wall-clock ceiling. Needed for real network I/O
 * (a loopback webhook POST): fake timers cannot drive undici sockets, and a
 * fixed spin budget flakes under load. Kept to the notifier tests. */
async function eventually(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!cond() && Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
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
  assert.equal(second.absent, 1);
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

test("restart after an upstream-accepted add reconciles by identity without a second POST", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  // Whisparr accepts the add, then the process dies before acknowledgement:
  // the durable attempt row is the last local evidence.
  const claim = storage.claimAcquisition(id);
  storage.beginSubmission(id, claim.claimToken);
  storedItems.set(EXT_A, 1);

  storage.recoverAbandonedWork();
  assert.equal(probe(id).state, "uncertain");

  const summary = await acquisition.runDueWork();
  assert.equal(summary.reconciled, 1);
  assert.equal(postCount(), 0, "reconciliation after a death never re-POSTs");
  const rec = probe(id);
  assert.equal(rec.state, "monitoring");
  assert.equal(rec.whisparrId, 1);
  assert.equal(rec.whisparrPath, "/data/whisparr/0f0f0f0f");
});

test("cancellation suppresses only undispatched work; sent and in-flight work survive", async () => {
  const owner = boot();

  // Accepted work: delivered, then its only request withdrawn.
  approve(owner.id, MOVIE_A);
  const idA = workId(MOVIE_A);
  await acquisition.runDueWork();
  assert.equal(probe(idA).state, "monitoring");

  // In-flight work: attempt persisted (submitting), no acknowledgement.
  approve(owner.id, MOVIE_B);
  const idB = workId(MOVIE_B);
  const claim = storage.claimAcquisition(idB);
  storage.beginSubmission(idB, claim.claimToken);
  assert.equal(rawState(idB).state, "submitting");

  // Undispatched work: approved but never claimed or sent.
  approve(owner.id, MOVIE_C);
  const idC = workId(MOVIE_C);

  // Withdraw every request; each is the last active intent for its identity.
  for (const request of storage
    .listRequests(owner)
    .filter((r) => r.decision === "approved")) {
    storage.cancelRequest(owner, request.id);
  }
  assert.equal(
    storage.getAcquisitionByReference(MOVIE_A)?.state,
    "monitoring",
    "accepted work is never deleted by a withdrawal",
  );
  assert.equal(
    storage.getAcquisitionByReference(MOVIE_B)?.state,
    "submitting",
    "in-flight work survives a withdrawal",
  );
  assert.equal(
    storage.getAcquisitionByReference(MOVIE_C),
    null,
    "the last withdrawal suppresses undispatched work",
  );
  assert.equal(
    storage.listDueAcquisitions(later(), 100).some((a) => a.id === idC),
    false,
  );

  // A re-request creates fresh work that dispatches like new.
  approve(owner.id, MOVIE_C);
  const freshId = workId(MOVIE_C);
  assert.notEqual(freshId, idC, "re-requested work is a fresh row");
  const before = postCount();
  const summary = await acquisition.runDueWork();
  assert.equal(summary.delivered, 1);
  assert.equal(postCount(), before + 1, "fresh work POSTs after suppression");
  assert.equal(probe(freshId).state, "monitoring");
});

test("changed facts persist; a proven removal is authoritative while an outage is not", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);
  await acquisition.runDueWork();

  // Upstream path changed: the next observation must persist the new facts.
  knobs.pathOverride = "/data/whisparr/moved";
  let summary = await acquisition.runDueWork(later());
  assert.equal(summary.observed, 1);
  let rec = probe(id);
  assert.equal(
    rec.whisparrPath,
    "/data/whisparr/moved",
    "a changed path is persisted, never kept stale",
  );

  // Outage: an unknown check keeps facts and the last observation intact.
  const observedAt = rec.lastObservedAt;
  knobs.downAll = true;
  summary = await acquisition.runDueWork(later());
  assert.equal(summary.unavailable, 1);
  rec = probe(id);
  assert.equal(rec.whisparrPath, "/data/whisparr/moved");
  assert.equal(rec.lastObservedAt, observedAt);
  assert.equal(
    storage.hasAuthoritativeAbsence(rec),
    false,
    "an outage is never an authoritative absence",
  );

  // Proven removal: a successful lookup says the identity is gone.
  knobs.downAll = false;
  storedItems.delete(EXT_A);
  summary = await acquisition.runDueWork(later());
  assert.equal(summary.absent, 1);
  rec = probe(id);
  assert.equal(
    storage.hasAuthoritativeAbsence(rec),
    true,
    "a proven removal is authoritative",
  );
  assert.equal(rec.whisparrPath, null);
  assert.equal(rec.whisparrId, null);
  assert.equal(rec.state, "monitoring", "removal keeps state and history");
  assert.equal(
    rec.lastObservedAt,
    observedAt,
    "removal never overwrites the last real observation",
  );
});

// --- shutdown ---------------------------------------------------------

function rawRow(id: string): { state: string; claim_token: string | null } {
  probeDb ??= new DatabaseSync(join(dir, "velvarr.sqlite"));
  return probeDb
    .prepare("SELECT state, claim_token FROM acquisitions WHERE id = ?")
    .get(id) as { state: string; claim_token: string | null };
}

test("shutdown past the grace window releases the claim, recovers the attempt, and stale writes land nowhere", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_A);
  const id = workId(MOVIE_A);

  const { promise, resolve } = Promise.withResolvers<void>();
  knobs.holdAdd = promise;
  const pass = acquisition.runDueWork();
  await until(() => rawState(id).attempt === 1);

  // Concurrent shutdown calls coalesce into one run.
  const s1 = acquisition.shutdownAcquisition(150);
  const s2 = acquisition.shutdownAcquisition(150);
  assert.equal(s1, s2, "concurrent shutdown calls share one run");
  assert.equal((await s1).forced, true, "grace expiry abandons the stuck pass");
  assert.equal(
    rawRow(id).claim_token,
    null,
    "claim released, never left for the next process to age out",
  );
  assert.equal(
    rawRow(id).state,
    "uncertain",
    "the half-written submitting attempt is boot-reconcilable",
  );
  // Unstick the pass: it now holds stale tokens and must write nothing.
  resolve();
  const summary = await pass;
  assert.equal(summary.errors, 1, "the stale write surfaces as a caught error");
  assert.equal(postCount(), 1, "no re-POST after recovery");
  assert.equal(rawRow(id).claim_token, null);
  assert.equal(rawRow(id).state, "uncertain");
  // A sequential second shutdown after the pass settled is safe and
  // reports nothing forced.
  assert.equal((await acquisition.shutdownAcquisition(50)).forced, false);
});

test("shutdown lets an in-flight pass finish inside the grace window", async () => {
  const owner = boot();
  approve(owner.id, MOVIE_B);
  const id = workId(MOVIE_B);

  const { promise, resolve } = Promise.withResolvers<void>();
  knobs.holdAdd = promise;
  const pass = acquisition.runDueWork();
  await until(() => postCount() === 1);
  const shutdown = acquisition.shutdownAcquisition(5_000);
  resolve();
  assert.equal((await shutdown).forced, false);
  assert.equal((await pass).delivered, 1);
  assert.equal(
    probe(id).state,
    "monitoring",
    "completed pass resolves its own attempt; nothing stranded",
  );
  assert.equal(postCount(), 1);
});

test("after shutdown the loop schedules no further passes until restarted", async (t) => {
  const owner = boot();
  approve(owner.id, MOVIE_C);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  acquisition.startAcquisitionLoop();
  await t.mock.timers.tick(5);
  await until(() => postCount() === 1);

  assert.equal((await acquisition.shutdownAcquisition(1_000)).forced, false);
  await t.mock.timers.tick(600_000);
  await until(() => false);
  assert.equal(postCount(), 1, "shutdown stopped all scheduling");

  // A fresh cycle after shutdown works (dev hot reload, next boot).
  approve(owner.id, MOVIE_A);
  acquisition.startAcquisitionLoop();
  await t.mock.timers.tick(5);
  await until(() => postCount() === 2);
  // Settle the pass before mock timers are torn down: its response handling
  // needs real I/O turns, and an unsettled pass wedges passInFlight.
  await until(() => false);
  acquisition.stopAcquisitionLoop();
});

test("server-start hook registers idempotent SIGTERM/SIGINT handlers", async () => {
  freshDb(); // nothing due: the hook's immediate pass is a no-op
  // register() is Node-runtime gated; the test process pretends to be the
  // server runtime for this call and restores the env after.
  process.env.NEXT_RUNTIME = "nodejs";
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  await register();
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
  assert.equal(process.listenerCount("SIGINT"), beforeInt + 1);
  await register(); // once-per-process guard: no double handlers
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
  assert.equal(process.listenerCount("SIGINT"), beforeInt + 1);
  delete process.env.NEXT_RUNTIME;
});

// --- notifier ---------------------------------------------------------

test("notifier fires exactly once per real transition and carries no credential", async () => {
  const owner = boot();
  const webhookBodies: string[] = [];
  const webhook = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      webhookBodies.push(raw);
      res.writeHead(200);
      res.end();
    });
  });
  const listening = Promise.withResolvers<void>();
  webhook.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  process.env.VELVARR_DISCORD_WEBHOOK_URL = `http://127.0.0.1:${
    (webhook.address() as AddressInfo).port
  }/api/webhooks/1/fixture-token`;
  try {
    approve(owner.id, MOVIE_A);
    const delivered = await acquisition.runDueWork();
    assert.equal(delivered.delivered, 1);
    // Notification is fire-and-forget: let the POST land before counting.
    await eventually(() => webhookBodies.length >= 1);
    assert.equal(webhookBodies.length, 1, "one notification for the add");

    const steady = await acquisition.runDueWork(later());
    assert.equal(steady.observed, 1, "steady monitoring recheck");

    knobs.inQueue = true;
    await acquisition.runDueWork(later());

    knobs.hasFile = true;
    await acquisition.runDueWork(later());
    await eventually(() => webhookBodies.length >= 2);
    // Drain any slow stragglers: a wrongful notification fired during the
    // steady/downloading passes would have landed by now.
    await eventually(() => false);
    assert.equal(
      webhookBodies.length,
      2,
      "exactly one notification per real transition",
    );

    const all = webhookBodies.join("\n");
    assert.ok(all.includes(EXT_A), "identity-only message names the media");
    assert.ok(!all.includes(KEY), "webhook body carries no Whisparr key");
    assert.ok(
      !all.includes("jf-owner-token"),
      "webhook body carries no session token",
    );
  } finally {
    delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
    webhook.closeAllConnections();
    webhook.close();
  }
});

test("a hanging or rejecting notifier neither fails nor delays the pass", async () => {
  const owner = boot();
  let mode: "hang" | "reject" = "hang";
  const webhook = createServer((_req, res) => {
    if (mode === "hang") return; // never respond
    res.writeHead(500);
    res.end("{}");
  });
  const listening = Promise.withResolvers<void>();
  webhook.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  process.env.VELVARR_DISCORD_WEBHOOK_URL = `http://127.0.0.1:${
    (webhook.address() as AddressInfo).port
  }/api/webhooks/1/fixture-token`;
  try {
    approve(owner.id, MOVIE_A);
    const start = Date.now();
    const first = await acquisition.runDueWork();
    const elapsed = Date.now() - start;
    assert.equal(first.delivered, 1, "hung notifier never fails the work");
    assert.ok(
      elapsed < 2_000,
      `hung notifier must not delay the pass (${elapsed}ms)`,
    );

    mode = "reject";
    approve(owner.id, MOVIE_B);
    const second = await acquisition.runDueWork();
    assert.equal(
      second.delivered,
      1,
      "rejecting notifier never fails the work",
    );
  } finally {
    delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
    webhook.closeAllConnections();
    webhook.close();
  }
});

// --- removals ---------------------------------------------------------

// Removal approvals need an elevated actor with the grant and a requester
// with the grant; both accounts live in this file's loopback-only DB.
function grantRemoval(): Account {
  storage.updateAccount(OWNER.id, {
    enabled: true,
    role: "admin",
    libraryIds: [],
    canRemove: true,
  });
  storage.updateAccount(FRIEND_ID, {
    enabled: true,
    role: "requester",
    libraryIds: [],
    canRemove: true,
  });
  return storage.getAccount(OWNER.id) as Account;
}

function removalApprove(media: MediaReference, level: RemovalLevel): string {
  storage.approveRemovalRequest(
    storage.getAccount(OWNER.id) as Account,
    storage.createRemovalRequest(FRIEND_ID, media, "household asked").id,
    level,
  );
  const exec = storage.getRemovalExecutionByReference(media);
  assert.ok(exec, `no removal execution created for ${media.id}`);
  return exec.id;
}

/** Raw removal row straight from SQLite, readable from inside the fixture's
 * DELETE handler to observe what the worker persisted before the call. */
type RemovalRow = {
  state: string;
  attempt: number;
  item: number | null;
  added: string | null;
};

function rawRemoval(id: string): RemovalRow {
  probeDb ??= new DatabaseSync(join(dir, "velvarr.sqlite"));
  return probeDb
    .prepare(
      "SELECT state, attempt_token IS NOT NULL AS attempt, whisparr_item_id AS item, whisparr_added AS added FROM removal_executions WHERE id = ?",
    )
    .get(id) as RemovalRow;
}

function removalAudits(
  execId: string,
): { outcome: string; detail: string | null }[] {
  probeDb ??= new DatabaseSync(join(dir, "velvarr.sqlite"));
  return probeDb
    .prepare(
      "SELECT outcome, detail FROM removal_audit WHERE execution_id = ? ORDER BY created_at, id",
    )
    .all(execId) as { outcome: string; detail: string | null }[];
}

function callPaths(): string[] {
  return calls.map((c) => `${c.method} ${c.path}`);
}

function deleteCount(): number {
  return callPaths().filter((p) => p.startsWith("DELETE")).length;
}

test("each Whisparr level issues exactly its own calls and nothing more", async () => {
  const levels: [RemovalLevel, string][] = [
    ["unmonitor", `PUT /api/v3/movie/1`],
    [
      "drop",
      `DELETE /api/v3/movie/1?deleteFiles=false&addImportExclusion=false`,
    ],
    [
      "exclude",
      `DELETE /api/v3/movie/1?deleteFiles=false&addImportExclusion=true`,
    ],
    [
      "delete_files",
      `DELETE /api/v3/movie/1?deleteFiles=true&addImportExclusion=true`,
    ],
  ];
  for (const [level, expected] of levels) {
    boot();
    grantRemoval();
    storedItems.set(EXT_A, 1);
    removalApprove(MOVIE_A, level);
    const summary = await acquisition.runDueWork();
    assert.deepEqual(
      callPaths(),
      [
        `GET /api/v3/movie?tpdbId=${EXT_A}`,
        `GET /api/v3/movie?tpdbId=${EXT_A}`,
        expected,
      ],
      `${level} call matrix`,
    );
    const exec = storage.getRemovalExecutionByReference(MOVIE_A);
    assert.equal(exec?.state, "done", `${level} completes as done`);
    assert.equal(summary.removed, 1, level);
    assert.equal(summary.errors, 0, level);
  }
});

test("the attempt row carries the observed facts before the destructive call", async () => {
  boot();
  grantRemoval();
  knobs.added = "2026-01-01T00:00:00.000Z";
  storedItems.set(EXT_A, 7);
  const execId = removalApprove(MOVIE_A, "delete_files");
  const atCall: { row: RemovalRow | null } = { row: null };
  onDelete = () => {
    atCall.row = rawRemoval(execId);
  };
  const summary = await acquisition.runDueWork();
  assert.ok(atCall.row, "the destructive DELETE ran");
  assert.equal(atCall.row.state, "executing", "attempt durable at call time");
  assert.equal(atCall.row.attempt, 1, "attempt token persisted pre-call");
  assert.equal(atCall.row.item, 7, "observed item id persisted pre-call");
  assert.equal(atCall.row.added, knobs.added, "observed added persisted");
  assert.equal(summary.removed, 1);
  assert.equal(summary.errors, 0);
});

test("a proven 404 on the destructive call completes as success", async () => {
  boot();
  grantRemoval();
  storedItems.set(EXT_A, 3);
  knobs.mutateStatus = 404;
  const execId = removalApprove(MOVIE_A, "drop");
  const summary = await acquisition.runDueWork();
  assert.equal(summary.removed, 1, "already gone is success");
  assert.equal(summary.failed, 0);
  assert.equal(storage.getRemovalExecutionByReference(MOVIE_A)?.state, "done");
  assert.equal(removalAudits(execId)[0]?.outcome, "done");
  // A completed execution never schedules again.
  await acquisition.runDueWork(later());
  assert.equal(deleteCount(), 1, "done removals are never re-executed");
});

test("an outage leaves it uncertain; the retry re-resolves and refuses re-added content", async () => {
  boot();
  grantRemoval();
  knobs.added = "2026-01-01T00:00:00.000Z";
  storedItems.set(EXT_A, 1);
  const execId = removalApprove(MOVIE_A, "drop");

  knobs.mutateStatus = 503;
  const first = await acquisition.runDueWork();
  assert.equal(first.uncertain, 1, "proven 5xx leaves the effect unknown");
  const afterFirst = storage.getRemovalExecutionByReference(MOVIE_A);
  assert.equal(afterFirst?.state, "uncertain");
  assert.equal(
    afterFirst?.whisparrAdded,
    "2026-01-01T00:00:00.000Z",
    "the captured added timestamp is durable",
  );

  // The identity is re-added under a newer added timestamp before the
  // bounded recheck: the retry must re-resolve, compare, and refuse.
  knobs.added = "2026-02-02T00:00:00.000Z";
  storedItems.set(EXT_A, 2);
  knobs.mutateStatus = 200;
  const seen = calls.length;
  const second = await acquisition.runDueWork(later());
  assert.deepEqual(
    callPaths().slice(seen),
    [`GET /api/v3/movie?tpdbId=${EXT_A}`, `GET /api/v3/movie?tpdbId=${EXT_A}`],
    "the refused retry resolves by identity and never DELETEs",
  );
  assert.equal(second.refused, 1);
  assert.equal(second.uncertain, 0);
  const exec = storage.getRemovalExecutionByReference(MOVIE_A);
  assert.equal(exec?.state, "failed", "a refusal is terminal, never retried");
  const audits = removalAudits(execId);
  const last = audits[audits.length - 1];
  assert.equal(last?.outcome, "failed");
  assert.match(last?.detail ?? "", /refus/i);
  assert.equal(deleteCount(), 1, "exactly one DELETE ever left the building");
});

test("a Jellyfin-level removal never executes in the loop and explains why", async () => {
  boot();
  grantRemoval();
  storedItems.set(EXT_A, 1);
  const execId = removalApprove(MOVIE_A, "delete_jellyfin_item");

  const first = await acquisition.runDueWork();
  assert.equal(first.removed, 0);
  assert.equal(first.blocked, 1);
  assert.equal(
    callPaths().length,
    0,
    "no user token means no calls of any kind — no downgrade, no admin key",
  );
  const exec = storage.getRemovalExecutionByReference(MOVIE_A);
  assert.ok(exec);
  assert.equal(exec.state, "uncertain");
  const audits = removalAudits(execId);
  assert.equal(audits.length, 1, "the reason is recorded exactly once");
  assert.equal(audits[0]?.outcome, "uncertain");
  assert.match(audits[0]?.detail ?? "", /Jellyfin user token/);

  // Later passes neither execute it nor append more evidence.
  const second = await acquisition.runDueWork(later());
  assert.equal(second.blocked, 1);
  assert.equal(callPaths().length, 0);
  assert.equal(removalAudits(execId).length, 1);
});

test("claim contention skips the removal instead of double-acting", async () => {
  boot();
  grantRemoval();
  storedItems.set(EXT_A, 1);
  storedItems.set(EXT_B, 2);
  const execA = removalApprove(MOVIE_A, "drop");
  const execB = removalApprove(MOVIE_B, "drop");

  // Hold the first DELETE open so a second execution can be claimed
  // externally while the pass is mid-flight: a genuine list/claim race.
  const hold = Promise.withResolvers<void>();
  knobs.holdDelete = hold.promise;
  const pass = acquisition.runDueWork();
  await until(() => deleteCount() === 1);
  const inFlight = calls[calls.length - 1]?.path ?? "";
  const other = inFlight.includes("/1") ? execB : execA;
  const raced = storage.claimRemovalExecution(other);
  hold.resolve();
  const summary = await pass;
  assert.equal(summary.removed, 1, "the in-flight removal lands");
  assert.equal(summary.contention, 1, "the raced claim is skipped");
  assert.equal(deleteCount(), 1, "a lost claim never double-acts");

  // Once the external claim is gone the skipped execution proceeds.
  storage.releaseRemovalClaim(other, raced.claimToken);
  const next = await acquisition.runDueWork();
  assert.equal(next.removed, 1);
  assert.equal(deleteCount(), 2);
});

test("removal and acquisition work coexist; a removal identity is never re-added", async () => {
  const owner = boot();
  grantRemoval();
  storedItems.set(EXT_A, 1);
  approve(owner.id, MOVIE_B);
  approve(owner.id, MOVIE_A);
  removalApprove(MOVIE_A, "drop");

  const summary = await acquisition.runDueWork();
  assert.equal(summary.removed, 1, "the removal lands");
  assert.equal(summary.delivered, 1, "the unrelated acquisition lands too");
  assert.equal(summary.blocked, 1, "the same-identity acquisition is held");
  assert.equal(postCount(), 1, "only movie B was ever added");
  assert.equal(deleteCount(), 1);
  assert.equal(storage.getAcquisitionByReference(MOVIE_B)?.state, "monitoring");
  assert.equal(
    storage.getAcquisitionByReference(MOVIE_A)?.state,
    "unsent",
    "the suppressed acquisition keeps its honest state",
  );
  // A completed removal keeps suppressing its identity on later passes.
  const second = await acquisition.runDueWork(later());
  assert.equal(second.blocked, 1);
  assert.equal(postCount(), 1, "a removed identity is never re-acquired");
});

test("the operator flag off leaves acquisition delivery untouched", async () => {
  const owner = boot();
  grantRemoval();
  approve(owner.id, MOVIE_A);
  delete process.env.VELVARR_ENABLE_REMOVAL;
  try {
    const summary = await acquisition.runDueWork();
    assert.equal(summary.delivered, 1, "acquisition work continues");
    assert.equal(summary.errors, 0, "the disabled flag is not an error");
  } finally {
    process.env.VELVARR_ENABLE_REMOVAL = "1";
  }
});

test("a settled removal notifies once; unsettled outcomes stay silent", async () => {
  boot();
  grantRemoval();
  const bodies: string[] = [];
  const webhook = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      bodies.push(raw);
      res.writeHead(200);
      res.end("{}");
    });
  });
  const listening = Promise.withResolvers<void>();
  webhook.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  process.env.VELVARR_DISCORD_WEBHOOK_URL = `http://127.0.0.1:${
    (webhook.address() as AddressInfo).port
  }/api/webhooks/1/fixture-token`;
  try {
    storedItems.set(EXT_A, 1);
    removalApprove(MOVIE_A, "drop");
    await acquisition.runDueWork();
    await eventually(() => bodies.length >= 1);
    assert.equal(bodies.length, 1, "one notification for the removal");
    const landed = bodies.join("\n");
    assert.ok(landed.includes("removed"), "names the removal transition");
    assert.ok(landed.includes(EXT_A), "identity-only message names the media");

    // A proven upstream rejection is a settled failure the household hears.
    storedItems.set(EXT_C, 3);
    knobs.mutateStatus = 400;
    removalApprove(MOVIE_C, "drop");
    await acquisition.runDueWork();
    await eventually(() => bodies.length >= 2);
    assert.ok(bodies[1]?.includes("failed"));

    // Uncertain then refused settles silently: a retry guard must not cry
    // wolf on an outcome that a later pass may still resolve. A transient
    // loopback hiccup can skip the pre-attempt lookup (nothing attempted,
    // state untouched); retry until the attempt is durable, then re-add the
    // content before the bounded recheck.
    knobs.mutateStatus = 503;
    knobs.added = "2026-01-01T00:00:00.000Z";
    storedItems.set(EXT_B, 2);
    removalApprove(MOVIE_B, "drop");
    let b1 = await acquisition.runDueWork();
    for (let i = 0; b1.unavailable > 0 && i < 5; i++) {
      b1 = await acquisition.runDueWork(later());
    }
    assert.equal(b1.uncertain, 1, "the outage leaves the attempt uncertain");
    assert.equal(
      storage.getRemovalExecutionByReference(MOVIE_B)?.whisparrAdded,
      "2026-01-01T00:00:00.000Z",
    );
    knobs.added = "2026-02-02T00:00:00.000Z";
    storedItems.set(EXT_B, 9);
    knobs.mutateStatus = 200;
    await acquisition.runDueWork(later());
    await eventually(() => false);
    assert.equal(bodies.length, 2, "unsettled outcomes never notify");
  } finally {
    delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
    webhook.closeAllConnections();
    webhook.close();
  }
});
