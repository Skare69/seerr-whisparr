import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Account,
  CatalogDetail,
  ExternalUser,
  IntegrationConfig,
  MediaReference,
} from "../src/lib/contracts.ts";

process.env.VELVARR_ORIGIN = "http://127.0.0.1:5577";
process.env.VELVARR_SETUP_SECRET = "setup-secret-for-tests-0123456789abcdef";
const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
process.env.VELVARR_SECRET_KEY = KEY_A;

const storage = await import("../src/server/storage.ts");
const security = await import("../src/server/security.ts");
const { DatabaseSync } = await import("node:sqlite");

let currentDir = "";
function freshDir(): string {
  storage.closeStorage();
  if (currentDir)
    rmSync(currentDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  currentDir = mkdtempSync(join(tmpdir(), "velvarr-storage-"));
  process.env.VELVARR_DATA_DIR = currentDir;
  return currentDir;
}

function ownerUser(): ExternalUser {
  return {
    id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    name: "Owner",
    isDisabled: false,
    enableRemoteAccess: true,
    enableMediaPlayback: true,
    isAdministrator: true,
  };
}

function otherUser(): ExternalUser {
  return {
    ...ownerUser(),
    id: "ffffffffffffffffffffffffffffffff",
    name: "Requester",
  };
}

function accountFixture(): Account {
  return {
    id: ownerUser().id,
    name: "Owner",
    role: "admin",
    enabled: true,
    libraryIds: [],
    isOwner: true,
    autoApprove: false,
  };
}

function testConfig(): IntegrationConfig {
  return {
    jellyfin: {
      url: "http://127.0.0.1:8096/jellyfin",
      externalUrl: "https://media.example.org/jellyfin",
      apiKey: "jf-admin-key",
      serverId: "0123456789abcdef0123456789abcdef",
      libraryIds: [
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
      ],
    },
    whisparr: { url: "http://127.0.0.1:6969", apiKey: "whisparr-key" },
  };
}

function dbFiles(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "latin1"))
    .join("\n");
}

test("import is lazy: no data dir or sqlite file is created", () => {
  const dir = freshDir();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  // Module already imported; without a storage call nothing may exist on disk.
  assert.ok(
    !existsSync(dir),
    "importing storage must not create the data directory",
  );
  assert.equal(storage.isInitialized(), false);
  assert.ok(
    existsSync(join(dir, "velvarr.sqlite")),
    "first storage call opens the database",
  );
});

test("bootstrap creates exactly one owner with a valid grant; second bootstrap is rejected without overwriting", () => {
  freshDir();
  const cfg = testConfig();
  const grant = storage.bootstrap(cfg, ownerUser(), "jf-owner-token");
  assert.equal(grant.account.isOwner, true);
  assert.equal(grant.account.role, "admin");
  assert.equal(grant.account.enabled, true);
  assert.deepEqual(grant.account.libraryIds, cfg.jellyfin.libraryIds);
  assert.ok(grant.expiresAt > Date.now());

  assert.throws(
    () =>
      storage.bootstrap(
        { ...cfg, jellyfin: { ...cfg.jellyfin, apiKey: "attacker-key" } },
        otherUser(),
        "t",
      ),
    (e: { code: string }) => e.code === "already_initialized",
  );
  // Config untouched by the losing race.
  assert.equal(storage.getConfig()?.jellyfin.apiKey, "jf-admin-key");
  const accounts = storage.listAccounts();
  assert.equal(accounts.length, 1);
  const first = accounts[0];
  assert.ok(first, "owner row must exist");
  assert.equal(first.isOwner, true);
  assert.equal(storage.getSession(grant.token)?.account.id, ownerUser().id);
});

test("bootstrap rejects invalid identity instead of creating an arbitrary owner", () => {
  freshDir();
  assert.throws(() =>
    storage.bootstrap(testConfig(), { ...ownerUser(), id: "" }, "t"),
  );
  assert.throws(() => storage.bootstrap(testConfig(), ownerUser(), ""));
  assert.equal(storage.isInitialized(), false);
});

test("import admits nothing: new users disabled requesters without libraries; existing keep grants and owner", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const imported = storage.importAccounts([otherUser(), ownerUser()]);
  assert.equal(imported.length, 2);
  const req = imported.find((a) => a.id === otherUser().id) as {
    enabled: boolean;
    role: string;
    libraryIds: string[];
  };
  assert.equal(req.enabled, false);
  assert.equal(req.role, "requester");
  assert.deepEqual(req.libraryIds, []);
  const owner = imported.find((a) => a.id === ownerUser().id) as {
    isOwner: boolean;
    role: string;
    enabled: boolean;
  };
  assert.equal(owner.isOwner, true);
  assert.equal(owner.enabled, true);
  assert.equal(storage.listAccounts().length, 2);
  // Disabled import cannot log in.
  assert.throws(
    () => storage.createSession(otherUser().id, "jf-token"),
    (e: { code: string }) => e.code === "account_disabled",
  );
});

test("sessions survive restart encrypted; wrong key refuses without data loss; right key restores access", () => {
  const dir = freshDir();
  const cfg = testConfig();
  const grant = storage.bootstrap(cfg, ownerUser(), "jf-owner-token");
  const [acct] = storage.importAccounts([otherUser()]);
  assert.ok(acct, "imported account must exist");
  storage.updateAccount(acct.id, {
    enabled: true,
    role: "requester",
    libraryIds: ["11111111111111111111111111111111"],
  });
  const userGrant = storage.createSession(acct.id, "jf-user-token");

  storage.closeStorage();
  process.env.VELVARR_SECRET_KEY = KEY_B;
  assert.throws(
    () => storage.getConfig(),
    (e: { code: string }) => e.code === "secret_key_mismatch",
  );
  assert.throws(() => storage.getSession(userGrant.token));

  process.env.VELVARR_SECRET_KEY = KEY_A;
  assert.equal(
    storage.getSession(userGrant.token)?.jellyfinToken,
    "jf-user-token",
  );
  assert.equal(storage.getSession(grant.token)?.account.isOwner, true);
  assert.equal(storage.getConfig()?.jellyfin.serverId, cfg.jellyfin.serverId);
  // Restarted database is still ours and schema-valid.
  assert.equal(storage.isInitialized(), true);

  storage.closeStorage();
  const raw = dbFiles(dir);
  assert.ok(
    !raw.includes("jf-user-token"),
    "user token must not be stored in plaintext",
  );
  assert.ok(
    !raw.includes("jf-admin-key"),
    "config secrets must not be stored in plaintext",
  );
  assert.ok(!raw.includes(KEY_A), "the encryption key must never be persisted");
  assert.ok(
    !raw.includes(userGrant.token),
    "session tokens must be stored hashed only",
  );
});

test("revocation is immediate: explicit revoke, expiry path, and grant change kill sessions", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const [acct] = storage.importAccounts([otherUser()]);
  assert.ok(acct, "imported account must exist");
  storage.updateAccount(acct.id, {
    enabled: true,
    role: "requester",
    libraryIds: ["11111111111111111111111111111111"],
  });
  const grant = storage.createSession(acct.id, "jf-token-1");

  storage.revokeSession(grant.token);
  assert.equal(storage.getSession(grant.token), null);
  // Revoking again is a no-op.
  storage.revokeSession(grant.token);

  const grant2 = storage.createSession(acct.id, "jf-token-2");
  storage.updateAccount(acct.id, {
    enabled: true,
    role: "requester",
    libraryIds: ["22222222222222222222222222222222"],
  });
  assert.equal(
    storage.getSession(grant2.token),
    null,
    "library grant change must revoke existing sessions",
  );

  const grant3 = storage.createSession(acct.id, "jf-token-3");
  storage.updateAccount(acct.id, {
    enabled: false,
    role: "requester",
    libraryIds: ["22222222222222222222222222222222"],
  });
  assert.equal(
    storage.getSession(grant3.token),
    null,
    "disabled account must invalidate sessions",
  );
});

test("library grants stay conservative: escalation rejected, valid subset accepted, owner protected", () => {
  freshDir();
  const grant = storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const [acct] = storage.importAccounts([otherUser()]);
  assert.ok(acct, "imported account must exist");

  assert.throws(
    () =>
      storage.updateAccount(acct.id, {
        enabled: true,
        role: "admin",
        libraryIds: ["33333333333333333333333333333333"],
      }),
    (e: { code: string }) => e.code === "unknown_library",
  );
  assert.deepEqual(storage.getAccount(acct.id)?.libraryIds, []);
  assert.equal(storage.getAccount(acct.id)?.role, "requester");

  const updated = storage.updateAccount(acct.id, {
    enabled: true,
    role: "moderator",
    libraryIds: [
      "11111111111111111111111111111111",
      "22222222222222222222222222222222",
    ],
  });
  assert.equal(updated.role, "moderator");

  assert.throws(
    () =>
      storage.updateAccount(grant.account.id, {
        enabled: false,
        role: "admin",
        libraryIds: [],
      }),
    (e: { code: string }) => e.code === "owner_protected",
  );
  assert.throws(
    () =>
      storage.updateAccount(grant.account.id, {
        enabled: true,
        role: "requester",
        libraryIds: [],
      }),
    (e: { code: string }) => e.code === "owner_protected",
  );
  assert.equal(storage.getAccount(grant.account.id)?.enabled, true);
  assert.equal(storage.getAccount(grant.account.id)?.role, "admin");
});

test("saveConfig pins the Jellyfin server identity", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const cfg = testConfig();
  cfg.jellyfin.serverId = "fffffffffffffffffffffffffffffffe";
  assert.throws(
    () => storage.saveConfig(cfg),
    (e: { code: string }) => e.code === "server_mismatch",
  );
  assert.throws(
    () =>
      storage.saveConfig({
        jellyfin: { ...testConfig().jellyfin, serverId: "nothex" },
      }),
    (e: { code: string }) => e.code === "invalid_config",
  );
});

test("malformed whisparr block is rejected and never persisted; valid one round-trips", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const bad = testConfig();
  bad.whisparr = { url: "http://127.0.0.1:6969", apiKey: "" };
  assert.throws(
    () => storage.saveConfig(bad),
    (e: { code: string }) => e.code === "invalid_config",
  );
  // Rejected config must not replace the persisted one.
  const kept = storage.getConfig()?.whisparr;
  assert.equal(kept?.url, "http://127.0.0.1:6969");
  assert.equal(kept?.apiKey, "whisparr-key");
  assert.ok(kept?.instanceId, "bootstrap assigns a Whisparr instance identity");
  assert.equal(kept?.delivery, undefined);

  const good = testConfig();
  good.whisparr = { url: "http://127.0.0.1:7000", apiKey: "new-key" };
  storage.saveConfig(good);
  const saved = storage.getConfig()?.whisparr;
  assert.equal(saved?.url, "http://127.0.0.1:7000");
  assert.equal(saved?.apiKey, "new-key");
});

test("missing encryption key blocks storage operations but not lazy status", () => {
  freshDir();
  delete process.env.VELVARR_SECRET_KEY;
  assert.equal(storage.isInitialized(), false);
  assert.throws(
    () => storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token"),
    (e: { code: string }) => e.code === "secret_key_invalid",
  );
  process.env.VELVARR_SECRET_KEY = KEY_A;
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  delete process.env.VELVARR_SECRET_KEY;
  assert.throws(
    () => storage.getConfig(),
    (e: { code: string }) => e.code === "secret_key_invalid",
  );
  process.env.VELVARR_SECRET_KEY = KEY_A;
});

test("foreign and future databases are refused without data loss", async () => {
  let dir = freshDir();
  const foreign = new DatabaseSync(join(dir, "velvarr.sqlite"));
  foreign.exec("PRAGMA application_id = 1094862650");
  foreign.exec("CREATE TABLE someones_data (a INTEGER)");
  foreign.close();
  assert.throws(
    () => storage.isInitialized(),
    (e: { code: string }) => e.code === "foreign_database",
  );

  dir = freshDir();
  const future = new DatabaseSync(join(dir, "velvarr.sqlite"));
  future.exec("PRAGMA application_id = 0x564c5652");
  future.exec("PRAGMA user_version = 99");
  future.close();
  assert.throws(
    () => storage.isInitialized(),
    (e: { code: string }) => e.code === "future_database",
  );
});

test("guardMutation enforces exact configured origin and safe transport", () => {
  process.env.VELVARR_ORIGIN = "http://127.0.0.1:5577";
  delete process.env.VELVARR_ALLOW_HTTP;
  const req = (origin?: string) =>
    new Request("http://127.0.0.1:5577/api/login", {
      method: "POST",
      headers: origin ? { origin } : {},
    });

  security.guardMutation(req("http://127.0.0.1:5577"));
  assert.throws(
    () => security.guardMutation(req()),
    (e: { code: string }) => e.code === "origin_missing",
  );
  assert.throws(
    () => security.guardMutation(req("http://evil.example")),
    (e: { code: string }) => e.code === "origin_mismatch",
  );
  assert.throws(
    () => security.guardMutation(req("http://127.0.0.1:5578")),
    (e: { code: string }) => e.code === "origin_mismatch",
  );

  // Non-loopback HTTP origin config is refused unless explicitly allowed.
  process.env.VELVARR_ORIGIN = "http://192.168.1.10:5577";
  assert.throws(
    () => security.guardMutation(req("http://192.168.1.10:5577")),
    (e: { code: string }) => e.code === "unsafe_origin",
  );
  process.env.VELVARR_ALLOW_HTTP = "1";
  security.guardMutation(req("http://192.168.1.10:5577"));
  delete process.env.VELVARR_ALLOW_HTTP;
  process.env.VELVARR_ORIGIN = "http://127.0.0.1:5577";
});

test("setup secret compare is constant-time-correct; login limiter is bounded per account and globally", () => {
  assert.throws(
    () => security.verifySetupSecret("wrong-secret"),
    (e: { code: string }) => e.code === "setup_secret_invalid",
  );
  assert.throws(
    () => security.verifySetupSecret(42),
    (e: { code: string }) => e.code === "setup_secret_invalid",
  );
  security.verifySetupSecret("setup-secret-for-tests-0123456789abcdef");

  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      security.consumeLoginAttempt("alice");
    } catch (e) {
      last = e;
    }
  }
  assert.equal(last, undefined, "five attempts must pass");
  assert.throws(
    () => security.consumeLoginAttempt("alice"),
    (e: { code: string }) => e.code === "too_many_attempts",
  );
  security.consumeLoginAttempt("bob");
});

test("session cookie flags follow origin transport and clear correctly", () => {
  process.env.VELVARR_ORIGIN = "https://velvarr.example.org";
  const set = security.sessionCookie({
    token: "tok123",
    expiresAt: Date.now() + 60_000,
    account: accountFixture(),
  });
  assert.ok(set.startsWith("velvarr_session=tok123;"));
  assert.ok(
    set.includes("HttpOnly") &&
      set.includes("SameSite=Strict") &&
      set.includes("Path=/") &&
      set.includes("Secure"),
  );
  assert.ok(
    set.includes("Max-Age=6") ||
      set.includes("Max-Age=5") ||
      set.includes("Max-Age=60"),
  );

  const clear = security.sessionCookie();
  assert.ok(clear.startsWith("velvarr_session=;"));
  assert.ok(clear.includes("Max-Age=0"));

  process.env.VELVARR_ORIGIN = "http://127.0.0.1:5577";
  const plain = security.sessionCookie({
    token: "tok123",
    expiresAt: Date.now() + 60_000,
    account: accountFixture(),
  });
  assert.ok(!plain.includes("Secure"));
  assert.ok(plain.includes("HttpOnly") && plain.includes("SameSite=Strict"));
});

// --- M2 foundations ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOVIE: MediaReference = {
  provider: "tpdb",
  kind: "movie",
  id: "b6fd4f84-8961-4b8a-9194-e357628dea20",
};
const SCENE: MediaReference = {
  provider: "stashdb",
  kind: "scene",
  id: "01a060a7-0644-7afd-8071-25752e1a45b7",
};

function admit(id: string, libraryIds: string[] = []): Account {
  return storage.updateAccount(id, {
    enabled: true,
    role: "requester",
    libraryIds,
  });
}

/** Encrypts like storage does, to fabricate readable rows in a v1 database. */
function encryptForTest(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY_A, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function movieDetail(overrides?: Partial<CatalogDetail>): CatalogDetail {
  return {
    reference: { provider: "tpdb", kind: "movie", id: MOVIE.id },
    title: "Pirates II: Stagnetti's Revenge",
    credits: [],
    tags: [{ id: "t1", name: "Adventure" }],
    related: [],
    links: [{ url: "https://theporndb.net/movies/x", label: "TPDB" }],
    aliases: ["Pirates 2"],
    ...overrides,
  };
}

function deliveryConfig(enabled: boolean): IntegrationConfig {
  return {
    ...testConfig(),
    whisparr: {
      url: "http://127.0.0.1:6969",
      apiKey: "whisparr-key",
      ...(enabled
        ? {
            delivery: {
              enabled: true,
              rootFolderPath: "/data/xxx",
              qualityProfileId: 1,
              searchOnAdd: false,
            },
          }
        : {}),
    },
  };
}

test("whisparr instance identity is storage-owned: preserved per endpoint, rotated on change", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const first = storage.getConfig()?.whisparr?.instanceId;
  assert.ok(first && UUID_RE.test(first));

  // Same endpoint across repeated saves (key rotation flow): identity kept.
  storage.saveConfig(testConfig());
  assert.equal(storage.getConfig()?.whisparr?.instanceId, first);
  assert.throws(
    () =>
      storage.saveConfig({
        ...testConfig(),
        whisparr: {
          url: "http://127.0.0.1:6969",
          apiKey: "k",
          instanceId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    (e: { code: string }) => e.code === "instance_mismatch",
  );

  // Changed endpoint: a fresh identity so old acquisition work is not reused.
  storage.saveConfig({
    ...testConfig(),
    whisparr: { url: "http://127.0.0.1:7000", apiKey: "k2" },
  });
  const second = storage.getConfig()?.whisparr?.instanceId;
  assert.ok(second && UUID_RE.test(second));
  assert.notEqual(second, first);
  // Removing whisparr and re-adding the same endpoint later still rotates.
  storage.saveConfig({ ...testConfig(), whisparr: undefined });
  storage.saveConfig({
    ...testConfig(),
    whisparr: { url: "http://127.0.0.1:6969", apiKey: "k" },
  });
  const third = storage.getConfig()?.whisparr?.instanceId;
  assert.ok(third && UUID_RE.test(third));
  assert.notEqual(third, first);
});

test("delivery settings are validated; absent delivery stays disabled", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(false), ownerUser(), "jf-owner-token");
  assert.equal(storage.getConfig()?.whisparr?.delivery, undefined);

  assert.throws(
    () =>
      storage.saveConfig({
        ...testConfig(),
        whisparr: {
          url: "http://127.0.0.1:6969",
          apiKey: "k",
          delivery: {
            enabled: true,
            rootFolderPath: "",
            qualityProfileId: 1,
            searchOnAdd: true,
          },
        },
      }),
    (e: { code: string }) => e.code === "invalid_config",
  );
  assert.throws(
    () =>
      storage.saveConfig({
        ...testConfig(),
        whisparr: {
          url: "http://127.0.0.1:6969",
          apiKey: "k",
          delivery: {
            enabled: true,
            rootFolderPath: "/data/xxx",
            qualityProfileId: 0,
            searchOnAdd: true,
          },
        },
      }),
    (e: { code: string }) => e.code === "invalid_config",
  );
  assert.throws(
    () =>
      storage.saveConfig({
        ...testConfig(),
        whisparr: {
          url: "http://127.0.0.1:6969",
          apiKey: "k",
          pathMappings: [{ whisparrPrefix: "", jellyfinPrefix: "/m" }],
        },
      }),
    (e: { code: string }) => e.code === "invalid_config",
  );

  storage.saveConfig(deliveryConfig(true));
  const cfg = storage.getConfig()?.whisparr;
  assert.equal(cfg?.delivery?.enabled, true);
  assert.equal(cfg?.delivery?.rootFolderPath, "/data/xxx");
  assert.equal(cfg?.delivery?.qualityProfileId, 1);
  assert.equal(cfg?.delivery?.searchOnAdd, false);
});

test("v1 database migrates in place preserving config, accounts, sessions, and grants", () => {
  const dir = freshDir();
  storage.closeStorage();
  rmSync(join(dir, "velvarr.sqlite"), { force: true });
  rmSync(join(dir, "velvarr.sqlite-wal"), { force: true });
  rmSync(join(dir, "velvarr.sqlite-shm"), { force: true });

  // Fabricate an exact v1 database (schema, app id, user_version).
  const v1 = new DatabaseSync(join(dir, "velvarr.sqlite"));
  v1.exec("PRAGMA application_id = 0x564c5652");
  v1.exec("PRAGMA user_version = 1");
  v1.exec(`
    CREATE TABLE config (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'requester')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      library_ids TEXT NOT NULL CHECK (json_valid(library_ids)),
      is_owner INTEGER NOT NULL CHECK (is_owner IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX accounts_single_owner ON accounts (is_owner) WHERE is_owner = 1;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      jellyfin_token BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > 0)
    );
    CREATE INDEX sessions_account ON sessions (account_id);
  `);
  v1.prepare(
    "INSERT INTO accounts (id, name, role, enabled, library_ids, is_owner, created_at) VALUES (?, ?, 'admin', 1, ?, 1, ?)",
  ).run(
    ownerUser().id,
    "Owner",
    JSON.stringify(testConfig().jellyfin.libraryIds),
    Date.now(),
  );
  v1.prepare("INSERT INTO config (id, data, updated_at) VALUES (0, ?, ?)").run(
    encryptForTest(JSON.stringify(testConfig())),
    Date.now(),
  );
  v1.close();

  assert.equal(storage.isInitialized(), true);
  const owner = storage.getAccount(ownerUser().id);
  assert.ok(owner);
  assert.equal(owner.role, "admin");
  assert.equal(owner.isOwner, true);
  assert.equal(
    owner.autoApprove,
    false,
    "migrated accounts default to no auto-approve",
  );
  assert.deepEqual(
    storage.getConfig()?.jellyfin.libraryIds,
    testConfig().jellyfin.libraryIds,
  );
  const grant = storage.createSession(owner.id, "jf-owner-token");
  assert.equal(storage.getSession(grant.token)?.account.id, owner.id);

  const raw = new DatabaseSync(join(dir, "velvarr.sqlite"));
  const version = (
    raw.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  raw.close();
  assert.equal(version, 2);
});

test("catalog records carry an application-owned id distinct from the external UUID", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const record = storage.upsertCatalogRecord(movieDetail());
  assert.notEqual(record.id, MOVIE.id);
  assert.ok(UUID_RE.test(record.id));
  assert.deepEqual(record.reference, movieDetail().reference);

  const again = storage.upsertCatalogRecord(movieDetail({ title: "Renamed" }));
  assert.equal(again.id, record.id);
  assert.equal(again.title, "Renamed");
  assert.ok(again.updatedAt >= again.createdAt);
  assert.equal(storage.getCatalogRecord(record.id)?.title, "Renamed");
  assert.equal(
    storage.getCatalogRecordByReference(movieDetail().reference)?.id,
    record.id,
  );
  assert.equal(
    storage.getCatalogRecordByReference({
      ...movieDetail().reference,
      id: "99999999-9999-4999-8999-999999999999",
    }),
    null,
  );

  assert.throws(
    () => storage.upsertCatalogRecord(movieDetail({ title: "" })),
    (e: { code: string }) => e.code === "invalid_catalog_detail",
  );
  assert.throws(
    () =>
      storage.upsertCatalogRecord(
        movieDetail({
          reference: { ...movieDetail().reference, id: "not-a-uuid" },
        }),
      ),
    (e: { code: string }) => e.code === "invalid_catalog_detail",
  );
});

test("two admitted users share one acquisition per identity; active intent is unique", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  const [imported] = storage.importAccounts([otherUser()]);
  assert.ok(imported);
  const other = admit(imported.id);
  const owner = storage.getAccount(ownerUser().id) as Account;

  const r1 = storage.createRequest(owner.id, MOVIE);
  const r2 = storage.createRequest(other.id, MOVIE);
  const a1 = storage.decideRequest(owner, r1.id, "approved");
  const a2 = storage.decideRequest(owner, r2.id, "approved");
  assert.equal(a1.decision, "approved");
  assert.equal(a2.decision, "approved");
  assert.notEqual(r1.id, r2.id);

  const due = storage.listDueAcquisitions(Date.now() + 60_000);
  const shared = due.filter((a) => a.media.id === MOVIE.id);
  assert.equal(shared.length, 1, "one shared acquisition for both requesters");
  assert.equal(shared[0]?.state, "unsent");
  assert.equal(
    shared[0]?.instanceId,
    storage.getConfig()?.whisparr?.instanceId,
  );

  assert.throws(
    () => storage.createRequest(owner.id, MOVIE),
    (e: { code: string }) => e.code === "request_exists",
  );
  // A different identity is a separate acquisition.
  const r3 = storage.createRequest(owner.id, SCENE);
  storage.decideRequest(owner, r3.id, "declined");
  assert.equal(
    storage
      .listDueAcquisitions(Date.now() + 60_000)
      .filter((a) => a.media.id === SCENE.id).length,
    0,
    "declined requests never enqueue work",
  );
});

test("request lifecycle authorization: role checks, privacy, own-cancellation isolation", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(false), ownerUser(), "jf-owner-token");
  const [imported] = storage.importAccounts([otherUser()]);
  assert.ok(imported);
  const other = admit(imported.id);
  const owner = storage.getAccount(ownerUser().id) as Account;

  // Admission is read from the stored account, not from any stale caller data.
  const [disabled] = storage.importAccounts([
    { ...otherUser(), id: "e".repeat(32), name: "Disabled" },
  ]);
  assert.ok(disabled);
  assert.throws(
    () => storage.createRequest(disabled.id, MOVIE),
    (e: { code: string }) => e.code === "account_not_admitted",
  );

  const mine = storage.createRequest(other.id, MOVIE);
  const owners = storage.createRequest(owner.id, SCENE);

  assert.throws(
    () => storage.decideRequest(other, mine.id, "approved"),
    (e: { code: string }) => e.code === "forbidden",
  );
  assert.throws(
    () => storage.getRequest(owners.id, other),
    (e: { code: string }) => e.code === "request_not_found",
  );
  assert.ok(
    storage.listRequests(other).every((r) => r.accountId === other.id),
    "a requester's durable view never includes another user's history",
  );
  assert.equal(storage.listRequests(owner).length >= 2, true);

  // Only the owning user can cancel, even though an admin approved nothing yet.
  assert.throws(
    () => storage.cancelRequest(owner, mine.id),
    (e: { code: string }) => e.code === "request_not_found",
  );
  const cancelled = storage.cancelRequest(other, mine.id);
  assert.equal(cancelled.decision, "cancelled");
  assert.ok(cancelled.decidedAt);
  assert.throws(
    () => storage.cancelRequest(other, mine.id),
    (e: { code: string }) => e.code === "request_not_cancellable",
  );

  // Cancellation suppresses nothing else: owner's request is untouched and a
  // cancelled intent may be re-raised.
  assert.equal(storage.getRequest(owners.id, owner).decision, "pending");
  assert.equal(storage.createRequest(other.id, MOVIE).decision, "pending");

  // Approval path: with delivery absent the shared work is honestly blocked.
  const pending = storage.createRequest(other.id, SCENE);
  assert.throws(
    () => storage.decideRequest(other, pending.id, "approved"),
    (e: { code: string }) => e.code === "forbidden",
  );
  storage.decideRequest(owner, pending.id, "approved");
  assert.equal(
    storage.listDueAcquisitions(Date.now() + 60_000).length,
    0,
    "blocked work is not schedulable",
  );
  assert.throws(
    () => storage.decideRequest(owner, pending.id, "declined"),
    (e: { code: string }) => e.code === "request_not_pending",
  );
});

test("submission attempts are CAS-safe and recover to uncertain after restart", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  const owner = storage.getAccount(ownerUser().id) as Account;
  const request = storage.createRequest(owner.id, MOVIE);
  storage.decideRequest(owner, request.id, "approved");

  const due = storage.listDueAcquisitions(Date.now() + 60_000);
  assert.equal(due.length, 1);
  const workId = due[0]?.id as string;

  const first = storage.claimAcquisition(workId);
  assert.equal(first.record.state, "unsent");
  assert.throws(
    () => storage.claimAcquisition(workId),
    (e: { code: string }) => e.code === "already_claimed",
  );
  const attempt = storage.beginSubmission(workId, first.claimToken);
  assert.throws(
    () => storage.beginSubmission(workId, "stale-claim"),
    (e: { code: string }) => e.code === "claim_lost",
  );
  assert.throws(
    () =>
      storage.completeSubmission(
        workId,
        first.claimToken,
        "stale-attempt",
        "accepted",
      ),
    (e: { code: string }) => e.code === "attempt_lost",
  );

  // Process dies after the persisted attempt, before the result: restart and
  // recover. The old worker's tokens are dead; nothing may blindly re-POST.
  storage.closeStorage();
  assert.equal(storage.isInitialized(), true);
  storage.recoverAbandonedWork();
  assert.throws(
    () =>
      storage.completeSubmission(
        workId,
        first.claimToken,
        attempt.attemptToken,
        "accepted",
      ),
    (e: { code: string }) => e.code === "attempt_lost",
  );
  const recovered = storage.listDueAcquisitions(Date.now() + 60_000);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.state, "uncertain");
  assert.ok(recovered[0]?.lastError);
  assert.equal(recovered[0]?.claimToken, null);
  assert.ok(recovered[0]?.attemptAt, "attempt evidence survives recovery");

  // Reconciled resubmission accepted; the claim token gates further writes.
  const second = storage.claimAcquisition(recovered[0]?.id as string);
  const attempt2 = storage.beginSubmission(
    recovered[0]?.id as string,
    second.claimToken,
  );
  const done = storage.completeSubmission(
    recovered[0]?.id as string,
    second.claimToken,
    attempt2.attemptToken,
    "accepted",
  );
  assert.equal(done.state, "monitoring");
  assert.ok(done.submittedAt);
  assert.equal(done.attemptToken, null);

  // An unavailable check never touches state or the last successful observation.
  const outage = storage.recordAcquisitionObservation(
    done.id,
    { unavailable: true, reason: "whisparr timeout" },
    second.claimToken,
  );
  assert.equal(outage.state, "monitoring");
  assert.equal(outage.lastError, "whisparr timeout");
  assert.equal(outage.lastObservedAt, null);
  const observed = storage.recordAcquisitionObservation(
    done.id,
    { state: "downloading" },
    second.claimToken,
  );
  assert.equal(observed.state, "downloading");
  assert.ok(observed.lastObservedAt);
  assert.equal(observed.lastError, null);
  storage.releaseAcquisitionClaim(done.id, second.claimToken);
  assert.throws(
    () =>
      storage.recordAcquisitionObservation(
        done.id,
        { state: "imported" },
        second.claimToken,
      ),
    (e: { code: string }) => e.code === "claim_lost",
  );
});

test("autoApprove is an explicit grant: omitted means preserved, changes revoke sessions", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const acct = storage.importAccounts([otherUser()])[0];
  assert.ok(acct);
  admit(acct.id);
  const grant = storage.createSession(acct.id, "jf-token");
  assert.equal(storage.getAccount(acct.id)?.autoApprove, false);

  // Omission preserves and does not revoke.
  storage.updateAccount(acct.id, {
    enabled: true,
    role: "requester",
    libraryIds: [],
  });
  assert.equal(storage.getAccount(acct.id)?.autoApprove, false);
  assert.ok(storage.getSession(grant.token), "unchanged grants keep sessions");

  // Explicit change revokes the session immediately.
  const updated = storage.updateAccount(acct.id, {
    enabled: true,
    role: "requester",
    libraryIds: [],
    autoApprove: true,
  });
  assert.equal(updated.autoApprove, true);
  assert.equal(storage.getSession(grant.token), null);

  // Later omission keeps the granted value.
  storage.updateAccount(acct.id, {
    enabled: true,
    role: "requester",
    libraryIds: ["11111111111111111111111111111111"],
  });
  assert.equal(storage.getAccount(acct.id)?.autoApprove, true);
});
