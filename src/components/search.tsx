"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type {
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
} from "../lib/contracts.ts";
import {
  api,
  ErrorPanel,
  ItemImage,
  messageOf,
  useParamsSetter,
} from "./shared.tsx";

/* ---------- API shape (GET /api/search) ---------- */

type SearchCategory = {
  id: string;
  provider: CatalogProvider;
  kind: CatalogKind;
  items: CatalogDetail[];
  error?: { code: string; message: string };
};

type SearchPayload = { query: string; categories: SearchCategory[] };

/* ---------- Small helpers ---------- */

const PORTRAIT_COLS =
  "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
const LANDSCAPE_COLS = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";
const SQUARE_COLS =
  "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6";
const STUDIO_COLS = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

// Three+ call sites below must label providers in lockstep with the catalog views.
function providerLabel(p: CatalogProvider): string {
  return p === "tpdb" ? "TPDB" : "StashDB";
}

const KIND_LABEL: Record<CatalogKind, string> = {
  movie: "Movies",
  scene: "Scenes",
  performer: "Performers",
  studio: "Studios",
};

/** Provider artwork may only reach the DOM through the same-origin proxy. */
function imgSrc(url: string | undefined): string | undefined {
  return url ? `/api/catalog/image?url=${encodeURIComponent(url)}` : undefined;
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

/* ---------- Cards: same treatments as the catalog views ---------- */

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
  const mins = item.durationSeconds
    ? `${Math.round(item.durationSeconds / 60)} min`
    : null;
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
          {[item.releaseDate, item.studio?.name, mins]
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

// Studios are text-first: a name and a blurb, never a fake poster crop.
function StudioCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <button
      type="button"
      className="card p-3 text-left"
      onClick={() => onOpen(item.reference)}
    >
      <div className="truncate text-sm font-medium">{item.title}</div>
      {item.description && (
        <div className="mt-1 line-clamp-2 text-xs text-muted">
          {item.description}
        </div>
      )}
    </button>
  );
}

/* ---------- One source category ---------- */

function CategorySection({
  cat,
  q,
  onRetry,
  onOpen,
}: {
  cat: SearchCategory;
  q: string;
  onRetry: () => void;
  onOpen: (r: CatalogReference) => void;
}) {
  const label = `${providerLabel(cat.provider)} ${KIND_LABEL[cat.kind]}`;
  const headingId = `search-cat-${cat.id}`;
  return (
    <section aria-labelledby={headingId} className="mt-8 first:mt-0">
      <h3 id={headingId} className="text-lg font-semibold">
        {label}
      </h3>
      <p className="mt-1 text-xs text-muted">
        {providerLabel(cat.provider)}’s own result set — never merged with other
        sources and never globally ranked.
      </p>
      <div className="mt-3">
        {cat.error ? (
          cat.error.code === "provider_not_configured" ? (
            // A missing key is a missing key: no retry, never an outage.
            <div className="panel p-4" role="note">
              <div className="font-medium">{label} is not configured</div>
              <p className="mt-1 text-sm text-muted">
                No API key is present for {providerLabel(cat.provider)}, so this
                section has nothing to search. That is a missing key, not an
                outage; add it under Settings.
              </p>
            </div>
          ) : (
            <ErrorPanel
              title={`${label} unavailable`}
              message={cat.error.message}
              onRetry={onRetry}
            />
          )
        ) : cat.items.length === 0 ? (
          <div className="panel p-4 text-sm text-muted">
            No {KIND_LABEL[cat.kind].toLowerCase()} results in{" "}
            {providerLabel(cat.provider)} for “{q}”.
          </div>
        ) : cat.kind === "movie" ? (
          <div className={PORTRAIT_COLS}>
            {cat.items.map((it) => (
              <MovieCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        ) : cat.kind === "scene" ? (
          <div className={LANDSCAPE_COLS}>
            {cat.items.map((it) => (
              <SceneCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        ) : cat.kind === "performer" ? (
          <div className={SQUARE_COLS}>
            {cat.items.map((it) => (
              <PerformerCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <div className={STUDIO_COLS}>
            {cat.items.map((it) => (
              <StudioCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- The surface ---------- */

export function SearchView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const q = (params.get("q") ?? "").trim();
  const ready = q.length >= 2;
  const [data, setData] = useState<SearchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  // Search fires on an explicit URL change only — never on keystrokes.
  useEffect(() => {
    if (!ready) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setError(null);
    setLoading(true);
    api<SearchPayload>(`/api/search?q=${encodeURIComponent(q)}`)
      .then((d) => {
        if (live) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(messageOf(e));
          setLoading(false);
        }
      });
    return () => {
      live = false; // stale in-flight responses are ignored
    };
  }, [q, ready, reload]);

  const open = useCallback(
    (r: CatalogReference) => {
      const clear = {
        q: null,
        year: null,
        performer: null,
        studio: null,
        tags: null,
        tagsAll: null,
        tagsExclude: null,
        sort: null,
        direction: null,
        page: null,
        perPage: null,
        tab: null,
        provider: null,
        kind: null,
        id: null,
      };
      // The reset must come first: spreading it last silently overwrote every
      // destination value, so no result could navigate anywhere.
      if (r.kind === "movie")
        setP({
          ...clear,
          view: "movies",
          provider: r.provider,
          kind: "movie",
          id: r.id,
        });
      else if (r.kind === "scene")
        setP({
          ...clear,
          view: "scenes",
          provider: r.provider,
          kind: "scene",
          id: r.id,
        });
      else if (r.kind === "performer")
        setP({
          ...clear,
          view: "performers",
          provider: r.provider,
          kind: "performer",
          id: r.id,
        });
      else if (r.provider === "stashdb")
        setP({
          ...clear,
          view: "scenes",
          provider: "stashdb",
          kind: "scene",
          studio: r.id,
        });
      else setP({ ...clear, view: "movies", studio: r.id });
    },
    [setP],
  );

  const retry = useCallback(() => setReload((n) => n + 1), []);

  return (
    <section aria-label="Search">
      <h2 className="text-xl font-semibold">Search</h2>
      <p className="mt-1 text-sm text-muted">
        One query, seven separate sections. Each section is that source’s own
        results — nothing is merged across providers and nothing is globally
        ranked.
      </p>

      <div className="mt-4">
        {!ready ? (
          <div className="panel p-8 text-center text-sm text-muted" role="note">
            {q.length === 1
              ? "Keep typing — enter at least 2 characters to search."
              : "Type at least 2 characters in the search box above and press Enter."}
          </div>
        ) : error ? (
          <ErrorPanel title="Search failed" message={error} onRetry={retry} />
        ) : loading || !data ? (
          <div aria-label="Searching all sources" aria-busy="true">
            <div className="skel h-6 w-48" />
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="skel aspect-[2/3]" />
              ))}
            </div>
          </div>
        ) : (
          data.categories.map((cat) => (
            <CategorySection
              key={cat.id}
              cat={cat}
              q={data.query}
              onRetry={retry}
              onOpen={open}
            />
          ))
        )}
      </div>
    </section>
  );
}
