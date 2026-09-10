"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import type { Account, ProviderStatus } from "../lib/contracts.ts";

/* ---------- API helper ---------- */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      path,
      init?.body
        ? { ...init, headers: { "content-type": "application/json" } }
        : init,
    );
  } catch {
    throw new ApiError(0, "network", "Cannot reach the Velvarr server.");
  }
  const data: unknown =
    res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)
      ?.error;
    if (res.status === 401)
      window.dispatchEvent(new Event("velvarr:unauthorized"));
    throw new ApiError(
      res.status,
      err?.code ?? "error",
      err?.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

/* ---------- URL helpers ---------- */

export function useParamsSetter() {
  const router = useRouter();
  return useCallback(
    (updates: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `?${qs}` : window.location.pathname, {
        scroll: false,
      });
    },
    [router],
  );
}

export function intOr(v: string | null, dflt: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isInteger(n) ? n : dflt;
}

/* ---------- Shared small components ---------- */

interface SessionInfo {
  account: Account;
  providers: ProviderStatus | null;
  signOut: () => void;
}

export const SessionCtx = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("Session context missing");
  return s;
}

export function ItemImage({
  name,
  src,
  className,
}: {
  name: string;
  src?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`img-fallback ${className ?? ""}`} aria-hidden="true">
        {name.slice(0, 1).toUpperCase() || "·"}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

export function ErrorPanel({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="panel panel-error flex items-start justify-between gap-3 p-4"
    >
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-1 text-sm text-muted">{message}</div>
      </div>
      {onRetry && (
        <button type="button" className="btn shrink-0" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function ForbiddenPanel() {
  return (
    <div className="panel panel-error p-6" role="alert">
      <h2 className="text-lg font-semibold">403 · Administrators only</h2>
      <p className="mt-2 text-sm text-muted">
        Your account does not have permission to view this area.
      </p>
    </div>
  );
}
