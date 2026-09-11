// Durable delivery/reconciliation worker over the landed storage and Whisparr
// interfaces. The loop holds no user sessions and never imports route code:
// every decision comes from persisted acquisition state, current stored
// accounts, and the integration credentials in the stored config. Timers are
// scheduling only — all durable state lives in SQLite, so a crash between
// steps leaves recoverable evidence, never a lost or duplicated add.

import { AppError } from "./http.ts";
import * as storage from "./storage.ts";
import {
  deliverToWhisparr,
  findWhisparrItem,
  observeWhisparrItem,
  type WhisparrDeliveryResult,
  type WhisparrObservation,
  type WhisparrItem,
} from "./whisparr.ts";
import type {
  Account,
  AcquisitionRecord,
  IntegrationConfig,
  MediaReference,
} from "../lib/contracts.ts";

// ponytail: fixed 60s cadence and 20-item batch are the ceilings; tune only
// when a real deployment shows pressure.
const INTERVAL_MS = 60_000;
const BATCH_SIZE = 20;
// ponytail: flat pass-level backoff with jitter, no per-item attempt counter —
// every re-POST is preceded by exact-identity reconciliation, so repetition
// can never duplicate an add.
const MAX_BACKOFF_MS = 10 * 60_000;
const JITTER_MS = 5_000;

export type WorkSummary = {
  /** Items the pass pulled from the due list. */
  considered: number;
  /** Adds Whisparr accepted. */
  delivered: number;
  /** Identities adopted because Whisparr already stored them. */
  adopted: number;
  reconciled: number;
  /** Real observations (monitoring/downloading/imported) recorded. */
  observed: number;
  /** Failed/unknown checks (outage) that left state and facts intact. */
  unavailable: number;
  /** Proven upstream absences: a successful lookup showed the identity
   * gone; facts cleared, state and history intact. */
  absent: number;
  failed: number;
  /** Outcomes still unknown; reconciled by identity on a later pass. */
  uncertain: number;
  /** Honestly blocked: delivery off/unconfigured, or no eligible requester. */
  blocked: number;
  /** Claims lost to a concurrent worker; skipped, never double-sent. */
  contention: number;
  /** Unexpected per-item errors swallowed to keep the batch alive. */
  errors: number;
  /** True when this call was skipped because a pass was already in flight. */
  overlap: boolean;
};

const EMPTY_SUMMARY: WorkSummary = {
  considered: 0,
  delivered: 0,
  adopted: 0,
  reconciled: 0,
  observed: 0,
  unavailable: 0,
  absent: 0,
  failed: 0,
  uncertain: 0,
  blocked: 0,
  contention: 0,
  errors: 0,
  overlap: false,
};

// listRequests filters on the viewer's role and touches no session or token;
// this stub just reads the full request history so eligibility can be
// re-checked against the current stored accounts before any dispatch.
const ALL_REQUESTS_VIEWER = {
  id: "",
  name: "acquisition-worker",
  role: "admin",
  enabled: true,
  libraryIds: [],
  isOwner: false,
  autoApprove: false,
} as const satisfies Account;

function reasonOf(e: unknown): string {
  const raw =
    e instanceof Error ? e.message : e instanceof AppError ? e.message : "";
  // AppError messages are sanitized upstream; never echo URLs or config.
  return (raw.trim().slice(0, 2000) || "unknown error").slice(0, 2000);
}

function deliveryReady(config: IntegrationConfig | null): boolean {
  const w = config?.whisparr;
  return (
    typeof w?.url === "string" &&
    w.url !== "" &&
    typeof w.apiKey === "string" &&
    w.apiKey !== "" &&
    w.delivery?.enabled === true
  );
}

/** Admission re-read from storage: an approved request only dispatches while
 * at least one requester account is still present and enabled. */
function hasEligibleRequester(media: MediaReference): boolean {
  return storage
    .listRequests(ALL_REQUESTS_VIEWER)
    .some(
      (r) =>
        r.decision === "approved" &&
        r.media.provider === media.provider &&
        r.media.kind === media.kind &&
        r.media.id === media.id &&
        storage.getAccount(r.accountId)?.enabled === true,
    );
}

function itemFacts(item: WhisparrItem): {
  whisparrId: number;
  path: string;
  title?: string;
} {
  return {
    whisparrId: item.whisparrId,
    path: item.path,
    ...(item.title !== undefined ? { title: item.title } : {}),
  };
}

/** One delivery attempt. The attempt row is persisted BEFORE any network
 * submission, so a crash leaves recoverable evidence (state submitting,
 * recovered to uncertain at the next boot) instead of a blind retry. */
async function dispatch(
  record: AcquisitionRecord,
  config: IntegrationConfig,
  claimToken: string,
  summary: WorkSummary,
): Promise<void> {
  const { attemptToken } = storage.beginSubmission(record.id, claimToken);
  let result: WhisparrDeliveryResult;
  try {
    result = await deliverToWhisparr(config, record.media);
  } catch (e) {
    const proven = e instanceof AppError ? e.upstreamStatus : undefined;
    if (proven !== undefined && proven >= 400 && proven < 500) {
      // Definitive client-side rejection before any add was accepted. A
      // generic 400 is a failure, never "already exists".
      storage.completeSubmission(
        record.id,
        claimToken,
        attemptToken,
        "failed",
        reasonOf(e),
      );
      summary.failed++;
    } else {
      // Timeout/5xx/network: unknown whether Whisparr stored anything. Stay
      // uncertain; the next pass reconciles by exact identity.
      storage.completeSubmission(
        record.id,
        claimToken,
        attemptToken,
        "uncertain",
        reasonOf(e),
      );
      summary.uncertain++;
    }
    return;
  }
  switch (result.outcome) {
    case "accepted":
    case "adopted": {
      storage.completeSubmission(
        record.id,
        claimToken,
        attemptToken,
        "accepted",
      );
      // Persist the stored item's facts now: playback path matching depends
      // on whisparrPath, and the next observation is a full interval away.
      storage.recordAcquisitionObservation(
        record.id,
        { state: "monitoring", item: itemFacts(result.item) },
        claimToken,
      );
      if (result.outcome === "adopted") summary.adopted++;
      else summary.delivered++;
      return;
    }
    case "failed":
      storage.completeSubmission(
        record.id,
        claimToken,
        attemptToken,
        "failed",
        result.reason,
      );
      summary.failed++;
      return;
    case "uncertain":
      storage.completeSubmission(
        record.id,
        claimToken,
        attemptToken,
        "uncertain",
        result.reason,
      );
      summary.uncertain++;
      return;
  }
}

/** Uncertainty rule: reconcile by exact identity BEFORE any second POST.
 * Found → record the real observation, no POST. Provably absent → one fresh
 * attempt. Unknown check (outage) → stay uncertain, recheck later. */
async function reconcileUncertain(
  record: AcquisitionRecord,
  config: IntegrationConfig,
  claimToken: string,
  summary: WorkSummary,
): Promise<void> {
  let existing: WhisparrItem | null;
  try {
    existing = await findWhisparrItem(config, record.media);
  } catch (e) {
    storage.recordAcquisitionObservation(
      record.id,
      { unavailable: true, reason: reasonOf(e) },
      claimToken,
    );
    summary.uncertain++;
    return;
  }
  if (existing !== null) {
    // Already stored upstream — never re-add.
    storage.recordAcquisitionObservation(
      record.id,
      {
        state: existing.hasFile ? "imported" : "monitoring",
        item: itemFacts(existing),
      },
      claimToken,
    );
    summary.reconciled++;
    return;
  }
  await dispatch(record, config, claimToken, summary);
}

/** Recheck previously-sent work. Real observations persist state and the
 * item facts playback depends on; an outage records a failed check without
 * touching recorded state or the last successful observation; a proven
 * absence (successful lookup, identity gone) is recorded authoritatively.
 * Monitoring with no release is never a failure — it is the steady state. */
async function observe(
  record: AcquisitionRecord,
  config: IntegrationConfig,
  claimToken: string,
  summary: WorkSummary,
): Promise<void> {
  let obs: WhisparrObservation;
  try {
    obs = await observeWhisparrItem(config, record.media);
  } catch (e) {
    // An outage records a failed check; recorded state and the last
    // successful observation stay untouched.
    storage.recordAcquisitionObservation(
      record.id,
      { unavailable: true, reason: reasonOf(e) },
      claimToken,
    );
    summary.unavailable++;
    return;
  }
  if (obs.found) {
    storage.recordAcquisitionObservation(
      record.id,
      { state: obs.state, item: itemFacts(obs.item) },
      claimToken,
    );
    summary.observed++;
  } else {
    // Proven upstream absence from a successful lookup (removed out of
    // band): an authoritative absence — facts cleared for callers, state
    // and history intact. Never a blind re-add and never a deletion
    // upstream.
    storage.recordAcquisitionObservation(
      record.id,
      { absent: true, reason: "whisparr no longer has this identity" },
      claimToken,
    );
    summary.absent++;
  }
}

async function processOne(
  item: AcquisitionRecord,
  config: IntegrationConfig | null,
  summary: WorkSummary,
): Promise<void> {
  // Local gates before any claim or network call: disabled delivery and
  // inadmissible requesters leave work honestly blocked (reason persisted,
  // state untouched) instead of looping against Whisparr or faking success.
  if (config === null || !deliveryReady(config)) {
    storage.recordAcquisitionObservation(item.id, {
      unavailable: true,
      reason: "whisparr delivery is disabled or unconfigured",
    });
    summary.blocked++;
    return;
  }
  if (item.state === "unsent" && !hasEligibleRequester(item.media)) {
    storage.recordAcquisitionObservation(item.id, {
      unavailable: true,
      reason: "no eligible requester remains for this acquisition",
    });
    summary.blocked++;
    return;
  }
  let claim: { record: AcquisitionRecord; claimToken: string };
  try {
    claim = storage.claimAcquisition(item.id);
  } catch (e) {
    if (e instanceof AppError && e.status === 409) {
      // Normal concurrency: another worker holds the claim. Skip the item
      // for this pass; never retry it here.
      summary.contention++;
      return;
    }
    throw e;
  }
  const { record, claimToken } = claim;
  try {
    switch (record.state) {
      case "uncertain":
        await reconcileUncertain(record, config, claimToken, summary);
        break;
      case "unsent":
        await dispatch(record, config, claimToken, summary);
        break;
      default:
        await observe(record, config, claimToken, summary);
        break;
    }
  } finally {
    // A thrown error must never strand the claim; a stale token no-ops.
    storage.releaseAcquisitionClaim(record.id, claimToken);
  }
}

/** Process one bounded batch of due work. Non-overlapping: a call made while
 * a pass is in flight is skipped, never queued. */
export async function runDueWork(
  now: number = Date.now(),
): Promise<WorkSummary> {
  if (passInFlight) {
    return { ...EMPTY_SUMMARY, overlap: true };
  }
  passInFlight = true;
  const summary: WorkSummary = { ...EMPTY_SUMMARY };
  try {
    const config = storage.getConfig();
    const due = storage.listDueAcquisitions(now, BATCH_SIZE);
    summary.considered = due.length;
    for (const item of due) {
      try {
        await processOne(item, config, summary);
      } catch (e) {
        // One bad item must not kill the batch; the claim was released in
        // processOne's finally and the item stays due for a later pass.
        summary.errors++;
        console.error(`[velvarr:acquisition] item ${item.id}: ${reasonOf(e)}`);
      }
    }
  } finally {
    passInFlight = false;
  }
  return summary;
}

let timer: NodeJS.Timeout | null = null;
let loopActive = false;
let passInFlight = false;
let backoffMs = 0;

function schedulePass(delayMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, delayMs);
  // A stopping process must not be kept alive by the pending timer.
  timer.unref?.();
}

async function tick(): Promise<void> {
  if (!loopActive) return;
  let summary: WorkSummary;
  try {
    summary = await runDueWork();
    backoffMs =
      summary.errors > 0
        ? Math.min(Math.max(backoffMs * 2, 5_000), MAX_BACKOFF_MS)
        : 0;
  } catch (e) {
    summary = { ...EMPTY_SUMMARY };
    backoffMs = Math.min(Math.max(backoffMs * 2, 5_000), MAX_BACKOFF_MS);
    console.error(`[velvarr:acquisition] pass failed: ${reasonOf(e)}`);
  }
  if (loopActive) {
    schedulePass(
      INTERVAL_MS + backoffMs + Math.floor(Math.random() * JITTER_MS),
    );
  }
}

/** Start the periodic loop. Idempotent; the first pass runs immediately. */
export function startAcquisitionLoop(): void {
  if (loopActive) return;
  loopActive = true;
  schedulePass(0);
}

/** Stop the loop and prevent further passes. Safe to call twice. */
export function stopAcquisitionLoop(): void {
  loopActive = false;
  backoffMs = 0;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
