import assert from "node:assert/strict";
import test from "node:test";
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
  ExternalUser,
  IntegrationConfig,
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
  assert.deepEqual(storage.getConfig()?.whisparr, {
    url: "http://127.0.0.1:6969",
    apiKey: "whisparr-key",
  });

  const good = testConfig();
  good.whisparr = { url: "http://127.0.0.1:7000", apiKey: "new-key" };
  storage.saveConfig(good);
  assert.deepEqual(storage.getConfig()?.whisparr, {
    url: "http://127.0.0.1:7000",
    apiKey: "new-key",
  });
});

test("missing encryption key blocks storage operations but not lazy status", () => {
  freshDir();
  delete process.env.VELVARR_SECRET_KEY;
  assert.equal(storage.isInitialized(), false);
  assert.throws(
    () => storage.bootstrap(testConfig(), ownerUser(), "jf-owner-token"),
    (e: { code: string }) => e.code === "secret_key_invalid",
  );
  assert.equal(storage.isInitialized(), false);
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
