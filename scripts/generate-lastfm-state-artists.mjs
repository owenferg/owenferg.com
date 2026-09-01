import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  artistKey,
  atomicWriteJson,
  buildAggregate,
  createJsonCache,
  createMusicbrainzClient,
  fetchLastfmLibrary,
  parseOverrides,
  reconcileCachedResolution,
  resolveArtistState,
  unwrapResolutionCache,
} from "./lastfm-state-artists.mjs";

const ROOT = new URL("../", import.meta.url);
const CACHE_DIRECTORY = new URL(".cache/lastfm-state-artists/", ROOT);
const OUTPUT_URL = new URL("src/data/lastfm-state-artists.json", ROOT);
const OVERRIDES_URL = new URL("scripts/lastfm-artist-overrides.json", ROOT);
const USERNAME = "Fergo555";

const apiKey = process.env.LASTFM_API_KEY;
if (!apiKey) throw new Error("set LASTFM_API_KEY before running npm run data:lastfm");

const releaseRunLock = await acquireRunLock();
try {
  const cache = createJsonCache(fileURLToPath(CACHE_DIRECTORY));
  const artists = await fetchLastfmLibrary({ apiKey, username: USERNAME });
  await cache.write("lastfm-library.json", artists);

  const overrides = parseOverrides(JSON.parse(await readFile(OVERRIDES_URL, "utf8")));
  const responseCache = await cache.createKeyValue("musicbrainz-responses.json");
  const musicbrainz = createMusicbrainzClient({ cache: responseCache });
  const savedResolutionCache = await cache.read("artist-resolutions.json", {});
  // accept both the original raw map and the fingerprinted cache used by the live run
  const savedResolutions = unwrapResolutionCache(savedResolutionCache);
  const resolutions = new Map(Object.entries(savedResolutions));

  for (const [index, artist] of artists.entries()) {
    const key = artistKey(artist);
    const cachedResolution = resolutions.get(key);
    const reusableResolution = reconcileCachedResolution(artist, overrides, cachedResolution);
    if (reusableResolution) {
      if (!sameResolution(reusableResolution, cachedResolution)) {
        resolutions.set(key, reusableResolution);
        await writeResolutions(cache, resolutions);
      }
      continue;
    }

    let resolution;
    try {
      resolution = await resolveArtistState(artist, { overrides, musicbrainz });
    } catch (error) {
      // stale Last.fm MBIDs should not discard hours of otherwise valid enrichment
      if (error instanceof Error && /MusicBrainz .* failed: 404/.test(error.message)) {
        resolution = { status: "unresolved", reason: "musicbrainz-not-found" };
      } else {
        throw error;
      }
    }
    resolutions.set(key, resolution);
    await writeResolutions(cache, resolutions);
    console.log(`[${index + 1}/${artists.length}] ${artist.name}: ${describeResolution(resolution)}`);
  }

  const generatedAt = new Date().toISOString();
  const aggregate = buildAggregate({ username: USERNAME, generatedAt, artists, resolutions });
  const unresolved = artists
    .map((artist) => ({ artist, resolution: resolutions.get(artistKey(artist)) }))
    .filter(({ resolution }) => resolution.status === "unresolved");

  await Promise.all([
    atomicWriteJson(fileURLToPath(OUTPUT_URL), aggregate),
    cache.write("unresolved-report.json", { generatedAt, count: unresolved.length, artists: unresolved }),
  ]);

  console.log(
    `wrote ${aggregate.totals.mappedArtistCount} mapped artists across 50 states and DC; ` +
      `${aggregate.totals.unresolvedArtistCount} need review`,
  );
} finally {
  await releaseRunLock();
}

function describeResolution(resolution) {
  return resolution.status === "mapped" ? `${resolution.state} (${resolution.method})` : `${resolution.status} (${resolution.reason})`;
}

function sameResolution(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeResolutions(cache, resolutions) {
  return cache.write("artist-resolutions.json", { resolutions: Object.fromEntries(resolutions) });
}

async function acquireRunLock() {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  const lockPath = fileURLToPath(new URL(".generator.lock", CACHE_DIRECTORY));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => ({}));
      if (Number.isSafeInteger(lock.pid) && processExists(lock.pid)) {
        throw new Error(`another Last.fm generator is already running with PID ${lock.pid}`);
      }
      // interrupted runs can leave a stale lock behind
      await unlink(lockPath);
    }
  }
  throw new Error("could not acquire the Last.fm generator lock");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
