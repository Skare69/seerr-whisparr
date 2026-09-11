// Opt-in Discord webhook notifier for durable request transitions.
// Reads its destination on every call, stays completely silent when unset,
// and never throws into the caller: a notification failure must never roll
// back a request or acquisition, so everything here is best-effort.

// ponytail: one bounded POST per event, no queue or coalescing — events fire
// per durable transition (low volume) and the SQLite record is the source of
// truth; add a rate limiter only if Discord 429s actually show up.
const TIMEOUT_MS = 5_000;

/** Small local record describing one durable transition. Plain strings so
 * callers can pass a MediaReference-shaped value directly. */
export type RequestNotification = {
  kind: "approved" | "acquired" | "available" | "failed";
  media: { provider: string; kind: string; id: string };
  title?: string;
};

/** Accept only real https Discord webhook URLs (plus plain http on loopback,
 * which is how the local test fixture exercises the send path without any
 * external network) so a misconfigured value cannot leak household activity
 * to an arbitrary remote host. */
function parseDestination(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "https:") {
    if (url.hostname !== "discord.com" && url.hostname !== "discordapp.com")
      return null;
  } else if (url.protocol === "http:") {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return null;
  } else {
    return null;
  }
  // /api/webhooks/{id}/{token} — both segments non-empty.
  return /^\/api\/webhooks\/[^/]+\/[^/]+/.test(url.pathname) ? url : null;
}

/** Fire one bounded webhook POST. Resolves without effect when the
 * destination is unset; refuses (with a URL-less warning) when it is not an
 * https Discord webhook; never rejects or lets a failure reach the caller.
 * The destination URL is never logged. */
export async function notifyRequestEvent(
  event: RequestNotification,
): Promise<void> {
  try {
    const raw = process.env.VELVARR_DISCORD_WEBHOOK_URL;
    if (!raw) return;
    const url = parseDestination(raw);
    if (!url) {
      console.warn(
        "[notify] VELVARR_DISCORD_WEBHOOK_URL is set but is not an https://discord.com webhook URL; notification skipped",
      );
      return;
    }
    // Titles and artwork are opt-in: identity-only by default.
    const detail = process.env.VELVARR_DISCORD_DETAIL === "1";
    const message = `Velvarr ${event.kind}: ${event.media.kind} ${event.media.provider}/${event.media.id}`;
    const body = detail
      ? {
          embeds: [
            {
              ...(event.title ? { title: event.title } : {}),
              description: message,
            },
          ],
        }
      : { content: message };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer(); // drain so the socket is released
    if (!res.ok)
      console.warn(`[notify] discord webhook responded ${res.status}; skipped`);
  } catch {
    // Best-effort by contract: timeouts and network errors are swallowed.
    // Deliberately no logging here — fetch errors would risk echoing the URL.
  }
}
