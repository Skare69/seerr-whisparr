// Velvarr shared records — M1 shapes plus M2 catalog/request/acquisition records.
// Plain records only; no implementation lives here.

export type Role = "admin" | "moderator" | "requester";

export type CatalogProvider = "tpdb" | "stashdb";

export type MediaKind = "movie" | "scene";

export type CatalogKind = MediaKind | "performer";

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

/** Result of one external acquisition check: a real observed state, or an
 * unavailable/error check that must not touch recorded state. */
export type AcquisitionObservation =
  | {
      state: "monitoring" | "downloading" | "imported";
      /** Observed external item facts to persist alongside the state. */
      item?: { whisparrId?: number; path?: string; title?: string };
    }
  | { unavailable: true; reason: string };

/** Per-user playback verdict. An exact Jellyfin match plus the current user's
 * authorization; never a global property of a download. */
export type PlaybackAccess =
  | { outcome: "available"; item: LibraryItem; watchUrl?: string }
  | { outcome: "missing" }
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
