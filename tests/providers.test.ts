// Provider-layer regression tests: isolated 127.0.0.1 HTTP fixtures only.
// No real network, no real credentials. Covers TPDB/StashDB detail mapping,
// canonical credit parents, fake-total suppression, real pagination
// continuation, not-found vs outage, malformed/oversized payload rejection,
// artwork host/content-type/size enforcement, and not-configured behavior.

import http from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError } from "../src/server/http.ts";
import {
  crossProviderLink,
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  IMAGE_BYTE_CAP,
  isProviderImageUrl,
  searchCatalog,
} from "../src/server/providers.ts";
import type { CatalogDetail } from "../src/lib/contracts.ts";

// --- constants and fixture helpers ---

const TPDB_TOKEN = "tpdb-fixture-token-0001";
const STASH_TOKEN = "stashdb-fixture-key-0001";
const MOVIE_ID = "71287a36-7079-44b6-938c-8096e4a681a9";
const MOVIE_ID_2 = "bd32beec-1927-4e93-853c-6fa9508597d2";
const SCENE_ID = "91e9610b-77fc-4046-b6d7-fd060f6e46a6";
const RELATED_SCENE_ID = "9b1663f6-1cd9-449f-a1c9-44b8f33c4280";
const SITE_PERFORMER_ID = "6263c88d-4bb5-4b41-b4a1-6e31a90308bd";
const CANON_PERFORMER_ID = "42386b25-d0f1-41dc-a53f-a132b2425acf";
const STASH_SCENE_ID = "01a060a7-0644-7afd-8071-25752e1a45b7";
const STASH_PERFORMER_ID = "13ceabee-8eaa-4fb6-8ade-03ce133a6822";
const STASH_CROSS_ID = "d4f1a54f-ddc7-4f50-a356-d417802cab1c";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Fixture {
  origin: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function reply(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function replyJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  reply(res, status, "application/json", JSON.stringify(payload));
}

async function startFixture(
  handler: (
    req: RecordedRequest,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<Fixture> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const record: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      void Promise.resolve(handler(record, res)).catch(() => {
        reply(res, 500, "text/plain", "fixture handler failure");
      });
    });
  });
  const listened = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listened.resolve());
  await listened.promise;
  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    requests,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

const ENV_KEYS = [
  "TPDB_API_TOKEN",
  "STASHDB_API_KEY",
  "TPDB_BASE_URL",
  "STASHDB_BASE_URL",
] as const;

function setEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): () => void {
  const saved = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  for (const k of ENV_KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function queryParams(fixture: Fixture, index: number): URLSearchParams {
  const record = fixture.requests[index];
  const query = record === undefined ? "" : (record.url.split("?")[1] ?? "");
  return new URLSearchParams(query);
}

function stashBody(
  fixture: Fixture,
  index: number,
): { query: string; variables: Record<string, unknown> } {
  const record = fixture.requests[index];
  assert.ok(record !== undefined, "expected a GraphQL request");
  assert.equal(record.method, "POST");
  assert.equal(record.url, "/graphql");
  return JSON.parse(record.body) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

function assertProviderError(
  err: unknown,
  status: number,
  code: string,
  upstreamStatus?: number,
): void {
  assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
  assert.equal(err.status, status);
  assert.equal(err.code, code);
  if (upstreamStatus === undefined) assert.equal(err.upstreamStatus, undefined);
  else assert.equal(err.upstreamStatus, upstreamStatus);
}

// Shared TPDB movie payload mirroring the live shape (flat row, canonical
// credit parents, provider-CDN artwork, embedded scenes).
function tpdbMovieRow(): Record<string, unknown> {
  return {
    id: MOVIE_ID,
    _id: 11510526,
    title: "Fixture Movie",
    type: "Movie",
    description: "Fixture description.",
    date: "2026-09-10",
    created: "2026-09-10T06:50:31.000000Z",
    last_updated: "2026-09-10T06:50:31.000000Z",
    duration: 2682,
    url: "https://www.example-studio.com/en/movie/fixture",
    poster: "https://cdn.theporndb.net/scene/d1/0b/6b/poster.jpg",
    posters: {
      full: "https://cdn.theporndb.net/scene/d1/0b/6b/poster-full.jpg",
      large: "https://cdn.theporndb.net/scene/d1/0b/6b/poster-large.jpg",
    },
    background: { full: "https://cdn.theporndb.net/scene/d1/0b/6b/bg.jpg" },
    image: "https://images02-openlife.gammacdn.com/movies/raw.jpg", // studio CDN: never emitted
    site: {
      uuid: "3bf3a0ea-d416-4ab2-a5be-7af3709079f5",
      name: "Fixture Studio",
      url: "https://example-studio.com",
    },
    performers: [
      {
        id: SITE_PERFORMER_ID,
        _id: 2650484,
        name: "Credited Name",
        image: null,
        parent: {
          id: CANON_PERFORMER_ID,
          _id: 83959,
          name: "Canonical Name",
          image: "https://cdn.theporndb.net/performer/37/43/30/canon.webp",
        },
      },
    ],
    tags: [
      { id: 70, uuid: "ffe45e51-8472-4a2d-a582-fe224da0c60f", name: "Anal" },
      { id: 194, uuid: "9865d865-320d-4bce-b17a-edd2a05bce41", name: "Asian" },
    ],
    scenes: [{ id: RELATED_SCENE_ID, title: "Embedded Scene" }],
    movies: [],
  };
}

// --- TPDB movie detail mapping ---

test("tpdb movie detail maps validated fields and canonical credit parents", async () => {
  const restore = setEnv({
    TPDB_API_TOKEN: TPDB_TOKEN,
    TPDB_BASE_URL: "",
  });
  const fixture = await startFixture((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, `/movies/${MOVIE_ID}`);
    assert.equal(req.headers.authorization, `Bearer ${TPDB_TOKEN}`);
    replyJson(res, 200, { data: tpdbMovieRow() });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const detail = await getCatalogDetail({
      provider: "tpdb",
      kind: "movie",
      id: MOVIE_ID,
    });
    assert.ok(detail !== null);
    assert.deepEqual(detail.reference, {
      provider: "tpdb",
      kind: "movie",
      id: MOVIE_ID,
    });
    assert.equal(detail.title, "Fixture Movie");
    assert.equal(detail.releaseDate, "2026-09-10"); // from `date`, never `created`
    assert.equal(detail.durationSeconds, 2682);
    assert.equal(
      detail.imageUrl,
      "https://cdn.theporndb.net/scene/d1/0b/6b/poster-full.jpg",
    );
    assert.equal(detail.studio?.name, "Fixture Studio");
    assert.equal(
      detail.sourceUrl,
      "https://www.example-studio.com/en/movie/fixture",
    );
    // Credit identity resolves through performers[].parent.id, credited name kept.
    assert.equal(detail.credits.length, 1);
    assert.deepEqual(detail.credits[0]?.reference, {
      provider: "tpdb",
      kind: "performer",
      id: CANON_PERFORMER_ID,
    });
    assert.equal(detail.credits[0]?.name, "Credited Name");
    assert.equal(
      detail.credits[0]?.imageUrl,
      "https://cdn.theporndb.net/performer/37/43/30/canon.webp",
    );
    // Studio-CDN raw image must not leak into any emitted field.
    assert.equal(JSON.stringify(detail).includes("gammacdn"), false);
    assert.deepEqual(detail.related, [
      { provider: "tpdb", kind: "scene", id: RELATED_SCENE_ID },
    ]);
    assert.deepEqual(detail.tags, [
      { id: "ffe45e51-8472-4a2d-a582-fe224da0c60f", name: "Anal" },
      { id: "9865d865-320d-4bce-b17a-edd2a05bce41", name: "Asian" },
    ]);
  } finally {
    await fixture.close();
    restore();
  }
});

// --- StashDB scene detail mapping ---

test("stashdb scene detail maps performers, clamps duration, drops absurd values", async () => {
  const restore = setEnv({
    STASHDB_API_KEY: STASH_TOKEN,
    STASHDB_BASE_URL: "",
  });
  const fixture = await startFixture((req, res) => {
    assert.equal(req.headers.apikey, STASH_TOKEN);
    replyJson(res, 200, {
      data: {
        findScene: {
          id: STASH_SCENE_ID,
          title: "START-602",
          code: "START-602",
          details: "Fixture details.",
          date: "2026-10-08",
          duration: 99_999_999, // absurd -> dropped
          urls: [
            {
              url: "https://r18.dev/videos/vod/movies/detail/-/id=1start602",
              type: "R18.DEV",
            },
          ],
          studio: {
            id: "8ac2ab16-e381-476a-95bc-0af807b80a93",
            name: "SOD Create",
          },
          tags: [
            { id: "1792db6e-514c-43d7-aed1-5ed92ec655ae", name: "Slutty" },
          ],
          performers: [
            {
              as: "Stage Alias",
              performer: {
                id: STASH_PERFORMER_ID,
                name: "MINAMO",
                deleted: false,
                images: [
                  {
                    url: "https://stashdb.org/images/1c73ec9e-0643-4564-aae6-441999853fac",
                  },
                ],
              },
            },
            {
              as: null,
              performer: { id: MISSING_ID, name: "Deleted One", deleted: true },
            },
            { as: null, performer: { id: "not-a-uuid", name: "Broken" } },
          ],
        },
      },
    });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    const detail = await getCatalogDetail({
      provider: "stashdb",
      kind: "scene",
      id: STASH_SCENE_ID,
    });
    assert.ok(detail !== null);
    assert.deepEqual(detail.reference, {
      provider: "stashdb",
      kind: "scene",
      id: STASH_SCENE_ID,
    });
    assert.equal(detail.title, "START-602");
    assert.equal(detail.releaseDate, "2026-10-08");
    assert.equal(detail.durationSeconds, undefined); // absurd duration dropped
    assert.equal(detail.studio?.name, "SOD Create");
    assert.deepEqual(detail.tags, [
      { id: "1792db6e-514c-43d7-aed1-5ed92ec655ae", name: "Slutty" },
    ]);
    // Deleted and non-UUID performers dropped; credited alias (`as`) is the name.
    assert.equal(detail.credits.length, 1);
    assert.deepEqual(detail.credits[0]?.reference, {
      provider: "stashdb",
      kind: "performer",
      id: STASH_PERFORMER_ID,
    });
    assert.equal(detail.credits[0]?.name, "Stage Alias");
    assert.equal(
      detail.credits[0]?.imageUrl,
      "https://stashdb.org/images/1c73ec9e-0643-4564-aae6-441999853fac",
    );
    assert.equal(
      detail.links[0]?.url,
      "https://r18.dev/videos/vod/movies/detail/-/id=1start602",
    );
    assert.equal(detail.links[0]?.label, "R18.DEV");
  } finally {
    await fixture.close();
    restore();
  }
});

// --- fake total suppression + real pagination continuation ---

test("tpdb unfiltered totals are suppressed; filtered totals and continuation are real", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");
    const page = Number(params.get("page") ?? "1");
    if (req.url.startsWith("/movies")) {
      // Fake-cap listing: total 10000 with a next link.
      replyJson(res, 200, {
        data: [
          {
            id: MOVIE_ID,
            title: `Movie page ${page}`,
            posters: {},
            background: {},
            performers: [],
            tags: [],
            scenes: [],
            movies: [],
          },
        ],
        links: { next: `${fixture.origin}/movies?per_page=1&page=${page + 1}` },
        meta: {
          current_page: page,
          per_page: 1,
          total: 10000,
          last_page: 10000,
        },
      });
      return;
    }
    // Filtered performer search: genuinely real total.
    replyJson(res, 200, {
      data: [
        {
          id: CANON_PERFORMER_ID,
          name: "Anna",
          extras: { links: {} },
          aliases: [],
        },
      ],
      links: { next: null },
      meta: { current_page: 1, per_page: 5, total: 1040, last_page: 208 },
    });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const unfiltered = await searchCatalog({
      provider: "tpdb",
      kind: "movie",
      perPage: 1,
    });
    assert.equal(unfiltered.totalCountKnown, false);
    assert.equal(unfiltered.total, undefined); // fake 10000 cap never surfaced
    assert.equal(unfiltered.hasMore, true);
    assert.equal(unfiltered.items.length, 1);

    const filtered = await searchCatalog({
      provider: "tpdb",
      kind: "performer",
      query: "anna",
      perPage: 5,
    });
    assert.equal(filtered.totalCountKnown, true);
    assert.equal(filtered.total, 1040);
    assert.equal(filtered.hasMore, false); // next link null
    assert.equal(filtered.items.length, 1);
    assert.deepEqual(filtered.items[0]?.reference, {
      provider: "tpdb",
      kind: "performer",
      id: CANON_PERFORMER_ID,
    });
  } finally {
    await fixture.close();
    restore();
  }
});

test("tpdb pagination continuation follows pages until the provider stops offering next", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");
    const page = Number(params.get("page") ?? "1");
    const next =
      page < 2 ? `${fixture.origin}/scenes?page=${page + 1}&per_page=1` : null;
    replyJson(res, 200, {
      data:
        page <= 2
          ? [
              {
                id: page === 1 ? SCENE_ID : MOVIE_ID,
                title: `Scene ${page}`,
                posters: {},
                background: {},
                performers: [],
                tags: [],
                scenes: [],
                movies: [],
              },
            ]
          : [],
      links: { next },
      meta: { current_page: page, per_page: 1, total: 10000 },
    });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const page1 = await searchCatalog({
      provider: "tpdb",
      kind: "scene",
      perPage: 1,
    });
    assert.equal(page1.page, 1);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.items[0]?.reference.id, SCENE_ID);

    const page2 = await searchCatalog({
      provider: "tpdb",
      kind: "scene",
      page: 2,
      perPage: 1,
    });
    assert.equal(page2.page, 2);
    assert.equal(page2.hasMore, false); // no next link on the last page
    assert.equal(page2.items[0]?.reference.id, MOVIE_ID);
    assert.equal(queryParams(fixture, 1).get("page"), "2");
  } finally {
    await fixture.close();
    restore();
  }
});

// --- search row hygiene: dedupe by id (never title), drop unusable rows ---

test("search deduplicates by provider id, keeps duplicate titles, drops malformed rows", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    replyJson(res, 200, {
      data: [
        { id: "not-a-uuid", title: "Broken Id" }, // dropped: non-UUID id
        { id: MOVIE_ID, title: "Same Title" }, // kept
        { id: MOVIE_ID, title: "Same Title" }, // dropped: duplicate id
        { id: MOVIE_ID_2, title: "Same Title" }, // kept: same title, different id
        { title: "No Id" }, // dropped
      ],
      links: { next: null },
      meta: { total: 10000 },
    });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const page = await searchCatalog({ provider: "tpdb", kind: "movie" });
    assert.deepEqual(
      page.items.map((i) => i.reference.id),
      [MOVIE_ID, MOVIE_ID_2],
    );
    assert.equal(page.items[0]?.title, "Same Title");
    assert.equal(page.items[1]?.title, "Same Title");
  } finally {
    await fixture.close();
    restore();
  }
});

// --- not found vs outage ---

test("tpdb 404 is authoritative absence; 401/500/network failures are distinct outages", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    if (req.url === `/movies/${MOVIE_ID}`) {
      replyJson(res, 200, { data: tpdbMovieRow() });
      return;
    }
    if (req.url === `/movies/${MISSING_ID}`) {
      replyJson(res, 404, { message: "scene not found" });
      return;
    }
    if (req.url === `/scenes/${SCENE_ID}`) {
      reply(res, 401, "application/json", "{}");
      return;
    }
    reply(res, 500, "application/json", "{}");
  });
  const dead = await startFixture(() => {});
  await dead.close(); // connection-refused outage target
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    assert.equal(
      (await getCatalogDetail({
        provider: "tpdb",
        kind: "movie",
        id: MOVIE_ID,
      })) !== null,
      true,
    );
    assert.equal(
      await getCatalogDetail({
        provider: "tpdb",
        kind: "movie",
        id: MISSING_ID,
      }),
      null,
    );
    await assert.rejects(
      getCatalogDetail({ provider: "tpdb", kind: "scene", id: SCENE_ID }),
      (err: unknown) => {
        assertProviderError(err, 401, "upstream_auth", 401);
        return true;
      },
    );
    await assert.rejects(
      getCatalogDetail({ provider: "tpdb", kind: "scene", id: MOVIE_ID_2 }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_unavailable", 500);
        return true;
      },
    );
    process.env.TPDB_BASE_URL = dead.origin;
    await assert.rejects(
      getCatalogDetail({ provider: "tpdb", kind: "movie", id: MOVIE_ID }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_unavailable");
        return true;
      },
    );
  } finally {
    await fixture.close();
    restore();
  }
});

test("stashdb data-null is authoritative absence; schema failure is an outage", async () => {
  const restore = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const fixture = await startFixture((req, res) => {
    const body = JSON.parse(req.body) as { query: string };
    if (body.query.includes("findScene")) {
      replyJson(res, 200, { data: { findScene: null } });
      return;
    }
    if (body.query.includes("findPerformer")) {
      replyJson(res, 200, {
        data: {
          findPerformer: {
            id: CANON_PERFORMER_ID,
            name: "Anna",
            deleted: false,
            aliases: [],
            urls: [],
            images: [],
          },
        },
      });
      return;
    }
    replyJson(res, 422, {
      errors: [{ message: "Cannot query field." }],
      data: null,
    });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    assert.equal(
      await getCatalogDetail({
        provider: "stashdb",
        kind: "scene",
        id: STASH_SCENE_ID,
      }),
      null,
    );
    const performer = await getCatalogDetail({
      provider: "stashdb",
      kind: "performer",
      id: CANON_PERFORMER_ID,
    });
    assert.equal(performer?.title, "Anna");
    await assert.rejects(
      searchCatalog({ provider: "stashdb", kind: "scene" }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_unavailable", 422);
        return true;
      },
    );
  } finally {
    await fixture.close();
    restore();
  }
});

// --- malformed / oversized payload rejection ---

test("malformed and oversized upstream payloads are rejected, not normalized into fakes", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    if (req.url === `/movies/${MOVIE_ID}`) {
      replyJson(res, 200, { data: { id: MOVIE_ID, title: null } }); // missing title
      return;
    }
    if (req.url === `/scenes/${SCENE_ID}`) {
      replyJson(res, 200, { data: { id: MOVIE_ID, title: "Wrong Id Row" } }); // id mismatch row -> unusable
      return;
    }
    if (req.url.startsWith("/movies?")) {
      reply(
        res,
        200,
        "application/json",
        JSON.stringify({
          data: [
            {
              id: MOVIE_ID,
              title: "x".repeat(400),
              description: "d".repeat(9000),
              duration: 5_000_000,
              date: "2026-13-40",
              posters: { full: "http://cdn.theporndb.net/insecure.jpg" },
              background: {},
              performers: [],
              tags: [],
              scenes: [],
              movies: [],
            },
            "not-an-object",
          ],
          links: { next: null },
          meta: { total: 10000 },
        }),
      );
      return;
    }
    reply(
      res,
      200,
      "application/json",
      `{"pad":"${"x".repeat(3 * 1024 * 1024)}"}`,
    );
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    await assert.rejects(
      getCatalogDetail({ provider: "tpdb", kind: "movie", id: MOVIE_ID }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_bad_response");
        return true;
      },
    );
    await assert.rejects(
      getCatalogDetail({ provider: "tpdb", kind: "scene", id: SCENE_ID }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_bad_response");
        return true;
      },
    );
    const page = await searchCatalog({ provider: "tpdb", kind: "movie" });
    // Oversized-but-valid row survives via clamping; garbage row is dropped.
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.description?.length, 6000); // clamped
    assert.equal(page.items[0]?.durationSeconds, undefined); // absurd -> dropped
    assert.equal(page.items[0]?.releaseDate, undefined); // invalid date -> dropped
    assert.equal(page.items[0]?.imageUrl, undefined); // insecure host -> dropped
    await assert.rejects(
      searchCatalog({ provider: "tpdb", kind: "performer", query: "oversize" }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_bad_response"); // >2MiB JSON
        return true;
      },
    );
  } finally {
    await fixture.close();
    restore();
  }
});

test("upstream fields are normalized: bad dates, absurd durations, insecure images dropped", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    replyJson(res, 200, {
      data: {
        id: SCENE_ID,
        title: "  Padded Title  ",
        description: "d".repeat(9000),
        date: "2026-13-40", // invalid calendar date -> dropped
        duration: 0, // absurd -> dropped
        posters: { full: "http://cdn.theporndb.net/insecure.jpg" }, // not https -> not emitted
        background: { large: "https://cdn.theporndb.net/scene/bg.jpg" },
        performers: [],
        tags: [],
        scenes: [],
        movies: [],
        site: { name: "  " },
      },
      links: { next: null },
      meta: { total: 10000 },
    });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const detail = await getCatalogDetail({
      provider: "tpdb",
      kind: "scene",
      id: SCENE_ID,
    });
    assert.ok(detail !== null);
    assert.equal(detail.title, "Padded Title");
    assert.equal(detail.releaseDate, undefined);
    assert.equal(detail.durationSeconds, undefined);
    assert.equal(detail.description?.length, 6000); // clamped
    assert.equal(detail.imageUrl, "https://cdn.theporndb.net/scene/bg.jpg");
    assert.equal(detail.studio, undefined);
  } finally {
    await fixture.close();
    restore();
  }
});

// --- artwork enforcement ---

test("artwork URL gate: https + provider hosts only, derived from live records", () => {
  assert.equal(
    isProviderImageUrl("https://cdn.theporndb.net/scene/ab/cd/ef.jpg").ok,
    true,
  );
  assert.equal(
    isProviderImageUrl("https://thumb.theporndb.net/abc=/500x500/smart").ok,
    true,
  );
  assert.equal(
    isProviderImageUrl(
      "https://stashdb.org/images/d695a097-3cf5-41c6-bf00-be5c7bc185b8",
    ).ok,
    true,
  );
  // Real studio-CDN host observed on live records: correctly refused.
  assert.deepEqual(
    isProviderImageUrl("https://images02-openlife.gammacdn.com/movies/1.jpg"),
    {
      ok: false,
      reason:
        "host images02-openlife.gammacdn.com is not a provider artwork host",
    },
  );
  assert.equal(isProviderImageUrl("http://cdn.theporndb.net/x.jpg").ok, false);
  assert.equal(isProviderImageUrl("ftp://cdn.theporndb.net/x.jpg").ok, false);
  assert.equal(
    isProviderImageUrl("https://cdn.theporndb.net/x.jpg#frag").ok,
    false,
  );
  assert.equal(
    isProviderImageUrl("https://user:pass@cdn.theporndb.net/x.jpg").ok,
    false,
  );
  assert.equal(isProviderImageUrl("not a url").ok, false);
});

test("artwork fetch: enforces content type, byte cap, and never sends credentials", async () => {
  const fixture = await startFixture((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.apikey, undefined);
    if (req.url === "/ok.png") {
      reply(res, 200, "image/png", PNG_BYTES);
      return;
    }
    if (req.url === "/page.html") {
      reply(res, 200, "text/html; charset=utf-8", "<html></html>");
      return;
    }
    if (req.url === "/vector.svg") {
      reply(res, 200, "image/svg+xml", "<svg/>");
      return;
    }
    reply(res, 200, "image/jpeg", Buffer.alloc(512, 7));
  });
  try {
    const ok = await fetchProviderArtwork(`${fixture.origin}/ok.png`);
    assert.equal(ok.contentType, "image/png");
    assert.deepEqual([...ok.bytes], [...PNG_BYTES]);

    await assert.rejects(
      fetchProviderArtwork(`${fixture.origin}/page.html`),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_bad_response");
        return true;
      },
    );
    await assert.rejects(
      fetchProviderArtwork(`${fixture.origin}/vector.svg`),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_bad_response");
        return true;
      },
    );
    await assert.rejects(
      fetchProviderArtwork(`${fixture.origin}/big.jpg`, { sizeLimit: 16 }),
      (err: unknown) => {
        assertProviderError(err, 502, "upstream_bad_response"); // byte cap
        return true;
      },
    );
    assert.equal(IMAGE_BYTE_CAP, 8 * 1024 * 1024);
  } finally {
    await fixture.close();
  }
});

// --- performer traversal (filmography) and stashdb INCLUDES ---

test("tpdb filmography pages the canonical performer route and rejects mixed filters", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");
    assert.equal(params.get("per_page"), "2");
    if (req.url.startsWith(`/performers/${CANON_PERFORMER_ID}/scenes`)) {
      replyJson(res, 200, {
        data: [
          {
            id: SCENE_ID,
            title: "Filmography Scene",
            posters: {},
            background: {},
            performers: [],
            tags: [],
            scenes: [],
            movies: [],
          },
        ],
        links: { next: null },
        meta: { total: 1 },
      });
      return;
    }
    replyJson(res, 404, {});
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const page = await searchCatalog({
      provider: "tpdb",
      kind: "scene",
      performer: CANON_PERFORMER_ID,
      perPage: 2,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.reference.id, SCENE_ID);
    await assert.rejects(
      searchCatalog({
        provider: "tpdb",
        kind: "scene",
        performer: CANON_PERFORMER_ID,
        query: "nope",
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    await assert.rejects(
      searchCatalog({
        provider: "tpdb",
        kind: "scene",
        performer: "not-a-uuid",
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_reference");
        return true;
      },
    );
  } finally {
    await fixture.close();
    restore();
  }
});

test("stashdb scene search passes performers INCLUDES and reports real counts", async () => {
  const restore = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const fixture = await startFixture((req, res) => {
    replyJson(res, 200, {
      data: {
        queryScenes: {
          count: 5,
          scenes: [
            {
              id: STASH_SCENE_ID,
              title: "S1",
              tags: [],
              performers: [],
              urls: [],
            },
            { id: MISSING_ID, title: "S2", tags: [], performers: [], urls: [] },
          ],
        },
      },
    });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    const page = await searchCatalog({
      provider: "stashdb",
      kind: "scene",
      performer: STASH_PERFORMER_ID,
      perPage: 2,
    });
    const body = stashBody(fixture, 0);
    const filter = body.variables.f as {
      performers: { value: string[]; modifier: string };
      per_page: number;
    };
    assert.deepEqual(filter.performers, {
      value: [STASH_PERFORMER_ID],
      modifier: "INCLUDES",
    });
    assert.equal(filter.per_page, 2);
    assert.equal(page.total, 5);
    assert.equal(page.totalCountKnown, true);
    assert.equal(page.hasMore, true); // 1*2 < 5
    assert.equal(page.items.length, 2);
    assert.equal(body.query.includes("queryScenes(input: $f)"), true);
  } finally {
    await fixture.close();
    restore();
  }
});

test("stashdb performer search reports its real count but no continuation (provider cap)", async () => {
  const restore = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const fixture = await startFixture((req, res) => {
    const performers = Array.from({ length: 10 }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(32, "0");
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      return { id, name: `Anna ${i}`, deleted: false, images: [] };
    });
    replyJson(res, 200, {
      data: { searchPerformers: { count: 872, performers } },
    });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    const page = await searchCatalog({
      provider: "stashdb",
      kind: "performer",
      query: "anna",
    });
    const body = stashBody(fixture, 0);
    assert.deepEqual(body.variables.t, "anna");
    assert.equal(page.items.length, 10);
    assert.equal(page.total, 872);
    assert.equal(page.totalCountKnown, true);
    assert.equal(page.hasMore, false); // provider cannot page this endpoint
  } finally {
    await fixture.close();
    restore();
  }
});

// --- status / verification / not-configured ---

test("provider status verifies one cheap authenticated call; missing keys are not-configured", async () => {
  const restore = setEnv({
    TPDB_API_TOKEN: TPDB_TOKEN,
    STASHDB_API_KEY: STASH_TOKEN,
  });
  const fixture = await startFixture((req, res) => {
    if (req.url === "/user") {
      replyJson(res, 200, { data: { id: 136293, name: "Skare", roles: [] } });
      return;
    }
    replyJson(res, 200, {
      data: {
        me: {
          id: "01a08c89-631e-77fb-b770-ebd7dd304b14",
          name: "skare",
          roles: ["READ"],
        },
      },
    });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    process.env.STASHDB_BASE_URL = fixture.origin;
    const tpdb = await getProviderStatus("tpdb");
    assert.deepEqual(tpdb, {
      provider: "tpdb",
      configured: true,
      verified: true,
      account: "Skare",
    });
    assert.equal(
      fixture.requests[0]?.headers.authorization,
      `Bearer ${TPDB_TOKEN}`,
    );

    const stash = await getProviderStatus("stashdb");
    assert.deepEqual(stash, {
      provider: "stashdb",
      configured: true,
      verified: true,
      account: "skare",
    });
    assert.equal(fixture.requests[1]?.headers.apikey, STASH_TOKEN);
  } finally {
    await fixture.close();
    restore();
  }

  const noKeys = setEnv({});
  try {
    assert.deepEqual(await getProviderStatus("tpdb"), {
      provider: "tpdb",
      configured: false,
    });
    assert.deepEqual(await getProviderStatus("stashdb"), {
      provider: "stashdb",
      configured: false,
    });
    await assert.rejects(
      searchCatalog({ provider: "tpdb", kind: "movie", query: "x" }),
      (err: unknown) => {
        assertProviderError(err, 503, "provider_not_configured");
        return true;
      },
    );
    await assert.rejects(
      getCatalogDetail({
        provider: "stashdb",
        kind: "scene",
        id: STASH_SCENE_ID,
      }),
      (err: unknown) => {
        assertProviderError(err, 503, "provider_not_configured");
        return true;
      },
    );
    // Empty-string credential is the same honest not-configured condition.
    assert.deepEqual(await getProviderStatus("tpdb"), {
      provider: "tpdb",
      configured: false,
    });
  } finally {
    noKeys();
  }
});

// --- cross-provider performer identity ---

function tpdbPerformerDetailFixture(
  links: { url: string; label?: string }[],
): CatalogDetail {
  return {
    reference: { provider: "tpdb", kind: "performer", id: CANON_PERFORMER_ID },
    title: "Marica Hase",
    credits: [],
    tags: [],
    related: [],
    links,
    aliases: [],
  };
}

test("cross-provider identity uses only explicit provider URLs; scenes stay unlinked", () => {
  const linked = crossProviderLink(
    tpdbPerformerDetailFixture([
      { url: "https://www.indexxx.com/m/marica-hase", label: "Indexxx" },
      {
        url: `https://stashdb.org/performers/${STASH_CROSS_ID}`,
        label: "StashDB",
      },
    ]),
  );
  assert.deepEqual(linked.linked, {
    provider: "stashdb",
    kind: "performer",
    id: STASH_CROSS_ID,
  });
  assert.equal(linked.unlinkedReason, undefined);

  const unlinked = crossProviderLink(
    tpdbPerformerDetailFixture([
      { url: "https://www.indexxx.com/m/marica-hase", label: "Indexxx" },
    ]),
  );
  assert.equal(unlinked.linked, undefined);
  assert.match(unlinked.unlinkedReason ?? "", /StashDB/);

  // A TPDB-lookalike URL must not satisfy a stashdb lookup.
  const wrongProvider = crossProviderLink(
    tpdbPerformerDetailFixture([
      { url: `https://www.theporndb.net/performers/${CANON_PERFORMER_ID}` },
    ]),
  );
  assert.equal(wrongProvider.linked, undefined);

  // Scenes/other kinds never link across providers.
  const sceneDetail: CatalogDetail = {
    reference: { provider: "tpdb", kind: "movie", id: MOVIE_ID },
    title: "Movie",
    credits: [],
    tags: [],
    related: [],
    links: [{ url: `https://stashdb.org/performers/${STASH_CROSS_ID}` }],
    aliases: [],
  };
  assert.match(
    crossProviderLink(sceneDetail).unlinkedReason ?? "",
    /performer-level/,
  );
});

// --- reference validation ---

test("catalog references are validated before any upstream call", async () => {
  await assert.rejects(
    getCatalogDetail({ provider: "tpdb", kind: "movie", id: "not-a-uuid" }),
    (err: unknown) => {
      assertProviderError(err, 400, "invalid_reference");
      return true;
    },
  );
  await assert.rejects(
    getCatalogDetail({ provider: "stashdb", kind: "movie", id: MOVIE_ID }),
    (err: unknown) => {
      assertProviderError(err, 400, "invalid_reference");
      return true;
    },
  );
});
