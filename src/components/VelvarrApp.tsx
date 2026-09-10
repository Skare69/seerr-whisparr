"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import type {
  Account,
  Library,
  LibraryItem,
  LibraryPage,
  ProviderStatus,
  Role,
  WhisparrDelivery,
  WhisparrPathMapping,
} from "../lib/contracts.ts";
import {
  ApiError,
  api,
  ErrorPanel,
  ForbiddenPanel,
  intOr,
  ItemImage,
  messageOf,
  SessionCtx,
  useParamsSetter,
  useSession,
} from "./shared.tsx";
import {
  DiscoverView,
  MoviesView,
  PerformersView,
  ScenesView,
} from "./catalog.tsx";
import { RequestsView } from "./requests.tsx";

/* ---------- App-local API view records (not in contracts.ts) ---------- */

interface WhisparrStatus {
  configured: boolean;
  version?: string;
  appName?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
}

interface IntegrationsInfo {
  jellyfin: {
    url: string;
    externalUrl: string;
    serverId: string;
    libraryIds: string[];
    apiKeyConfigured: boolean;
  };
  whisparr: {
    url: string;
    apiKeyConfigured: boolean;
    delivery: WhisparrDelivery | null;
    pathMappings: WhisparrPathMapping[];
  } | null;
}

/* ---------- View helpers ---------- */

const runtime = (ticks?: number) =>
  ticks && ticks > 0 ? `${Math.round(ticks / 600_000_000)} min` : null;

const PROVIDER_STATE: Record<ProviderStatus["tpdb"], string> = {
  not_configured: "Not configured",
  not_verified: "API key present — not verified",
};

function BootSkeleton() {
  return (
    <div className="min-h-screen md:flex" aria-hidden="true">
      <aside className="hidden md:block md:fixed md:inset-y-0 md:w-56 md:shrink-0 border-r border-edge bg-panel p-4">
        <div className="skel mb-8 h-6 w-28" />
        <div className="skel mb-2 h-8 w-full" />
        <div className="skel mb-2 h-8 w-full" />
      </aside>
      <div className="min-w-0 flex-1 md:ml-56">
        <div className="mx-auto max-w-6xl p-4 md:p-8">
          <div className="skel mb-4 h-9 w-64" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="skel aspect-[2/3]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Root ---------- */

type Phase = "boot" | "bootError" | "setupLocked" | "setup" | "login" | "app";

export default function VelvarrApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [account, setAccount] = useState<Account | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const enterApp = useCallback(async () => {
    const me = await api<{ account: Account; providers: ProviderStatus }>(
      "/api/me",
    );
    setAccount(me.account);
    setProviders(me.providers);
    setPhase("app");
  }, []);

  const enterAppSafe = useCallback(() => {
    enterApp().catch((e) => {
      if (e instanceof ApiError && e.status === 401) {
        setPhase("login");
        return;
      }
      setBootError(messageOf(e));
      setPhase("bootError");
    });
  }, [enterApp]);
  const boot = useCallback(async () => {
    setPhase("boot");
    setBootError(null);
    try {
      const status = await api<{ initialized: boolean; setupReady: boolean }>(
        "/api/status",
      );
      if (!status.initialized) {
        setPhase(status.setupReady ? "setup" : "setupLocked");
        return;
      }
      await enterApp();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase("login");
      } else {
        setBootError(messageOf(err));
        setPhase("bootError");
      }
    }
  }, [enterApp]);

  useEffect(() => {
    const on401 = () => {
      setAccount(null);
      setProviders(null);
      setPhase("login");
    };
    window.addEventListener("velvarr:unauthorized", on401);
    return () => window.removeEventListener("velvarr:unauthorized", on401);
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const signOut = useCallback(async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch {
      /* cookie already gone */
    }
    setAccount(null);
    setProviders(null);
    setPhase("login");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (phase === "boot") return <BootSkeleton />;
  if (phase === "bootError")
    return (
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div className="w-full">
          <ErrorPanel
            title="Velvarr could not start"
            message={bootError ?? "Unknown error"}
            onRetry={() => void boot()}
          />
        </div>
      </div>
    );
  if (phase === "setupLocked") return <SetupLocked />;
  if (phase === "setup") return <SetupWizard onDone={enterAppSafe} />;
  if (phase === "login") return <LoginView onSignedIn={enterAppSafe} />;

  if (phase !== "app" || !account) return <BootSkeleton />;
  return (
    <SessionCtx.Provider value={{ account, providers, signOut }}>
      <Shell />
    </SessionCtx.Provider>
  );
}

/* ---------- Anonymous: setup not configured ---------- */

function SetupLocked() {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center p-6">
      <div className="panel w-full p-6">
        <div className="text-lg font-semibold">
          Velvarr setup is not configured yet
        </div>
        <p className="mt-3 text-sm text-muted">
          This instance has no operator secrets. To finish installation, the
          server operator needs to:
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          <li>
            Set <code className="chip">VELVARR_SECRET_KEY</code> — exactly 64
            hex characters — and{" "}
            <code className="chip">VELVARR_SETUP_SECRET</code> — at least 32
            characters — in the server environment.
          </li>
          <li>
            Run <code className="chip">bun run setup</code> (or{" "}
            <code className="chip">npm run setup</code>) and restart Velvarr.
          </li>
        </ol>
        <p className="mt-3 text-sm text-muted">
          This page becomes the setup wizard once the secrets are present. No
          credentials are collected here.
        </p>
      </div>
    </div>
  );
}

/* ---------- Anonymous: setup wizard ---------- */

function SetupWizard({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({
    setupSecret: "",
    jellyfinUrl: "",
    jellyfinExternalUrl: "",
    jellyfinApiKey: "",
    username: "",
    password: "",
  });
  const [step, setStep] = useState<"inspect" | "confirm">("inspect");
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);
  const [libs, setLibs] = useState<Library[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [whisparrUrl, setWhisparrUrl] = useState("");
  const [whisparrApiKey, setWhisparrApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bind = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  const inspect = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (Object.values(f).some((v) => !v.trim())) {
      setError("All fields are required.");
      return;
    }
    setPending(true);
    try {
      const r = await api<{
        user: { id: string; name: string };
        libraries: Library[];
      }>("/api/setup/inspect", { method: "POST", body: JSON.stringify(f) });
      setUser(r.user);
      setLibs(r.libraries);
      setStep("confirm");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  const commit = async () => {
    setError(null);
    if (selected.length === 0) {
      setError("Select at least one library for the owner account.");
      return;
    }
    if (!ack) {
      setError("Confirm the owner acknowledgement to continue.");
      return;
    }
    setPending(true);
    try {
      await api<{ account: Account }>("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          libraryIds: selected,
          whisparrUrl: whisparrUrl || undefined,
          whisparrApiKey: whisparrApiKey || undefined,
        }),
      });
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center p-4 sm:p-6">
      <div className="panel w-full p-6">
        <div className="text-lg font-semibold">Set up Velvarr</div>
        <p className="mt-1 text-sm text-muted">
          One-time protected bootstrap. The selected Jellyfin account becomes
          the permanent owner.
        </p>

        {error && (
          <div className="mt-4" role="alert">
            <ErrorPanel message={error} />
          </div>
        )}

        {step === "inspect" && (
          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => void inspect(e)}
            noValidate
          >
            <div>
              <label className="label" htmlFor="su-secret">
                Setup secret
              </label>
              <input
                id="su-secret"
                type="password"
                className="input"
                autoComplete="off"
                value={f.setupSecret}
                onChange={bind("setupSecret")}
              />
            </div>
            <div>
              <label className="label" htmlFor="su-url">
                Jellyfin server URL
              </label>
              <input
                id="su-url"
                type="text"
                className="input"
                placeholder="http://jellyfin:8096"
                autoComplete="off"
                maxLength={300}
                value={f.jellyfinUrl}
                onChange={bind("jellyfinUrl")}
              />
            </div>
            <div>
              <label className="label" htmlFor="su-ext">
                Jellyfin external URL (web address users open)
              </label>
              <input
                id="su-ext"
                type="text"
                className="input"
                placeholder="https://jellyfin.example.com"
                autoComplete="off"
                maxLength={300}
                value={f.jellyfinExternalUrl}
                onChange={bind("jellyfinExternalUrl")}
              />
            </div>
            <div>
              <label className="label" htmlFor="su-key">
                Jellyfin API key (administrator)
              </label>
              <input
                id="su-key"
                type="password"
                className="input"
                autoComplete="off"
                value={f.jellyfinApiKey}
                onChange={bind("jellyfinApiKey")}
              />
            </div>
            <div>
              <label className="label" htmlFor="su-user">
                Owner Jellyfin username
              </label>
              <input
                id="su-user"
                type="text"
                className="input"
                autoComplete="username"
                value={f.username}
                onChange={bind("username")}
              />
            </div>
            <div>
              <label className="label" htmlFor="su-pass">
                Owner Jellyfin password
              </label>
              <input
                id="su-pass"
                type="password"
                className="input"
                autoComplete="current-password"
                value={f.password}
                onChange={bind("password")}
              />
            </div>
            <button
              type="submit"
              className="btn btn-accent w-full"
              disabled={pending}
            >
              {pending ? "Checking…" : "Inspect connection"}
            </button>
          </form>
        )}

        {step === "confirm" && user && (
          <div className="mt-5 space-y-4">
            <div className="text-sm">
              Verified Jellyfin account:{" "}
              <span className="font-medium">
                {user.name} <span className="chip">{user.id}</span>
              </span>
            </div>

            <fieldset>
              <legend className="label">Libraries the owner can browse</legend>
              {libs.length === 0 ? (
                <div className="panel p-3 text-sm text-muted">
                  No eligible movie/video libraries were returned. Setup cannot
                  be completed without at least one library.
                </div>
              ) : (
                <div className="space-y-2">
                  {libs.map((lib) => (
                    <label
                      key={lib.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="check"
                        checked={selected.includes(lib.id)}
                        onChange={() =>
                          setSelected((cur) =>
                            cur.includes(lib.id)
                              ? cur.filter((x) => x !== lib.id)
                              : [...cur, lib.id],
                          )
                        }
                      />
                      {lib.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="check mt-0.5"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                I understand this Jellyfin account becomes the permanent Velvarr
                owner and that bootstrap closes after this step.
              </span>
            </label>

            <details className="panel p-3">
              <summary className="cursor-pointer text-sm text-muted">
                Optional: Whisparr integration
              </summary>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="label" htmlFor="su-whisparr-url">
                    Whisparr URL
                  </label>
                  <input
                    id="su-whisparr-url"
                    type="text"
                    className="input"
                    placeholder="http://whisparr:6969"
                    autoComplete="off"
                    maxLength={300}
                    value={whisparrUrl}
                    onChange={(e) => setWhisparrUrl(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="su-whisparr-key">
                    Whisparr API key
                  </label>
                  <input
                    id="su-whisparr-key"
                    type="password"
                    className="input"
                    autoComplete="off"
                    value={whisparrApiKey}
                    onChange={(e) => setWhisparrApiKey(e.target.value)}
                  />
                </div>
              </div>
            </details>

            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => {
                  setStep("inspect");
                  setAck(false);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-accent flex-1"
                disabled={pending || libs.length === 0}
                onClick={() => void commit()}
              >
                {pending ? "Creating…" : "Create owner account"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Anonymous: login ---------- */

function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setPending(true);
    try {
      await api<{ account: Account }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm items-center p-6">
      <div className="panel w-full p-6">
        <div className="text-lg font-semibold">Velvarr</div>
        <p className="mt-1 text-sm text-muted">
          Sign in with your Jellyfin account.
        </p>
        {error && (
          <div className="mt-4" role="alert">
            <ErrorPanel message={error} />
          </div>
        )}
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
          <div>
            <label className="label" htmlFor="li-user">
              Username
            </label>
            <input
              id="li-user"
              type="text"
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="li-pass">
              Password
            </label>
            <input
              id="li-pass"
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-accent w-full"
            disabled={pending}
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ---------- Shell ---------- */

const VIEWS = [
  "discover",
  "movies",
  "scenes",
  "performers",
  "requests",
  "library",
  "admin",
  "settings",
] as const;
type View = (typeof VIEWS)[number];

const PROVIDER_VIEWS = {
  discover: { label: "Discover", needs: ["tpdb", "stashdb"] },
  movies: { label: "Movies", needs: ["tpdb"] },
  scenes: { label: "Scenes", needs: ["stashdb"] },
  performers: { label: "Performers", needs: ["stashdb"] },
  requests: { label: "Requests", needs: [] },
} as const;
type ProviderView = keyof typeof PROVIDER_VIEWS;

function Shell() {
  const session = useSession();
  const params = useSearchParams();
  const setP = useParamsSetter();
  const raw = params.get("view");
  const view: View = VIEWS.includes(raw as View) ? (raw as View) : "library";
  const isAdmin = session.account.role === "admin";

  const nav = [
    { id: "discover" as View, label: "Discover", show: true },
    { id: "movies" as View, label: "Movies", show: true },
    { id: "scenes" as View, label: "Scenes", show: true },
    { id: "performers" as View, label: "Performers", show: true },
    { id: "requests" as View, label: "Requests", show: true },
    { id: "library" as View, label: "Library", show: true },
    { id: "admin" as View, label: "Admin", show: isAdmin },
    { id: "settings" as View, label: "Settings", show: isAdmin },
  ].filter((n) => n.show);
  const go = (v: View) => setP({ view: v === "library" ? null : v });

  const navBtns = nav.map((n) => (
    <button
      key={n.id}
      type="button"
      className="nav-btn"
      aria-current={view === n.id ? "page" : undefined}
      onClick={() => go(n.id)}
    >
      {n.label}
    </button>
  ));

  return (
    <div className="min-h-screen md:flex">
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-56 shrink-0 flex-col border-r border-edge bg-panel p-4 md:flex">
        <div className="mb-6 text-lg font-semibold tracking-tight">Velvarr</div>
        <nav className="space-y-1" aria-label="Main">
          {navBtns}
        </nav>
        <div className="mt-auto space-y-2 pt-4">
          <div className="truncate text-sm font-medium">
            {session.account.name}
          </div>
          <div className="flex items-center gap-2">
            <span className="chip chip-accent capitalize">
              {session.account.role}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => void session.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 md:ml-56">
        <header className="border-b border-edge bg-panel px-4 py-3 md:hidden">
          <div className="flex items-center justify-between gap-2">
            <div className="text-lg font-semibold text-ink">Velvarr</div>
            <div className="flex items-center gap-2">
              <span className="chip chip-accent capitalize">
                {session.account.role}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => void session.signOut()}
              >
                Sign out
              </button>
            </div>
          </div>
          <nav className="mt-2 flex flex-wrap gap-1" aria-label="Main">
            {nav.map((n) => (
              <button
                key={n.id}
                type="button"
                className="nav-chip"
                aria-current={view === n.id ? "page" : undefined}
                onClick={() => go(n.id)}
              >
                {n.label}
              </button>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-6xl p-4 md:p-8">
          <h1 className="sr-only">Velvarr</h1>
          {view === "library" && <LibraryView />}
          {view === "admin" && (isAdmin ? <AdminView /> : <ForbiddenPanel />)}
          {view === "settings" &&
            (isAdmin ? <SettingsView /> : <ForbiddenPanel />)}
          {view !== "library" && view !== "admin" && view !== "settings" && (
            <ProviderSurface view={view} onLibrary={() => go("library")} />
          )}
        </main>
      </div>
    </div>
  );
}

function ProviderSurface({
  view,
  onLibrary,
}: {
  view: ProviderView;
  onLibrary: () => void;
}) {
  const { providers } = useSession();
  const { label, needs } = PROVIDER_VIEWS[view];
  const missing = needs.filter((p) => providers?.[p] === "not_configured");
  if (missing.length > 0)
    return (
      <ProviderNotice
        label={label}
        missing={[...missing]}
        providers={providers}
        onLibrary={onLibrary}
      />
    );
  if (view === "discover") return <DiscoverView />;
  if (view === "movies") return <MoviesView />;
  if (view === "scenes") return <ScenesView />;
  if (view === "performers") return <PerformersView />;
  return <RequestsView />;
}

// Honesty panel for a provider-gated surface: a missing key is stated as a
// missing key — never as an outage and never as an empty catalog.
function ProviderNotice({
  label,
  missing,
  providers,
  onLibrary,
}: {
  label: string;
  missing: string[];
  providers: ProviderStatus | null;
  onLibrary: () => void;
}) {
  return (
    <div className="panel p-6">
      <h2 className="text-lg font-semibold">{label}</h2>
      <p className="mt-2 text-sm text-muted">
        {missing.join(" and ")} {missing.length === 1 ? "is" : "are"} not
        configured — no API key is present for this surface. That is a missing
        key, not an outage; add it under Settings.
      </p>
      <div className="mt-4">
        <ProvidersCard providers={providers} />
      </div>
      <p className="mt-3 text-sm text-muted">
        “Not configured” means no API key is present. “API key present — not
        verified” means a key exists but nothing has been proven against the
        provider yet.
      </p>
      <button type="button" className="btn mt-4" onClick={onLibrary}>
        Back to Library
      </button>
    </div>
  );
}

/* ---------- Library ---------- */

function LibraryView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const search = params.get("search") ?? "";
  const libraryId = params.get("libraryId") ?? "";
  const start = Math.max(0, intOr(params.get("start"), 0));
  const limitRaw = intOr(params.get("limit"), 24);
  const limit = limitRaw >= 1 && limitRaw <= 60 ? limitRaw : 24;
  const itemId = params.get("item");

  const [searchInput, setSearchInput] = useState(search);
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [libsError, setLibsError] = useState<string | null>(null);
  const [pageData, setPageData] = useState<LibraryPage | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const closeItem = useCallback(() => setP({ item: null }), [setP]);

  const loadLibs = useCallback(() => {
    setLibsError(null);
    api<{ libraries: Library[] }>("/api/libraries")
      .then((d) => setLibs(d.libraries))
      .catch((e) => setLibsError(messageOf(e)));
  }, []);

  useEffect(loadLibs, [loadLibs]);

  // ponytail: fixed 400ms debounce; typed-submit (Enter) flushes immediately
  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(
      () => setP({ search: searchInput || null, start: null }),
      400,
    );
    return () => clearTimeout(t);
  }, [searchInput, search, setP]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setGridError(null);
    const qs = new URLSearchParams({
      start: String(start),
      limit: String(limit),
      search,
    });
    if (libraryId) qs.set("libraryId", libraryId);
    api<LibraryPage>(`/api/library?${qs}`)
      .then((d) => {
        if (live) {
          setPageData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setGridError(messageOf(e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [start, limit, search, libraryId, reload]);

  const items = pageData?.items ?? [];
  const end = pageData
    ? Math.min(pageData.start + pageData.items.length, pageData.total)
    : 0;
  const hasNext = pageData
    ? pageData.start + pageData.items.length < pageData.total
    : false;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="sm:max-w-xs sm:flex-1">
          <label className="label" htmlFor="lib-search">
            Search
          </label>
          <input
            id="lib-search"
            type="search"
            className="input"
            placeholder="Search titles…"
            maxLength={200}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                setP({ search: searchInput || null, start: null });
            }}
          />
        </div>
        <div className="sm:w-64">
          <label className="label" htmlFor="lib-filter">
            Library
          </label>
          {libsError ? (
            <ErrorPanel message={libsError} onRetry={loadLibs} />
          ) : (
            <select
              id="lib-filter"
              className="input"
              value={libraryId}
              onChange={(e) =>
                setP({ libraryId: e.target.value || null, start: null })
              }
            >
              <option value="">All libraries</option>
              {(libs ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {gridError ? (
        <ErrorPanel
          title="Library unavailable"
          message={gridError}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : loading ? (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          aria-label="Loading library"
        >
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="skel aspect-[2/3]" />
          ))}
        </div>
      ) : libs && libs.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          Your account has no library access yet. Ask an administrator to grant
          you libraries.
        </div>
      ) : items.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          {search || libraryId
            ? "No items match your search or filter."
            : "This library has no items yet."}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((it) => (
              <button
                key={it.id}
                className="card"
                onClick={() => setP({ item: it.id })}
              >
                <div className="relative aspect-[2/3] w-full bg-raised">
                  <ItemImage
                    name={it.name}
                    src={it.image}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </div>
                <div className="p-2">
                  <div className="truncate text-sm font-medium">{it.name}</div>
                  <div className="truncate text-xs text-muted">
                    {[it.year, it.kind].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-sm text-muted">
              {pageData && pageData.total > 0
                ? `Items ${pageData.start + 1}–${end} of ${pageData.total}`
                : "No items"}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                disabled={start === 0}
                onClick={() => {
                  setP({ start: String(Math.max(0, start - limit)) });
                  window.scrollTo({ top: 0 });
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                disabled={!hasNext}
                onClick={() => {
                  setP({ start: String(start + limit) });
                  window.scrollTo({ top: 0 });
                }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {itemId && <ItemDetail id={itemId} onClose={closeItem} />}
    </div>
  );
}

/* ---------- Item detail dialog ---------- */

// ponytail: Esc + backdrop + initial focus, no full focus trap; add trap if tabbing out matters
function ItemDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [item, setItem] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setItem(null);
    api<{ item: LibraryItem }>(`/api/library/${encodeURIComponent(id)}`)
      .then((d) => live && setItem(d.item))
      .catch((e) => live && setError(messageOf(e)));
    return () => {
      live = false;
    };
  }, [id, reload]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Item details"
        className="panel max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Close details"
          >
            Close
          </button>
        </div>

        {error ? (
          <ErrorPanel
            title="Item unavailable"
            message={error}
            onRetry={() => setReload((n) => n + 1)}
          />
        ) : !item ? (
          <div className="flex gap-4" aria-label="Loading details">
            <div className="skel aspect-[2/3] w-36 shrink-0" />
            <div className="flex-1 space-y-3 pt-2">
              <div className="skel h-6 w-3/4" />
              <div className="skel h-4 w-1/3" />
              <div className="skel h-4 w-full" />
              <div className="skel h-4 w-5/6" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="relative aspect-[2/3] w-36 shrink-0 self-center bg-raised sm:self-start">
              <ItemImage
                name={item.name}
                src={item.image}
                className="absolute inset-0 h-full w-full rounded-lg object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip">{item.kind}</span>
                {item.year != null && <span className="chip">{item.year}</span>}
                {runtime(item.durationTicks) && (
                  <span className="chip">{runtime(item.durationTicks)}</span>
                )}
              </div>
              <h2 className="mt-2 text-xl font-semibold">{item.name}</h2>
              {item.overview ? (
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {item.overview}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  No synopsis available.
                </p>
              )}
              <div className="mt-4">
                {item.canPlay && item.watchUrl ? (
                  <a
                    className="btn btn-accent"
                    href={item.watchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Watch in Jellyfin
                  </a>
                ) : (
                  <div className="panel p-3 text-sm text-muted">
                    Playback is not available for this item or your account.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Admin: accounts ---------- */
function AdminView() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [libs, setLibs] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setForbidden(false);
    api<{ accounts: Account[]; libraries: Library[] }>("/api/admin/users")
      .then((d) => {
        setAccounts(d.accounts);
        setLibs(d.libraries);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(messageOf(e));
      });
  }, []);

  useEffect(load, [load]);

  const importUsers = async () => {
    setImporting(true);
    setImportMsg(null);
    setImportError(null);
    try {
      const r = await api<{ accounts: Account[] }>("/api/admin/users/import", {
        method: "POST",
        body: "{}",
      });
      setImportMsg(
        r.accounts.length > 0
          ? `Imported ${r.accounts.length} account${r.accounts.length === 1 ? "" : "s"} — disabled until you grant access.`
          : "No new Jellyfin users to import.",
      );
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setImportError(messageOf(e));
    } finally {
      setImporting(false);
    }
  };

  if (forbidden) return <ForbiddenPanel />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Accounts</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={load}
            disabled={importing}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-accent"
            onClick={() => void importUsers()}
            disabled={importing}
          >
            {importing ? "Importing…" : "Import from Jellyfin"}
          </button>
        </div>
      </div>

      {importMsg && (
        <div className="panel p-3 text-sm" role="status">
          {importMsg}
        </div>
      )}
      {importError && (
        <ErrorPanel title="Import failed" message={importError} />
      )}

      {error ? (
        <ErrorPanel
          title="Accounts unavailable"
          message={error}
          onRetry={load}
        />
      ) : accounts == null ? (
        <div className="panel p-4" aria-label="Loading accounts">
          <div className="skel mb-3 h-12 w-full" />
          <div className="skel mb-3 h-12 w-full" />
          <div className="skel h-12 w-full" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          No Velvarr accounts yet. Import Jellyfin users to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              libraries={libs}
              onSaved={(acc) =>
                setAccounts(
                  (cur) => cur?.map((x) => (x.id === acc.id ? acc : x)) ?? cur,
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  account: initial,
  libraries,
  onSaved,
}: {
  account: Account;
  libraries: Library[];
  onSaved: (a: Account) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [role, setRole] = useState<Role>(initial.role);
  const [autoApprove, setAutoApprove] = useState(initial.autoApprove);
  const [libIds, setLibIds] = useState<string[]>(initial.libraryIds);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = initial.isOwner;
  const dirty =
    (!owner && enabled !== initial.enabled) ||
    (!owner && role !== initial.role) ||
    (!owner && autoApprove !== initial.autoApprove) ||
    libIds.length !== initial.libraryIds.length ||
    !libIds.every((x) => initial.libraryIds.includes(x));

  const toggleLib = (id: string) =>
    setLibIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );

  const reset = () => {
    setEnabled(initial.enabled);
    setRole(initial.role);
    setAutoApprove(initial.autoApprove);
    setLibIds(initial.libraryIds);
    setError(null);
  };

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api<{ account: Account }>(
        `/api/admin/users/${initial.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: owner ? initial.enabled : enabled,
            role: owner ? initial.role : role,
            autoApprove: owner ? initial.autoApprove : autoApprove,
            libraryIds: libIds,
          }),
        },
      );
      onSaved(r.account);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-40 flex items-center gap-2">
          <span className="font-medium">{initial.name}</span>
          {owner && <span className="chip chip-accent">Owner</span>}
          {!owner && (
            <span className={`chip ${initial.enabled ? "chip-accent" : ""}`}>
              {initial.enabled ? "Active" : "Disabled"}
            </span>
          )}
        </div>

        <div>
          <label className="label" htmlFor={`role-${initial.id}`}>
            Role
          </label>
          <select
            id={`role-${initial.id}`}
            className="input"
            value={owner ? initial.role : role}
            disabled={owner || pending}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="requester">Requester</option>
            <option value="moderator">Moderator</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div>
          <span className="label">Enabled</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="check"
              checked={owner ? initial.enabled : enabled}
              disabled={owner || pending}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {owner ? "Always enabled" : "Account can sign in"}
          </label>
        </div>

        <div>
          <span className="label">Auto-approve</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="check"
              checked={owner ? initial.autoApprove : autoApprove}
              disabled={owner || pending}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            {owner ? "Always (owner)" : "Approves own requests"}
          </label>
          <p className="mt-1 text-xs text-muted">
            Lets this user approve their own requests without a moderator.
          </p>
        </div>
      </div>

      <fieldset className="mt-3">
        <legend className="label">Libraries</legend>
        {libraries.length === 0 ? (
          <div className="text-sm text-muted">No libraries configured.</div>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {libraries.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="check"
                  checked={libIds.includes(l.id)}
                  disabled={pending}
                  onChange={() => toggleLib(l.id)}
                />
                {l.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {error && (
        <div className="mt-3" role="alert">
          <ErrorPanel message={error} />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn btn-accent"
          disabled={!dirty || pending}
          onClick={() => void save()}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!dirty || pending}
          onClick={reset}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/* ---------- Settings: integrations, Whisparr, providers ---------- */

function SettingsView() {
  const { providers } = useSession();
  const [forbidden, setForbidden] = useState(false);

  if (forbidden) return <ForbiddenPanel />;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Settings</h2>
      <IntegrationsForm onForbidden={() => setForbidden(true)} />
      <WhisparrCard onForbidden={() => setForbidden(true)} />
      <ProvidersCard providers={providers} />
    </div>
  );
}

function IntegrationsForm({ onForbidden }: { onForbidden: () => void }) {
  const [info, setInfo] = useState<IntegrationsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jellyfinUrl, setJellyfinUrl] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [jellyfinApiKey, setJellyfinApiKey] = useState("");
  const [whisparrUrl, setWhisparrUrl] = useState("");
  const [whisparrApiKey, setWhisparrApiKey] = useState("");
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [rootFolderPath, setRootFolderPath] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const [mappings, setMappings] = useState<WhisparrPathMapping[]>([]);
  const [whisparrStatus, setWhisparrStatus] = useState<WhisparrStatus | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api<IntegrationsInfo>("/api/admin/integrations")
      .then((d) => {
        setInfo(d);
        setJellyfinUrl(d.jellyfin.url);
        setExternalUrl(d.jellyfin.externalUrl);
        setWhisparrUrl(d.whisparr?.url ?? "");
        setDeliveryEnabled(d.whisparr?.delivery?.enabled ?? false);
        setRootFolderPath(d.whisparr?.delivery?.rootFolderPath ?? "");
        setQualityProfileId(
          d.whisparr?.delivery
            ? String(d.whisparr.delivery.qualityProfileId)
            : "",
        );
        setSearchOnAdd(d.whisparr?.delivery?.searchOnAdd ?? true);
        setMappings(d.whisparr?.pathMappings ?? []);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) onForbidden();
        else setLoadError(messageOf(e));
      });
    // Read-only status supplies the real root folders / quality profiles; when
    // it is unavailable the form falls back to manual entry below.
    api<WhisparrStatus>("/api/admin/whisparr")
      .then(setWhisparrStatus)
      .catch(() => setWhisparrStatus(null));
  }, [onForbidden]);

  useEffect(load, [load]);

  // Select choices; the currently stored value is always offered so a stale
  // status can never silently change what will be saved.
  const hasUrl = whisparrUrl.trim() !== "";
  const rootChoices = (() => {
    const paths = whisparrStatus?.rootFolders?.map((rf) => rf.path) ?? [];
    if (rootFolderPath !== "" && !paths.includes(rootFolderPath))
      return [rootFolderPath, ...paths];
    return paths;
  })();
  const profileChoices = (() => {
    const known = whisparrStatus?.profiles ?? [];
    const id = Number(qualityProfileId);
    if (
      qualityProfileId !== "" &&
      Number.isInteger(id) &&
      !known.some((p) => p.id === id)
    )
      return [...known, { id, name: `Saved profile #${id}` }];
    return known;
  })();
  const effectiveRoot = rootFolderPath || rootChoices[0] || "";
  const effectiveProfile =
    qualityProfileId || (profileChoices[0] ? String(profileChoices[0].id) : "");
  const halfMappings = mappings.filter(
    (m) =>
      (m.whisparrPrefix.trim() === "") !== (m.jellyfinPrefix.trim() === ""),
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(null);
    if (!password) {
      setError("Re-enter your Jellyfin password to confirm this change.");
      return;
    }
    if (!jellyfinUrl.trim() || !externalUrl.trim()) {
      setError("Jellyfin URL and external URL are required.");
      return;
    }
    const profile = Number(effectiveProfile);
    if (hasUrl && (!Number.isInteger(profile) || profile < 1)) {
      setError("Choose a quality profile (a positive whole number).");
      return;
    }
    if (hasUrl && deliveryEnabled && !effectiveRoot.trim()) {
      setError("A root folder is required while delivery is enabled.");
      return;
    }
    if (hasUrl && halfMappings.length > 0) {
      setError(
        "Each path mapping needs both a Whisparr prefix and a Jellyfin prefix.",
      );
      return;
    }
    setPending(true);
    try {
      await api<unknown>("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify({
          password,
          jellyfinUrl: jellyfinUrl.trim(),
          jellyfinExternalUrl: externalUrl.trim(),
          ...(jellyfinApiKey ? { jellyfinApiKey } : {}),
          whisparrUrl: whisparrUrl.trim(),
          ...(whisparrApiKey ? { whisparrApiKey } : {}),
          // Always sent with a Whisparr URL: the server stores delivery on the
          // connection wholesale, so an omitted key on a re-saved URL would
          // silently drop the configured delivery.
          ...(hasUrl
            ? {
                delivery: {
                  enabled: deliveryEnabled,
                  rootFolderPath: effectiveRoot.trim(),
                  qualityProfileId: profile,
                  searchOnAdd,
                },
                pathMappings: mappings
                  .filter(
                    (m) =>
                      m.whisparrPrefix.trim() !== "" &&
                      m.jellyfinPrefix.trim() !== "",
                  )
                  .map((m) => ({
                    whisparrPrefix: m.whisparrPrefix.trim(),
                    jellyfinPrefix: m.jellyfinPrefix.trim(),
                  })),
              }
            : {}),
        }),
      });
      setPassword("");
      setJellyfinApiKey("");
      setWhisparrApiKey("");
      setSaved("Integrations updated.");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) onForbidden();
      else setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  if (loadError)
    return (
      <ErrorPanel
        title="Integrations unavailable"
        message={loadError}
        onRetry={load}
      />
    );
  if (!info)
    return (
      <div className="panel p-4" aria-label="Loading integrations">
        <div className="skel h-40 w-full" />
      </div>
    );

  return (
    <form className="panel p-5" onSubmit={(e) => void save(e)} noValidate>
      <h3 className="font-semibold">Integrations</h3>
      <p className="mt-1 text-sm text-muted">
        Jellyfin server <span className="chip">{info.jellyfin.serverId}</span> ·{" "}
        {info.jellyfin.libraryIds.length} configured librar
        {info.jellyfin.libraryIds.length === 1 ? "y" : "ies"} (grants are not
        changed here)
      </p>

      {error && (
        <div className="mt-4" role="alert">
          <ErrorPanel message={error} />
        </div>
      )}
      {saved && (
        <div className="panel mt-4 p-3 text-sm" role="status">
          {saved}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="int-jf-url">
            Jellyfin URL
          </label>
          <input
            id="int-jf-url"
            type="text"
            className="input"
            autoComplete="off"
            maxLength={300}
            value={jellyfinUrl}
            onChange={(e) => setJellyfinUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-jf-ext">
            Jellyfin external URL
          </label>
          <input
            id="int-jf-ext"
            type="text"
            className="input"
            autoComplete="off"
            maxLength={300}
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-jf-key">
            Jellyfin API key
          </label>
          <input
            id="int-jf-key"
            type="password"
            className="input"
            autoComplete="off"
            placeholder={
              info.jellyfin.apiKeyConfigured
                ? "Configured — leave blank to keep"
                : "Not set"
            }
            value={jellyfinApiKey}
            onChange={(e) => setJellyfinApiKey(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-w-url">
            Whisparr URL (blank removes it, with delivery settings)
          </label>
          <input
            id="int-w-url"
            type="text"
            className="input"
            autoComplete="off"
            maxLength={300}
            value={whisparrUrl}
            onChange={(e) => setWhisparrUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-w-key">
            Whisparr API key
          </label>
          <input
            id="int-w-key"
            type="password"
            className="input"
            autoComplete="off"
            placeholder={
              info.whisparr?.apiKeyConfigured
                ? "Configured — leave blank to keep"
                : "Not set"
            }
            value={whisparrApiKey}
            onChange={(e) => setWhisparrApiKey(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="int-pass">
            Your Jellyfin password (confirms the change)
          </label>
          <input
            id="int-pass"
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Whisparr delivery</legend>
        <p className="mt-1 text-sm text-muted">
          With delivery disabled, approved requests are held inside Velvarr —
          never dropped, never sent to Whisparr until you enable this.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="check"
                checked={deliveryEnabled}
                disabled={!hasUrl || pending}
                onChange={(e) => setDeliveryEnabled(e.target.checked)}
              />
              Send approved requests to Whisparr
            </label>
          </div>
          <div>
            <label className="label" htmlFor="int-w-root">
              Root folder
            </label>
            {rootChoices.length > 0 ? (
              <select
                id="int-w-root"
                className="input"
                value={effectiveRoot}
                disabled={!hasUrl || pending}
                onChange={(e) => setRootFolderPath(e.target.value)}
              >
                {rootChoices.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="int-w-root"
                type="text"
                className="input"
                autoComplete="off"
                maxLength={1024}
                placeholder="Whisparr download root, e.g. /data/adult"
                value={rootFolderPath}
                disabled={!hasUrl || pending}
                onChange={(e) => setRootFolderPath(e.target.value)}
              />
            )}
          </div>
          <div>
            <label className="label" htmlFor="int-w-profile">
              Quality profile
            </label>
            {profileChoices.length > 0 ? (
              <select
                id="int-w-profile"
                className="input"
                value={effectiveProfile}
                disabled={!hasUrl || pending}
                onChange={(e) => setQualityProfileId(e.target.value)}
              >
                {profileChoices.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="int-w-profile"
                type="number"
                min={1}
                step={1}
                className="input"
                value={qualityProfileId}
                disabled={!hasUrl || pending}
                onChange={(e) => setQualityProfileId(e.target.value)}
              />
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="check"
                checked={searchOnAdd}
                disabled={!hasUrl || pending}
                onChange={(e) => setSearchOnAdd(e.target.checked)}
              />
              Search Whisparr as soon as a request is sent
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Path mappings (Whisparr → Jellyfin)</legend>
        <p className="mt-1 text-sm text-muted">
          Prefix pairs that line Whisparr download paths up with Jellyfin
          library paths. Only needed when the two roots differ.
        </p>
        {mappings.map((m, i) => (
          <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <label className="label" htmlFor={`map-w-${i}`}>
                Whisparr prefix
              </label>
              <input
                id={`map-w-${i}`}
                type="text"
                className="input"
                autoComplete="off"
                maxLength={1024}
                value={m.whisparrPrefix}
                disabled={!hasUrl || pending}
                onChange={(e) =>
                  setMappings((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, whisparrPrefix: e.target.value } : x,
                    ),
                  )
                }
              />
            </div>
            <div className="min-w-40 flex-1">
              <label className="label" htmlFor={`map-j-${i}`}>
                Jellyfin prefix
              </label>
              <input
                id={`map-j-${i}`}
                type="text"
                className="input"
                autoComplete="off"
                maxLength={1024}
                value={m.jellyfinPrefix}
                disabled={!hasUrl || pending}
                onChange={(e) =>
                  setMappings((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, jellyfinPrefix: e.target.value } : x,
                    ),
                  )
                }
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={!hasUrl || pending}
              onClick={() =>
                setMappings((cur) => cur.filter((_, j) => j !== i))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn mt-3"
          disabled={!hasUrl || pending || mappings.length >= 50}
          onClick={() =>
            setMappings((cur) => [
              ...cur,
              { whisparrPrefix: "", jellyfinPrefix: "" },
            ])
          }
        >
          Add mapping
        </button>
      </fieldset>

      <button type="submit" className="btn btn-accent mt-4" disabled={pending}>
        {pending ? "Saving…" : "Save integrations"}
      </button>
    </form>
  );
}

function WhisparrCard({ onForbidden }: { onForbidden: () => void }) {
  const [status, setStatus] = useState<WhisparrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<WhisparrStatus>("/api/admin/whisparr")
      .then((s) => {
        setStatus(s);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) onForbidden();
        else {
          setError(messageOf(e));
          setLoading(false);
        }
      });
  }, [onForbidden]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Whisparr</h3>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="mt-3 space-y-2" aria-label="Checking Whisparr">
          <div className="skel h-5 w-1/2" />
          <div className="skel h-5 w-2/3" />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Whisparr unavailable"
            message={error}
            onRetry={load}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Add the Whisparr URL and API key above to enable
          read-only status.
        </p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Application</dt>
            <dd className="font-medium">
              {status.appName ?? "Whisparr"}
              {status.version ? ` ${status.version}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Root folders</dt>
            <dd className="mt-1">
              {status.rootFolders?.length ? (
                <ul className="space-y-1">
                  {status.rootFolders.map((rf) => (
                    <li key={rf.id} className="chip">
                      {rf.path}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">None returned</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Quality profiles</dt>
            <dd className="mt-1">
              {status.profiles?.length ? (
                <span className="text-muted">
                  {status.profiles.map((p) => p.name).join(", ")}
                </span>
              ) : (
                <span className="text-muted">None returned</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

// Shape returned by GET /api/admin/providers (ProviderVerification).
type ProviderCheckRow =
  | { provider: "tpdb" | "stashdb"; configured: false }
  | {
      provider: "tpdb" | "stashdb";
      configured: true;
      verified: true;
      account: string;
    };

function ProvidersCard({ providers }: { providers: ProviderStatus | null }) {
  const [check, setCheck] = useState<ProviderCheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api<{ providers: ProviderCheckRow[] }>("/api/admin/providers")
      .then((d) => setCheck(d.providers))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(messageOf(e));
      });
  }, []);

  useEffect(load, [load]);

  return (
    <div className="panel p-5">
      <h3 className="font-semibold">Metadata providers</h3>
      <p className="mt-1 text-sm text-muted">
        The first chip reads the stored environment; the second is a live check
        against the provider — the real proof. A failed live check is an outage
        or a bad key, never an empty catalog.
      </p>
      <dl className="mt-3 space-y-2 text-sm">
        {(
          [
            ["tpdb", "TPDB"],
            ["stashdb", "StashDB"],
          ] as const
        ).map(([id, name]) => {
          const state = providers?.[id];
          const live = check?.find((r) => r.provider === id);
          return (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <dt className="font-medium">{name}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <span className="chip">
                  {state ? PROVIDER_STATE[state] : "Unknown"}
                </span>
                {forbidden ? null : live ? (
                  live.configured ? (
                    <span className="chip chip-accent">
                      Verified · {live.account}
                    </span>
                  ) : (
                    <span className="chip">Live check: not configured</span>
                  )
                ) : (
                  <span className="chip">Live check pending</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {forbidden ? (
        <p className="mt-3 text-sm text-muted">
          Live verification needs an administrator account.
        </p>
      ) : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Live provider check failed"
            message={error}
            onRetry={load}
          />
        </div>
      ) : null}
    </div>
  );
}
