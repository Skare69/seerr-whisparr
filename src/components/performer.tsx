"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  ApiError,
  api,
  ErrorPanel,
  intOr,
  ItemImage,
  messageOf,
  useParamsSetter,
  useSession,
} from "./shared";
import type {
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
} from "../lib/contracts";

/* ---------- Local shapes ---------- */

type DetailPayload = {
  detail: CatalogDetail;
  link: { linked?: CatalogReference } | { unlinkedReason?: string };
};

type SearchPage = {
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
};

type Tab = "scenes" | "movies";

/* ---------- Small helpers (same conventions as catalog.tsx) ---------- */

const PORTRAIT_COLS =
  "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
const LANDSCAPE_COLS = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

function providerLabel(p: CatalogProvider): string {
  return p === "tpdb" ? "TPDB" : "StashDB";
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

/* ---------- Fetch hooks: a live flag makes stale in-flight responses inert ---------- */

function usePerformerDetail(
  provider: CatalogProvider,
  id: string,
  enabled: boolean,
  reload: number,
): { payload: DetailPayload | null; err: ApiError | null; loading: boolean } {
  const [payload, setPayload] = useState<DetailPayload | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setPayload(null);
    setErr(null);
    setLoading(true);
    api<DetailPayload>(
      `/api/catalog/${provider}/performer/${encodeURIComponent(id)}`,
    )
      .then((d) => {
        if (live) {
          setPayload(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setErr(
            e instanceof ApiError
              ? e
              : new ApiError(0, "network", messageOf(e)),
          );
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [provider, id, enabled, reload]);
  return { payload, err, loading };
}

function usePerformerListing(
  provider: CatalogProvider,
  kind: "movie" | "scene",
  performerId: string,
  page: number,
  perPage: number,
  reload: number,
): { data: SearchPage | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<SearchPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setError(null);
    setLoading(true);
    const qs = new URLSearchParams({
      provider,
      kind,
      performer: performerId,
      page: String(page),
      perPage: String(perPage),
    });
    api<SearchPage>(`/api/catalog/search?${qs.toString()}`)
      .then((d) => {
        if (live) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        // An outage is an error with retry, never an empty page.
        if (live) {
          setError(messageOf(e));
          setLoading(false);
        }
      });
    return () => {
      live = false; // stale in-flight responses are ignored
    };
  }, [provider, kind, performerId, page, perPage, reload]);
  return { data, error, loading };
}

/* ---------- Cards: the established treatments ---------- */

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

/* ---------- Panels, skeleton, paging ---------- */

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

function HeaderSkeleton() {
  return (
    <div
      className="flex flex-col gap-4 sm:flex-row"
      aria-label="Loading performer"
      aria-busy="true"
    >
      <div className="skel aspect-square w-36 shrink-0 self-center sm:w-44 sm:self-start" />
      <div className="flex-1 space-y-3 pt-2">
        <div className="skel h-6 w-1/2" />
        <div className="skel h-4 w-1/4" />
        <div className="skel h-4 w-full" />
        <div className="skel h-4 w-2/3" />
      </div>
    </div>
  );
}

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
        {/* A capped total is never rendered as a catalog size. */}
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

/* ---------- One paged tab listing (scenes, or TPDB movies) ---------- */

function Listing({
  provider,
  kind,
  performerId,
  performerName,
  page,
  perPage,
}: {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  performerId: string;
  performerName: string;
  page: number;
  perPage: number;
}) {
  const setP = useParamsSetter();
  const [reload, setReload] = useState(0);
  const { data, error, loading } = usePerformerListing(
    provider,
    kind,
    performerId,
    page,
    perPage,
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
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const kindLabel = kind === "movie" ? "movies" : "scenes";
  return (
    <div>
      {error ? (
        <ErrorPanel
          title={`${providerLabel(provider)} unavailable`}
          message={error}
          onRetry={retry}
        />
      ) : loading || !data ? (
        <GridSkeleton
          aspect={kind === "movie" ? "aspect-[2/3]" : "aspect-video"}
          cols={kind === "movie" ? PORTRAIT_COLS : LANDSCAPE_COLS}
          count={kind === "movie" ? 10 : 6}
        />
      ) : data.items.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          {providerLabel(provider)} returned no {kindLabel} for {performerName}.
        </div>
      ) : (
        <>
          <div className={kind === "movie" ? PORTRAIT_COLS : LANDSCAPE_COLS}>
            {data.items.map((it) =>
              kind === "movie" ? (
                <MovieCard key={it.reference.id} item={it} onOpen={open} />
              ) : (
                <SceneCard key={it.reference.id} item={it} onOpen={open} />
              ),
            )}
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
  );
}

/* ---------- StashDB has no movies: say so, never an empty grid ---------- */

function StashDbMoviesNote({
  performerName,
  linked,
  onOpen,
}: {
  performerName: string;
  linked?: CatalogReference;
  onOpen: (r: CatalogReference) => void;
}) {
  const tpdbPerformer =
    linked && linked.provider === "tpdb" && linked.kind === "performer"
      ? linked
      : undefined;
  return (
    <div className="panel p-6" role="note">
      <h3 className="font-semibold">Movies come from TPDB</h3>
      <p className="mt-2 text-sm text-muted">
        StashDB has no movie records, so this page lists {performerName}
        &rsquo;s StashDB scenes only.
      </p>
      {tpdbPerformer ? (
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => onOpen(tpdbPerformer)}
          >
            Open {performerName} on TPDB
          </button>
          <p className="mt-2 text-xs text-muted">
            Their TPDB page lists their TPDB movies.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">
          No TPDB link is recorded for this performer, so their TPDB movies
          cannot be shown here.
        </p>
      )}
    </div>
  );
}

/* ---------- The performer page ---------- */

const TAB_IDS = ["scenes", "movies"] as const;
const TAB_LABEL: Record<Tab, string> = { scenes: "Scenes", movies: "Movies" };

export function PerformerView({ reference }: { reference: CatalogReference }) {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  // URL-driven: tab (default scenes) and page survive reload and Back.
  const tab: Tab = params.get("tab") === "movies" ? "movies" : "scenes";
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const notConfigured = providers?.[reference.provider] === "not_configured";
  const [reload, setReload] = useState(0);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    scenes: null,
    movies: null,
  });

  const { payload, err, loading } = usePerformerDetail(
    reference.provider,
    reference.id,
    !notConfigured,
    reload,
  );
  const linked = payload
    ? "linked" in payload.link
      ? payload.link.linked
      : undefined
    : undefined;
  const unlinkedReason = payload
    ? "unlinkedReason" in payload.link
      ? payload.link.unlinkedReason
      : undefined
    : undefined;

  const onTab = useCallback(
    (t: Tab) => setP({ tab: t === "movies" ? "movies" : null, page: null }),
    [setP],
  );

  // Roving focus over the tablist; selection follows focus (automatic
  // activation). Arrow keys cycle — Home/End jump to the ends.
  const onTablistKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const next: Tab | null =
        e.key === "ArrowRight" || e.key === "ArrowLeft"
          ? tab === "scenes"
            ? "movies"
            : "scenes"
          : e.key === "Home"
            ? "scenes"
            : e.key === "End"
              ? "movies"
              : null;
      if (!next) return;
      e.preventDefault();
      onTab(next);
      tabRefs.current[next]?.focus();
    },
    [tab, onTab],
  );

  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }),
    [setP],
  );

  const d = payload?.detail;
  const sourceUrl =
    d?.sourceUrl && !d.links.some((l) => l.url === d.sourceUrl)
      ? d.sourceUrl
      : undefined;

  // The performer page is entered with a pushed history entry, so Back returns
  // to the results that led here. Shown only when there is somewhere to go
  // back to, so a deep link never offers a control that leaves the app.
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;

  return (
    <section aria-label="Performer">
      {canGoBack && (
        <button
          type="button"
          className="btn mb-3"
          onClick={() => window.history.back()}
        >
          Back to results
        </button>
      )}
      {notConfigured || err?.code === "provider_not_configured" ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">
            {providerLabel(reference.provider)} is not configured
          </h3>
          <p className="mt-2 text-sm text-muted">
            No API key is present for {providerLabel(reference.provider)}, so
            this performer&rsquo;s page cannot be loaded. Ask an administrator
            to add a key in Settings. This is different from a temporary outage
            — an outage would show a retry.
          </p>
        </div>
      ) : err?.status === 404 ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">Not in the provider catalog</h3>
          <p className="mt-2 text-sm text-muted">
            {providerLabel(reference.provider)} no longer has this record. It
            may have been removed at the source.
          </p>
        </div>
      ) : err ? (
        <ErrorPanel
          title={`${providerLabel(reference.provider)} unavailable`}
          message={err.message}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : loading || !d ? (
        <HeaderSkeleton />
      ) : (
        <>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="relative aspect-square w-36 shrink-0 self-center bg-raised sm:w-44 sm:self-start">
              <ItemImage
                name={d.title}
                src={imgSrc(d.imageUrl)}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold">{d.title}</h2>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="chip">
                  {providerLabel(reference.provider)} · performer
                </span>
              </div>
              {d.aliases.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Also known as: {d.aliases.join(", ")}
                </p>
              )}
              {d.description && (
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  {d.description}
                </p>
              )}

              <div className="mt-3">
                <div className="label">Cross-provider link</div>
                {linked ? (
                  <button
                    type="button"
                    className="chip chip-accent mt-1"
                    onClick={() => open(linked)}
                  >
                    Open the linked {providerLabel(linked.provider)} record
                  </button>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    {unlinkedReason
                      ? unlinkedReason
                      : "No cross-provider link is recorded, so the other provider’s catalog cannot be shown for this performer."}
                  </p>
                )}
              </div>

              {(d.links.length > 0 || sourceUrl) && (
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
                        {l.label ?? providerLabel(reference.provider)}
                      </a>
                    ))}
                    {sourceUrl && (
                      <a
                        className="chip"
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Source · {providerLabel(reference.provider)}
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6">
            <div
              role="tablist"
              aria-label={`${d.title} catalogs`}
              className="flex gap-2"
              onKeyDown={onTablistKeyDown}
            >
              {TAB_IDS.map((t) => (
                <button
                  key={t}
                  ref={(el) => {
                    tabRefs.current[t] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`performer-tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`performer-panel-${t}`}
                  tabIndex={tab === t ? 0 : -1}
                  className={`btn ${tab === t ? "btn-accent" : ""}`}
                  onClick={() => onTab(t)}
                >
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id={`performer-panel-${tab}`}
              aria-labelledby={`performer-tab-${tab}`}
              className="mt-4"
            >
              {tab === "movies" && reference.provider === "stashdb" ? (
                <StashDbMoviesNote
                  performerName={d.title}
                  linked={linked}
                  onOpen={open}
                />
              ) : (
                <Listing
                  key={tab}
                  provider={reference.provider}
                  kind={tab === "movies" ? "movie" : "scene"}
                  performerId={reference.id}
                  performerName={d.title}
                  page={page}
                  perPage={perPage}
                />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
