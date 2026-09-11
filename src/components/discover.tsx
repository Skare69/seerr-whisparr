"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  CatalogDetail,
  CatalogReference,
  LibraryItem,
  MediaReference,
  RequestRecord,
} from "../lib/contracts";
import {
  ErrorPanel,
  ItemImage,
  api,
  messageOf,
  useParamsSetter,
} from "./shared";

/* Wire shapes mirroring the server's discover response (route.ts Shelf).
 * Kept local: contracts.ts stays domain records; the shelf envelope is a
 * response contract. An errored shelf carries `error` and NO `items` key. */
interface ShelfError {
  code: string;
  message: string;
}

interface Shelf {
  id: string;
  title: string;
  scope: string;
  source: "tpdb" | "stashdb" | "jellyfin" | "velvarr";
  browse?: { view: string; params: Record<string, string> };
  kind: "catalog" | "library" | "requests";
  items?: CatalogDetail[] | LibraryItem[] | RequestRecord[];
  error?: ShelfError;
}

interface DiscoverPage {
  shelves: Shelf[];
}

/* ---------- Page fetch: one GET, shared across mounts ---------- */

// ponytail: module-level page cache — discover is a homepage snapshot, remounts
// reuse it until a retry or full reload; drop it if per-shelf freshness matters.
let cache: DiscoverPage | null = null;
let inflight: Promise<DiscoverPage> | null = null;

function fetchDiscover(): Promise<DiscoverPage> {
  inflight ??= api<DiscoverPage>("/api/discover")
    .then((page) => {
      cache = page;
      return page;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/* ---------- Small helpers (same conventions as catalog.tsx) ---------- */

/** Provider artwork may only reach the DOM through the same-origin proxy. */
function imgSrc(url: string | undefined): string | undefined {
  return url ? `/api/catalog/image?url=${encodeURIComponent(url)}` : undefined;
}

function durationLabel(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function sourceLabel(s: Shelf["source"]): string {
  return s === "tpdb"
    ? "TPDB"
    : s === "stashdb"
      ? "StashDB"
      : s === "jellyfin"
        ? "Jellyfin"
        : "Velvarr";
}

/** Server labels provider shelves view:"catalog"; the URL contract's surfaces
 * are movies|scenes keyed by the shelf's own kind param. */
function targetView(shelf: Shelf): string {
  if (!shelf.browse) return "discover";
  if (shelf.browse.view === "catalog")
    return shelf.browse.params.kind === "scene" ? "scenes" : "movies";
  return shelf.browse.view;
}

const BROWSE_KEYS = [
  "q",
  "year",
  "performer",
  "studio",
  "tags",
  "tagsAll",
  "tagsExclude",
  "sort",
  "direction",
  "page",
  "perPage",
  "tab",
  "id",
  "provider",
  "kind",
];

/** Browse-all lands on the filtered surface carrying exactly the shelf's
 * filters: shelf params applied, every other browse-state key cleared. */
function browseUpdates(shelf: Shelf): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  for (const k of BROWSE_KEYS) updates[k] = null;
  if (shelf.browse)
    for (const [k, v] of Object.entries(shelf.browse.params)) updates[k] = v;
  updates.view = targetView(shelf);
  return updates;
}

const NOT_CONFIGURED_CODES = ["provider_not_configured", "not_configured"];

const DATE_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/* ---------- Skeletons: same geometry as the final rows ---------- */

function CardRowSkeleton({
  aspect,
  width,
  count,
}: {
  aspect: string;
  width: string;
  count: number;
}) {
  return (
    <div className="mt-3 flex gap-4 overflow-x-auto pb-2" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel shrink-0 ${aspect} ${width}`} />
      ))}
    </div>
  );
}

function ShelfSkeleton({
  aspect,
  width,
  count,
}: {
  aspect: string;
  width: string;
  count: number;
}) {
  return (
    <section className="mt-8" aria-busy="true">
      <div className="skel h-5 w-44" />
      <div className="skel mt-2 h-4 w-full max-w-md" />
      <CardRowSkeleton aspect={aspect} width={width} count={count} />
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div className="mt-3 space-y-2" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="skel h-9 w-full max-w-xl" />
      ))}
    </div>
  );
}

/* ---------- Shelf bodies ---------- */

/** Catalog cards reuse the established treatments: portrait movies,
 * landscape scenes, square performer headshots. */
function CatalogCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  const kind = item.reference.kind;
  const aspect =
    kind === "scene"
      ? "aspect-video"
      : kind === "performer"
        ? "aspect-square"
        : "aspect-[2/3]";
  const width = kind === "scene" ? "w-64 sm:w-80" : "w-36 sm:w-40";
  const meta =
    kind === "scene"
      ? [
          item.releaseDate,
          item.studio?.name,
          durationLabel(item.durationSeconds),
        ]
      : [item.releaseDate?.slice(0, 4), item.studio?.name];
  const performers =
    kind === "scene" ? item.credits.map((c) => c.name).join(", ") : "";
  return (
    /* Sized wrapper: .card is unlayered CSS with width:100%, so sizing
     * utilities on the button itself lose the cascade — the wrapper owns
     * the tile width, the card fills it. */
    <div className={`shrink-0 ${width}`}>
      <button
        type="button"
        className="card"
        onClick={() => onOpen(item.reference)}
      >
        <div className={`relative w-full bg-raised ${aspect}`}>
          <ItemImage
            name={item.title}
            src={imgSrc(item.imageUrl)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
        <div className="p-2">
          <div className="truncate text-sm font-medium">{item.title}</div>
          <div className="truncate text-xs text-muted">
            {meta.filter(Boolean).join(" · ")}
          </div>
          {performers && (
            <div className="truncate text-xs text-muted">with {performers}</div>
          )}
        </div>
      </button>
    </div>
  );
}

/** Jellyfin tiles: the item image is already a same-origin /api/images path,
 * and the outward link appears only when playback is genuinely permitted. */
function LibraryCard({ item }: { item: LibraryItem }) {
  const mins =
    item.durationTicks != null && item.durationTicks > 0
      ? Math.round(item.durationTicks / 600000000)
      : null;
  return (
    <div className="panel w-64 shrink-0 overflow-hidden sm:w-80">
      <div className="relative aspect-video w-full bg-raised">
        <ItemImage
          name={item.name}
          src={item.image}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <div className="p-2">
        <div className="truncate text-sm font-medium">{item.name}</div>
        <div className="truncate text-xs text-muted">
          {[item.year, item.kind, mins === null ? null : `${mins} min`]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {item.canPlay && item.watchUrl && (
          <a
            className="btn mt-2"
            href={item.watchUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open in Jellyfin
          </a>
        )}
      </div>
    </div>
  );
}

/* Lazy row titles with a module cache (same pattern as requests.tsx): the
 * reference renders immediately; an unresolvable one stays the reference. */
const titleCache: Record<string, string | null> = {};

function RequestTitle({ media }: { media: MediaReference }) {
  const key = `${media.provider}:${media.kind}:${media.id}`;
  const [title, setTitle] = useState<string | null | undefined>(
    () => titleCache[key],
  );
  useEffect(() => {
    if (title !== undefined) return;
    let live = true;
    api<{ detail: { title: string } }>(
      `/api/catalog/${media.provider}/${media.kind}/${media.id}`,
    )
      .then((d) => {
        titleCache[key] = d.detail.title;
        if (live) setTitle(d.detail.title);
      })
      .catch(() => {
        titleCache[key] = null;
        if (live) setTitle(null);
      });
    return () => {
      live = false;
    };
  }, [key, title, media.provider, media.kind, media.id]);
  if (title) return <span className="font-medium">{title}</span>;
  return (
    <span className="font-mono text-xs text-muted">
      {media.provider} · {media.kind} · {media.id}
    </span>
  );
}

function RequestRows({
  items,
  onOpen,
}: {
  items: RequestRecord[];
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <ul className="mt-3 divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-panel">
      {items.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised"
            onClick={() => onOpen(r.media)}
          >
            <span className="min-w-0 flex-1 truncate">
              <RequestTitle media={r.media} />
            </span>
            <span
              className={`chip capitalize ${r.decision === "pending" ? "chip-accent" : ""}`}
            >
              {r.decision}
            </span>
            <span className="shrink-0 text-xs text-muted">
              {DATE_FMT.format(r.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------- One shelf: title + honest scope + body by kind ---------- */

function ShelfSection({
  shelf,
  busy,
  onRetry,
  onBrowse,
  onOpen,
}: {
  shelf: Shelf;
  busy: boolean;
  onRetry: () => void;
  onBrowse: (updates: Record<string, string | null>) => void;
  onOpen: (r: CatalogReference) => void;
}) {
  const isSceneShelf = shelf.browse?.params.kind === "scene";
  let body: ReactNode;
  if (shelf.error) {
    if (busy) {
      // Retrying the page: keep the shelf slot reserved with its skeleton.
      body =
        shelf.kind === "requests" ? (
          <RowsSkeleton />
        ) : (
          <CardRowSkeleton
            aspect={
              shelf.kind === "catalog" && !isSceneShelf
                ? "aspect-[2/3]"
                : "aspect-video"
            }
            width={
              shelf.kind === "catalog" && !isSceneShelf
                ? "w-36 sm:w-40"
                : "w-64 sm:w-80"
            }
            count={6}
          />
        );
    } else if (NOT_CONFIGURED_CODES.includes(shelf.error.code)) {
      // A missing key is stated as a missing key — never an outage, never
      // an empty catalog, never with a retry that cannot help.
      body = (
        <div className="panel p-4">
          <span className="chip chip-accent">Not configured</span>
          <p className="mt-2 text-sm text-muted">
            {sourceLabel(shelf.source)} has no API key on this server, so this
            shelf cannot be filled. Add the key under Settings — that is a
            missing credential, not an outage.
          </p>
        </div>
      );
    } else {
      body = (
        <ErrorPanel
          title={`${sourceLabel(shelf.source)} is unavailable`}
          message={shelf.error.message}
          onRetry={onRetry}
        />
      );
    }
  } else if (!shelf.items || shelf.items.length === 0) {
    body = (
      <div className="panel p-4 text-sm text-muted">Nothing here yet.</div>
    );
  } else if (shelf.kind === "requests") {
    body = (
      <RequestRows
        items={shelf.items.filter((it): it is RequestRecord => "media" in it)}
        onOpen={onOpen}
      />
    );
  } else if (shelf.kind === "library") {
    body = (
      <div className="mt-3 flex gap-4 overflow-x-auto pb-2">
        {shelf.items
          .filter((it): it is LibraryItem => "canPlay" in it)
          .map((it, i) => (
            <LibraryCard key={`${shelf.id}-${i}`} item={it} />
          ))}
      </div>
    );
  } else {
    body = (
      <div className="mt-3 flex gap-4 overflow-x-auto pb-2">
        {shelf.items
          .filter((it): it is CatalogDetail => "reference" in it)
          .map((it) => (
            <CatalogCard key={it.reference.id} item={it} onOpen={onOpen} />
          ))}
      </div>
    );
  }
  return (
    <section className="mt-8" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">{shelf.title}</h3>
        {shelf.browse && (
          <button
            type="button"
            className="btn"
            onClick={() => onBrowse(browseUpdates(shelf))}
          >
            Browse all
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">{shelf.scope}</p>
      {body}
    </section>
  );
}

/* ---------- The discover homepage ---------- */

export function DiscoverShelves() {
  const setP = useParamsSetter();
  const [page, setPage] = useState(cache);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(cache === null);

  const load = useCallback((force: boolean) => {
    if (!force && cache) {
      setPage(cache);
      setBusy(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    fetchDiscover()
      .then((p) => {
        setPage(p);
        setBusy(false);
      })
      .catch((e: unknown) => {
        setError(messageOf(e));
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Catalog cards open the detail over the matching surface view; the
  // destination view mounts the shared detail dialog for provider+kind+id.
  const openDetail = useCallback(
    (r: CatalogReference) =>
      setP({
        view:
          r.kind === "movie"
            ? "movies"
            : r.kind === "scene"
              ? "scenes"
              : "performers",
        provider: r.provider,
        kind: r.kind,
        id: r.id,
      }),
    [setP],
  );

  if (busy && !page) {
    return (
      <section aria-label="Discover" aria-busy="true">
        <h2 className="text-xl font-semibold">Discover</h2>
        <ShelfSkeleton aspect="aspect-[2/3]" width="w-36 sm:w-40" count={6} />
        <ShelfSkeleton aspect="aspect-video" width="w-64 sm:w-80" count={5} />
        <ShelfSkeleton aspect="aspect-video" width="w-64 sm:w-80" count={5} />
        <ShelfSkeleton aspect="aspect-video" width="w-64 sm:w-80" count={5} />
        <section className="mt-8" aria-busy="true">
          <div className="skel h-5 w-44" />
          <div className="skel mt-2 h-4 w-full max-w-md" />
          <RowsSkeleton />
        </section>
      </section>
    );
  }
  if (error && !page) {
    return (
      <section aria-label="Discover">
        <h2 className="text-xl font-semibold">Discover</h2>
        <ErrorPanel
          title="Discover is unavailable"
          message={error}
          onRetry={() => load(true)}
        />
      </section>
    );
  }
  if (!page) return null;
  return (
    <section aria-label="Discover">
      <h2 className="text-xl font-semibold">Discover</h2>
      {page.shelves.map((s) => (
        <ShelfSection
          key={s.id}
          shelf={s}
          busy={busy}
          onRetry={() => load(true)}
          onBrowse={setP}
          onOpen={openDetail}
        />
      ))}
    </section>
  );
}
