// Whisparr integration. Strictly read-only: GET status, rootfolder, and
// qualityprofile only. No adds, commands, monitoring, downloads, or scans —
// mutations are an M2+ concern gated on provider proofs.

import { requestJson } from "./http.ts";
import type { IntegrationConfig } from "../lib/contracts.ts";

export interface WhisparrStatus {
  configured: boolean;
  version?: string;
  appName?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
}

interface StatusDto {
  version?: unknown;
  appName?: unknown;
}

interface RootFolderDto {
  id?: unknown;
  path?: unknown;
}

interface QualityProfileDto {
  id?: unknown;
  name?: unknown;
}

export async function getWhisparrStatus(
  config: IntegrationConfig,
): Promise<WhisparrStatus> {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) {
    return { configured: false };
  }
  // All three reads are plain GETs against the v3 API with the key header;
  // any upstream failure rejects so routes can report a genuine outage.
  const [status, rootFolders, profiles] = await Promise.all([
    requestJson<StatusDto>(
      whisparr.url,
      "/api/v3/system/status",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
    requestJson<RootFolderDto[]>(
      whisparr.url,
      "/api/v3/rootfolder",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
    requestJson<QualityProfileDto[]>(
      whisparr.url,
      "/api/v3/qualityprofile",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
  ]);
  return {
    configured: true,
    version:
      typeof status?.version === "string"
        ? status.version.slice(0, 64)
        : undefined,
    appName:
      typeof status?.appName === "string"
        ? status.appName.slice(0, 64)
        : undefined,
    rootFolders: (Array.isArray(rootFolders) ? rootFolders : [])
      .filter((r) => Number.isInteger(r?.id) && typeof r?.path === "string")
      .map((r) => ({ id: r.id as number, path: r.path as string })),
    profiles: (Array.isArray(profiles) ? profiles : [])
      .filter((p) => Number.isInteger(p?.id) && typeof p?.name === "string")
      .map((p) => ({ id: p.id as number, name: p.name as string })),
  };
}
