import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../src/server/http.ts";
import type {
  Account,
  CatalogDetail,
  CatalogReference,
  ExternalUser,
  IntegrationConfig,
  MediaKind,
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
  // Migrated forward, not pinned to a literal that every new migration breaks.
  assert.ok(version > 1, "v1 database must be migrated forward");
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

test("studio catalog records persist, while performer and studio references stay unrequestable", () => {
  freshDir();
  storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token");
  const studioRef: CatalogReference = {
    provider: "stashdb",
    kind: "studio",
    id: "c2f1a4d3-8b67-4c5e-9a01-776655443322",
  };
  const record = storage.upsertCatalogRecord({
    reference: studioRef,
    title: "Vixen",
    credits: [],
    tags: [],
    related: [],
    links: [],
    aliases: [],
  });
  assert.equal(record.reference.kind, "studio");
  assert.deepEqual(storage.getCatalogRecord(record.id)?.reference, studioRef);
  assert.equal(storage.getCatalogRecordByReference(studioRef)?.title, "Vixen");
  const [imported] = storage.importAccounts([otherUser()]);
  assert.ok(imported);
  const requester = admit(imported.id);
  // MediaReference narrowing is compile-time only; this mirrors the caller a
  // non-media reference must be refused by, exercising the runtime guard.
  const asMedia = (r: CatalogReference): MediaReference => ({
    provider: r.provider,
    kind: r.kind as MediaKind,
    id: r.id,
  });
  const performerRef: CatalogReference = {
    provider: "tpdb",
    kind: "performer",
    id: "d4e5f6a7-b8c9-4d0e-9223-887766554433",
  };
  for (const ref of [performerRef, studioRef]) {
    assert.throws(
      () => storage.createRequest(requester.id, asMedia(ref)),
      (e: { code: string }) => e.code === "invalid_reference",
    );
    assert.throws(
      () => storage.getAcquisitionByReference(asMedia(ref)),
      (e: { code: string }) => e.code === "invalid_reference",
    );
  }
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
  // Shared work stays private per user: neither requester sees the other's
  // request history for the same target.
  assert.ok(
    storage.listRequests(other).every((r) => r.accountId === other.id),
    "a requester's history view never includes the other approver's request",
  );
  assert.throws(
    () => storage.getRequest(r1.id, other),
    (e: { code: string }) => e.code === "request_not_found",
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

test("the autoApprove grant approves only the granted user's own request", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  const [imported] = storage.importAccounts([otherUser()]);
  assert.ok(imported);
  const plain = admit(imported.id);
  const granted = storage.updateAccount(imported.id, {
    enabled: true,
    role: "requester",
    libraryIds: [],
    autoApprove: true,
  });
  const owner = storage.getAccount(ownerUser().id) as Account;

  // Without the grant a requester cannot decide at all.
  const own = storage.createRequest(plain.id, MOVIE);
  assert.throws(
    () => storage.decideRequest(plain, own.id, "approved"),
    (e: { code: string }) => e.code === "forbidden",
  );

  // With it, self-approval works and enqueues the shared work.
  assert.equal(
    storage.decideRequest(granted, own.id, "approved").decision,
    "approved",
  );
  assert.equal(
    storage
      .listDueAcquisitions(Date.now() + 60_000)
      .filter((a) => a.media.id === MOVIE.id).length,
    1,
  );

  // The grant is not a moderation role: it cannot touch another user's
  // request, and it cannot decline anything.
  const ownersRequest = storage.createRequest(owner.id, SCENE);
  assert.throws(
    () => storage.decideRequest(granted, ownersRequest.id, "approved"),
    (e: { code: string }) => e.code === "forbidden",
  );
  const second = storage.createRequest(granted.id, SCENE);
  assert.throws(
    () => storage.decideRequest(granted, second.id, "declined"),
    (e: { code: string }) => e.code === "forbidden",
  );
});

test("enabling delivery revives work approved while it was disabled", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(false), ownerUser(), "jf-owner-token");
  const owner = storage.getAccount(ownerUser().id) as Account;
  const request = storage.createRequest(owner.id, MOVIE);
  storage.decideRequest(owner, request.id, "approved");
  assert.equal(
    storage.listDueAcquisitions(Date.now() + 60_000).length,
    0,
    "blocked work is not schedulable while delivery is off",
  );
  const blocked = storage.getAcquisitionByReference(MOVIE);
  assert.equal(blocked?.state, "blocked");

  storage.saveConfig(deliveryConfig(true));
  const due = storage.listDueAcquisitions(Date.now() + 60_000);
  assert.equal(due.length, 1, "enabling delivery must requeue blocked work");
  assert.equal(due[0]?.state, "unsent");
  assert.equal(due[0]?.id, blocked?.id, "the same shared row is revived");
});

test("an upgraded config without an instance identity is repaired at startup", () => {
  freshDir();
  const config = deliveryConfig(true);
  storage.bootstrap(config, ownerUser(), "jf-owner-token");
  const owner = storage.getAccount(ownerUser().id) as Account;

  // Simulate a pre-instanceId installation: same server, identity stripped.
  const legacy = storage.getConfig() as IntegrationConfig;
  const whisparr = legacy.whisparr as NonNullable<
    IntegrationConfig["whisparr"]
  >;
  delete whisparr.instanceId;
  storage.closeStorage();
  const raw = new DatabaseSync(join(currentDir, "velvarr.sqlite"));
  raw
    .prepare("UPDATE config SET data = ?, updated_at = ? WHERE id = 0")
    .run(encryptForTest(JSON.stringify(legacy)), Date.now());
  raw.close();
  assert.equal(storage.getConfig()?.whisparr?.instanceId, undefined);

  // Approving before repair must refuse rather than silently enqueue nothing.
  const early = storage.createRequest(owner.id, MOVIE);
  assert.throws(
    () => storage.decideRequest(owner, early.id, "approved"),
    (e: { code: string }) => e.code === "instance_identity_missing",
  );

  storage.initializeStorage();
  assert.ok(storage.getConfig()?.whisparr?.instanceId, "identity backfilled");
  storage.decideRequest(owner, early.id, "approved");
  assert.equal(
    storage.listDueAcquisitions(Date.now() + 60_000).length,
    1,
    "approval after repair enqueues real shared work",
  );
});

test("the last withdrawal suppresses only undispatched work; sent work survives", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  const owner = storage.getAccount(ownerUser().id) as Account;

  // Last withdrawal of undispatched work removes the shared row only.
  const r1 = storage.createRequest(owner.id, MOVIE);
  storage.decideRequest(owner, r1.id, "approved");
  const unsent = storage.getAcquisitionByReference(MOVIE);
  assert.ok(unsent);
  assert.equal(unsent.state, "unsent");
  storage.cancelRequest(owner, r1.id);
  assert.equal(
    storage.getAcquisitionByReference(MOVIE),
    null,
    "the last withdrawal suppresses undispatched work",
  );
  assert.equal(
    storage
      .listDueAcquisitions(Date.now() + 60_000)
      .filter((a) => a.media.id === MOVIE.id).length,
    0,
  );
  // History is preserved and a re-request creates fresh work, never a
  // resurrection of the half-cancelled row.
  assert.equal(storage.getRequest(r1.id, owner).decision, "cancelled");
  const r1b = storage.createRequest(owner.id, MOVIE);
  storage.decideRequest(owner, r1b.id, "approved");
  const fresh = storage.getAcquisitionByReference(MOVIE);
  assert.ok(fresh);
  assert.notEqual(fresh.id, unsent.id, "re-requested work is a fresh row");
  assert.equal(fresh.state, "unsent");

  // A non-last withdrawal suppresses nothing: another intent remains.
  const [imported] = storage.importAccounts([otherUser()]);
  assert.ok(imported);
  const other = admit(imported.id);
  const r2 = storage.createRequest(other.id, MOVIE);
  storage.decideRequest(owner, r2.id, "approved");
  storage.cancelRequest(owner, r1b.id);
  const still = storage.getAcquisitionByReference(MOVIE);
  assert.ok(still, "a non-last withdrawal suppresses nothing");
  assert.equal(still.id, fresh.id);

  // Accepted work survives even the last withdrawal.
  const claim = storage.claimAcquisition(still.id);
  const attempt = storage.beginSubmission(still.id, claim.claimToken);
  storage.completeSubmission(
    still.id,
    claim.claimToken,
    attempt.attemptToken,
    "accepted",
  );
  storage.releaseAcquisitionClaim(still.id, claim.claimToken);
  storage.cancelRequest(other, r2.id);
  const kept = storage.getAcquisitionByReference(MOVIE);
  assert.ok(kept, "accepted work is never deleted by a withdrawal");
  assert.equal(kept.state, "monitoring");
  // In-flight (submitting) work survives too: the external system may
  // already hold the add.
  const inflightRef: MediaReference = {
    provider: "tpdb",
    kind: "movie",
    id: "33333333-3333-4333-8333-333333333333",
  };
  const r5 = storage.createRequest(owner.id, inflightRef);
  storage.decideRequest(owner, r5.id, "approved");
  const inflight = storage.getAcquisitionByReference(inflightRef);
  assert.ok(inflight);
  const claim2 = storage.claimAcquisition(inflight.id);
  storage.beginSubmission(inflight.id, claim2.claimToken);
  storage.cancelRequest(owner, r5.id);
  assert.equal(
    storage.getAcquisitionByReference(inflightRef)?.state,
    "submitting",
    "in-flight work survives a withdrawal",
  );

  // Undispatched blocked work is withdrawn by the last withdrawal as well.
  storage.saveConfig(deliveryConfig(false));
  const r3 = storage.createRequest(owner.id, SCENE);
  storage.decideRequest(owner, r3.id, "approved");
  const blocked = storage.getAcquisitionByReference(SCENE);
  assert.ok(blocked);
  assert.equal(blocked.state, "blocked");
  storage.cancelRequest(owner, r3.id);
  assert.equal(
    storage.getAcquisitionByReference(SCENE),
    null,
    "undispatched blocked work is withdrawn too",
  );
});

test("observations update changed facts; a proven absence is distinct from an outage", () => {
  freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  const owner = storage.getAccount(ownerUser().id) as Account;
  const request = storage.createRequest(owner.id, MOVIE);
  storage.decideRequest(owner, request.id, "approved");
  const work = storage.getAcquisitionByReference(MOVIE);
  assert.ok(work);

  // A changed path must overwrite the stored facts, never stick stale.
  const first = storage.recordAcquisitionObservation(work.id, {
    state: "monitoring",
    item: { whisparrId: 5, path: "/data/old", title: "Old" },
  });
  assert.equal(first.whisparrPath, "/data/old");
  const moved = storage.recordAcquisitionObservation(work.id, {
    state: "monitoring",
    item: { whisparrId: 6, path: "/data/new", title: "New" },
  });
  assert.equal(moved.whisparrPath, "/data/new", "a changed path is persisted");
  assert.ok(moved.lastObservedAt);

  // An outage is an unknown check: facts and the observation survive.
  const outage = storage.recordAcquisitionObservation(work.id, {
    unavailable: true,
    reason: "whisparr timeout",
  });
  assert.equal(outage.whisparrPath, "/data/new");
  assert.equal(outage.lastObservedAt, moved.lastObservedAt);
  assert.ok(outage.lastErrorAt);
  assert.equal(
    storage.hasAuthoritativeAbsence(outage),
    false,
    "an outage is never an authoritative absence",
  );
  assert.equal(
    storage.isObservationStale(outage, (outage.lastErrorAt ?? 0) + 1),
    false,
    "inside the threshold the fact is not yet stale",
  );
  assert.equal(
    storage.isObservationStale(
      outage,
      (outage.lastErrorAt ?? 0) + 10 * 60_000 + 1,
    ),
    true,
    "aged past the threshold with a later failed check is stale",
  );

  // A fresh success heals staleness.
  const healed = storage.recordAcquisitionObservation(work.id, {
    state: "downloading",
    item: { whisparrId: 6, path: "/data/new" },
  });
  assert.equal(
    storage.isObservationStale(
      healed,
      (healed.lastObservedAt ?? 0) + 10 * 60_000 + 1,
    ),
    false,
    "a newer successful observation is never stale",
  );

  // Proven absence from a successful lookup: facts cleared, state and the
  // last real observation intact — distinguishable from any outage.
  const absent = storage.recordAcquisitionObservation(work.id, {
    absent: true,
    reason: "whisparr no longer has this identity",
  });
  assert.equal(
    storage.hasAuthoritativeAbsence(absent),
    true,
    "a proven removal is authoritative",
  );
  assert.equal(absent.whisparrId, null);
  assert.equal(absent.whisparrPath, null);
  assert.equal(absent.whisparrTitle, null);
  assert.equal(absent.state, "downloading", "absence keeps the recorded state");
  assert.equal(
    absent.lastObservedAt,
    healed.lastObservedAt,
    "absence never overwrites the last real observation",
  );
  const outage2 = storage.recordAcquisitionObservation(work.id, {
    unavailable: true,
    reason: "down again",
  });
  assert.equal(
    storage.hasAuthoritativeAbsence(outage2),
    true,
    "an outage after a proven absence keeps the authoritative absence",
  );
});

// --- M5 durability: failed migrations, backup/restore, restart reconciliation ---

const BACKUP_SCRIPT = fileURLToPath(
  new URL("../scripts/backup.mjs", import.meta.url),
);

/** Runs the real backup script against a data directory. */
function runBackup(dataDir: string, destination: string): void {
  const res = spawnSync(process.execPath, [BACKUP_SCRIPT, destination], {
    env: {
      ...process.env,
      VELVARR_DATA_DIR: dataDir,
      VELVARR_SECRET_KEY: KEY_A,
    },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `backup script failed: ${res.stderr}`);
}

/** Fabricates a schema-v3 database whose data rejects migration 4: the
 * unique identity index is missing and two catalog rows share one identity,
 * so migration 4's LAST statement (CREATE UNIQUE INDEX) fails only after
 * CREATE TABLE / INSERT / DROP TABLE / RENAME all succeeded in-transaction. */
function fabricateV3(dir: string): void {
  const v3 = new DatabaseSync(join(dir, "velvarr.sqlite"));
  v3.exec("PRAGMA application_id = 0x564c5652");
  v3.exec(`
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
    ALTER TABLE accounts ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0
      CHECK (auto_approve IN (0, 1));
    CREATE TABLE catalog_identities (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('tpdb', 'stashdb')),
      kind TEXT NOT NULL CHECK (kind IN ('movie', 'scene', 'performer')),
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE requests (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('tpdb', 'stashdb')),
      kind TEXT NOT NULL CHECK (kind IN ('movie', 'scene')),
      external_id TEXT NOT NULL,
      decision TEXT NOT NULL
        CHECK (decision IN ('pending', 'approved', 'declined', 'cancelled')),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE UNIQUE INDEX requests_active_intent
      ON requests (account_id, provider, kind, external_id)
      WHERE decision IN ('pending', 'approved');
    CREATE TABLE acquisitions (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('tpdb', 'stashdb')),
      kind TEXT NOT NULL CHECK (kind IN ('movie', 'scene')),
      external_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'unsent', 'submitting', 'uncertain', 'monitoring',
          'downloading', 'imported', 'failed', 'blocked'
        )
      ),
      claim_token TEXT,
      attempt_token TEXT,
      claimed_at INTEGER,
      attempt_at INTEGER,
      due_at INTEGER,
      submitted_at INTEGER,
      last_observed_at INTEGER,
      last_error_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX acquisitions_identity
      ON acquisitions (instance_id, provider, kind, external_id);
    CREATE INDEX acquisitions_due ON acquisitions (due_at);
    ALTER TABLE acquisitions ADD COLUMN whisparr_id INTEGER;
    ALTER TABLE acquisitions ADD COLUMN whisparr_path TEXT;
    ALTER TABLE acquisitions ADD COLUMN whisparr_title TEXT;
  `);
  v3.exec("PRAGMA user_version = 3");
  const now = Date.now();
  v3.prepare(
    "INSERT INTO accounts (id, name, role, enabled, library_ids, is_owner, created_at) VALUES (?, 'Owner', 'admin', 1, ?, 1, ?)",
  ).run(ownerUser().id, JSON.stringify(testConfig().jellyfin.libraryIds), now);
  v3.prepare("INSERT INTO config (id, data, updated_at) VALUES (0, ?, ?)").run(
    encryptForTest(JSON.stringify(testConfig())),
    now,
  );
  v3.prepare(
    "INSERT INTO catalog_identities (id, provider, kind, external_id, title, created_at, updated_at) VALUES ('cat-v3-1', 'tpdb', 'movie', ?, 'Restore Target', ?, ?)",
  ).run(MOVIE.id, now, now);
  v3.prepare(
    "INSERT INTO catalog_identities (id, provider, kind, external_id, title, created_at, updated_at) VALUES ('cat-v3-2', 'tpdb', 'movie', ?, 'Restore Duplicate', ?, ?)",
  ).run(MOVIE.id, now, now);
  v3.prepare(
    "INSERT INTO requests (id, account_id, provider, kind, external_id, decision, created_at, decided_at) VALUES ('req-v3-1', ?, 'tpdb', 'movie', ?, 'approved', ?, ?)",
  ).run(ownerUser().id, MOVIE.id, now, now);
  v3.prepare(
    "INSERT INTO acquisitions (id, instance_id, provider, kind, external_id, state, attempt_token, attempt_at, due_at, created_at, updated_at) VALUES ('acq-v3-1', 'instance-v3', 'tpdb', 'movie', ?, 'submitting', 'attempt-v3', ?, ?, ?, ?)",
  ).run(MOVIE.id, now, now, now, now);
  v3.close();
}

/** Logical dump: identity, version, schema objects, and every row of every
 * table — journal-mode and byte-level churn from failed open attempts ignored. */
function logicalState(file: string): {
  applicationId: number;
  userVersion: number;
  objects: string[];
  rows: Record<string, unknown[]>;
} {
  const d = new DatabaseSync(file);
  try {
    // Trusted shape: the module's own PRAGMA result rows.
    const appIdRow = d.prepare("PRAGMA application_id").get() as {
      application_id: number;
    };
    const verRow = d.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const masterRows = d
      .prepare("SELECT type || ':' || name AS o FROM sqlite_master ORDER BY o")
      .all() as { o: string }[];
    const tableRows = d
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const rows: Record<string, unknown[]> = {};
    for (const t of tableRows) {
      rows[t.name] = d
        .prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`)
        .all();
    }
    return {
      applicationId: appIdRow.application_id,
      userVersion: verRow.user_version,
      objects: masterRows.map((r) => r.o),
      rows,
    };
  } finally {
    d.close();
  }
}

function rawConfigBlob(dir: string): Buffer {
  const d = new DatabaseSync(join(dir, "velvarr.sqlite"));
  try {
    const row = d.prepare("SELECT data FROM config WHERE id = 0").get() as {
      data: Buffer;
    };
    return row.data;
  } finally {
    d.close();
  }
}

test("a failed migration rolls back completely: version, schema, and every row survive; the error names the version without leaking paths or keys", () => {
  const dir = freshDir();
  storage.closeStorage();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(dir, `velvarr.sqlite${suffix}`), { force: true });

  fabricateV3(dir);
  const before = logicalState(join(dir, "velvarr.sqlite"));
  assert.equal(before.userVersion, 3);

  let failure: unknown;
  try {
    storage.isInitialized();
  } catch (e) {
    failure = e;
  }
  // Storage contract: open/migration failures surface as AppError with a code.
  assert.ok(
    failure instanceof AppError,
    "failure must surface as an explicit error",
  );
  assert.equal(failure.code, "migration_failed");
  assert.match(failure.message, /version 4/);
  assert.ok(!failure.message.includes(dir), "must not leak the data dir path");
  assert.ok(!failure.message.includes(KEY_A), "must not leak key material");

  // Nothing moved: same version, same schema objects, same rows — including
  // the duplicate rows. No catalog_identities_new may survive.
  const after = logicalState(join(dir, "velvarr.sqlite"));
  assert.equal(after.userVersion, 3, "user_version must be unchanged");
  assert.deepEqual(after.objects, before.objects, "no partial schema survives");
  assert.deepEqual(after.rows, before.rows, "every pre-existing row intact");
  assert.ok(after.objects.includes("table:catalog_identities"));
  assert.ok(!after.objects.includes("table:catalog_identities_new"));

  // Conflict resolved, the same database migrates and pre-existing rows are
  // readable with the same key.
  const repair = new DatabaseSync(join(dir, "velvarr.sqlite"));
  repair.prepare("DELETE FROM catalog_identities WHERE id = 'cat-v3-2'").run();
  repair.close();
  assert.equal(storage.isInitialized(), true);
  const raw = new DatabaseSync(join(dir, "velvarr.sqlite"));
  const versionRow = raw.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  raw.close();
  assert.equal(versionRow.user_version, 4);
  assert.deepEqual(storage.getConfig(), testConfig());
  const owner = storage.getAccount(ownerUser().id);
  assert.ok(owner);
  assert.equal(owner.isOwner, true);
  assert.equal(storage.getRequest("req-v3-1", owner)?.decision, "approved");
  const acq = storage.getAcquisitionByReference(MOVIE, "instance-v3");
  assert.equal(acq?.state, "submitting");
  assert.equal(acq?.attemptToken, "attempt-v3");
  const catalog = storage.getCatalogRecordByReference({
    provider: "tpdb",
    kind: "movie",
    id: MOVIE.id,
  });
  assert.equal(catalog?.title, "Restore Target");
});

test("backup restores into a fresh data directory with everything intact; a wrong key fails safely", () => {
  const dir = freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  // getConfig includes the storage-owned whisparr instanceId; compare against
  // the stored form, not the input shape.
  const savedConfig = storage.getConfig();
  assert.ok(savedConfig);
  const owner = storage.getAccount(ownerUser().id) as Account;
  const [imported] = storage.importAccounts([otherUser()]);
  assert.ok(imported);
  const admitted = admit(imported.id);
  const catalog = storage.upsertCatalogRecord(movieDetail());
  const request = storage.createRequest(admitted.id, MOVIE);
  const decided = storage.decideRequest(owner, request.id, "approved");
  const due = storage.listDueAcquisitions(Date.now() + 60_000);
  assert.equal(due.length, 1);
  const work = due[0];
  assert.ok(work);
  const workId = work.id;
  const claimed = storage.claimAcquisition(workId);
  storage.recordAcquisitionObservation(
    workId,
    {
      state: "monitoring",
      item: { whisparrId: 42, path: "/data/xxx", title: "Pirates II" },
    },
    claimed.claimToken,
  );
  storage.releaseAcquisitionClaim(workId, claimed.claimToken);
  const grant = storage.createSession(admitted.id, "jf-restore-session");
  const before = storage.getAcquisitionByReference(MOVIE);
  assert.ok(before);

  // Snapshot while the database is in use: this handle and its live WAL stay open.
  const snapshot = join(dir, "snapshot.sqlite");
  runBackup(dir, snapshot);
  assert.ok(existsSync(snapshot));
  assert.ok(
    storage.getSession(grant.token),
    "live db keeps working after snapshot",
  );

  // Restore = copy the snapshot in as velvarr.sqlite of a NEW data directory.
  const restored = mkdtempSync(join(tmpdir(), "velvarr-restore-"));
  copyFileSync(snapshot, join(restored, "velvarr.sqlite"));
  storage.closeStorage();
  process.env.VELVARR_DATA_DIR = restored;
  assert.equal(storage.isInitialized(), true);
  assert.deepEqual(storage.getConfig(), savedConfig);
  assert.deepEqual(storage.getAccount(ownerUser().id), owner);
  assert.deepEqual(storage.getAccount(admitted.id), admitted);
  assert.equal(storage.getSession(grant.token)?.account.id, admitted.id);
  assert.deepEqual(storage.getCatalogRecord(catalog.id), catalog);
  assert.deepEqual(storage.getRequest(request.id, owner), decided);
  assert.deepEqual(storage.getAcquisitionByReference(MOVIE), before);

  // A wrong key fails loudly and corrupts nothing on the restored copy.
  storage.closeStorage();
  const wrongKey = mkdtempSync(join(tmpdir(), "velvarr-wrongkey-"));
  copyFileSync(snapshot, join(wrongKey, "velvarr.sqlite"));
  process.env.VELVARR_DATA_DIR = wrongKey;
  process.env.VELVARR_SECRET_KEY = KEY_B;
  assert.equal(storage.isInitialized(), true);
  const blobBefore = rawConfigBlob(wrongKey);
  assert.throws(
    () => storage.getConfig(),
    (e: { code: string }) => e.code === "secret_key_mismatch",
  );
  assert.deepEqual(rawConfigBlob(wrongKey), blobBefore);
  storage.closeStorage();

  // The right key still opens the untouched copy.
  process.env.VELVARR_SECRET_KEY = KEY_A;
  assert.deepEqual(storage.getConfig(), savedConfig);
  storage.closeStorage();
  rmSync(restored, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
  rmSync(wrongKey, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});

test("restored in-flight submissions reconcile to uncertain, never unsent; identity and audit evidence survive", () => {
  const dir = freshDir();
  storage.bootstrap(deliveryConfig(true), ownerUser(), "jf-owner-token");
  const savedConfig = storage.getConfig();
  assert.ok(savedConfig);
  const owner = storage.getAccount(ownerUser().id) as Account;
  const request = storage.createRequest(owner.id, MOVIE);
  storage.decideRequest(owner, request.id, "approved");
  const due = storage.listDueAcquisitions(Date.now() + 60_000);
  assert.equal(due.length, 1);
  const work = due[0];
  assert.ok(work);
  const workId = work.id;
  const claimed = storage.claimAcquisition(workId);
  const attempt = storage.beginSubmission(workId, claimed.claimToken);
  const submitting = storage.getAcquisitionByReference(MOVIE);
  assert.equal(submitting?.state, "submitting");
  const beforeRequest = storage.getRequest(request.id, owner);

  // Crash-equivalent: snapshot mid-submission, restore elsewhere.
  const snapshot = join(dir, "snapshot.sqlite");
  runBackup(dir, snapshot);
  const restored = mkdtempSync(join(tmpdir(), "velvarr-reconcile-"));
  copyFileSync(snapshot, join(restored, "velvarr.sqlite"));
  storage.closeStorage();
  process.env.VELVARR_DATA_DIR = restored;
  assert.equal(storage.isInitialized(), true);

  // Opening alone must not touch the work; recovery is an explicit step.
  const untouched = storage.getAcquisitionByReference(MOVIE);
  assert.equal(untouched?.state, "submitting");
  assert.equal(untouched?.attemptToken, attempt.attemptToken);

  storage.recoverAbandonedWork();
  const reconciled = storage.getAcquisitionByReference(MOVIE);
  assert.ok(reconciled);
  assert.equal(reconciled.state, "uncertain", "uncertain, not unsent");
  assert.equal(reconciled.submittedAt, null);
  assert.equal(reconciled.attemptAt, submitting?.attemptAt);
  assert.equal(
    reconciled.attemptToken,
    attempt.attemptToken,
    "attempt evidence survives recovery",
  );
  assert.equal(reconciled.claimToken, null);
  assert.match(reconciled.lastError ?? "", /unknown/i);
  assert.equal(reconciled.instanceId, submitting?.instanceId);
  assert.deepEqual(reconciled.media, MOVIE);
  assert.equal(reconciled.createdAt, submitting?.createdAt);
  assert.deepEqual(storage.getRequest(request.id, owner), beforeRequest);
  assert.deepEqual(storage.getConfig(), savedConfig);
  storage.closeStorage();
  rmSync(restored, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});
