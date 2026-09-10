"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  api,
  ApiError,
  ErrorPanel,
  intOr,
  ItemImage,
  messageOf,
  useParamsSetter,
  useSession,
} from "./shared";
import type {
  AcquisitionState,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  MediaKind,
  PlaybackAccess,
  RequestDecision,
  RequestRecord,
} from "../lib/contracts";

/* ---------- Local shapes for API responses ---------- */

type CatalogSearchPage = {
  provider: CatalogProvider;
  kind: CatalogKind;
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
};

type DetailPayload = {
  detail: CatalogDetail;
  link: { linked?: CatalogReference } | { unlinkedReason?: string };
  myRequest: {
    id: string;
    decision: RequestDecision;
    createdAt: number;
    decidedAt: number | null;
  } | null;
  acquisition: {
    state: AcquisitionState;
    lastError: string | null;
    updatedAt: number;
  } | null;
};

type DetailTarget = {
  provider: CatalogProvider;
  kind: CatalogKind;
  id: string;
};

/* ---------- Small helpers ---------- */

const PORTRAIT_COLS =
  "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
const LANDSCAPE_COLS = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

function providerLabel(p: CatalogProvider): string {
  return p === "tpdb" ? "TPDB" : "StashDB";
}

function providerStateLabel(s: "not_configured" | "not_verified"): string {
  return s === "not_configured"
    ? "not configured"
    : "API key present — not verified";
}

function providerOf(v: string | null): CatalogProvider {
  return v === "stashdb" ? "stashdb" : "tpdb";
}

function kindStrict(v: string | null): CatalogKind | null {
  return v === "movie" || v === "scene" || v === "performer" ? v : null;
}

function asMediaKind(kind: CatalogKind): MediaKind | null {
  return kind === "movie" || kind === "scene" ? kind : null;
}

/** Provider artwork may only reach the DOM through the same-origin proxy. */
function imgSrc(url: string | undefined): string | undefined {
  return url ? `/api/catalog/image?url=${encodeURIComponent(url)}` : undefined;
}

function duration(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Local input that resyncs when the URL value changes from the outside
 * (chip removal, provider switch, Back) without fighting the user's typing. */
function useSyncedInput(value: string) {
  const [input, setInput] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setInput(value);
    }
  });
  const mark = useCallback((v: string) => {
    committed.current = v;
  }, []);
  return { input, setInput, mark };
}

function SearchBox({
  id,
  label,
  value,
  onCommit,
  placeholder = "Search titles…",
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const { input, setInput, mark } = useSyncedInput(value);
  const commit = useCallback(
    (v: string) => {
      const t = v.trim();
      mark(t);
      onCommit(t);
    },
    [mark, onCommit],
  );
  useEffect(() => {
    if (input === value) return;
    const t = setTimeout(() => commit(input), 400);
    return () => clearTimeout(t);
  }, [input, value, commit]);
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="search"
        className="input"
        maxLength={200}
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(input);
        }}
      />
    </div>
  );
}

function YearBox({
  id,
  value,
  onCommit,
  locked,
  lockNote,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
  locked?: boolean;
  lockNote?: string;
}) {
  const { input, setInput, mark } = useSyncedInput(value);
  const commit = useCallback(() => {
    const t = input.trim();
    // Server rejects anything but a 4-digit year in range; never send junk.
    if (t !== "" && !/^\d{4}$/.test(t)) return;
    if (t !== "" && (Number(t) < 1870 || Number(t) > 2100)) return;
    mark(t);
    onCommit(t);
  }, [input, mark, onCommit]);
  return (
    <div>
      <label className="label" htmlFor={id}>
        Year
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1870}
        max={2100}
        placeholder="Any year"
        className="input"
        disabled={locked}
        value={input}
        aria-describedby={lockNote ? `${id}-note` : undefined}
        onChange={(e) => setInput(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {lockNote && (
        <p id={`${id}-note`} className="mt-1 text-xs text-muted">
          {lockNote}
        </p>
      )}
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="chip"
      onClick={onRemove}
      aria-label={`Remove filter: ${label}`}
    >
      {label} <span aria-hidden="true">×</span>
    </button>
  );
}

function GridSkeleton({
  aspect,
  cols,
  count,
}: {
  aspect: string;
  cols: string;
  count: number;
}) {
  return (
    <div className={cols} aria-label="Loading results" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel ${aspect}`} />
      ))}
    </div>
  );
}

/** Count text only when the provider attests a real total; a capped total
 * (totalCountKnown false) renders paging alone and never a fake size. */
function Paging({
  page,
  hasMore,
  total,
  totalCountKnown,
  onPage,
}: {
  page: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  onPage: (p: number) => void;
}) {
  const go = (p: number) => {
    onPage(p);
    window.scrollTo({ top: 0 });
  };
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <div className="text-sm text-muted">
        {totalCountKnown && total != null ? `${total} results · ` : ""}Page{" "}
        {page}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn"
          disabled={!hasMore}
          onClick={() => go(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function NotConfigured({ provider }: { provider: CatalogProvider }) {
  return (
    <div className="panel p-6" role="note">
      <h3 className="font-semibold">
        {providerLabel(provider)} is not configured
      </h3>
      <p className="mt-2 text-sm text-muted">
        No API key is present for {providerLabel(provider)}, so there is nothing
        to search. Ask an administrator to add a key in Settings. This is
        different from a temporary outage — an outage would show a retry.
      </p>
    </div>
  );
}

function SourcePicker({
  value,
  onChange,
}: {
  value: CatalogProvider;
  onChange: (p: CatalogProvider) => void;
}) {
  return (
    <div role="group" aria-label="Source provider">
      <div className="label">Source</div>
      <div className="mt-1 flex gap-2">
        {(["tpdb", "stashdb"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`btn ${value === p ? "btn-accent" : ""}`}
            aria-pressed={value === p}
            onClick={() => onChange(p)}
          >
            {providerLabel(p)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Search hook ---------- */

function useCatalogSearch(
  provider: CatalogProvider,
  kind: CatalogKind,
  q: string,
  year: string,
  performer: string,
  page: number,
  perPage: number,
  paged: boolean,
  enabled: boolean,
  reload: number,
): { data: CatalogSearchPage | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<CatalogSearchPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError(null);
    setLoading(true);
    const qs = new URLSearchParams({ provider, kind });
    if (paged) {
      qs.set("page", String(page));
      qs.set("perPage", String(perPage));
    }
    if (q) qs.set("q", q);
    if (year) qs.set("year", year);
    if (performer) qs.set("performer", performer);
    api<CatalogSearchPage>(`/api/catalog/search?${qs.toString()}`)
      .then((d) => {
        if (live) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          // An outage is an error, never an empty page.
          setError(messageOf(e));
          setLoading(false);
        }
      });
    return () => {
      live = false; // stale in-flight responses are ignored
    };
  }, [
    provider,
    kind,
    q,
    year,
    performer,
    page,
    perPage,
    paged,
    enabled,
    reload,
  ]);
  return { data, error, loading };
}

/* ---------- Cards: three deliberate treatments ---------- */

function MovieCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <button
      type="button"
      className="card text-left"
      onClick={() => onOpen(item.reference)}
    >
      <div className="relative aspect-[2/3] w-full bg-raised">
        <ItemImage
          name={item.title}
          src={imgSrc(item.imageUrl)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <div className="p-2">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="truncate text-xs text-muted">
          {[item.releaseDate?.slice(0, 4), item.studio?.name]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </button>
  );
}

function SceneCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  const performers = item.credits.map((c) => c.name).join(", ");
  return (
    <button
      type="button"
      className="card text-left"
      onClick={() => onOpen(item.reference)}
    >
      <div className="relative aspect-video w-full bg-raised">
        <ItemImage
          name={item.title}
          src={imgSrc(item.imageUrl)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <div className="p-2">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="truncate text-xs text-muted">
          {[item.releaseDate, item.studio?.name, duration(item.durationSeconds)]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {performers && (
          <div className="truncate text-xs text-muted">with {performers}</div>
        )}
      </div>
    </button>
  );
}

function PerformerCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  const aka = item.aliases[0];
  return (
    <button
      type="button"
      className="card text-left"
      onClick={() => onOpen(item.reference)}
    >
      <div className="relative aspect-square w-full bg-raised">
        <ItemImage
          name={item.title}
          src={imgSrc(item.imageUrl)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <div className="p-2">
        <div className="truncate text-sm font-medium">{item.title}</div>
        {aka && <div className="truncate text-xs text-muted">aka {aka}</div>}
      </div>
    </button>
  );
}

/* ---------- Detail dialog ---------- */

function detailTarget(params: URLSearchParams): DetailTarget | null {
  const providerRaw = params.get("provider");
  const provider =
    providerRaw === "tpdb" || providerRaw === "stashdb" ? providerRaw : null;
  const kind = kindStrict(params.get("kind"));
  const id = params.get("id");
  if (!provider || !kind || !id) return null;
  return { provider, kind, id };
}

function DetailSkeleton({ kind }: { kind: CatalogKind }) {
  return (
    <div className="flex gap-4" aria-label="Loading details" aria-busy="true">
      <div
        className={`skel shrink-0 ${
          kind === "scene" ? "aspect-video w-64" : "aspect-[2/3] w-36"
        }`}
      />
      <div className="flex-1 space-y-3 pt-2">
        <div className="skel h-6 w-3/4" />
        <div className="skel h-4 w-1/3" />
        <div className="skel h-4 w-full" />
        <div className="skel h-4 w-5/6" />
      </div>
    </div>
  );
}

const DECISION_TEXT: Record<RequestDecision, string> = {
  pending: "Requested — waiting for a moderator",
  approved: "Request approved",
  declined: "Request declined",
  cancelled: "Request cancelled",
};

function acquisitionText(a: {
  state: AcquisitionState;
  lastError: string | null;
}): string {
  switch (a.state) {
    case "unsent":
      return "Queued — not submitted yet";
    case "submitting":
      return "Queued — being submitted";
    case "monitoring":
      return "Watching for a release (this is not a failure)";
    case "downloading":
      return "Downloading";
    case "imported":
      return "Imported — in your library";
    case "uncertain":
      return "Being reconciled — the last check was inconclusive";
    case "failed":
      return a.lastError ? `Failed — ${a.lastError}` : "Failed";
    case "blocked":
      return "Blocked — delivery is turned off";
  }
}

const AVAIL_NOTE: Record<"denied" | "ambiguous" | "unavailable", string> = {
  denied: "Your account is not permitted to play this item.",
  ambiguous: "The library match is ambiguous — ask an administrator to check.",
  unavailable: "Availability cannot be checked right now.",
};

function AvailabilityBox({
  target,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
}) {
  const [avail, setAvail] = useState<PlaybackAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api<PlaybackAccess>(
      `/api/availability/${target.provider}/${target.kind}/${encodeURIComponent(target.id)}`,
    )
      .then((d) => {
        if (live) setAvail(d);
      })
      .catch((e) => {
        if (live) setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [target.provider, target.kind, target.id, reload]);
  return (
    <div className="mt-3">
      <div className="label">In your library</div>
      {error ? (
        <div className="mt-1">
          <ErrorPanel
            title="Availability check failed"
            message={error}
            onRetry={() => setReload((n) => n + 1)}
          />
        </div>
      ) : !avail ? (
        <div className="skel mt-1 h-10 w-full" aria-hidden="true" />
      ) : avail.outcome === "available" ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="chip chip-accent">Available now</span>
          {avail.watchUrl && (
            <a
              className="btn"
              href={avail.watchUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Jellyfin
            </a>
          )}
        </div>
      ) : avail.outcome === "missing" ? (
        <p className="mt-1 text-sm text-muted">
          Not in your library. Request it above and Velvarr will watch for it.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          {AVAIL_NOTE[avail.outcome]}
          {avail.reason ? ` — ${avail.reason}` : ""}
        </p>
      )}
    </div>
  );
}

function MediaActions({
  target,
  mine,
  acquisition,
  onRefetch,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
  mine: DetailPayload["myRequest"];
  acquisition: DetailPayload["acquisition"];
  onRefetch: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(mine);
  const [autoApproved, setAutoApproved] = useState(false);
  useEffect(() => setRequested(mine), [mine]);
  const request = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ request: RequestRecord; autoApproved?: boolean }>(
        "/api/requests",
        {
          method: "POST",
          body: JSON.stringify({
            media: {
              provider: target.provider,
              kind: target.kind,
              id: target.id,
            },
          }),
        },
      );
      setRequested({
        id: d.request.id,
        decision: d.request.decision,
        createdAt: d.request.createdAt,
        decidedAt: d.request.decidedAt,
      });
      setAutoApproved(d.autoApproved === true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "request_exists") {
        // An existing request is a state, not an error: reload the detail so
        // the real decision shows.
        onRefetch();
      } else {
        setError(messageOf(e));
      }
    } finally {
      setBusy(false);
    }
  }, [target, onRefetch]);
  return (
    <div className="mt-4">
      <div className="label">Request</div>
      {requested ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="chip chip-accent">
            {DECISION_TEXT[requested.decision]}
          </span>
          {autoApproved && <span className="chip">Auto-approved</span>}
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => void request()}
          >
            {busy ? "Requesting…" : "Request this title"}
          </button>
          {error && (
            <span className="text-sm text-danger" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
      {acquisition && (
        <p className="mt-2 text-sm text-muted">
          Acquisition status: {acquisitionText(acquisition)}
        </p>
      )}
      <AvailabilityBox target={target} />
      {target.kind === "movie" && (
        <p className="mt-2 text-xs text-muted">
          Owning one scene does not make the movie itself available in your
          library.
        </p>
      )}
    </div>
  );
}

function DetailBody({
  payload,
  target,
  onNavigate,
  onRefetch,
}: {
  payload: DetailPayload;
  target: DetailTarget;
  onNavigate: (r: CatalogReference) => void;
  onRefetch: () => void;
}) {
  const d = payload.detail;
  const mediaKind = asMediaKind(target.kind);
  const linked = "linked" in payload.link ? payload.link.linked : undefined;
  const studioRef =
    d.studio?.reference && asMediaKind(d.studio.reference.kind) !== null
      ? d.studio.reference
      : null;
  const aspect =
    target.kind === "scene"
      ? "aspect-video w-full sm:w-72"
      : target.kind === "performer"
        ? "aspect-square w-36 sm:w-44"
        : "aspect-[2/3] w-36 sm:w-44";
  const showSourceUrl =
    d.sourceUrl && !d.links.some((l) => l.url === d.sourceUrl)
      ? d.sourceUrl
      : null;
  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div
        className={`relative shrink-0 self-center bg-raised sm:self-start ${aspect}`}
      >
        <ItemImage
          name={d.title}
          src={imgSrc(d.imageUrl)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-xl font-semibold">{d.title}</h3>
        <div className="mt-1 flex flex-wrap gap-1">
          {d.releaseDate && <span className="chip">{d.releaseDate}</span>}
          {duration(d.durationSeconds) && (
            <span className="chip">{duration(d.durationSeconds)}</span>
          )}
          {d.studio && <span className="chip">{d.studio.name}</span>}
        </div>
        {d.description ? (
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {d.description}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">No description available.</p>
        )}
        {d.aliases.length > 0 && (
          <p className="mt-2 text-xs text-muted">
            Also known as: {d.aliases.join(", ")}
          </p>
        )}

        {d.credits.length > 0 && (
          <div className="mt-3">
            <div className="label">Performers</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {d.credits.map((c) => (
                <button
                  key={`${c.reference.provider}:${c.reference.id}`}
                  type="button"
                  className="chip flex items-center gap-1"
                  onClick={() => onNavigate(c.reference)}
                >
                  {c.imageUrl && (
                    <ItemImage
                      name={c.name}
                      src={imgSrc(c.imageUrl)}
                      className="h-5 w-5 rounded-full object-cover"
                    />
                  )}
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {studioRef && (
          <div className="mt-3">
            <div className="label">Studio</div>
            <button
              type="button"
              className="chip mt-1"
              onClick={() => onNavigate(studioRef)}
            >
              {d.studio?.name}
            </button>
          </div>
        )}

        {d.tags.length > 0 && (
          <div className="mt-3">
            <div className="label">Tags</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {d.tags.map((t) => (
                <span key={t.id} className="chip">
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3">
          <div className="label">Cross-provider link</div>
          {linked ? (
            <button
              type="button"
              className="chip chip-accent mt-1"
              onClick={() => onNavigate(linked)}
            >
              Open the linked {providerLabel(linked.provider)} record
            </button>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {"unlinkedReason" in payload.link
                ? payload.link.unlinkedReason
                : "No cross-provider link."}
            </p>
          )}
        </div>

        {(d.links.length > 0 || showSourceUrl) && (
          <div className="mt-3">
            <div className="label">Links</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {d.links.map((l, i) => (
                <a
                  key={i}
                  className="chip"
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {l.label ?? providerLabel(target.provider)}
                </a>
              ))}
              {showSourceUrl && (
                <a
                  className="chip"
                  href={showSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source · {providerLabel(target.provider)}
                </a>
              )}
            </div>
          </div>
        )}

        {mediaKind && (
          <MediaActions
            target={{
              provider: target.provider,
              kind: mediaKind,
              id: target.id,
            }}
            mine={payload.myRequest}
            acquisition={payload.acquisition}
            onRefetch={onRefetch}
          />
        )}

        {d.related.length > 0 && (
          <div className="mt-3">
            <div className="label">
              {target.kind === "movie"
                ? "Scenes in this movie (as supplied by the provider)"
                : "Related"}
            </div>
            <div className="mt-1 flex flex-wrap gap-2">
              {d.related.map((r, i) => (
                <button
                  key={`${r.provider}:${r.kind}:${r.id}:${i}`}
                  type="button"
                  className="chip"
                  onClick={() => onNavigate(r)}
                >
                  {providerLabel(r.provider)} · {r.kind} · {r.id.slice(0, 8)}…
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The open catalog detail: provider + kind + id URL params. Returns null
 * when closed; mounted by every catalog view so any surface can open it. */
function CatalogDetail() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const target = detailTarget(params);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const [payload, setPayload] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reload, setReload] = useState(0);
  const provider = target?.provider;
  const kind = target?.kind;
  const id = target?.id;
  const refKey = provider && kind && id ? `${provider}:${kind}:${id}` : null;

  const close = useCallback(
    () => setP({ provider: null, kind: null, id: null }),
    [setP],
  );

  // Escape closes; focus moves in on open and is restored on close. Background
  // scroll is deliberately left untouched.
  const open = refKey !== null;
  // Runs once per open/close — in-dialog navigation must not re-capture or
  // restore focus; only closing does.
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus.current?.focus();
    };
  }, [open, close]);
  // Moves focus into the panel on open and whenever the target changes.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open, refKey]);

  useEffect(() => {
    if (!provider || !kind || !id) return;
    let live = true;
    setPayload(null);
    setError(null);
    setNotFound(false);
    api<DetailPayload>(
      `/api/catalog/${provider}/${kind}/${encodeURIComponent(id)}`,
    )
      .then((d) => {
        if (live) setPayload(d);
      })
      .catch((e) => {
        if (!live) return;
        // 404 catalog_not_found is authoritative absence, not an outage.
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [provider, kind, id, reload]);

  if (!target) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
      onClick={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={
          payload ? `${payload.detail.title} details` : "Catalog details"
        }
        className="panel max-h-[92vh] w-full max-w-3xl overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="chip">
            {providerLabel(target.provider)} · {target.kind}
          </span>
          <button
            type="button"
            className="btn"
            onClick={close}
            aria-label="Close details"
          >
            Close
          </button>
        </div>
        {notFound ? (
          <div className="panel p-6" role="note">
            <h3 className="font-semibold">Not in the provider catalog</h3>
            <p className="mt-2 text-sm text-muted">
              {providerLabel(target.provider)} no longer has this record. It may
              have been removed at the source.
            </p>
          </div>
        ) : error ? (
          <ErrorPanel
            title="Catalog unavailable"
            message={error}
            onRetry={() => setReload((n) => n + 1)}
          />
        ) : !payload ? (
          <DetailSkeleton kind={target.kind} />
        ) : (
          <DetailBody
            key={refKey}
            payload={payload}
            target={target}
            onNavigate={(r) =>
              setP({ provider: r.provider, kind: r.kind, id: r.id })
            }
            onRefetch={() => setReload((n) => n + 1)}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- Views ---------- */

export function DiscoverView() {
  const setP = useParamsSetter();
  const { providers } = useSession();
  const shelves = [
    {
      view: "movies",
      title: "Movies",
      blurb:
        "Browse TPDB movies by title, year or performer. StashDB has no movies.",
    },
    {
      view: "scenes",
      title: "Scenes",
      blurb:
        "Browse scenes from TPDB and StashDB — kept separate by source, never merged.",
    },
    {
      view: "performers",
      title: "Performers",
      blurb: "Look up performers on TPDB and StashDB.",
    },
  ] as const;
  return (
    <section aria-label="Discover">
      <h2 className="text-xl font-semibold">Discover</h2>
      <p className="mt-1 text-sm text-muted">
        Jump into the catalog. Requesting and playback live on each title’s
        page.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {shelves.map((s) => (
          <button
            key={s.view}
            type="button"
            className="card p-4 text-left"
            onClick={() => setP({ view: s.view })}
          >
            <div className="font-medium">{s.title}</div>
            <div className="mt-1 text-sm text-muted">{s.blurb}</div>
          </button>
        ))}
      </div>
      <div className="panel mt-4 p-4 text-sm text-muted">
        {providers ? (
          <>
            TPDB: {providerStateLabel(providers.tpdb)} · StashDB:{" "}
            {providerStateLabel(providers.stashdb)}
          </>
        ) : (
          "Provider status is still loading."
        )}
      </div>
      <CatalogDetail />
    </section>
  );
}

export function MoviesView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  const q = params.get("q") ?? "";
  const year = params.get("year") ?? "";
  const performer = params.get("performer") ?? "";
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const [reload, setReload] = useState(0);
  const notConfigured = providers?.tpdb === "not_configured";
  const { data, error } = useCatalogSearch(
    "tpdb",
    "movie",
    q,
    year,
    performer,
    page,
    perPage,
    true,
    !notConfigured,
    reload,
  );
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null, page: null }),
    [setP],
  );
  const onYear = useCallback(
    (v: string) => setP({ year: v || null, page: null }),
    [setP],
  );
  const onPerformer = useCallback(
    (v: string) => setP({ performer: v || null, page: null }),
    [setP],
  );
  const retry = useCallback(() => setReload((n) => n + 1), []);
  return (
    <section aria-label="Movies">
      <h2 className="text-xl font-semibold">Movies</h2>
      <p className="mt-1 text-sm text-muted">
        Browsed from TPDB — StashDB has no movie records, so no source choice is
        offered here.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <div className="sm:max-w-xs sm:flex-1">
          <SearchBox id="movie-q" label="Search" value={q} onCommit={onQ} />
        </div>
        <div className="sm:w-36">
          <YearBox id="movie-year" value={year} onCommit={onYear} />
        </div>
        <div className="sm:w-56">
          <SearchBox
            id="movie-performer"
            label="Performer"
            value={performer}
            onCommit={onPerformer}
            placeholder="Performer name…"
          />
        </div>
      </div>
      {(q || year || performer) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Filters:</span>
          {q && <FilterChip label={`“${q}”`} onRemove={() => onQ("")} />}
          {year && (
            <FilterChip label={`Year ${year}`} onRemove={() => onYear("")} />
          )}
          {performer && (
            <FilterChip
              label={`Performer: ${performer}`}
              onRemove={() => onPerformer("")}
            />
          )}
        </div>
      )}
      <div className="mt-4">
        {notConfigured ? (
          <NotConfigured provider="tpdb" />
        ) : error ? (
          <ErrorPanel
            title="TPDB unavailable"
            message={error}
            onRetry={retry}
          />
        ) : !data ? (
          <GridSkeleton aspect="aspect-[2/3]" cols={PORTRAIT_COLS} count={10} />
        ) : data.items.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-muted">
            {q || year || performer
              ? "No movies match your filters."
              : "No movies found."}
          </div>
        ) : (
          <>
            <div className={PORTRAIT_COLS}>
              {data.items.map((it) => (
                <MovieCard key={it.reference.id} item={it} onOpen={open} />
              ))}
            </div>
            <Paging
              page={page}
              hasMore={data.hasMore}
              total={data.total}
              totalCountKnown={data.totalCountKnown}
              onPage={onPage}
            />
          </>
        )}
      </div>
      <CatalogDetail />
    </section>
  );
}

export function ScenesView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  const provider = providerOf(params.get("provider"));
  const q = params.get("q") ?? "";
  // Year only exists on TPDB; a stale year from the other source is ignored
  // and cleared on switch, never silently sent to StashDB.
  const year = provider === "tpdb" ? (params.get("year") ?? "") : "";
  const performer = params.get("performer") ?? "";
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const [reload, setReload] = useState(0);
  const notConfigured = providers?.[provider] === "not_configured";
  const { data, error } = useCatalogSearch(
    provider,
    "scene",
    q,
    year,
    performer,
    page,
    perPage,
    true,
    !notConfigured,
    reload,
  );
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null, page: null }),
    [setP],
  );
  const onYear = useCallback(
    (v: string) => setP({ year: v || null, page: null }),
    [setP],
  );
  const onPerformer = useCallback(
    (v: string) => setP({ performer: v || null, page: null }),
    [setP],
  );
  const onProvider = useCallback(
    (p: CatalogProvider) =>
      setP({
        provider: p,
        page: null,
        ...(p === "stashdb" ? { year: null } : {}),
      }),
    [setP],
  );
  const retry = useCallback(() => setReload((n) => n + 1), []);
  return (
    <section aria-label="Scenes">
      <h2 className="text-xl font-semibold">Scenes</h2>
      <p className="mt-1 text-sm text-muted">
        Results are labeled by source and never merged — pick TPDB or StashDB
        explicitly.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <SourcePicker value={provider} onChange={onProvider} />
        <div className="sm:max-w-xs sm:flex-1">
          <SearchBox id="scene-q" label="Search" value={q} onCommit={onQ} />
        </div>
        {provider === "tpdb" ? (
          <div className="sm:w-36">
            <YearBox id="scene-year" value={year} onCommit={onYear} />
          </div>
        ) : (
          <div className="sm:w-36">
            <YearBox
              id="scene-year"
              value=""
              onCommit={() => {}}
              locked
              lockNote="Not available for StashDB — StashDB scene search does not support year."
            />
          </div>
        )}
        <div className="sm:w-56">
          <SearchBox
            id="scene-performer"
            label="Performer"
            value={performer}
            onCommit={onPerformer}
            placeholder="Performer name…"
          />
        </div>
      </div>
      {(q || (provider === "tpdb" && year) || performer) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Filters:</span>
          {q && <FilterChip label={`“${q}”`} onRemove={() => onQ("")} />}
          {provider === "tpdb" && year && (
            <FilterChip label={`Year ${year}`} onRemove={() => onYear("")} />
          )}
          {performer && (
            <FilterChip
              label={`Performer: ${performer}`}
              onRemove={() => onPerformer("")}
            />
          )}
        </div>
      )}
      <div className="mt-4">
        {notConfigured ? (
          <NotConfigured provider={provider} />
        ) : error ? (
          <ErrorPanel
            title={`${providerLabel(provider)} unavailable`}
            message={error}
            onRetry={retry}
          />
        ) : !data ? (
          <GridSkeleton aspect="aspect-video" cols={LANDSCAPE_COLS} count={6} />
        ) : data.items.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-muted">
            {q || year || performer
              ? `No ${providerLabel(provider)} scenes match your filters.`
              : `No ${providerLabel(provider)} scenes found.`}
          </div>
        ) : (
          <>
            <div className={LANDSCAPE_COLS}>
              {data.items.map((it) => (
                <SceneCard key={it.reference.id} item={it} onOpen={open} />
              ))}
            </div>
            <Paging
              page={page}
              hasMore={data.hasMore}
              total={data.total}
              totalCountKnown={data.totalCountKnown}
              onPage={onPage}
            />
          </>
        )}
      </div>
      <CatalogDetail />
    </section>
  );
}

export function PerformersView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  const provider = providerOf(params.get("provider"));
  const q = params.get("q") ?? "";
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const [reload, setReload] = useState(0);
  // StashDB performer search is unpaged; TPDB performer search is paged but
  // still query-only — year and performer filters are invalid for both.
  const unpaged = provider === "stashdb";
  const notConfigured = providers?.[provider] === "not_configured";
  const needsQuery = q.trim() === "";
  const enabled = !notConfigured && !needsQuery;
  const { data, error } = useCatalogSearch(
    provider,
    "performer",
    q,
    "",
    "",
    page,
    perPage,
    !unpaged,
    enabled,
    reload,
  );
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null, page: null }),
    [setP],
  );
  const onProvider = useCallback(
    (p: CatalogProvider) => setP({ provider: p, page: null }),
    [setP],
  );
  const retry = useCallback(() => setReload((n) => n + 1), []);
  return (
    <section aria-label="Performers">
      <h2 className="text-xl font-semibold">Performers</h2>
      <p className="mt-1 text-sm text-muted">
        Performer search needs a name. {providerLabel(provider)}{" "}
        {unpaged ? "results come back unpaged." : "results are paged."}
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <SourcePicker value={provider} onChange={onProvider} />
        <div className="sm:max-w-xs sm:flex-1">
          <SearchBox
            id="performer-q"
            label="Search"
            value={q}
            onCommit={onQ}
            placeholder="Performer name…"
          />
        </div>
      </div>
      {q && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Filters:</span>
          <FilterChip label={`“${q}”`} onRemove={() => onQ("")} />
        </div>
      )}
      <div className="mt-4">
        {notConfigured ? (
          <NotConfigured provider={provider} />
        ) : needsQuery ? (
          <div className="panel p-8 text-center text-sm text-muted">
            Type a name to search {providerLabel(provider)} performers —
            performer search requires a query.
          </div>
        ) : error ? (
          <ErrorPanel
            title={`${providerLabel(provider)} unavailable`}
            message={error}
            onRetry={retry}
          />
        ) : !data ? (
          <GridSkeleton
            aspect="aspect-square"
            cols={PORTRAIT_COLS}
            count={10}
          />
        ) : data.items.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-muted">
            No {providerLabel(provider)} performers match “{q}”.
          </div>
        ) : (
          <>
            <div className={PORTRAIT_COLS}>
              {data.items.map((it) => (
                <PerformerCard key={it.reference.id} item={it} onOpen={open} />
              ))}
            </div>
            {unpaged ? (
              <div className="mt-6 text-sm text-muted">
                {data.totalCountKnown && data.total != null
                  ? `${data.total} results`
                  : `${data.items.length} results shown`}
              </div>
            ) : (
              <Paging
                page={page}
                hasMore={data.hasMore}
                total={data.total}
                totalCountKnown={data.totalCountKnown}
                onPage={onPage}
              />
            )}
          </>
        )}
      </div>
      <CatalogDetail />
    </section>
  );
}
