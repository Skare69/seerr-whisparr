// Discord notifier tests against a local HTTP fixture only: no real Discord,
// no external network. Env is pinned per test and restored in a finally, and
// console output is captured so the destination URL/token can never pass
// through a log line unnoticed.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { notifyRequestEvent } from "../src/server/notify.ts";

// --- fixture webhook ---------------------------------------------------

const TOKEN = "fixture-token-segment-9f8e7d6c";
const TITLE = "Private Scene Title";
const EVENT = {
  kind: "approved" as const,
  media: {
    provider: "tpdb",
    kind: "scene",
    id: "0f0f0f0f-1111-4222-8333-444455556666",
  },
  title: TITLE,
};

type Capture = { method: string; body: Record<string, unknown> };
let requests: Capture[] = [];
let mode: "ok" | "error" | "hang" = "ok";

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += chunk;
  requests.push({
    method: req.method ?? "",
    body: JSON.parse(raw) as Record<string, unknown>,
  });
  if (mode === "hang") return; // never responds: exercises the timeout path
  res.statusCode = mode === "error" ? 500 : 204;
  res.end();
}

const server: Server = createServer((req, res) => {
  void handle(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const WEBHOOK = `http://127.0.0.1:${
  (server.address() as AddressInfo).port
}/api/webhooks/1234567890/${TOKEN}`;

after(() => {
  server.closeAllConnections();
  server.close();
});

// --- helpers ------------------------------------------------------------

/** Plain-http loopback is the only non-Discord destination the module
 * accepts, precisely so this fixture can exercise the real send path. */
function pinEnv(webhook: string | undefined, detail?: string): void {
  if (webhook === undefined) delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
  else process.env.VELVARR_DISCORD_WEBHOOK_URL = webhook;
  if (detail === undefined) delete process.env.VELVARR_DISCORD_DETAIL;
  else process.env.VELVARR_DISCORD_DETAIL = detail;
}

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = console.warn;
  try {
    await run();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines;
}

function assertNoDestination(lines: string[]): void {
  for (const line of lines) {
    assert.ok(!line.includes(TOKEN), `log leaked token: ${line}`);
    assert.ok(!line.includes("api/webhooks"), `log leaked URL path: ${line}`);
  }
}

// --- tests --------------------------------------------------------------

test("unset env is a silent no-op with zero requests", async () => {
  requests = [];
  mode = "ok";
  try {
    pinEnv(undefined);
    await captureLogs(() => notifyRequestEvent(EVENT));
    assert.equal(requests.length, 0);
  } finally {
    pinEnv(undefined);
  }
});

test("configured webhook posts once, identity-only, without the title", async () => {
  requests = [];
  mode = "ok";
  try {
    pinEnv(WEBHOOK);
    await notifyRequestEvent(EVENT);
    assert.equal(requests.length, 1);
    const first = requests[0];
    assert.ok(first, "fixture received one request");
    assert.equal(first.method, "POST");
    const content = String(first.body.content ?? "");
    for (const part of ["approved", "scene", "tpdb", EVENT.media.id])
      assert.ok(content.includes(part), `content missing ${part}: ${content}`);
    assert.equal(first.body.embeds, undefined);
    assert.ok(!JSON.stringify(first.body).includes(TITLE));
  } finally {
    pinEnv(undefined);
  }
});

test("detail mode includes the title", async () => {
  requests = [];
  mode = "ok";
  try {
    pinEnv(WEBHOOK, "1");
    await notifyRequestEvent(EVENT);
    assert.equal(requests.length, 1);
    const sent = requests[0];
    assert.ok(sent, "fixture received one request");
    const embeds = sent.body.embeds as
      { title?: string; description?: string }[] | undefined;
    const embed = embeds?.[0];
    assert.equal(embed?.title, TITLE);
    assert.ok(embed?.description?.includes(EVENT.media.id));
    assert.equal(sent.body.content, undefined);
  } finally {
    pinEnv(undefined);
  }
});

test("non-Discord or non-https destinations are refused without a request", async () => {
  requests = [];
  mode = "ok";
  try {
    for (const bad of [
      "https://example.com/api/webhooks/123/tok",
      "http://discord.com/api/webhooks/123/tok",
      "ftp://discord.com/api/webhooks/123/tok",
      "not-a-url",
    ]) {
      pinEnv(bad);
      const lines = await captureLogs(() => notifyRequestEvent(EVENT));
      assert.equal(requests.length, 0);
      assert.ok(lines.length > 0, "refusal should warn without the URL");
      assertNoDestination(lines);
    }
  } finally {
    pinEnv(undefined);
  }
});

test("an upstream 500 resolves without throwing and logs no URL", async () => {
  requests = [];
  mode = "error";
  try {
    pinEnv(WEBHOOK);
    const lines = await captureLogs(() => notifyRequestEvent(EVENT));
    assert.equal(requests.length, 1, "no retry after a failed response");
    assertNoDestination(lines);
  } finally {
    pinEnv(undefined);
  }
});

test("a hanging webhook resolves at the timeout without throwing", async () => {
  requests = [];
  mode = "hang";
  try {
    pinEnv(WEBHOOK);
    const lines = await captureLogs(() => notifyRequestEvent(EVENT));
    assert.equal(requests.length, 1);
    assertNoDestination(lines);
  } finally {
    pinEnv(undefined);
  }
});

test("a network error resolves silently without throwing", async () => {
  requests = [];
  mode = "ok";
  try {
    const dead: Server = createServer(() => {});
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    pinEnv(`http://127.0.0.1:${port}/api/webhooks/1/tok`);
    const lines = await captureLogs(() => notifyRequestEvent(EVENT));
    assert.equal(requests.length, 0);
    assertNoDestination(lines);
  } finally {
    pinEnv(undefined);
  }
});
