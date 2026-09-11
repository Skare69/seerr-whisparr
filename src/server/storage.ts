import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  Account,
  AttemptOutcome,
  AcquisitionObservation,
  AcquisitionRecord,
  CatalogCredit,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogRecord,
  CatalogReference,
  ExternalLink,
  ExternalUser,
  IntegrationConfig,
  MediaKind,
  MediaReference,
  RequestDecision,
  RequestRecord,
  Role,
  Session,
  SessionGrant,
} from "../lib/contracts.ts";
import { AppError } from "./http.ts";

// Schema identity: application_id spells 'VLVR', user_version is the schema version.
const APP_ID = 0x564c5652;
const SCHEMA_VERSION = 4;
// ponytail: fixed 7-day session TTL; make it an env knob only if an operator asks.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;
const ROLES: readonly Role[] = ["admin", "moderator", "requester"];
// ponytail: fixed 60s recheck delay after failed/unknown outcomes; a backoff
// policy is worth adding only when the reconciliation loop exists to tune.
const RECHECK_DELAY_MS = 60_000;
// ponytail: fixed 10-minute staleness ceiling — ten missed 60s recheck passes
// before a fact counts as aged; retune only alongside RECHECK_DELAY_MS.
const STALE_OBSERVATION_MS = 10 * 60_000;
const PROVIDERS: readonly CatalogProvider[] = ["tpdb", "stashdb"];
const MEDIA_KINDS: readonly MediaKind[] = ["movie", "scene"];
const CATALOG_KINDS: readonly CatalogKind[] = [
  "movie",
  "scene",
  "performer",
  "studio",
];
const OBSERVED_STATES = ["monitoring", "downloading", "imported"] as const;
const SCHEDULABLE_STATES = [
  "unsent",
  "uncertain",
  "monitoring",
  "downloading",
  "failed",
] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AccountRow = {
  id: string;
  name: string;
  role: string;
  enabled: number;
  library_ids: string;
  is_owner: number;
  auto_approve: number;
};
type SessionJoinRow = AccountRow & {
  jellyfin_token: Buffer;
  expires_at: number;
};
type CatalogRow = {
  id: string;
  provider: string;
  kind: string;
  external_id: string;
  title: string;
  created_at: number;
  updated_at: number;
};
type RequestRow = {
  id: string;
  account_id: string;
  provider: string;
  kind: string;
  external_id: string;
  decision: string;
  created_at: number;
  decided_at: number | null;
};
type AcquisitionRow = {
  id: string;
  instance_id: string;
  provider: string;
  kind: string;
  external_id: string;
  state: string;
  claim_token: string | null;
  attempt_token: string | null;
  claimed_at: number | null;
  attempt_at: number | null;
  due_at: number | null;
  submitted_at: number | null;
  last_observed_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  whisparr_id: number | null;
  whisparr_path: string | null;
  whisparr_title: string | null;
  created_at: number;
  updated_at: number;
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
  insertCatalog: StatementSync;
  updateCatalogTitle: StatementSync;
  getCatalogById: StatementSync;
  getCatalogByRef: StatementSync;
  insertRequest: StatementSync;
  getRequest: StatementSync;
  listAllRequests: StatementSync;
  listAccountRequests: StatementSync;
  decideRequest: StatementSync;
  cancelOwnRequest: StatementSync;
  countActiveRequestsExcept: StatementSync;
  insertAcquisition: StatementSync;
  getAcquisition: StatementSync;
  getAcquisitionByIdentity: StatementSync;
  listDueAcquisitions: StatementSync;
  claimAcquisition: StatementSync;
  beginSubmission: StatementSync;
  completeSubmissionAccepted: StatementSync;
  completeSubmissionUncertain: StatementSync;
  completeSubmissionFailed: StatementSync;
  requeueBlocked: StatementSync;
  recordObservation: StatementSync;
  recordObservationError: StatementSync;
  recordAbsence: StatementSync;
  withdrawUndispatched: StatementSync;
  releaseClaim: StatementSync;
  recoverSubmitting: StatementSync;
  releaseAllClaims: StatementSync;
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
  2: `
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
    CREATE UNIQUE INDEX catalog_identities_ref
      ON catalog_identities (provider, kind, external_id);
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
  `,
  3: `
    ALTER TABLE acquisitions ADD COLUMN whisparr_id INTEGER;
    ALTER TABLE acquisitions ADD COLUMN whisparr_path TEXT;
    ALTER TABLE acquisitions ADD COLUMN whisparr_title TEXT;
  `,
  4: `
    -- SQLite cannot alter a CHECK constraint: rebuild the table with the
    -- studio kind admitted, preserving every row and the unique identity index.
    CREATE TABLE catalog_identities_new (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('tpdb', 'stashdb')),
      kind TEXT NOT NULL CHECK (kind IN ('movie', 'scene', 'performer', 'studio')),
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO catalog_identities_new
      SELECT id, provider, kind, external_id, title, created_at, updated_at
      FROM catalog_identities;
    DROP TABLE catalog_identities;
    ALTER TABLE catalog_identities_new RENAME TO catalog_identities;
    CREATE UNIQUE INDEX catalog_identities_ref
      ON catalog_identities (provider, kind, external_id);
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
        "INSERT INTO accounts (id, name, role, enabled, library_ids, is_owner, auto_approve, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      ),
      updateAccountName: d.prepare("UPDATE accounts SET name = ? WHERE id = ?"),
      updateAccountGrants: d.prepare(
        "UPDATE accounts SET enabled = ?, role = ?, library_ids = ?, auto_approve = ? WHERE id = ?",
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
      insertCatalog: d.prepare(
        "INSERT INTO catalog_identities (id, provider, kind, external_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      updateCatalogTitle: d.prepare(
        "UPDATE catalog_identities SET title = ?, updated_at = ? WHERE id = ?",
      ),
      getCatalogById: d.prepare(
        "SELECT * FROM catalog_identities WHERE id = ?",
      ),
      getCatalogByRef: d.prepare(
        "SELECT * FROM catalog_identities WHERE provider = ? AND kind = ? AND external_id = ?",
      ),
      insertRequest: d.prepare(
        "INSERT INTO requests (id, account_id, provider, kind, external_id, decision, created_at, decided_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)",
      ),
      getRequest: d.prepare("SELECT * FROM requests WHERE id = ?"),
      listAllRequests: d.prepare(
        "SELECT * FROM requests ORDER BY created_at DESC, id DESC",
      ),
      listAccountRequests: d.prepare(
        "SELECT * FROM requests WHERE account_id = ? ORDER BY created_at DESC, id DESC",
      ),
      decideRequest: d.prepare(
        "UPDATE requests SET decision = ?, decided_at = ? WHERE id = ? AND decision = 'pending'",
      ),
      cancelOwnRequest: d.prepare(
        "UPDATE requests SET decision = 'cancelled', decided_at = ? WHERE id = ? AND decision IN ('pending', 'approved')",
      ),
      countActiveRequestsExcept: d.prepare(
        "SELECT COUNT(*) AS n FROM requests WHERE provider = ? AND kind = ? AND external_id = ? AND decision IN ('pending', 'approved') AND id != ?",
      ),
      insertAcquisition: d.prepare(
        "INSERT OR IGNORE INTO acquisitions (id, instance_id, provider, kind, external_id, state, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      getAcquisition: d.prepare("SELECT * FROM acquisitions WHERE id = ?"),
      getAcquisitionByIdentity: d.prepare(
        "SELECT * FROM acquisitions WHERE instance_id = ? AND provider = ? AND kind = ? AND external_id = ?",
      ),
      listDueAcquisitions: d.prepare(
        `SELECT * FROM acquisitions
         WHERE state IN (${SCHEDULABLE_STATES.map(() => "?").join(", ")})
           AND due_at IS NOT NULL AND due_at <= ? AND claim_token IS NULL
         ORDER BY due_at ASC, id ASC LIMIT ?`,
      ),
      claimAcquisition: d.prepare(
        "UPDATE acquisitions SET claim_token = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND claim_token IS NULL",
      ),
      beginSubmission: d.prepare(
        "UPDATE acquisitions SET state = 'submitting', attempt_token = ?, attempt_at = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND state IN ('unsent', 'uncertain')",
      ),
      completeSubmissionAccepted: d.prepare(
        "UPDATE acquisitions SET state = 'monitoring', submitted_at = ?, due_at = ?, attempt_token = NULL, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ? AND attempt_token = ?",
      ),
      completeSubmissionUncertain: d.prepare(
        "UPDATE acquisitions SET state = 'uncertain', attempt_token = NULL, due_at = ?, last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND attempt_token = ?",
      ),
      completeSubmissionFailed: d.prepare(
        "UPDATE acquisitions SET state = 'failed', attempt_token = NULL, due_at = ?, last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND attempt_token = ?",
      ),
      requeueBlocked: d.prepare(
        "UPDATE acquisitions SET state = 'unsent', due_at = ?, updated_at = ? WHERE state = 'blocked' AND claim_token IS NULL",
      ),
      recordObservation: d.prepare(
        `UPDATE acquisitions SET state = ?, last_observed_at = ?, due_at = ?,
           whisparr_id = COALESCE(?, whisparr_id),
           whisparr_path = COALESCE(?, whisparr_path),
           whisparr_title = COALESCE(?, whisparr_title),
           last_error = NULL, last_error_at = NULL, updated_at = ?
         WHERE id = ? AND (? IS NULL OR claim_token = ?)`,
      ),
      recordObservationError: d.prepare(
        "UPDATE acquisitions SET last_error = ?, last_error_at = ?, due_at = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR claim_token = ?)",
      ),
      recordAbsence: d.prepare(
        `UPDATE acquisitions SET last_error = ?, last_error_at = ?, due_at = ?,
           whisparr_id = NULL, whisparr_path = NULL, whisparr_title = NULL, updated_at = ?
         WHERE id = ? AND (? IS NULL OR claim_token = ?)`,
      ),
      withdrawUndispatched: d.prepare(
        "DELETE FROM acquisitions WHERE id = ? AND state IN ('unsent', 'blocked') AND claim_token IS NULL AND attempt_token IS NULL AND submitted_at IS NULL",
      ),
      releaseClaim: d.prepare(
        "UPDATE acquisitions SET claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ?",
      ),
      recoverSubmitting: d.prepare(
        "UPDATE acquisitions SET state = 'uncertain', due_at = ?, last_error = COALESCE(last_error, 'submission outcome unknown after restart'), last_error_at = ?, updated_at = ? WHERE state = 'submitting'",
      ),
      releaseAllClaims: d.prepare(
        "UPDATE acquisitions SET claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE claim_token IS NOT NULL",
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
    autoApprove: row.auto_approve === 1,
  };
}

function nonemptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isHttpUrl(v: unknown): v is string {
  if (!nonemptyString(v, 2048)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Catalog payloads come from providers, so the compile-time shapes are
// re-checked at runtime with real typeof/isArray predicates before persisting.
function validCatalogRef(
  r: CatalogReference | undefined,
  kinds: readonly CatalogKind[],
): boolean {
  return (
    !!r &&
    PROVIDERS.includes(r.provider) &&
    kinds.includes(r.kind) &&
    typeof r.id === "string" &&
    UUID_RE.test(r.id)
  );
}

function validLink(l: ExternalLink): boolean {
  return (
    !!l &&
    isHttpUrl(l.url) &&
    (l.label === undefined || nonemptyString(l.label, 200))
  );
}

function validLinks(links: ExternalLink[] | undefined): boolean {
  return (
    links === undefined || (Array.isArray(links) && links.every(validLink))
  );
}

function validCredit(c: CatalogCredit): boolean {
  return (
    !!c &&
    validCatalogRef(c.reference, CATALOG_KINDS) &&
    nonemptyString(c.name, 500) &&
    (c.imageUrl === undefined || isHttpUrl(c.imageUrl)) &&
    validLinks(c.links)
  );
}
// Provider payloads are re-validated at runtime before anything persists.
function assertCatalogDetail(detail: CatalogDetail): void {
  const d: CatalogDetail | undefined = detail;
  if (
    !d ||
    !validCatalogRef(d.reference, CATALOG_KINDS) ||
    !nonemptyString(d.title, 1000) ||
    (d.description !== undefined && !nonemptyString(d.description, 10_000)) ||
    (d.releaseDate !== undefined &&
      (!nonemptyString(d.releaseDate, 10) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(d.releaseDate))) ||
    (d.durationSeconds !== undefined &&
      (!Number.isInteger(d.durationSeconds) || d.durationSeconds < 1)) ||
    (d.imageUrl !== undefined && !isHttpUrl(d.imageUrl)) ||
    (d.sourceUrl !== undefined && !isHttpUrl(d.sourceUrl)) ||
    (d.studio !== undefined &&
      (!d.studio ||
        !nonemptyString(d.studio.name, 500) ||
        (d.studio.reference !== undefined &&
          !validCatalogRef(d.studio.reference, CATALOG_KINDS)))) ||
    !Array.isArray(d.credits) ||
    !d.credits.every(validCredit) ||
    !Array.isArray(d.tags) ||
    !d.tags.every(
      (t) => !!t && nonemptyString(t.id, 500) && nonemptyString(t.name, 500),
    ) ||
    !Array.isArray(d.related) ||
    !d.related.every((r) => validCatalogRef(r, CATALOG_KINDS)) ||
    !validLinks(d.links) ||
    !Array.isArray(d.aliases) ||
    !d.aliases.every((a) => nonemptyString(a, 500))
  ) {
    throw new AppError(
      400,
      "invalid_catalog_detail",
      "catalog detail is incomplete or malformed",
    );
  }
}

function assertMediaReference(ref: MediaReference): void {
  if (!validCatalogRef(ref, MEDIA_KINDS)) {
    throw new AppError(400, "invalid_reference", "media reference is invalid");
  }
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
      !w.apiKey ||
      (w.instanceId !== undefined && !UUID_RE.test(w.instanceId))
    ) {
      throw new AppError(
        400,
        "invalid_config",
        "Whisparr configuration is incomplete",
      );
    }
    const d = w.delivery;
    if (
      d !== undefined &&
      (typeof d.enabled !== "boolean" ||
        typeof d.rootFolderPath !== "string" ||
        !Number.isInteger(d.qualityProfileId) ||
        d.qualityProfileId < 1 ||
        typeof d.searchOnAdd !== "boolean" ||
        (d.enabled && !d.rootFolderPath))
    ) {
      throw new AppError(
        400,
        "invalid_config",
        "Whisparr delivery settings are incomplete",
      );
    }
    const m = w.pathMappings;
    if (
      m !== undefined &&
      (!Array.isArray(m) ||
        m.some(
          (p) =>
            !p ||
            typeof p.whisparrPrefix !== "string" ||
            !p.whisparrPrefix ||
            typeof p.jellyfinPrefix !== "string" ||
            !p.jellyfinPrefix,
        ))
    ) {
      throw new AppError(
        400,
        "invalid_config",
        "Whisparr path mappings are incomplete",
      );
    }
  }
}

/** The Whisparr instance identity is storage-owned: preserved across key
 * rotation and unchanged endpoints, freshly generated when the endpoint is new
 * or changed so old acquisition work is never silently reused. */
function resolveWhisparrIdentity(
  current: IntegrationConfig | null,
  next: IntegrationConfig,
): IntegrationConfig {
  if (!next.whisparr) return next;
  const cur = current?.whisparr;
  let instanceId = next.whisparr.instanceId;
  if (cur && cur.url === next.whisparr.url && cur.instanceId) {
    if (instanceId !== undefined && instanceId !== cur.instanceId) {
      throw new AppError(
        409,
        "instance_mismatch",
        "refusing to reassign the identity of an unchanged Whisparr endpoint",
      );
    }
    instanceId = cur.instanceId;
  } else if (instanceId === undefined) {
    instanceId = randomUUID();
  }
  return { ...next, whisparr: { ...next.whisparr, instanceId } };
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
    let current: IntegrationConfig | null = null;
    if (existing) {
      current = JSON.parse(
        decryptString(loadKey(), existing.data),
      ) as IntegrationConfig;
      if (current.jellyfin.serverId !== config.jellyfin.serverId) {
        throw new AppError(
          409,
          "server_mismatch",
          "refusing to change the configured Jellyfin server identity",
        );
      }
    }
    // Enabling delivery must revive work that was approved while it was off:
    // 'blocked' is deliberately not schedulable, so nothing else would ever
    // pick these rows up again.
    if (
      config.whisparr?.delivery?.enabled === true &&
      current?.whisparr?.delivery?.enabled !== true
    ) {
      S().requeueBlocked.run(Date.now(), Date.now());
    }
    const resolved = resolveWhisparrIdentity(current, config);
    S().updateConfig.run(
      encryptString(loadKey(), JSON.stringify(resolved)),
      Date.now(),
    );
  });
}

export function bootstrap(
  config: IntegrationConfig,
  user: ExternalUser,
  userToken: string,
): SessionGrant {
  assertConfigShape(config);
  const resolved = resolveWhisparrIdentity(null, config);
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
      libraryIds: [...resolved.jellyfin.libraryIds],
      isOwner: true,
      autoApprove: false,
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
      encryptString(loadKey(), JSON.stringify(resolved)),
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
  changes: {
    enabled: boolean;
    role: Role;
    libraryIds: string[];
    autoApprove?: boolean;
  },
): Account {
  if (
    typeof changes?.enabled !== "boolean" ||
    !ROLES.includes(changes.role) ||
    !Array.isArray(changes.libraryIds) ||
    (changes.autoApprove !== undefined &&
      typeof changes.autoApprove !== "boolean")
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
  // Preserve-on-omission PATCH: an absent autoApprove keeps the stored grant.
  const autoApprove = changes.autoApprove ?? existing.autoApprove;
  const d = open();
  inTransaction(d, () => {
    S().updateAccountGrants.run(
      changes.enabled ? 1 : 0,
      changes.role,
      JSON.stringify(changes.libraryIds),
      autoApprove ? 1 : 0,
      id,
    );
    const changed =
      existing.enabled !== changes.enabled ||
      existing.role !== changes.role ||
      existing.autoApprove !== autoApprove ||
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

// --- M2: catalog identities, requests, shared acquisitions ---

function rowToCatalog(row: CatalogRow): CatalogRecord {
  return {
    id: row.id,
    reference: {
      provider: row.provider as CatalogProvider,
      kind: row.kind as CatalogKind,
      id: row.external_id,
    },
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRequest(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    media: {
      provider: row.provider as CatalogProvider,
      kind: row.kind as MediaKind,
      id: row.external_id,
    },
    decision: row.decision as RequestDecision,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function rowToAcquisition(row: AcquisitionRow): AcquisitionRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    media: {
      provider: row.provider as CatalogProvider,
      kind: row.kind as MediaKind,
      id: row.external_id,
    },
    state: row.state as AcquisitionRecord["state"],
    claimToken: row.claim_token,
    attemptToken: row.attempt_token,
    claimedAt: row.claimed_at,
    attemptAt: row.attempt_at,
    dueAt: row.due_at,
    submittedAt: row.submitted_at,
    lastObservedAt: row.last_observed_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    whisparrId: row.whisparr_id ?? null,
    whisparrPath: row.whisparr_path ?? null,
    whisparrTitle: row.whisparr_title ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// node:sqlite reports code 'ERR_SQLITE_ERROR' with errcode 2067/1555 for a
// unique/primary-key violation and names the conflicting columns, not the
// index: matching a code prefix or an index name never fired.
const SQLITE_UNIQUE_ERRCODES: Record<number, true> = { 1555: true, 2067: true };

function isUniqueConflict(e: unknown, columns: readonly string[]): boolean {
  return (
    e instanceof Error &&
    "errcode" in e &&
    typeof e.errcode === "number" &&
    SQLITE_UNIQUE_ERRCODES[e.errcode] === true &&
    columns.every((column) => e.message.includes(column))
  );
}

/** Opens (and migrates) the database eagerly, then repairs an upgraded
 * configuration that predates the stored Whisparr instance identity. Without
 * this, approvals on such an installation succeed while silently enqueueing no
 * shared work. Call from the server-start hook, never from a request path. */
export function initializeStorage(): void {
  const d = open();
  const config = getConfig();
  const whisparr = config?.whisparr;
  if (!config || !whisparr) return;
  if (!whisparr.instanceId) saveConfig(config);
  const instanceId = getConfig()?.whisparr?.instanceId;
  if (!instanceId) return;
  // Approvals recorded before this instance identity existed enqueued nothing.
  // INSERT OR IGNORE leaves already-tracked identities untouched.
  inTransaction(d, () => {
    const now = Date.now();
    const state = whisparr.delivery?.enabled ? "unsent" : "blocked";
    for (const row of S().listAllRequests.all() as RequestRow[]) {
      if (row.decision !== "approved") continue;
      S().insertAcquisition.run(
        randomUUID(),
        instanceId,
        row.provider,
        row.kind,
        row.external_id,
        state,
        state === "unsent" ? now : null,
        now,
        now,
      );
    }
  });
}

export function upsertCatalogRecord(detail: CatalogDetail): CatalogRecord {
  assertCatalogDetail(detail);
  const d = open();
  return inTransaction(d, () => {
    const now = Date.now();
    const existing = S().getCatalogByRef.get(
      detail.reference.provider,
      detail.reference.kind,
      detail.reference.id,
    ) as CatalogRow | undefined;
    if (existing) {
      S().updateCatalogTitle.run(detail.title, now, existing.id);
      return rowToCatalog(S().getCatalogById.get(existing.id) as CatalogRow);
    }
    const id = randomUUID();
    S().insertCatalog.run(
      id,
      detail.reference.provider,
      detail.reference.kind,
      detail.reference.id,
      detail.title,
      now,
      now,
    );
    return rowToCatalog(S().getCatalogById.get(id) as CatalogRow);
  });
}

export function getCatalogRecord(id: string): CatalogRecord | null {
  const row = S().getCatalogById.get(id) as CatalogRow | undefined;
  return row ? rowToCatalog(row) : null;
}

export function getCatalogRecordByReference(
  reference: CatalogReference,
): CatalogRecord | null {
  const row = S().getCatalogByRef.get(
    reference.provider,
    reference.kind,
    reference.id,
  ) as CatalogRow | undefined;
  return row ? rowToCatalog(row) : null;
}

/** Records one user's intent. Admission is read from the current stored
 * account, never from a caller-supplied stale Account. */
export function createRequest(
  accountId: string,
  media: MediaReference,
): RequestRecord {
  assertMediaReference(media);
  const d = open();
  return inTransaction(d, () => {
    const account = S().getAccount.get(accountId) as AccountRow | undefined;
    if (!account || account.enabled !== 1) {
      throw new AppError(
        403,
        "account_not_admitted",
        "only admitted accounts may request",
      );
    }
    const id = randomUUID();
    const now = Date.now();
    try {
      S().insertRequest.run(
        id,
        accountId,
        media.provider,
        media.kind,
        media.id,
        now,
      );
    } catch (e) {
      if (
        isUniqueConflict(e, ["requests.account_id", "requests.external_id"])
      ) {
        throw new AppError(
          409,
          "request_exists",
          "an active request for this item already exists",
        );
      }
      throw e;
    }
    return rowToRequest(S().getRequest.get(id) as RequestRow);
  });
}

/** Durable request view, filtered by the viewer's role: requesters see only
 * their own history; moderators and administrators see all. */
export function listRequests(viewer: Account): RequestRecord[] {
  const rows =
    viewer.role === "requester"
      ? (S().listAccountRequests.all(viewer.id) as RequestRow[])
      : (S().listAllRequests.all() as RequestRow[]);
  return rows.map(rowToRequest);
}

export function getRequest(id: string, viewer: Account): RequestRecord {
  const row = S().getRequest.get(id) as RequestRow | undefined;
  if (!row || (viewer.role === "requester" && row.account_id !== viewer.id)) {
    // A requester learns nothing about another user's requests.
    throw new AppError(404, "request_not_found", "request not found");
  }
  return rowToRequest(row);
}

/** Approval is transactional with the shared-acquisition attachment: two
 * approvers converge on one acquisition row per instance+identity. */
export function decideRequest(
  actor: Account,
  requestId: string,
  decision: "approved" | "declined",
): RequestRecord {
  const elevated = actor.role === "admin" || actor.role === "moderator";
  // The autoApprove grant is exactly permission to approve one's own request.
  // Declining someone's request still requires an elevated role.
  const selfApproving =
    decision === "approved" && actor.autoApprove === true && !elevated;
  if (!elevated && !selfApproving) {
    throw new AppError(403, "forbidden", "decisions require elevated role");
  }
  const d = open();
  return inTransaction(d, () => {
    const row = S().getRequest.get(requestId) as RequestRow | undefined;
    if (!row) {
      throw new AppError(404, "request_not_found", "request not found");
    }
    if (row.decision !== "pending") {
      throw new AppError(
        409,
        "request_not_pending",
        "only pending requests can be decided",
      );
    }
    if (selfApproving && row.account_id !== actor.id) {
      throw new AppError(
        403,
        "forbidden",
        "the auto-approve grant only covers your own requests",
      );
    }
    const now = Date.now();
    S().decideRequest.run(decision, now, requestId);
    if (decision === "approved") {
      const whisparr = getConfig()?.whisparr;
      if (whisparr && !whisparr.instanceId) {
        // An approval that enqueues nothing is a silent no-op; refuse instead.
        // initializeStorage backfills this identity for upgraded installs.
        throw new AppError(
          500,
          "instance_identity_missing",
          "the configured Whisparr connection has no stored instance identity",
        );
      }
      if (whisparr?.instanceId) {
        // Delivery disabled or unset leaves actionable blocked work, never a
        // pretend success. No Whisparr at all means nothing to deliver to yet.
        const state = whisparr.delivery?.enabled ? "unsent" : "blocked";
        S().insertAcquisition.run(
          randomUUID(),
          whisparr.instanceId,
          row.provider,
          row.kind,
          row.external_id,
          state,
          state === "unsent" ? now : null,
          now,
          now,
        );
      }
    }
    return rowToRequest(S().getRequest.get(requestId) as RequestRow);
  });
}

/** Cancels only the actor's own intent; never another user's request and
 * never any external media. Withdrawal decision: when the cancelled request
 * was the LAST active intent for the identity, shared work that provably
 * never left the building — state 'unsent' or 'blocked', no claim, no
 * attempt, no submission — is withdrawn by REMOVING the shared acquisition
 * row. Nothing external ever received it, so removal deletes no media and no
 * history (request rows are untouched); removal rather than a terminal state
 * is what lets a later re-request create fresh work instead of resurrecting
 * a half-cancelled row, and a removed row can never be scheduled.
 * 'submitting', 'uncertain' and everything already observed always survives,
 * because the external system may already hold it. */
export function cancelRequest(
  actor: Account,
  requestId: string,
): RequestRecord {
  const d = open();
  return inTransaction(d, () => {
    const row = S().getRequest.get(requestId) as RequestRow | undefined;
    if (!row || row.account_id !== actor.id) {
      throw new AppError(404, "request_not_found", "request not found");
    }
    if (row.decision !== "pending" && row.decision !== "approved") {
      throw new AppError(
        409,
        "request_not_cancellable",
        "only pending or approved requests can be cancelled",
      );
    }
    S().cancelOwnRequest.run(Date.now(), requestId);
    // Last-withdrawal suppression: only undispatched work, only when no
    // other active intent remains for this identity.
    const instance = getConfig()?.whisparr?.instanceId;
    if (instance !== undefined) {
      const active = S().countActiveRequestsExcept.get(
        row.provider,
        row.kind,
        row.external_id,
        requestId,
      ) as { n: number };
      if (active.n === 0) {
        const shared = S().getAcquisitionByIdentity.get(
          instance,
          row.provider,
          row.kind,
          row.external_id,
        ) as AcquisitionRow | undefined;
        if (shared !== undefined) S().withdrawUndispatched.run(shared.id);
      }
    }
    return rowToRequest(S().getRequest.get(requestId) as RequestRow);
  });
}

/** Shared acquisition for one identity on the configured instance, or null.
 * Carries no per-user request history. */
export function getAcquisitionByReference(
  media: MediaReference,
  instanceId?: string,
): AcquisitionRecord | null {
  assertMediaReference(media);
  const instance = instanceId ?? getConfig()?.whisparr?.instanceId;
  if (!instance) return null;
  const row = S().getAcquisitionByIdentity.get(
    instance,
    media.provider,
    media.kind,
    media.id,
  ) as AcquisitionRow | undefined;
  return row ? rowToAcquisition(row) : null;
}

/** Schedulable work: due, unclaimed acquisitions ordered oldest-due first. */
export function listDueAcquisitions(
  now: number,
  limit = 20,
): AcquisitionRecord[] {
  return (
    S().listDueAcquisitions.all(
      ...SCHEDULABLE_STATES,
      now,
      limit,
    ) as AcquisitionRow[]
  ).map(rowToAcquisition);
}

/** Transactionally claims one acquisition; concurrent claims lose with 409. */
export function claimAcquisition(id: string): {
  record: AcquisitionRecord;
  claimToken: string;
} {
  const d = open();
  return inTransaction(d, () => {
    const claimToken = randomUUID();
    const now = Date.now();
    S().claimAcquisition.run(claimToken, now, now, id);
    const row = S().getAcquisition.get(id) as AcquisitionRow | undefined;
    if (!row || row.claim_token !== claimToken) {
      throw new AppError(409, "already_claimed", "acquisition already claimed");
    }
    return { record: rowToAcquisition(row), claimToken };
  });
}

/** Persists the attempt (state submitting) BEFORE any network submission.
 * A crash after this point leaves recoverable evidence instead of a blind retry. */
export function beginSubmission(
  id: string,
  claimToken: string,
): { attemptToken: string } {
  const d = open();
  const attemptToken = randomUUID();
  const res = S().beginSubmission.run(
    attemptToken,
    Date.now(),
    Date.now(),
    id,
    claimToken,
  );
  if (res.changes === 0) {
    throw new AppError(
      409,
      "claim_lost",
      "claim or state changed; this worker is stale",
    );
  }
  return { attemptToken };
}

export function completeSubmission(
  id: string,
  claimToken: string,
  attemptToken: string,
  outcome: AttemptOutcome,
  error?: string,
): AcquisitionRecord {
  const d = open();
  const now = Date.now();
  let res: { changes: number | bigint };
  switch (outcome) {
    case "accepted":
      res = S().completeSubmissionAccepted.run(
        now,
        now + RECHECK_DELAY_MS,
        now,
        id,
        claimToken,
        attemptToken,
      );
      break;
    case "uncertain":
      res = S().completeSubmissionUncertain.run(
        now,
        error ?? "submission outcome unknown",
        now,
        now,
        id,
        claimToken,
        attemptToken,
      );
      break;
    case "failed":
      res = S().completeSubmissionFailed.run(
        now + RECHECK_DELAY_MS,
        error ?? "submission failed",
        now,
        now,
        id,
        claimToken,
        attemptToken,
      );
      break;
    default:
      throw new AppError(
        400,
        "invalid_outcome",
        "submission outcome is invalid",
      );
  }
  if (res.changes === 0) {
    throw new AppError(
      409,
      "attempt_lost",
      "claim or attempt changed; this worker is stale",
    );
  }
  return rowToAcquisition(S().getAcquisition.get(id) as AcquisitionRow);
}

/** A successful observation updates recorded state and the last-observed
 * fact; a proven absence clears the recorded facts while keeping state and
 * the last observation; an unavailable/error check never touches state, the
 * last observation, or the facts. */
export function recordAcquisitionObservation(
  id: string,
  observation: AcquisitionObservation,
  claimToken?: string,
): AcquisitionRecord {
  const d = open();
  const now = Date.now();
  const claim = claimToken ?? null;
  let res: { changes: number | bigint };
  if ("state" in observation) {
    if (!OBSERVED_STATES.includes(observation.state)) {
      throw new AppError(400, "invalid_observation", "observation is invalid");
    }
    // Imported work is terminal for scheduling; other states recheck.
    const due =
      observation.state === "imported" ? null : now + RECHECK_DELAY_MS;
    // Validated, bounded item facts; a missing field keeps the stored value.
    const item = observation.item;
    const whisparrId =
      typeof item?.whisparrId === "number" && Number.isInteger(item.whisparrId)
        ? item.whisparrId
        : null;
    const whisparrPath = nonemptyString(item?.path, 4096)
      ? (item?.path as string)
      : null;
    const whisparrTitle = nonemptyString(item?.title, 300)
      ? (item?.title as string)
      : null;
    res = S().recordObservation.run(
      observation.state,
      now,
      due,
      whisparrId,
      whisparrPath,
      whisparrTitle,
      now,
      id,
      claim,
      claim,
    );
  } else if ("absent" in observation) {
    if (!nonemptyString(observation.reason, 2000)) {
      throw new AppError(400, "invalid_observation", "observation is invalid");
    }
    // Proven absence from a successful lookup: the recorded facts are now
    // known false, so they are cleared; state and lastObservedAt (the last
    // real observation) stay, keeping this distinct from an unknown check.
    res = S().recordAbsence.run(
      observation.reason,
      now,
      now + RECHECK_DELAY_MS,
      now,
      id,
      claim,
      claim,
    );
  } else {
    if (!nonemptyString(observation.reason, 2000)) {
      throw new AppError(400, "invalid_observation", "observation is invalid");
    }
    res = S().recordObservationError.run(
      observation.reason,
      now,
      now + RECHECK_DELAY_MS,
      now,
      id,
      claim,
      claim,
    );
  }
  if (claim !== null && res.changes === 0) {
    throw new AppError(
      409,
      "claim_lost",
      "claim changed; this worker is stale",
    );
  }
  return rowToAcquisition(S().getAcquisition.get(id) as AcquisitionRow);
}

/** True when the recorded item facts have aged past the staleness ceiling
 * while a later check failed (lastErrorAt after lastObservedAt): the caller
 * is looking at old facts, honestly labeled. Purely derived; never mutates. */
export function isObservationStale(
  record: AcquisitionRecord,
  now: number = Date.now(),
): boolean {
  return (
    record.lastObservedAt !== null &&
    record.lastErrorAt !== null &&
    record.lastErrorAt >= record.lastObservedAt &&
    now - record.lastObservedAt > STALE_OBSERVATION_MS
  );
}

/** True only for a proven Whisparr absence recorded after a real
 * observation: the item facts were cleared because a successful lookup
 * showed the identity gone. An outage/unknown check keeps the facts and
 * never sets this. */
export function hasAuthoritativeAbsence(record: AcquisitionRecord): boolean {
  return (
    record.lastObservedAt !== null &&
    record.lastErrorAt !== null &&
    record.whisparrId === null &&
    record.whisparrPath === null &&
    record.whisparrTitle === null
  );
}

export function releaseAcquisitionClaim(id: string, claimToken: string): void {
  S().releaseClaim.run(Date.now(), id, claimToken);
}

/** Startup recovery: in-flight submissions become uncertain (reconcile by
 * identity before any re-POST); all claims die with the previous process. */
export function recoverAbandonedWork(): void {
  const d = open();
  inTransaction(d, () => {
    const now = Date.now();
    S().recoverSubmitting.run(now, now, now);
    S().releaseAllClaims.run(now);
  });
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
