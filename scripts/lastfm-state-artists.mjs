import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STATE_NAMES = Object.freeze({
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
});

const LASTFM_ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
const MUSICBRAINZ_ENDPOINT = "https://musicbrainz.org/ws/2";
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function normalizeArtistName(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function parseLastfmPage(payload) {
  if (payload?.error) throw new Error(`Last.fm ${payload.error}: ${payload.message ?? "unknown error"}`);
  const container = payload?.topartists;
  if (!container || !Array.isArray(container.artist)) throw new Error("invalid Last.fm top artists response");

  const totalPages = Number.parseInt(container["@attr"]?.totalPages ?? "", 10);
  const page = Number.parseInt(container["@attr"]?.page ?? "", 10);
  if (!Number.isSafeInteger(totalPages) || totalPages < 1 || !Number.isSafeInteger(page) || page < 1) {
    throw new Error("Last.fm response is missing valid pagination metadata");
  }

  return {
    page,
    totalPages,
    artists: container.artist.map((artist) => {
      const playcount = Number.parseInt(artist.playcount, 10);
      if (!artist.name || !Number.isSafeInteger(playcount) || playcount < 0 || !artist.url) {
        throw new Error("Last.fm returned an invalid artist record");
      }
      return { name: artist.name, playcount, url: artist.url, mbid: artist.mbid || null };
    }),
  };
}

export async function fetchLastfmLibrary({ apiKey, username, fetchImpl = fetch, pageSize = 1000 }) {
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");

  const artists = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const url = new URL(LASTFM_ENDPOINT);
    url.search = new URLSearchParams({
      method: "user.getTopArtists",
      user: username,
      api_key: apiKey,
      period: "overall",
      limit: String(pageSize),
      page: String(page),
      format: "json",
    }).toString();
    const response = await fetchWithRetry(url, { fetchImpl, label: `Last.fm page ${page}` });
    const parsed = parseLastfmPage(await response.json());
    if (parsed.page !== page) throw new Error(`Last.fm returned page ${parsed.page} for page ${page}`);
    totalPages = parsed.totalPages;
    artists.push(...parsed.artists);
  }

  // MBID wins when present, otherwise Last.fm's normalized display name is the stable key
  const unique = new Map();
  for (const artist of artists) {
    const key = artist.mbid ? `mbid:${artist.mbid}` : `name:${normalizeArtistName(artist.name)}`;
    const previous = unique.get(key);
    if (!previous || artist.playcount > previous.playcount) unique.set(key, artist);
  }
  return [...unique.values()].sort(compareArtists);
}

export function selectExactSearchMatch(payload, expectedName) {
  const expected = normalizeArtistName(expectedName);
  const matches = (payload?.artists ?? []).filter(
    (artist) => normalizeArtistName(artist.name ?? "") === expected && Number(artist.score) >= 95,
  );
  return matches.length === 1 && matches[0].id ? matches[0] : null;
}

export function stateCodeFromArea(area) {
  const codes = area?.["iso-3166-2-codes"] ?? [];
  const code = codes.find((candidate) => /^US-[A-Z]{2}$/.test(candidate));
  if (!code) return null;
  const state = code.slice(3);
  return Object.hasOwn(STATE_NAMES, state) ? state : null;
}

export async function resolveArtistState(artist, context) {
  const { overrides } = context;
  const explicitOverride = resolveArtistOverride(artist, overrides);
  if (explicitOverride) return explicitOverride;

  let mbid = artist.mbid;
  if (!mbid) {
    const search = await context.musicbrainz.searchArtist(artist.name);
    const exact = selectExactSearchMatch(search, artist.name);
    if (!exact) return unresolved("no-unique-exact-match");
    mbid = exact.id;
  }

  const entity = await context.musicbrainz.getArtist(mbid);
  for (const candidate of [entity["begin-area"], entity.area]) {
    const state = await resolveAreaState(candidate, context.musicbrainz);
    if (state) return mapped(state, candidate === entity["begin-area"] ? "begin-area" : "area");
  }

  const countryCodes = [entity["begin-area"], entity.area].flatMap(
    (area) => area?.["iso-3166-1-codes"] ?? [],
  );
  if (countryCodes.includes("US")) return unresolved("us-area-without-state");
  return countryCodes.length > 0 ? excluded("non-us-origin") : unresolved("unknown-origin");
}

export function resolveArtistOverride(artist, overrides) {
  if (artist.mbid && overrides.excludeMbid.has(artist.mbid)) return excluded("override-mbid");
  const normalizedName = normalizeArtistName(artist.name);
  if (overrides.excludeName.has(normalizedName)) return excluded("override-name");

  const forced =
    (artist.mbid && overrides.stateByMbid.get(artist.mbid)) ??
    overrides.stateByName.get(normalizedName);
  return forced ? mapped(forced, "override") : null;
}

export function reconcileCachedResolution(artist, overrides, cachedResolution) {
  const explicitOverride = resolveArtistOverride(artist, overrides);
  if (explicitOverride) return explicitOverride;
  if (!cachedResolution) return null;

  // removed overrides need fresh enrichment while unrelated cached work survives
  const overrideDerived =
    cachedResolution.method === "override" ||
    cachedResolution.reason === "override-mbid" ||
    cachedResolution.reason === "override-name";
  return overrideDerived ? null : cachedResolution;
}

export function unwrapResolutionCache(payload) {
  return payload?.resolutions ?? payload ?? {};
}

export async function resolveAreaState(initialArea, musicbrainz) {
  if (!initialArea?.id) return null;
  const seen = new Set();
  let area = initialArea;

  // six lookups covers city -> county -> state with room for less direct hierarchies
  for (let depth = 0; depth < 6; depth += 1) {
    if (!area?.id || seen.has(area.id)) return null;
    seen.add(area.id);

    const direct = stateCodeFromArea(area);
    if (direct) return direct;

    const detailed = await musicbrainz.getArea(area.id);
    const detailedState = stateCodeFromArea(detailed);
    if (detailedState) return detailedState;

    // only one backward relation is an unambiguous geographic parent
    const parents = (detailed.relations ?? []).filter(
      (relation) => relation.type === "part of" && relation.direction === "backward" && relation.area,
    );
    if (parents.length !== 1) return null;
    area = parents[0].area;
  }
  return null;
}

export function createMusicbrainzClient({
  cache,
  fetchImpl = fetch,
  sleep = defaultSleep,
  minIntervalMs = 1100,
  userAgent = "owenferg.com Last.fm map (https://owenferg.com)",
}) {
  let lastRequestAt = 0;

  async function request(path, searchParams = {}) {
    const url = new URL(`${MUSICBRAINZ_ENDPOINT}/${path}`);
    url.search = new URLSearchParams({ ...searchParams, fmt: "json" }).toString();
    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // MusicBrainz asks clients to stay at roughly one request per second
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRequestAt));
    if (waitMs) await sleep(waitMs);
    lastRequestAt = Date.now();

    const response = await fetchWithRetry(url, {
      fetchImpl,
      sleep,
      label: `MusicBrainz ${path}`,
      headers: { "user-agent": userAgent, accept: "application/json" },
    });
    const payload = await response.json();
    await cache.set(cacheKey, payload);
    return payload;
  }

  return {
    getArtist: (mbid) => request(`artist/${encodeURIComponent(mbid)}`, { inc: "area-rels" }),
    getArea: (mbid) => request(`area/${encodeURIComponent(mbid)}`, { inc: "area-rels" }),
    searchArtist: (name) => request("artist", { query: `artist:${quoteLucene(name)}`, limit: "5" }),
  };
}

export async function fetchWithRetry(
  url,
  { fetchImpl = fetch, sleep = defaultSleep, label = String(url), headers, attempts = 10 } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers });
      if (response.ok) return response;
      if (!TRANSIENT_STATUS.has(response.status)) {
        throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
      }
      lastError = new Error(`${label} failed transiently: ${response.status}`);
      if (attempt < attempts - 1) {
        const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
      }
    } catch (error) {
      if (error instanceof Error && /failed: \d/.test(error.message)) throw error;
      lastError = error;
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts`, { cause: lastError });
}

export function buildAggregate({ username, generatedAt, artists, resolutions }) {
  const byState = new Map(Object.keys(STATE_NAMES).map((state) => [state, []]));
  let mappedArtistCount = 0;
  let excludedArtistCount = 0;
  let unresolvedArtistCount = 0;

  for (const artist of artists) {
    const resolution = resolutions.get(artistKey(artist));
    if (!resolution) throw new Error(`missing resolution for ${artist.name}`);
    if (resolution.status === "mapped") {
      byState.get(resolution.state).push(artist);
      mappedArtistCount += 1;
    } else if (resolution.status === "excluded") {
      excludedArtistCount += 1;
    } else {
      unresolvedArtistCount += 1;
    }
  }

  const states = {};
  for (const [code, stateArtists] of byState) {
    const ranked = [...stateArtists].sort(compareArtists);
    states[code] = {
      name: STATE_NAMES[code],
      artistCount: ranked.length,
      scrobbleCount: ranked.reduce((sum, artist) => sum + artist.playcount, 0),
      topArtists: ranked.slice(0, 3).map(({ name, playcount, url }) => ({ name, playcount, url })),
    };
  }

  const aggregate = {
    schemaVersion: 1,
    generatedAt,
    username,
    period: "overall",
    sources: {
      lastfm: `https://www.last.fm/user/${encodeURIComponent(username)}/library/artists`,
      musicbrainz: "https://musicbrainz.org",
    },
    totals: {
      libraryArtistCount: artists.length,
      mappedArtistCount,
      excludedArtistCount,
      unresolvedArtistCount,
      mappedScrobbleCount: Object.values(states).reduce((sum, state) => sum + state.scrobbleCount, 0),
    },
    states,
  };
  validateAggregate(aggregate);
  return aggregate;
}

export function validateAggregate(aggregate) {
  if (aggregate.schemaVersion !== 1 || aggregate.period !== "overall") throw new Error("invalid aggregate metadata");
  const expected = Object.keys(STATE_NAMES);
  const actual = Object.keys(aggregate.states ?? {});
  if (actual.length !== 51 || expected.some((state) => !Object.hasOwn(aggregate.states, state))) {
    throw new Error("aggregate must contain 50 states and DC");
  }
  for (const code of expected) {
    const state = aggregate.states[code];
    if (state.name !== STATE_NAMES[code]) throw new Error(`invalid state name for ${code}`);
    for (const field of ["artistCount", "scrobbleCount"]) {
      if (!Number.isSafeInteger(state[field]) || state[field] < 0) throw new Error(`invalid ${field} for ${code}`);
    }
    if (!Array.isArray(state.topArtists) || state.topArtists.length > 3) throw new Error(`invalid top artists for ${code}`);
    if (state.artistCount < state.topArtists.length) throw new Error(`too many top artists for ${code}`);
    for (let index = 0; index < state.topArtists.length; index += 1) {
      const artist = state.topArtists[index];
      if (!artist.name || !artist.url || !Number.isSafeInteger(artist.playcount) || artist.playcount < 0) {
        throw new Error(`invalid top artist for ${code}`);
      }
      if (index > 0 && state.topArtists[index - 1].playcount < artist.playcount) {
        throw new Error(`top artists are not sorted for ${code}`);
      }
    }
  }
  const totals = aggregate.totals;
  if (totals.libraryArtistCount !== totals.mappedArtistCount + totals.excludedArtistCount + totals.unresolvedArtistCount) {
    throw new Error("artist classifications do not add up");
  }
  const artistCount = Object.values(aggregate.states).reduce((sum, state) => sum + state.artistCount, 0);
  const scrobbleCount = Object.values(aggregate.states).reduce((sum, state) => sum + state.scrobbleCount, 0);
  if (artistCount !== totals.mappedArtistCount || scrobbleCount !== totals.mappedScrobbleCount) {
    throw new Error("state aggregates do not match metadata totals");
  }
}

export function parseOverrides(payload) {
  const validState = (state, label) => {
    if (!Object.hasOwn(STATE_NAMES, state)) throw new Error(`invalid state ${state} in ${label}`);
    return state;
  };
  return {
    stateByMbid: new Map(Object.entries(payload.stateByMbid ?? {}).map(([key, state]) => [key, validState(state, "stateByMbid")])),
    stateByName: new Map(Object.entries(payload.stateByName ?? {}).map(([key, state]) => [normalizeArtistName(key), validState(state, "stateByName")])),
    excludeMbid: new Set(payload.excludeMbid ?? []),
    excludeName: new Set((payload.excludeName ?? []).map(normalizeArtistName)),
  };
}

export function createJsonCache(directory) {
  return {
    async read(name, fallback = null) {
      try {
        return JSON.parse(await readFile(join(directory, name), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return fallback;
        throw error;
      }
    },
    async write(name, value) {
      await atomicWriteJson(join(directory, name), value);
    },
    async createKeyValue(name) {
      const file = join(directory, name);
      const values = new Map(Object.entries((await this.read(name, {})) ?? {}));
      return {
        get: (key) => values.get(key),
        set: async (key, value) => {
          values.set(key, value);
          await atomicWriteJson(file, Object.fromEntries(values));
        },
      };
    },
  };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export function artistKey(artist) {
  return artist.mbid ? `mbid:${artist.mbid}` : `name:${normalizeArtistName(artist.name)}`;
}

function compareArtists(left, right) {
  return right.playcount - left.playcount || left.name.localeCompare(right.name);
}

function quoteLucene(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function mapped(state, method) {
  return { status: "mapped", state, method };
}

function excluded(reason) {
  return { status: "excluded", reason };
}

function unresolved(reason) {
  return { status: "unresolved", reason };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
