// Velvarr shared records — M1 shapes plus M2 catalog/request/acquisition records.
// Plain records only; no implementation lives here.

export type Role = "admin" | "moderator" | "requester";

export type CatalogProvider = "tpdb" | "stashdb";

export type MediaKind = "movie" | "scene";

export type CatalogKind = MediaKind | "performer" | "studio";

/** Provider-scoped external identity. `id` is the provider's external UUID,
 * never the application-owned catalog record id. */
export type CatalogReference = {
  provider: CatalogProvider;
  kind: CatalogKind;
  id: string;
};

/** CatalogReference narrowed to requestable media. */
export type MediaReference = {
  provider: CatalogProvider;
  kind: MediaKind;
  id: string;
};

export type ExternalLink = { url: string; label?: string };

export type CatalogCredit = {
  /** Performer reference. */
  reference: CatalogReference;
  name: string;
  imageUrl?: string;
  links?: ExternalLink[];
};

/** Full provider detail for one catalog entity. Ephemerally valuable; only a
 * minimal summary is persisted (see CatalogRecord). */
export type CatalogDetail = {
  reference: CatalogReference;
  title: string;
  description?: string;
  /** ISO calendar date (YYYY-MM-DD) when the provider supplies one. */
  releaseDate?: string;
  durationSeconds?: number;
  imageUrl?: string;
  studio?: { name: string; reference?: CatalogReference };
  credits: CatalogCredit[];
  /** Provider-native tags: the provider's own IDs and names. */
  tags: { id: string; name: string }[];
  related: CatalogReference[];
  links: ExternalLink[];
  aliases: string[];
  sourceUrl?: string;
};

/** Application-owned durable catalog summary. `id` is a Velvarr UUID, distinct
 * from any external UUID; holds title/reference/history, not a provider mirror. */
export type CatalogRecord = {
  id: string;
  reference: CatalogReference;
  title: string;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
};

export type RequestDecision = "pending" | "approved" | "declined" | "cancelled";

/** One user's durable intent. Independent of acquisition and playback state. */
export type RequestRecord = {
  id: string;
  accountId: string;
  media: MediaReference;
  decision: RequestDecision;
  /** Unix milliseconds. */
  createdAt: number;
  decidedAt: number | null;
};

export type RemovalLevel =
  "unmonitor" | "drop" | "exclude" | "delete_files" | "delete_jellyfin_item";

export type RemovalDecision = "pending" | "approved" | "declined" | "cancelled";

/** One user's durable removal intent. The requester supplies only a reason;
 * the level is chosen by the approver, never by the requester. */
export type RemovalRequest = {
  id: string;
  accountId: string;
  media: MediaReference;
  reason: string;
  decision: RemovalDecision;
  /** Set only at approval; null while pending and after decline or cancel. */
  level: RemovalLevel | null;
  /** Unix milliseconds. */
  createdAt: number;
  decidedAt: number | null;
};

export type RemovalExecutionState =
  "unsent" | "executing" | "uncertain" | "done" | "failed" | "blocked";

/** Shared durable removal work for one resolved identity on one logical
 * Whisparr instance; several requests attach to it. Carries no per-user
 * history and stores the external facts observed before the call so a retry
 * can re-resolve by identity and compare. */
export type RemovalExecution = {
  id: string;
  instanceId: string;
  media: MediaReference;
  state: RemovalExecutionState;
  level: RemovalLevel;
  /** Compare-and-set tokens; stale workers holding old tokens fail writes. */
  claimToken: string | null;
  claimedAt: number | null;
  attemptToken: string | null;
  attemptAt: number | null;
  /** External facts observed before the call: Whisparr item id, path, file
   * count, size, and the item's added timestamp. A retry re-resolves by
   * identity and compares these before touching anything. */
  whisparrItemId: number | null;
  whisparrPath: string | null;
  whisparrFileCount: number | null;
  whisparrSize: number | null;
  whisparrAdded: string | null;
  /** Parties who created this execution: the first requester and the approver
   * whose approval attached it. Later attachments live on their own requests. */
  requesterId: string;
  approverId: string;
  /** Next due attempt, unix milliseconds. */
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RemovalAttemptOutcome = "done" | "failed" | "uncertain";

/** External facts a worker observes before any removal call. */
export type RemovalObservedFacts = {
  whisparrItemId?: number;
  path?: string;
  fileCount?: number;
  size?: number;
  added?: string;
};

/** Append-only evidence for one execution attempt. Never mutated, never
 * deleted; parties and identities are denormalized so rows stand alone. */
export type RemovalAudit = {
  id: string;
  executionId: string;
  requesterId: string;
  approverId: string;
  media: MediaReference;
  level: RemovalLevel;
  attemptToken: string | null;
  outcome: RemovalAttemptOutcome;
  detail: string | null;
  /** Unix milliseconds. */
  createdAt: number;
};

export type AcquisitionState =
  | "unsent"
  | "submitting"
  | "uncertain"
  | "monitoring"
  | "downloading"
  | "imported"
  | "failed"
  | "blocked";

/** Shared durable work for one resolved identity on one logical Whisparr
 * instance; several requests attach to it. Carries no per-user history. */
export type AcquisitionRecord = {
  id: string;
  instanceId: string;
  media: MediaReference;
  state: AcquisitionState;

  /** Compare-and-set tokens; stale workers holding old tokens fail their writes. */
  claimToken: string | null;
  attemptToken: string | null;
  claimedAt: number | null;
  attemptAt: number | null;
  /** Next due check, unix milliseconds. */
  dueAt: number | null;
  submittedAt: number | null;
  /** Last successful external observation, unix milliseconds. Kept separate
   * from check health: an outage never overwrites it. */
  lastObservedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** Last observed external item facts, kept so per-user availability can be
   * resolved without calling Whisparr on every read. Only overwritten by a
   * successful observation. */
  whisparrId: number | null;
  whisparrPath: string | null;
  whisparrTitle: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AttemptOutcome = "accepted" | "failed" | "uncertain";

/** Result of one external acquisition check: a real observed state, a proven
 * absence from a successful check (authoritative — recorded item facts are
 * cleared), or an unavailable/error check that must not touch recorded
 * state. */
export type AcquisitionObservation =
  | {
      state: "monitoring" | "downloading" | "imported";
      /** Observed external item facts to persist alongside the state. */
      item?: { whisparrId?: number; path?: string; title?: string };
    }
  | { absent: true; reason: string }
  | { unavailable: true; reason: string };

/** Per-user playback verdict. An exact Jellyfin match plus the current user's
 * authorization; never a global property of a download. */
export type PlaybackAccess =
  | { outcome: "available"; item: LibraryItem; watchUrl?: string }
  | { outcome: "missing" }
  // Imported in Whisparr but Jellyfin has not yet produced an authorized
  // exact match — distinct from missing and from unavailable.
  | { outcome: "awaiting_scan"; reason?: string }
  | { outcome: "denied"; reason?: string }
  | { outcome: "ambiguous"; reason?: string }
  | { outcome: "unavailable"; reason?: string };

export type WhisparrDelivery = {
  enabled: boolean;
  rootFolderPath: string;
  qualityProfileId: number;
  searchOnAdd: boolean;
};

export type WhisparrPathMapping = {
  whisparrPrefix: string;
  jellyfinPrefix: string;
};

export type IntegrationConfig = {
  jellyfin: {
    url: string;
    externalUrl: string;
    apiKey: string;
    serverId: string;
    libraryIds: string[];
  };
  whisparr?: {
    url: string;
    apiKey: string;
    /** Application-owned logical connection identity. Storage generates and
     * preserves it; a changed endpoint conservatively receives a new identity. */
    instanceId?: string;
    /** Absent delivery means delivery is disabled. */
    delivery?: WhisparrDelivery;
    pathMappings?: WhisparrPathMapping[];
  };
};

export type Account = {
  id: string;
  name: string;
  role: Role;
  enabled: boolean;
  libraryIds: string[];
  isOwner: boolean;
  /** Explicit auto-approve grant for requests; independent of library grants. */
  autoApprove: boolean;
  /** Explicit removal grant, required (with the operator flag) to create or
   * approve removal requests; default false, set by an administrator. */
  canRemove: boolean;
};

export type ExternalUser = {
  id: string;
  name: string;
  isDisabled: boolean;
  enableRemoteAccess: boolean;
  enableMediaPlayback: boolean;
  isAdministrator: boolean;
};

export type Library = { id: string; name: string };

export type LibraryItem = {
  id: string;
  name: string;
  kind: string;
  year?: number;
  overview?: string;
  durationTicks?: number;
  image?: string;
  canPlay: boolean;
  watchUrl?: string;
};

export type LibraryPage = {
  items: LibraryItem[];
  total: number;
  start: number;
  limit: number;
};

export type Session = {
  account: Account;
  jellyfinToken: string;
};

export type SessionGrant = {
  token: string;
  /** Unix milliseconds. */
  expiresAt: number;
  account: Account;
};

export type ProviderStatus = {
  tpdb: "not_configured" | "not_verified";
  stashdb: "not_configured" | "not_verified";
};
