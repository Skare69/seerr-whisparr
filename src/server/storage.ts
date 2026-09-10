import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  Account,
  ExternalUser,
  IntegrationConfig,
  Role,
  Session,
  SessionGrant,
} from "../lib/contracts.ts";
import { AppError } from "./http.ts";

// Schema identity: application_id spells 'VLVR', user_version is the schema version.
const APP_ID = 0x564c5652;
const SCHEMA_VERSION = 1;
// ponytail: fixed 7-day session TTL; make it an env knob only if an operator asks.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;
const ROLES: readonly Role[] = ["admin", "moderator", "requester"];

type AccountRow = {
  id: string;
  name: string;
  role: string;
  enabled: number;
  library_ids: string;
  is_owner: number;
};
type SessionJoinRow = AccountRow & {
  jellyfin_token: Buffer;
  expires_at: number;
};

type Statements = {
  hasConfig: StatementSync;
  ownerExists: StatementSync;
  getConfig: StatementSync;
  insertConfig: StatementSync;
  updateConfig: StatementSync;
  insertAccount: StatementSync;
  updateAccountName: StatementSync;
  updateAccountGrants: StatementSync;
  getAccount: StatementSync;
  listAccounts: StatementSync;
  insertSession: StatementSync;
  getSession: StatementSync;
  deleteSession: StatementSync;
  deleteAccountSessions: StatementSync;
};

const MIGRATIONS: Record<number, string> = {
  1: `
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
  `,
};

let db: DatabaseSync | null = null;
let stmts: Statements | null = null;

function open(): DatabaseSync {
  if (db) return db;
  const dir = process.env.VELVARR_DATA_DIR || "./data";
  mkdirSync(dir, { recursive: true });
  const d = new DatabaseSync(path.join(dir, "velvarr.sqlite"));
  try {
    d.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA foreign_keys = ON");
    d.exec("PRAGMA synchronous = NORMAL");
    validateAndMigrate(d);
  } catch (e) {
    // Refuse foreign/future databases without holding the file handle open.
    try {
      d.close();
    } catch {
      // already closed
    }
    throw e;
  }
  db = d;
  return d;
}

function hasUserTables(d: DatabaseSync): boolean {
  const row = d
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  return row.n > 0;
}

function validateAndMigrate(d: DatabaseSync): void {
  const appId = (
    d.prepare("PRAGMA application_id").get() as { application_id: number }
  ).application_id;
  const version = (
    d.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (appId === APP_ID) {
    if (version > SCHEMA_VERSION) {
      throw new AppError(
        500,
        "future_database",
        "database was created by a newer Velvarr version",
      );
    }
  } else if (appId === 0) {
    if (hasUserTables(d)) {
      throw new AppError(
        500,
        "foreign_database",
        "database file is not a Velvarr database",
      );
    }
    d.exec(`PRAGMA application_id = ${APP_ID}`);
  } else {
    throw new AppError(
      500,
      "foreign_database",
      "database file is not a Velvarr database",
    );
  }
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration === undefined) {
      throw new AppError(
        500,
        "missing_migration",
        `no migration for schema version ${v}`,
      );
    }
    d.exec("BEGIN IMMEDIATE");
    try {
      d.exec(migration);
      d.exec(`PRAGMA user_version = ${v}`);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

function S(): Statements {
  if (!stmts) {
    const d = open();
    stmts = {
      hasConfig: d.prepare("SELECT id FROM config WHERE id = 0"),
      ownerExists: d.prepare("SELECT id FROM accounts WHERE is_owner = 1"),
      getConfig: d.prepare("SELECT data FROM config WHERE id = 0"),
      insertConfig: d.prepare(
        "INSERT INTO config (id, data, updated_at) VALUES (0, ?, ?)",
      ),
      updateConfig: d.prepare(
        "UPDATE config SET data = ?, updated_at = ? WHERE id = 0",
      ),
      insertAccount: d.prepare(
        "INSERT INTO accounts (id, name, role, enabled, library_ids, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      updateAccountName: d.prepare("UPDATE accounts SET name = ? WHERE id = ?"),
      updateAccountGrants: d.prepare(
        "UPDATE accounts SET enabled = ?, role = ?, library_ids = ? WHERE id = ?",
      ),
      getAccount: d.prepare("SELECT * FROM accounts WHERE id = ?"),
      listAccounts: d.prepare(
        "SELECT * FROM accounts ORDER BY created_at ASC, id ASC",
      ),
      insertSession: d.prepare(
        "INSERT INTO sessions (token_hash, account_id, jellyfin_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ),
      getSession: d.prepare(
        "SELECT a.*, s.jellyfin_token, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?",
      ),
      deleteSession: d.prepare("DELETE FROM sessions WHERE token_hash = ?"),
      deleteAccountSessions: d.prepare(
        "DELETE FROM sessions WHERE account_id = ?",
      ),
    };
  }
  return stmts;
}

function inTransaction<T>(d: DatabaseSync, fn: () => T): T {
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      d.exec("ROLLBACK");
    } catch {
      // already rolled back / no transaction
    }
    throw e;
  }
}

function loadKey(): Buffer {
  const raw = process.env.VELVARR_SECRET_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new AppError(
      500,
      "secret_key_invalid",
      "VELVARR_SECRET_KEY must be exactly 64 hex characters",
    );
  }
  return Buffer.from(raw, "hex");
}

function encryptString(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decryptString(key: Buffer, blob: Buffer): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([
      decipher.update(blob.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(
      500,
      "secret_key_mismatch",
      "stored secrets cannot be decrypted with the configured VELVARR_SECRET_KEY",
    );
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    role: row.role as Role,
    enabled: row.enabled === 1,
    libraryIds: JSON.parse(row.library_ids) as string[],
    isOwner: row.is_owner === 1,
  };
}

function assertConfigShape(config: IntegrationConfig): void {
  const j = config?.jellyfin;
  if (
    !j ||
    typeof j.url !== "string" ||
    !j.url ||
    typeof j.externalUrl !== "string" ||
    typeof j.apiKey !== "string" ||
    !j.apiKey ||
    typeof j.serverId !== "string" ||
    !/^[0-9a-f]{32}$/.test(j.serverId) ||
    !Array.isArray(j.libraryIds) ||
    j.libraryIds.some((l) => typeof l !== "string" || !/^[0-9a-f]{32}$/.test(l))
  ) {
    throw new AppError(
      400,
      "invalid_config",
      "integration configuration is incomplete",
    );
  }
  if (config.whisparr !== undefined) {
    const w = config.whisparr;
    if (
      typeof w.url !== "string" ||
      !w.url ||
      typeof w.apiKey !== "string" ||
      !w.apiKey
    ) {
      throw new AppError(
        400,
        "invalid_config",
        "Whisparr configuration is incomplete",
      );
    }
  }
}

function issueSession(account: Account, jellyfinToken: string): SessionGrant {
  const d = open();
  const raw = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  S().insertSession.run(
    hashToken(raw),
    account.id,
    encryptString(loadKey(), jellyfinToken),
    now,
    expiresAt,
  );
  return { token: raw, expiresAt, account };
}

export function isInitialized(): boolean {
  return S().hasConfig.get() !== undefined;
}

export function getConfig(): IntegrationConfig | null {
  const row = S().getConfig.get() as { data: Buffer } | undefined;
  if (!row) return null;
  return JSON.parse(decryptString(loadKey(), row.data)) as IntegrationConfig;
}

export function saveConfig(config: IntegrationConfig): void {
  assertConfigShape(config);
  const d = open();
  inTransaction(d, () => {
    const existing = S().getConfig.get() as { data: Buffer } | undefined;
    if (existing) {
      const current = JSON.parse(
        decryptString(loadKey(), existing.data),
      ) as IntegrationConfig;
      if (current.jellyfin.serverId !== config.jellyfin.serverId) {
        throw new AppError(
          409,
          "server_mismatch",
          "refusing to change the configured Jellyfin server identity",
        );
      }
      S().updateConfig.run(
        encryptString(loadKey(), JSON.stringify(config)),
        Date.now(),
      );
    } else {
      S().insertConfig.run(
        encryptString(loadKey(), JSON.stringify(config)),
        Date.now(),
      );
    }
  });
}

export function bootstrap(
  config: IntegrationConfig,
  user: ExternalUser,
  userToken: string,
): SessionGrant {
  assertConfigShape(config);
  if (
    !user ||
    typeof user.id !== "string" ||
    !user.id ||
    typeof user.name !== "string" ||
    !user.name
  ) {
    throw new AppError(400, "invalid_identity", "owner identity is invalid");
  }
  if (typeof userToken !== "string" || !userToken) {
    throw new AppError(
      400,
      "invalid_identity",
      "owner Jellyfin token is required",
    );
  }
  const d = open();
  return inTransaction(d, () => {
    // BEGIN IMMEDIATE serializes concurrent bootstraps; the single-owner unique
    // index is the second line of defense.
    if (S().hasConfig.get() || S().ownerExists.get()) {
      throw new AppError(
        409,
        "already_initialized",
        "Velvarr is already initialized",
      );
    }
    const account: Account = {
      id: user.id,
      name: user.name,
      role: "admin",
      enabled: true,
      libraryIds: [...config.jellyfin.libraryIds],
      isOwner: true,
    };
    S().insertAccount.run(
      account.id,
      account.name,
      account.role,
      account.enabled ? 1 : 0,
      JSON.stringify(account.libraryIds),
      1,
      Date.now(),
    );
    S().insertConfig.run(
      encryptString(loadKey(), JSON.stringify(config)),
      Date.now(),
    );
    return issueSession(account, userToken);
  });
}

export function importAccounts(users: ExternalUser[]): Account[] {
  const d = open();
  return inTransaction(d, () => {
    const out: Account[] = [];
    for (const user of users) {
      if (!user || typeof user.id !== "string" || !user.id) {
        throw new AppError(
          400,
          "invalid_identity",
          "imported user identity is invalid",
        );
      }
      const existing = S().getAccount.get(user.id) as AccountRow | undefined;
      if (existing) {
        // No username merge, no re-enable, no grant/role/owner change: name only.
        S().updateAccountName.run(
          typeof user.name === "string" && user.name
            ? user.name
            : existing.name,
          user.id,
        );
      } else {
        S().insertAccount.run(
          user.id,
          user.name ?? "",
          "requester",
          0,
          "[]",
          0,
          Date.now(),
        );
      }
      out.push(rowToAccount(S().getAccount.get(user.id) as AccountRow));
    }
    return out;
  });
}

export function listAccounts(): Account[] {
  return (S().listAccounts.all() as AccountRow[]).map(rowToAccount);
}

export function getAccount(id: string): Account | null {
  const row = S().getAccount.get(id) as AccountRow | undefined;
  return row ? rowToAccount(row) : null;
}

export function updateAccount(
  id: string,
  changes: { enabled: boolean; role: Role; libraryIds: string[] },
): Account {
  if (
    typeof changes?.enabled !== "boolean" ||
    !ROLES.includes(changes.role) ||
    !Array.isArray(changes.libraryIds)
  ) {
    throw new AppError(
      400,
      "invalid_account_update",
      "account update is invalid",
    );
  }
  const existing = getAccount(id);
  if (!existing)
    throw new AppError(404, "account_not_found", "account not found");
  if (existing.isOwner) {
    if (!changes.enabled) {
      throw new AppError(
        403,
        "owner_protected",
        "the owner account cannot be disabled",
      );
    }
    if (changes.role !== "admin") {
      throw new AppError(
        403,
        "owner_protected",
        "the owner account cannot be demoted",
      );
    }
  }
  const configured = getConfig()?.jellyfin.libraryIds ?? [];
  const unknown = changes.libraryIds.filter((l) => !configured.includes(l));
  if (unknown.length > 0) {
    throw new AppError(
      400,
      "unknown_library",
      "library grants must be a subset of configured libraries",
    );
  }
  const d = open();
  inTransaction(d, () => {
    S().updateAccountGrants.run(
      changes.enabled ? 1 : 0,
      changes.role,
      JSON.stringify(changes.libraryIds),
      id,
    );
    const changed =
      existing.enabled !== changes.enabled ||
      existing.role !== changes.role ||
      existing.libraryIds.length !== changes.libraryIds.length ||
      existing.libraryIds.some((l, i) => l !== changes.libraryIds[i]);
    if (changed) S().deleteAccountSessions.run(id);
  });
  return getAccount(id) as Account;
}

export function createSession(
  accountId: string,
  jellyfinToken: string,
): SessionGrant {
  if (typeof jellyfinToken !== "string" || !jellyfinToken) {
    throw new AppError(400, "invalid_identity", "Jellyfin token is required");
  }
  const account = getAccount(accountId);
  if (!account)
    throw new AppError(404, "account_not_found", "account not found");
  if (!account.enabled)
    throw new AppError(403, "account_disabled", "account is not admitted");
  return issueSession(account, jellyfinToken);
}

export function getSession(rawToken: string): Session | null {
  if (typeof rawToken !== "string" || !rawToken) return null;
  const row = S().getSession.get(hashToken(rawToken)) as
    SessionJoinRow | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    S().deleteSession.run(hashToken(rawToken));
    return null;
  }
  if (row.enabled !== 1) return null;
  return {
    account: rowToAccount(row),
    jellyfinToken: decryptString(loadKey(), row.jellyfin_token),
  };
}

export function revokeSession(rawToken: string): void {
  if (typeof rawToken !== "string" || !rawToken) return;
  S().deleteSession.run(hashToken(rawToken));
}

export function closeStorage(): void {
  stmts = null;
  if (db) {
    try {
      db.close();
    } catch {
      // already closed
    }
    db = null;
  }
}
