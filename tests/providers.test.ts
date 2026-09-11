// Provider-layer regression tests: isolated 127.0.0.1 HTTP fixtures only.
// No real network, no real credentials. Covers TPDB/StashDB detail mapping,
// canonical credit parents, fake-total suppression, real pagination
// continuation, not-found vs outage, malformed/oversized payload rejection,
// artwork host/content-type/size enforcement, not-configured behavior, studio
// and tag discovery, provider-genuine studio/tag filters, and sort mapping.

import http from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import { AppError, resetMetaCache } from "../src/server/http.ts";
import {
  crossProviderLink,
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  IMAGE_BYTE_CAP,
  isProviderImageUrl,
  resolveSort,
  searchCatalog,
  searchCatalogTags,
} from "../src/server/providers.ts";
import type { CatalogSearchQuery } from "../src/server/providers.ts";
import type { CatalogDetail } from "../src/lib/contracts.ts";

// One shared fixture upstream per file; every test starts with a cold cache
// so cached reads never mask a scripted upstream change.
beforeEach(() => {
  resetMetaCache();
});

// --- constants and fixture helpers ---

const TPDB_TOKEN = "tpdb-fixture-token-0001";
const STASH_TOKEN = "stashdb-fixture-key-0001";
const MOVIE_ID = "71287a36-7079-44b6-938c-8096e4a681a9";
const MOVIE_ID_2 = "bd32beec-1927-4e93-853c-6fa9508597d2";
const SCENE_ID = "91e9610b-77fc-4046-b6d7-fd060f6e46a6";
const RELATED_SCENE_ID = "9b1663f6-1cd9-449f-a1c9-44b8f33c4280";
const SITE_PERFORMER_ID = "6263c88d-4bb5-4b41-b4a1-6e31a90308bd";
const CANON_PERFORMER_ID = "42386b25-d0f1-41dc-a53f-a132b2425acf";
const TPDB_STUDIO_ID = "1dafafd3-da8f-47f3-aca2-e6bb9f354292";
const TPDB_NETWORK_ID = "b42c05ae-27e3-4ae2-8b79-eb40ad3b52fe";
const TPDB_STUDIO_NUMERIC = 3372;
const TPDB_TAG_A = "ffe45e51-8472-4a2d-a582-fe224da0c60f";
const TPDB_TAG_B = "9865d865-320d-4bce-b17a-edd2a05bce41";
const STASH_STUDIO_ID = "915dd307-a440-4578-b83f-699b9706faea";
const STASH_PARENT_STUDIO_ID = "b62bc449-c3d9-49ff-9a16-8f5b1bfa20b9";
const STASH_DELETED_STUDIO_ID = "e5a7c221-3ba2-4f4e-9d3a-7f01c2b45d66";
const STASH_TAG_ID = "beb2cfa5-834a-45b6-9b87-092e19d2b43a";
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
          images: [
            {
              url: "https://stashdb.org/images/d695a097-3cf5-41c6-bf00-be5c7bc185b8",
            },
          ],
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
    assert.equal(
      detail.imageUrl,
      "https://stashdb.org/images/d695a097-3cf5-41c6-bf00-be5c7bc185b8",
    );
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

test("stashdb scene search keeps artwork, performer filters, and real counts", async () => {
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
              images: [
                { url: "https://untrusted.example/scene.jpg" },
                {
                  url: "https://stashdb.org/images/1c73ec9e-0643-4564-aae6-441999853fac",
                },
              ],
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
      sort: "trending",
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
    assert.equal(
      page.items[0]?.imageUrl,
      "https://stashdb.org/images/1c73ec9e-0643-4564-aae6-441999853fac",
    );
    assert.equal(page.items[1]?.imageUrl, undefined);
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

// --- TPDB studio (sites) search and detail ---

function tpdbSiteRow(): Record<string, unknown> {
  return {
    uuid: TPDB_STUDIO_ID,
    id: TPDB_STUDIO_NUMERIC,
    parent_id: TPDB_STUDIO_NUMERIC,
    network_id: TPDB_STUDIO_NUMERIC,
    name: "Vixen",
    short_name: "vixen",
    url: "https://vixen.com",
    description: "Part of a network.",
    logo: "https://cdn.theporndb.net/sites/aa/logo.png",
    favicon: null,
    poster: "https://cdn.theporndb.net/sites/aa/poster.png",
    network: { uuid: TPDB_NETWORK_ID, id: 36826, name: "Vixen Media Group" },
    parent: null,
  };
}

test("tpdb studio search and detail map sites rows with provider-supplied parents", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    if (req.url.startsWith("/sites?")) {
      replyJson(res, 200, {
        data: [
          tpdbSiteRow(),
          {
            // Studio-CDN logo only, no parent rows: artwork dropped, no
            // parent relationship invented.
            uuid: TPDB_NETWORK_ID,
            id: 36826,
            name: "Gamma Studio",
            logo: "https://images02-openlife.gammacdn.com/logo.png",
            poster: null,
            network: null,
            parent: null,
          },
        ],
        links: { next: null },
        meta: { total: 10000 }, // cap value must stay suppressed
      });
      return;
    }
    if (req.url === `/sites/${TPDB_STUDIO_ID}`) {
      replyJson(res, 200, { data: tpdbSiteRow() });
      return;
    }
    replyJson(res, 404, {});
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const page = await searchCatalog({
      provider: "tpdb",
      kind: "studio",
      query: "vixen",
      perPage: 12,
    });
    const params = queryParams(fixture, 0);
    assert.equal(params.get("q"), "vixen");
    assert.equal(params.get("per_page"), "12");
    assert.equal(page.kind, "studio");
    assert.equal(page.total, undefined); // 10000 cap never surfaces as real
    assert.equal(page.totalCountKnown, false);
    const item = page.items[0];
    assert.deepEqual(item?.reference, {
      provider: "tpdb",
      kind: "studio",
      id: TPDB_STUDIO_ID,
    });
    assert.equal(item?.title, "Vixen");
    assert.equal(
      item?.imageUrl,
      "https://cdn.theporndb.net/sites/aa/poster.png",
    );
    assert.deepEqual(item?.studio, {
      name: "Vixen Media Group",
      reference: { provider: "tpdb", kind: "studio", id: TPDB_NETWORK_ID },
    });
    assert.equal(item?.sourceUrl, "https://vixen.com");
    const gamma = page.items[1];
    assert.equal(gamma?.imageUrl, undefined);
    assert.equal(gamma?.studio, undefined);
    assert.equal(JSON.stringify(page).includes("gammacdn"), false);

    const detail = await getCatalogDetail({
      provider: "tpdb",
      kind: "studio",
      id: TPDB_STUDIO_ID,
    });
    assert.ok(detail !== null);
    assert.deepEqual(detail.reference, {
      provider: "tpdb",
      kind: "studio",
      id: TPDB_STUDIO_ID,
    });
    assert.equal(detail.description, "Part of a network.");
    assert.equal(detail.studio?.name, "Vixen Media Group");
    const missing = await getCatalogDetail({
      provider: "tpdb",
      kind: "studio",
      id: MISSING_ID,
    });
    assert.equal(missing, null); // 404 stays authoritative absence
  } finally {
    await fixture.close();
    restore();
  }
});

// --- TPDB studio filter: uuid -> numeric site_id resolution, capped totals ---

test("tpdb studio-filtered scene queries resolve uuid to numeric site_id and keep capped totals suppressed", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    if (req.url.startsWith(`/sites/${TPDB_STUDIO_ID}`)) {
      replyJson(res, 200, {
        data: { uuid: TPDB_STUDIO_ID, id: TPDB_STUDIO_NUMERIC, name: "Vixen" },
      });
      return;
    }
    if (req.url.startsWith("/scenes?")) {
      replyJson(res, 200, {
        data: [
          {
            id: SCENE_ID,
            title: "Vixen Scene",
            site: { uuid: TPDB_STUDIO_ID, name: "Vixen" },
            posters: {},
            background: {},
            performers: [],
            tags: [],
            scenes: [],
            movies: [],
          },
        ],
        links: { next: null },
        meta: { total: 10000 }, // even a studio-filtered query can be capped
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
      studio: TPDB_STUDIO_ID,
    });
    const params = queryParams(fixture, 1);
    assert.equal(params.get("site_id"), String(TPDB_STUDIO_NUMERIC));
    assert.equal(page.total, undefined);
    assert.equal(page.totalCountKnown, false);
    assert.equal(page.items[0]?.reference.id, SCENE_ID);
    assert.deepEqual(page.items[0]?.studio, {
      name: "Vixen",
      reference: { provider: "tpdb", kind: "studio", id: TPDB_STUDIO_ID },
    });
  } finally {
    await fixture.close();
    restore();
  }
});

// --- StashDB studio search and findStudio detail ---

test("stashdb studio search and findStudio map studios; absence stays authoritative", async () => {
  const restore = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const stashStudioRow = {
    id: STASH_STUDIO_ID,
    name: "Vixen",
    deleted: false,
    urls: [{ url: "https://www.vixen.com/", type: "HOME" }],
    images: [
      {
        url: "https://stashdb.org/images/23b009b5-d781-4940-9877-02a72e4b4c68",
      },
    ],
    parent: { id: STASH_PARENT_STUDIO_ID, name: "Vixen Media Group" },
  };
  const fixture = await startFixture((req, res) => {
    const parsed = JSON.parse(req.body) as {
      query: string;
      variables: { t?: string; id?: string };
    };
    const vars = parsed.variables ?? {};
    if (parsed.query.includes("searchStudio")) {
      assert.equal(vars.t, "vixen");
      replyJson(res, 200, {
        data: {
          searchStudio: [
            stashStudioRow,
            // deleted studios never surface
            {
              id: MISSING_ID,
              name: "Ghost Studio",
              deleted: true,
              urls: [],
              images: [],
              parent: null,
            },
          ],
        },
      });
      return;
    }
    if (vars.id === MISSING_ID) {
      replyJson(res, 200, { data: { findStudio: null } });
      return;
    }
    if (vars.id === STASH_DELETED_STUDIO_ID) {
      replyJson(res, 200, {
        data: {
          findStudio: {
            ...stashStudioRow,
            id: STASH_DELETED_STUDIO_ID,
            deleted: true,
          },
        },
      });
      return;
    }
    replyJson(res, 200, { data: { findStudio: stashStudioRow } });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    const page = await searchCatalog({
      provider: "stashdb",
      kind: "studio",
      query: "vixen",
    });
    assert.equal(page.kind, "studio");
    assert.equal(page.items.length, 1); // deleted search row skipped
    assert.deepEqual(page.items[0]?.reference, {
      provider: "stashdb",
      kind: "studio",
      id: STASH_STUDIO_ID,
    });
    assert.equal(
      page.items[0]?.imageUrl,
      "https://stashdb.org/images/23b009b5-d781-4940-9877-02a72e4b4c68",
    );
    assert.deepEqual(page.items[0]?.studio, {
      name: "Vixen Media Group",
      reference: {
        provider: "stashdb",
        kind: "studio",
        id: STASH_PARENT_STUDIO_ID,
      },
    });
    // searchStudio exposes no count: unknown, never faked
    assert.equal(page.total, undefined);
    assert.equal(page.totalCountKnown, false);
    assert.equal(page.hasMore, false);

    const detail = await getCatalogDetail({
      provider: "stashdb",
      kind: "studio",
      id: STASH_STUDIO_ID,
    });
    assert.ok(detail !== null);
    assert.equal(detail.links[0]?.label, "HOME");
    assert.equal(
      await getCatalogDetail({
        provider: "stashdb",
        kind: "studio",
        id: MISSING_ID,
      }),
      null,
    );
    assert.equal(
      await getCatalogDetail({
        provider: "stashdb",
        kind: "studio",
        id: STASH_DELETED_STUDIO_ID,
      }),
      null,
    );
  } finally {
    await fixture.close();
    restore();
  }
});

// --- tag lookup: provider-native ids only ---

test("tag lookup returns provider-native ids without cross-provider mapping", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const tpdbFixture = await startFixture((req, res) => {
    const params = new URLSearchParams(req.url.split("?")[1] ?? "");
    assert.equal(params.get("q"), "anal");
    assert.equal(params.get("per_page"), "50");
    replyJson(res, 200, {
      data: [{ id: 70, uuid: TPDB_TAG_A, name: "Anal" }],
    });
  });
  let tpdbTags: { id: string; name: string }[];
  try {
    process.env.TPDB_BASE_URL = tpdbFixture.origin;
    tpdbTags = await searchCatalogTags("tpdb", "anal");
    assert.deepEqual(tpdbTags, [{ id: TPDB_TAG_A, name: "Anal" }]);
    await assert.rejects(searchCatalogTags("tpdb", "   "), (err: unknown) => {
      assertProviderError(err, 400, "invalid_search");
      return true;
    });
  } finally {
    await tpdbFixture.close();
    restore();
  }

  const restore2 = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const stashFixture = await startFixture((req, res) => {
    const parsed = JSON.parse(req.body) as { variables: { t?: string } };
    assert.equal(parsed.variables?.t, "anal");
    replyJson(res, 200, {
      data: {
        searchTag: [
          { id: STASH_TAG_ID, name: "Anal Creampie" },
          { id: "not-a-uuid", name: "Broken" }, // non-UUID dropped
        ],
      },
    });
  });
  try {
    process.env.STASHDB_BASE_URL = stashFixture.origin;
    const stashTags = await searchCatalogTags("stashdb", "anal");
    assert.deepEqual(stashTags, [{ id: STASH_TAG_ID, name: "Anal Creampie" }]);
    // provider-native ids are kept verbatim, never mapped across providers
    assert.notEqual(tpdbTags[0]?.id, stashTags[0]?.id);
  } finally {
    await stashFixture.close();
    restore2();
  }
});

// --- studio and tag filters produce the right upstream query ---

test("studio and tag filters produce the right upstream query for each provider", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    if (req.url.startsWith(`/sites/${TPDB_STUDIO_ID}`)) {
      replyJson(res, 200, {
        data: { uuid: TPDB_STUDIO_ID, id: TPDB_STUDIO_NUMERIC, name: "Vixen" },
      });
      return;
    }
    if (req.url.startsWith("/scenes?") || req.url.startsWith("/movies?")) {
      replyJson(res, 200, {
        data: [],
        links: { next: null },
        meta: { total: 5 },
      });
      return;
    }
    replyJson(res, 404, {});
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    await searchCatalog({
      provider: "tpdb",
      kind: "scene",
      studio: TPDB_STUDIO_ID,
      tags: [TPDB_TAG_A, TPDB_TAG_B],
    });
    // request 0 resolved the uuid; request 1 is the filtered query
    const sceneParams = queryParams(fixture, 1);
    assert.equal(sceneParams.get("site_id"), String(TPDB_STUDIO_NUMERIC));
    assert.deepEqual(sceneParams.getAll("tags[]"), [TPDB_TAG_A, TPDB_TAG_B]);
    assert.equal(sceneParams.get("tag_and"), null);
    assert.equal(sceneParams.get("orderBy"), null);

    await searchCatalog({
      provider: "tpdb",
      kind: "movie",
      studio: String(TPDB_STUDIO_NUMERIC),
      tagsAll: [TPDB_TAG_A],
      sort: "recency",
    });
    // numeric studio id passes straight through: no /sites lookup in between
    assert.equal(fixture.requests[2]?.url.startsWith("/movies?"), true);
    const movieParams = queryParams(fixture, 2);
    assert.equal(movieParams.get("site_id"), String(TPDB_STUDIO_NUMERIC));
    assert.deepEqual(movieParams.getAll("tags[]"), [TPDB_TAG_A]);
    assert.equal(movieParams.get("tag_and"), "1");
    assert.equal(movieParams.get("orderBy"), "recently_released");
  } finally {
    await fixture.close();
    restore();
  }

  const restore2 = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const stashFixture = await startFixture((req, res) => {
    replyJson(res, 200, { data: { queryScenes: { count: 483, scenes: [] } } });
  });
  try {
    process.env.STASHDB_BASE_URL = stashFixture.origin;
    const page = await searchCatalog({
      provider: "stashdb",
      kind: "scene",
      studio: STASH_STUDIO_ID,
      tags: [STASH_TAG_ID],
      sort: "trending",
    });
    const body = stashBody(stashFixture, 0);
    const filter = body.variables.f as {
      studios?: { value: string[]; modifier: string };
      tags?: { value: string[]; modifier: string };
      sort?: string;
      direction?: string;
    };
    assert.deepEqual(filter.studios, {
      value: [STASH_STUDIO_ID],
      modifier: "INCLUDES",
    });
    assert.deepEqual(filter.tags, {
      value: [STASH_TAG_ID],
      modifier: "INCLUDES",
    });
    assert.equal(filter.sort, "TRENDING");
    assert.equal(filter.direction, "DESC");
    assert.deepEqual(page.sort, {
      key: "trending",
      direction: "desc",
      upstream: "TRENDING",
    });

    await searchCatalog({
      provider: "stashdb",
      kind: "scene",
      tagsExclude: [STASH_TAG_ID],
      sort: "popularity",
      direction: "asc",
    });
    const body2 = stashBody(stashFixture, 1);
    const filter2 = body2.variables.f as {
      tags?: { value: string[]; modifier: string };
      sort?: string;
      direction?: string;
    };
    assert.deepEqual(filter2.tags, {
      value: [STASH_TAG_ID],
      modifier: "EXCLUDES",
    });
    assert.equal(filter2.sort, "POPULARITY");
    assert.equal(filter2.direction, "ASC");
  } finally {
    await stashFixture.close();
    restore2();
  }
});

// --- unsupported combinations are rejected explicitly ---

test("unsupported filter and sort combinations are rejected explicitly", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    replyJson(res, 200, { data: [], links: { next: null }, meta: {} });
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    // filmography + studio: rejected before any upstream call
    await assert.rejects(
      searchCatalog({
        provider: "tpdb",
        kind: "scene",
        performer: CANON_PERFORMER_ID,
        studio: TPDB_STUDIO_ID,
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // TRENDING is refused for TPDB: no popularity or trending order exists
    await assert.rejects(
      searchCatalog({ provider: "tpdb", kind: "scene", sort: "trending" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_search");
        assert.match(err.message, /trending/);
        return true;
      },
    );
    await assert.rejects(
      searchCatalog({ provider: "tpdb", kind: "movie", sort: "popularity" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.message, /popularity/);
        return true;
      },
    );
    // relevance takes no direction
    await assert.rejects(
      searchCatalog({
        provider: "tpdb",
        kind: "scene",
        sort: "relevance",
        direction: "asc",
      }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.match(err.message, /relevance/);
        return true;
      },
    );
    // direction without sort is meaningless
    await assert.rejects(
      searchCatalog({ provider: "tpdb", kind: "movie", direction: "asc" }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // TPDB exposes one tag criterion
    await assert.rejects(
      searchCatalog({
        provider: "tpdb",
        kind: "scene",
        tags: [TPDB_TAG_A],
        tagsAll: [TPDB_TAG_B],
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // smuggled field on a variant that has no filters: never silently dropped
    const smuggled: Record<string, unknown> = {
      provider: "tpdb",
      kind: "performer",
      query: "anna",
      tags: [TPDB_TAG_A],
    };
    await assert.rejects(
      searchCatalog(smuggled as CatalogSearchQuery),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // malformed tag filter ids are rejected, not passed upstream
    await assert.rejects(
      searchCatalog({ provider: "tpdb", kind: "scene", tags: ["70"] }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    assert.equal(fixture.requests.length, 0); // nothing reached upstream
  } finally {
    await fixture.close();
    restore();
  }

  const restore2 = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const stashFixture = await startFixture((req, res) => {
    replyJson(res, 200, { data: { queryScenes: { count: 1, scenes: [] } } });
  });
  try {
    process.env.STASHDB_BASE_URL = stashFixture.origin;
    // one tag criterion per query
    await assert.rejects(
      searchCatalog({
        provider: "stashdb",
        kind: "scene",
        tags: [STASH_TAG_ID],
        tagsExclude: [STASH_TAG_ID],
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    await assert.rejects(
      searchCatalog({
        provider: "stashdb",
        kind: "scene",
        direction: "asc",
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    const smuggled: Record<string, unknown> = {
      provider: "stashdb",
      kind: "performer",
      query: "anna",
      studio: STASH_STUDIO_ID,
    };
    await assert.rejects(
      searchCatalog(smuggled as CatalogSearchQuery),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    const smuggled2: Record<string, unknown> = {
      provider: "stashdb",
      kind: "studio",
      query: "vixen",
      sort: "trending",
    };
    await assert.rejects(
      searchCatalog(smuggled2 as CatalogSearchQuery),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    assert.equal(stashFixture.requests.length, 0);
  } finally {
    await stashFixture.close();
    restore2();
  }
});

// --- sort resolution: only provider-genuine orders ---

test("sort resolution maps exactly to upstream orders and refuses fake ones", () => {
  assert.deepEqual(resolveSort("tpdb", "scene", "recency"), {
    key: "recency",
    direction: "desc",
    upstream: "recently_released",
  });
  assert.deepEqual(resolveSort("tpdb", "movie", "recency", "asc"), {
    key: "recency",
    direction: "asc",
    upstream: "former_released",
  });
  assert.equal(
    resolveSort("tpdb", "scene", "duration", "asc").upstream,
    "duration_asc",
  );
  const relevance = resolveSort("tpdb", "movie", "relevance");
  assert.equal(relevance.upstream, "most_relevant");
  assert.equal(relevance.direction, undefined);
  assert.throws(() => resolveSort("tpdb", "scene", "trending"), AppError);
  assert.throws(() => resolveSort("tpdb", "scene", "popularity"), AppError);
  assert.throws(() => resolveSort("stashdb", "scene", "recency"), AppError);
  assert.throws(() => resolveSort("stashdb", "scene", "relevance"), AppError);
  assert.deepEqual(resolveSort("stashdb", "scene", "updated", "asc"), {
    key: "updated",
    direction: "asc",
    upstream: "UPDATED_AT",
  });
  assert.equal(
    resolveSort("stashdb", "scene", "trending").upstream,
    "TRENDING",
  );
});

// --- studioMode: parent-studio inclusion on StashDB scenes only ---

test("stashdb studioMode withChildren emits parentStudio; default keeps studios INCLUDES; never both", async () => {
  const restore = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const fixture = await startFixture((req, res) => {
    replyJson(res, 200, { data: { queryScenes: { count: 3, scenes: [] } } });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    await searchCatalog({
      provider: "stashdb",
      kind: "scene",
      studio: STASH_STUDIO_ID,
      studioMode: "withChildren",
    });
    const withChildren = stashBody(fixture, 0).variables.f as Record<
      string,
      unknown
    >;
    assert.equal(withChildren.parentStudio, STASH_STUDIO_ID);
    assert.equal("studios" in withChildren, false); // never both criteria

    await searchCatalog({
      provider: "stashdb",
      kind: "scene",
      studio: STASH_STUDIO_ID,
      studioMode: "exact",
    });
    const exact = stashBody(fixture, 1).variables.f as {
      studios?: { value: string[]; modifier: string };
      parentStudio?: unknown;
    };
    assert.deepEqual(exact.studios, {
      value: [STASH_STUDIO_ID],
      modifier: "INCLUDES",
    });
    assert.equal("parentStudio" in exact, false);

    // omitted studioMode is byte-for-byte today's behavior (a distinct
    // studio id keeps it a distinct upstream request rather than a cache hit
    // on the exact variant above).
    await searchCatalog({
      provider: "stashdb",
      kind: "scene",
      studio: STASH_PARENT_STUDIO_ID,
    });
    const omitted = stashBody(fixture, 2).variables.f as {
      studios?: { value: string[]; modifier: string };
      parentStudio?: unknown;
    };
    assert.deepEqual(omitted.studios, {
      value: [STASH_PARENT_STUDIO_ID],
      modifier: "INCLUDES",
    });
    assert.equal("parentStudio" in omitted, false);
  } finally {
    await fixture.close();
    restore();
  }
});

test("studioMode is rejected before any upstream call outside stashdb scene + studio", async () => {
  const restore = setEnv({
    TPDB_API_TOKEN: TPDB_TOKEN,
    STASHDB_API_KEY: STASH_TOKEN,
  });
  const fixture = await startFixture(() => {
    assert.fail("no request may reach upstream for a rejected studioMode");
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    process.env.STASHDB_BASE_URL = fixture.origin;
    // TPDB has no parentStudio criterion and must never emulate one by
    // widening. The typed union already forbids studioMode here, so this
    // proves the runtime guard an untyped caller would hit.
    const tpdbSceneSmuggled: Record<string, unknown> = {
      provider: "tpdb",
      kind: "scene",
      studio: TPDB_STUDIO_ID,
      studioMode: "withChildren",
    };
    await assert.rejects(
      searchCatalog(tpdbSceneSmuggled as CatalogSearchQuery),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // smuggled onto a TPDB variant that has no studio filters at all
    const tpdbSmuggled: Record<string, unknown> = {
      provider: "tpdb",
      kind: "studio",
      query: "vixen",
      studioMode: "withChildren",
    };
    await assert.rejects(
      searchCatalog(tpdbSmuggled as CatalogSearchQuery),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // stashdb scene: studioMode without a studio filter
    await assert.rejects(
      searchCatalog({
        provider: "stashdb",
        kind: "scene",
        studioMode: "withChildren",
      }),
      (err: unknown) => {
        assertProviderError(err, 400, "invalid_search");
        return true;
      },
    );
    // smuggled onto stashdb performer and studio searches
    const stashSmuggles: Record<string, unknown>[] = [
      {
        provider: "stashdb",
        kind: "performer",
        query: "anna",
        studioMode: "exact",
      },
      {
        provider: "stashdb",
        kind: "studio",
        query: "vixen",
        studioMode: "exact",
      },
    ];
    for (const smuggled of stashSmuggles) {
      await assert.rejects(
        searchCatalog(smuggled as CatalogSearchQuery),
        (err: unknown) => {
          assertProviderError(err, 400, "invalid_search");
          return true;
        },
      );
    }
    assert.equal(fixture.requests.length, 0); // nothing reached upstream
  } finally {
    await fixture.close();
    restore();
  }
});

test("stashdb studio detail carries provider-supplied child count; absent stays absent", async () => {
  const restore = setEnv({ STASHDB_API_KEY: STASH_TOKEN });
  const fixture = await startFixture((req, res) => {
    const body = JSON.parse(req.body) as { variables: { id?: string } };
    const childIds =
      body.variables.id === STASH_STUDIO_ID
        ? [STASH_TAG_ID, MISSING_ID, "not-a-uuid"] // 2 valid, one malformed
        : body.variables.id === STASH_PARENT_STUDIO_ID
          ? [] // supplied empty list: a real zero, not an absence
          : undefined; // field absent entirely
    replyJson(res, 200, {
      data: {
        findStudio: {
          id: body.variables.id,
          name: "Studio",
          deleted: false,
          ...(childIds === undefined
            ? {}
            : { child_studios: childIds.map((id) => ({ id })) }),
        },
      },
    });
  });
  try {
    process.env.STASHDB_BASE_URL = fixture.origin;
    const withChildren = (await getCatalogDetail({
      provider: "stashdb",
      kind: "studio",
      id: STASH_STUDIO_ID,
    })) as CatalogDetail & { childStudioCount?: number };
    assert.equal(withChildren.childStudioCount, 2); // malformed ids never counted
    const realZero = (await getCatalogDetail({
      provider: "stashdb",
      kind: "studio",
      id: STASH_PARENT_STUDIO_ID,
    })) as CatalogDetail & { childStudioCount?: number };
    assert.equal(realZero.childStudioCount, 0); // real zero, distinguishable
    const absent = await getCatalogDetail({
      provider: "stashdb",
      kind: "studio",
      id: STASH_DELETED_STUDIO_ID,
    });
    assert.equal(absent !== null && "childStudioCount" in absent, false); // omitted, never defaulted
  } finally {
    await fixture.close();
    restore();
  }
});

// --- bounded release-date filter: emitted, rejected, and never leaked into
// ordinary browse ---

test("tpdb releaseDate emits the upstream date + date_operation pair; ordinary browse stays unbounded", async () => {
  const restore = setEnv({ TPDB_API_TOKEN: TPDB_TOKEN });
  const fixture = await startFixture((req, res) => {
    if (req.url.startsWith("/movies?") || req.url.startsWith("/scenes?")) {
      replyJson(res, 200, {
        data: [{ ...tpdbMovieRow() }],
        links: { next: null },
        meta: { total: 1 },
      });
      return;
    }
    replyJson(res, 404, {});
  });
  try {
    process.env.TPDB_BASE_URL = fixture.origin;
    const bound = { cutoff: "2026-09-11", operation: "<=" } as const;
    await searchCatalog({
      provider: "tpdb",
      kind: "movie",
      releaseDate: { ...bound },
      sort: "recency",
      direction: "desc",
    });
    const movieParams = queryParams(fixture, 0);
    assert.equal(movieParams.get("date"), "2026-09-11");
    assert.equal(movieParams.get("date_operation"), "<=");
    assert.equal(movieParams.get("orderBy"), "recently_released");
    await searchCatalog({
      provider: "tpdb",
      kind: "scene",
      releaseDate: { cutoff: "2026-01-01", operation: ">" },
    });
    const sceneParams = queryParams(fixture, 1);
    assert.equal(sceneParams.get("date"), "2026-01-01");
    assert.equal(sceneParams.get("date_operation"), ">");
    assert.equal(sceneParams.get("orderBy"), null);

    // Ordinary browse without the bound is byte-for-byte today's request:
    // neither param appears at all.
    await searchCatalog({ provider: "tpdb", kind: "movie" });
    const browseParams = queryParams(fixture, 2);
    assert.equal(browseParams.get("date"), null);
    assert.equal(browseParams.get("date_operation"), null);
    assert.equal(fixture.requests[2]?.url, "/movies?page=1&per_page=24");
  } finally {
    await fixture.close();
    restore();
  }
});

test("releaseDate is rejected explicitly where unsupported or malformed, before any upstream call", async () => {
  const bound = { cutoff: "2026-09-11", operation: "<=" } as const;
  const cases: {
    query: CatalogSearchQuery;
    match: RegExp;
  }[] = [
    {
      query: {
        provider: "stashdb",
        kind: "scene",
        releaseDate: bound,
      } as CatalogSearchQuery,
      match: /only supported on TPDB movie and scene/,
    },
    {
      query: {
        provider: "stashdb",
        kind: "performer",
        query: "anna",
        releaseDate: bound,
      } as CatalogSearchQuery,
      match: /only supported on TPDB movie and scene/,
    },
    {
      query: {
        provider: "stashdb",
        kind: "studio",
        query: "vixen",
        releaseDate: bound,
      } as CatalogSearchQuery,
      match: /only supported on TPDB movie and scene/,
    },
    {
      query: {
        provider: "tpdb",
        kind: "performer",
        query: "anna",
        releaseDate: bound,
      } as CatalogSearchQuery,
      match: /only supported on TPDB movie and scene/,
    },
    {
      query: {
        provider: "tpdb",
        kind: "studio",
        query: "vixen",
        releaseDate: bound,
      } as CatalogSearchQuery,
      match: /only supported on TPDB movie and scene/,
    },
    {
      // filmography paging cannot carry the bound either
      query: {
        provider: "tpdb",
        kind: "movie",
        performer: CANON_PERFORMER_ID,
        releaseDate: bound,
      },
      match: /release-date/,
    },
    {
      // Invalid values a typed caller cannot express; these prove the
      // runtime guard an untyped caller would hit.
      query: {
        provider: "tpdb",
        kind: "movie",
        releaseDate: { cutoff: "2026-09-11", operation: "lte" },
      } as Record<string, unknown> as CatalogSearchQuery,
      match: /operation of </,
    },
    {
      query: {
        provider: "tpdb",
        kind: "scene",
        releaseDate: { cutoff: "2026-02-30", operation: "<=" },
      } as CatalogSearchQuery,
      match: /ISO cutoff date/,
    },
    {
      query: {
        provider: "tpdb",
        kind: "movie",
        releaseDate: "2026-09-11",
      } as Record<string, unknown> as CatalogSearchQuery,
      match: /ISO cutoff date/,
    },
  ];
  for (const { query, match } of cases) {
    await assert.rejects(searchCatalog(query), (err: unknown) => {
      assertProviderError(err, 400, "invalid_search");
      assert.match(err instanceof AppError ? err.message : "", match);
      return true;
    });
  }
});
