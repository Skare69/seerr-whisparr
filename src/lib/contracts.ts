// Velvarr M1 shared records — exact shapes from local://velvarr-m1-contract.txt.
// Plain records only; no implementation lives here.

export type Role = "admin" | "moderator" | "requester";

export type IntegrationConfig = {
  jellyfin: {
    url: string;
    externalUrl: string;
    apiKey: string;
    serverId: string;
    libraryIds: string[];
  };
  whisparr?: { url: string; apiKey: string };
};

export type Account = {
  id: string;
  name: string;
  role: Role;
  enabled: boolean;
  libraryIds: string[];
  isOwner: boolean;
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
