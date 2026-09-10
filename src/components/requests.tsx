"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, ErrorPanel, messageOf, useSession } from "./shared";
import type {
  MediaReference,
  ProviderStatus,
  RequestDecision,
  RequestRecord,
} from "../lib/contracts";

/* Facts displayed per row, kept visibly separate:
 *  1. Decision  — one user's intent (this list, from RequestRecord).
 *  2. Acquisition — shared work several requests attach to. GET /api/requests
 *     returns RequestRecord[] only, so the list never has an acquisition state
 *     to show; it is surfaced on the catalog detail, never invented here.
 *  3. Playback — per-user; resolved on the catalog detail, never here.
 * Cancelling removes only the request (intent) and never shared media — stated
 * in the visible note below. */

// Locale-aware and stable across rows; timestamps are unix milliseconds.
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const GROUP_ORDER: RequestDecision[] = [
  "pending",
  "approved",
  "declined",
  "cancelled",
];

const GROUP_LABEL: Record<RequestDecision, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Error codes from PATCH /api/requests/:id, mapped faithfully per row. */
function decisionError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "forbidden")
      return "You do not have permission to change this request.";
    if (e.code === "request_not_found")
      return "This request no longer exists — it may have already been removed. Refresh to update the list.";
    if (e.code === "request_not_pending")
      return "This request is no longer pending — it was already decided. Refresh to see the current state.";
    if (e.code === "request_not_cancellable")
      return "This request can no longer be cancelled. Refresh to see the current state.";
  }
  return messageOf(e);
}

/* ponytail: module-level title cache — titles are public provider facts keyed
 * by reference; unbounded only by distinct requested media. Drop if that grows. */
const titleCache = new Map<string, string | null>();

const keyOf = (m: MediaReference) => `${m.provider}:${m.kind}:${m.id}`;

/** The provider reference — shown while (or instead of) a title. */
function ReferenceLine({ media }: { media: MediaReference }) {
  return (
    <span className="font-mono text-xs break-all text-muted">
      {media.provider} · {media.kind} · {media.id}
    </span>
  );
}

/** Lazily resolves a row's title from the catalog detail. Renders the
 * reference immediately and never blocks on provider health: an outage, a 404
 * catalog_not_found, or a not-configured provider all degrade to the
 * reference. Null cache entries remember known-unresolvable references. */
function MediaTitle({
  media,
  providers,
}: {
  media: MediaReference;
  providers: ProviderStatus | null;
}) {
  const key = keyOf(media);
  const [title, setTitle] = useState<string | null | undefined>(() =>
    titleCache.get(key),
  );

  useEffect(() => {
    if (title !== undefined) return;

    // A not-configured provider can never answer; the reference is the honest display.
    if (providers && providers[media.provider] === "not_configured") {
      titleCache.set(key, null);
      setTitle(null);
      return;
    }
    let live = true;
    api<{ detail: { title: string } }>(
      `/api/catalog/${media.provider}/${media.kind}/${media.id}`,
    )
      .then((d) => {
        titleCache.set(key, d.detail.title);
        if (live) setTitle(d.detail.title);
      })
      .catch(() => {
        titleCache.set(key, null);
        if (live) setTitle(null);
      });
    return () => {
      live = false;
    };
  }, [key, title, providers, media.provider, media.kind, media.id]);

  if (title) return <span className="font-medium">{title}</span>;
  return <ReferenceLine media={media} />;
}

/** Link target for the shared URL contract: an open catalog detail is
 * view + provider + kind + id; the catalog view matches the media kind. */
function detailHref(media: MediaReference): string {
  const view = media.kind === "movie" ? "movies" : "scenes";
  return `/?view=${view}&provider=${media.provider}&kind=${media.kind}&id=${encodeURIComponent(media.id)}`;
}

function RequestRow({
  record,
  canApprove,
  canDecline,
  canCancel,
  busy,
  providers,
  onDecide,
  rowError,
}: {
  record: RequestRecord;
  canApprove: boolean;
  canDecline: boolean;
  canCancel: boolean;
  busy: boolean;
  providers: ProviderStatus | null;
  onDecide: (
    record: RequestRecord,
    decision: "approved" | "declined" | "cancelled",
  ) => void;
  rowError: { id: string; message: string } | null;
}) {
  const r = record;
  return (
    <li className="panel p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <MediaTitle media={r.media} providers={providers} />
          <p className="mt-1 text-xs text-muted">
            {r.media.provider} · {r.media.kind}
          </p>
          <p className="mt-1 text-xs text-muted">
            Requested {DATE_FMT.format(new Date(r.createdAt))}
            {r.decidedAt !== null
              ? ` · Decided ${DATE_FMT.format(new Date(r.decidedAt))}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`chip ${r.decision === "pending" ? "chip-accent" : ""}`}
          >
            {GROUP_LABEL[r.decision]}
          </span>
          <a className="btn" href={detailHref(r.media)}>
            View in catalog
          </a>
          {canApprove && (
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => onDecide(r, "approved")}
            >
              Approve
            </button>
          )}
          {canDecline && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onDecide(r, "declined")}
            >
              Decline
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onDecide(r, "cancelled")}
            >
              Cancel request
            </button>
          )}
        </div>
      </div>
      {rowError !== null && rowError.id === r.id && (
        <div className="mt-3">
          <ErrorPanel title="Update not applied" message={rowError.message} />
        </div>
      )}
    </li>
  );
}

export function RequestsView() {
  const { account, providers } = useSession();
  const [requests, setRequests] = useState<RequestRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const isStaff = account.role === "admin" || account.role === "moderator";

  // Re-read after every successful decision — the UI never guesses a result.
  const load = useCallback(() => {
    setError(null);
    api<{ requests: RequestRecord[] }>("/api/requests")
      .then((d) => setRequests(d.requests))
      .catch((e: unknown) => setError(messageOf(e)));
  }, []);

  useEffect(load, [load]);

  const decide = useCallback(
    (
      record: RequestRecord,
      decision: "approved" | "declined" | "cancelled",
    ) => {
      if (busyRef.current) return; // belt for same-tick double clicks
      busyRef.current = true;
      setBusyId(record.id);
      setRowError(null);
      api<{ request: RequestRecord }>(`/api/requests/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      })
        .then(() => {
          setAnnouncement(`Request ${decision}.`);
          busyRef.current = false;
          setBusyId(null);
          load(); // re-read; server truth, no optimism
        })
        .catch((e: unknown) => {
          const msg = decisionError(e);
          setAnnouncement(msg);
          busyRef.current = false;
          setBusyId(null);
          setRowError({ id: record.id, message: msg });
        });
    },
    [load],
  );

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((decision) => ({
        decision,
        items: (requests ?? [])
          .filter((r) => r.decision === decision)
          .sort((a, b) => b.createdAt - a.createdAt),
      })).filter((g) => g.items.length > 0),
    [requests],
  );

  let content;
  if (error !== null) {
    // Provider/server outage is an error with retry, never an empty state.
    content = (
      <ErrorPanel title="Requests unavailable" message={error} onRetry={load} />
    );
  } else if (requests === null) {
    content = (
      <>
        <div className="sr-only" role="status">
          Loading requests
        </div>
        <div className="grid gap-3" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skel h-20 w-full" />
          ))}
        </div>
      </>
    );
  } else if (requests.length === 0) {
    content = (
      <div className="panel p-8 text-center text-sm text-muted">
        {isStaff
          ? "No one has requested anything yet."
          : "You have not requested anything yet. Find something in the catalog and request it."}
      </div>
    );
  } else {
    content = (
      <div className="grid gap-8">
        {groups.map((g) => (
          <section key={g.decision} aria-labelledby={`requests-${g.decision}`}>
            <h2
              id={`requests-${g.decision}`}
              className="mb-3 text-lg font-semibold"
            >
              {GROUP_LABEL[g.decision]}{" "}
              <span className="text-sm font-normal text-muted">
                ({g.items.length})
              </span>
            </h2>
            <ul className="grid gap-3">
              {g.items.map((r) => {
                const mine = r.accountId === account.id;
                const pending = r.decision === "pending";
                return (
                  <RequestRow
                    key={r.id}
                    record={r}
                    providers={providers}
                    busy={busyId !== null}
                    rowError={rowError}
                    onDecide={decide}
                    // Staff decide anyone's pending request; the owner cancels
                    // their own pending or approved one; an owner holding the
                    // autoApprove grant may approve their own pending request.
                    canApprove={
                      pending && (isStaff || (mine && account.autoApprove))
                    }
                    canDecline={pending && isStaff}
                    canCancel={mine && (pending || r.decision === "approved")}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Requests</h2>
          <p className="mt-1 text-sm text-muted">
            {isStaff
              ? "Showing every user's requests."
              : "Showing only your own requests."}
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setRowError(null);
            load();
          }}
        >
          Refresh
        </button>
      </div>

      <p className="mb-6 max-w-prose text-sm text-muted">
        A request is one person&rsquo;s intent. Downloading is shared work that
        several requests can attach to, and playback access is decided per
        person — neither is changed here. Cancelling removes only that
        request&rsquo;s intent; it never deletes shared media.
      </p>

      {content}
    </div>
  );
}
