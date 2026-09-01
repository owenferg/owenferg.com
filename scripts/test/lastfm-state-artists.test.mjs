import assert from "node:assert/strict";
import test from "node:test";
import {
  STATE_NAMES,
  buildAggregate,
  createMusicbrainzClient,
  fetchLastfmLibrary,
  fetchWithRetry,
  parseLastfmPage,
  parseOverrides,
  reconcileCachedResolution,
  resolveAreaState,
  resolveArtistState,
  selectExactSearchMatch,
  stateCodeFromArea,
  unwrapResolutionCache,
  validateAggregate,
} from "../lastfm-state-artists.mjs";

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function lastfmPayload(page, totalPages, artists) {
  return {
    topartists: {
      "@attr": { page: String(page), totalPages: String(totalPages) },
      artist: artists.map((artist) => ({ mbid: "", url: `https://last.fm/${artist.name}`, ...artist })),
    },
  };
}

test("parses Last.fm pagination and rejects API errors", () => {
  const parsed = parseLastfmPage(lastfmPayload(1, 2, [{ name: "Artist", playcount: "12" }]));
  assert.equal(parsed.totalPages, 2);
  assert.deepEqual(parsed.artists[0], {
    name: "Artist",
    playcount: 12,
    url: "https://last.fm/Artist",
    mbid: null,
  });
  assert.throws(() => parseLastfmPage({ error: 10, message: "Invalid API key" }), /Last.fm 10/);
});

test("fetches every overall page and deduplicates artists", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return jsonResponse(
      page === 1
        ? lastfmPayload(1, 2, [
            { name: "A", playcount: "4", mbid: "a" },
            { name: "No MBID", playcount: "2" },
          ])
        : lastfmPayload(2, 2, [
            { name: "B", playcount: "3", mbid: "b" },
            { name: " no  mbid ", playcount: "1" },
          ]),
    );
  };
  const artists = await fetchLastfmLibrary({ apiKey: "test", username: "Fergo555", fetchImpl });
  assert.equal(requested.length, 2);
  assert.equal(new URL(requested[0]).searchParams.get("period"), "overall");
  assert.equal(new URL(requested[0]).searchParams.get("limit"), "1000");
  assert.deepEqual(artists.map(({ name }) => name), ["A", "B", "No MBID"]);
});

test("retries transient responses using Retry-After", async () => {
  let calls = 0;
  const sleeps = [];
  const response = await fetchWithRetry("https://example.test", {
    label: "fixture",
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({}, { status: 429, headers: { "retry-after": "0.25" } })
        : jsonResponse({ ok: true });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
});

test("accepts only one strong exact MusicBrainz search result", () => {
  assert.equal(
    selectExactSearchMatch({ artists: [{ id: "1", name: "The Artist", score: 100 }] }, "the artist").id,
    "1",
  );
  assert.equal(
    selectExactSearchMatch(
      { artists: [{ id: "1", name: "Artist", score: 100 }, { id: "2", name: "Artist", score: 99 }] },
      "Artist",
    ),
    null,
  );
  assert.equal(selectExactSearchMatch({ artists: [{ id: "1", name: "Artist", score: 94 }] }, "Artist"), null);
});

test("resolves state codes directly and through parent part-of relations", async () => {
  assert.equal(stateCodeFromArea({ "iso-3166-2-codes": ["US-DC"] }), "DC");
  const areas = new Map([
    ["city", { id: "city", relations: [{ type: "part of", direction: "backward", area: { id: "state" } }] }],
    ["state", { id: "state", "iso-3166-2-codes": ["US-WA"] }],
  ]);
  assert.equal(
    await resolveAreaState({ id: "city" }, { getArea: async (id) => areas.get(id) }),
    "WA",
  );
});

test("follows one parent chain without expanding a country's children", async () => {
  const calls = [];
  const areas = new Map([
    [
      "aberdeen",
      {
        id: "aberdeen",
        name: "Aberdeen",
        relations: [{ type: "part of", direction: "backward", area: { id: "county", name: "Grays Harbor County" } }],
      },
    ],
    [
      "county",
      {
        id: "county",
        relations: [
          { type: "part of", direction: "backward", area: { id: "washington", name: "Washington" } },
          { type: "part of", direction: "forward", area: { id: "child-city", name: "Aberdeen" } },
        ],
      },
    ],
    ["washington", { id: "washington", "iso-3166-2-codes": ["US-WA"] }],
  ]);
  const state = await resolveAreaState(
    { id: "aberdeen", name: "Aberdeen" },
    {
      getArea: async (id) => {
        calls.push(id);
        return areas.get(id);
      },
    },
  );
  assert.equal(state, "WA");
  assert.deepEqual(calls, ["aberdeen", "county", "washington"]);

  const broadCalls = [];
  const broad = await resolveAreaState(
    { id: "bromley", name: "Bromley" },
    {
      getArea: async (id) => {
        broadCalls.push(id);
        if (id === "bromley") {
          return {
            id,
            relations: [
              { type: "part of", direction: "backward", area: { id: "london" } },
              ...Array.from({ length: 100 }, (_, index) => ({
                type: "part of",
                direction: "forward",
                area: { id: `child-${index}` },
              })),
            ],
          };
        }
        if (id === "london") {
          return { id, relations: [{ type: "part of", direction: "backward", area: { id: "england" } }] };
        }
        if (id === "england") {
          return { id, relations: [{ type: "part of", direction: "backward", area: { id: "uk" } }] };
        }
        return { id, relations: [] };
      },
    },
  );
  assert.equal(broad, null);
  assert.deepEqual(broadCalls, ["bromley", "london", "england", "uk"]);
});

test("stops ambiguous and overlong parent chains", async () => {
  let calls = 0;
  const ambiguous = await resolveAreaState(
    { id: "overlap" },
    {
      getArea: async () => ({
        id: "overlap",
        relations: [
          { type: "part of", direction: "backward", area: { id: "parent-a" } },
          { type: "part of", direction: "backward", area: { id: "parent-b" } },
        ],
      }),
    },
  );
  assert.equal(ambiguous, null);

  await resolveAreaState(
    { id: "area-0" },
    {
      getArea: async (id) => {
        calls += 1;
        const index = Number(id.slice("area-".length));
        return {
          id,
          relations: [{ type: "part of", direction: "backward", area: { id: `area-${index + 1}` } }],
        };
      },
    },
  );
  assert.equal(calls, 6);
});

test("prefers overrides then begin area and classifies unknown origins", async () => {
  const overrides = parseOverrides({ stateByName: { "Forced Artist": "OR" } });
  const never = async () => assert.fail("MusicBrainz should not be called");
  assert.deepEqual(
    await resolveArtistState(
      { name: "Forced Artist", mbid: null },
      { overrides, musicbrainz: { searchArtist: never, getArtist: never, getArea: never } },
    ),
    { status: "mapped", state: "OR", method: "override" },
  );

  const emptyOverrides = parseOverrides({});
  const mapped = await resolveArtistState(
    { name: "Artist", mbid: "artist-id" },
    {
      overrides: emptyOverrides,
      musicbrainz: {
        getArtist: async () => ({ "begin-area": { id: "dc", "iso-3166-2-codes": ["US-DC"] } }),
        getArea: never,
      },
    },
  );
  assert.deepEqual(mapped, { status: "mapped", state: "DC", method: "begin-area" });

  const unknown = await resolveArtistState(
    { name: "Unknown", mbid: "unknown-id" },
    { overrides: emptyOverrides, musicbrainz: { getArtist: async () => ({}), getArea: never } },
  );
  assert.deepEqual(unknown, { status: "unresolved", reason: "unknown-origin" });
});

test("reconciles override edits per artist without invalidating ordinary resolutions", () => {
  const artist = { name: "Target Artist", mbid: "target-mbid" };
  const ordinary = { status: "mapped", state: "WA", method: "begin-area" };
  const unrelatedEdit = parseOverrides({ stateByName: { "Somebody Else": "CA" } });
  assert.equal(reconcileCachedResolution(artist, unrelatedEdit, ordinary), ordinary);

  const added = reconcileCachedResolution(
    artist,
    parseOverrides({ stateByMbid: { "target-mbid": "OR" } }),
    ordinary,
  );
  assert.deepEqual(added, { status: "mapped", state: "OR", method: "override" });

  const changed = reconcileCachedResolution(
    artist,
    parseOverrides({ stateByName: { "Target Artist": "ID" } }),
    { status: "mapped", state: "OR", method: "override" },
  );
  assert.deepEqual(changed, { status: "mapped", state: "ID", method: "override" });

  const excluded = reconcileCachedResolution(
    artist,
    parseOverrides({ excludeName: ["target artist"] }),
    ordinary,
  );
  assert.deepEqual(excluded, { status: "excluded", reason: "override-name" });

  assert.equal(
    reconcileCachedResolution(
      artist,
      parseOverrides({}),
      { status: "mapped", state: "OR", method: "override" },
    ),
    null,
  );
  assert.equal(
    reconcileCachedResolution(
      artist,
      parseOverrides({}),
      { status: "excluded", reason: "override-mbid" },
    ),
    null,
  );
});

test("accepts raw and fingerprinted resolution cache shapes", () => {
  const resolutions = { "mbid:one": { status: "mapped", state: "WA", method: "area" } };
  assert.equal(unwrapResolutionCache(resolutions), resolutions);
  assert.equal(
    unwrapResolutionCache({ overridesFingerprint: "old-fingerprint", resolutions }),
    resolutions,
  );
});

test("MusicBrainz client caches identical responses", async () => {
  const values = new Map();
  let requests = 0;
  const client = createMusicbrainzClient({
    cache: {
      get: (key) => values.get(key),
      set: async (key, value) => values.set(key, value),
    },
    minIntervalMs: 0,
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({ id: "artist" });
    },
  });
  await client.getArtist("artist");
  await client.getArtist("artist");
  assert.equal(requests, 1);
});

test("builds and validates a deterministic 51-state aggregate", () => {
  const artists = [
    { name: "Second", mbid: "2", playcount: 2, url: "https://last.fm/second" },
    { name: "First", mbid: "1", playcount: 5, url: "https://last.fm/first" },
    { name: "Unknown", mbid: "3", playcount: 1, url: "https://last.fm/unknown" },
  ];
  const resolutions = new Map([
    ["mbid:1", { status: "mapped", state: "CA", method: "area" }],
    ["mbid:2", { status: "mapped", state: "CA", method: "area" }],
    ["mbid:3", { status: "unresolved", reason: "unknown-origin" }],
  ]);
  const result = buildAggregate({ username: "Fergo555", generatedAt: "2026-01-01T00:00:00.000Z", artists, resolutions });
  assert.equal(Object.keys(result.states).length, Object.keys(STATE_NAMES).length);
  assert.equal(result.states.CA.artistCount, 2);
  assert.equal(result.states.CA.scrobbleCount, 7);
  assert.deepEqual(result.states.CA.topArtists.map(({ name }) => name), ["First", "Second"]);
  assert.equal(result.states.DC.artistCount, 0);
  validateAggregate(result);
});

test("validation rejects inconsistent aggregate totals", () => {
  const states = Object.fromEntries(
    Object.entries(STATE_NAMES).map(([code, name]) => [code, { name, artistCount: 0, scrobbleCount: 0, topArtists: [] }]),
  );
  const invalid = {
    schemaVersion: 1,
    period: "overall",
    totals: { libraryArtistCount: 1, mappedArtistCount: 0, excludedArtistCount: 0, unresolvedArtistCount: 0, mappedScrobbleCount: 0 },
    states,
  };
  assert.throws(() => validateAggregate(invalid), /classifications do not add up/);
});
