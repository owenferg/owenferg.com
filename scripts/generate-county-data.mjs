import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { csvParse } from "d3-dsv";
import * as shapefile from "shapefile";
import { topology as makeTopology } from "topojson-server";

const ROOT = new URL("../", import.meta.url);
const OUTPUT_DIRECTORY = new URL("src/data/", ROOT);

const SOURCES = {
  population:
    "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv",
  income:
    "https://www2.census.gov/programs-surveys/saipe/datasets/2024/2024-state-and-county/est24all.txt",
  geometry:
    "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip",
};

const EXCLUDED_STATE_FIPS = new Set(["60", "66", "69", "72", "78"]);
const EXPECTED_COUNTY_COUNT = 3_144;
const EXPECTED_STATE_COUNT = 51;
const SQUARE_METERS_PER_SQUARE_MILE = 2_589_988.110336;
const KNOWN_NULL_INCOME_FIPS = new Set(["15005"]);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "owenferg-census-"));

try {
  const [populationCsv, incomeText, geometryZip] = await Promise.all([
    downloadText(SOURCES.population),
    downloadText(SOURCES.income),
    downloadBuffer(SOURCES.geometry),
  ]);

  const populationByFips = parsePopulation(populationCsv);
  const incomeByFips = parseIncome(incomeText);
  const countyFeatures = await parseGeometry(geometryZip, temporaryDirectory);

  validateSourceCoverage(countyFeatures, populationByFips, incomeByFips);

  const countyStats = buildCountyStats(countyFeatures, populationByFips, incomeByFips);
  const countyTopology = buildCountyTopology(countyFeatures);
  validateOutputs(countyTopology, countyStats);

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const topologyUrl = new URL("county-topology.json", OUTPUT_DIRECTORY);
  const statisticsUrl = new URL("county-statistics.json", OUTPUT_DIRECTORY);

  await Promise.all([
    writeJson(topologyUrl, countyTopology),
    writeJson(statisticsUrl, countyStats),
  ]);

  const topologyBytes = Buffer.byteLength(JSON.stringify(countyTopology));
  const statisticsBytes = Buffer.byteLength(JSON.stringify(countyStats));
  console.log(
    `wrote ${EXPECTED_COUNTY_COUNT.toLocaleString()} counties (${formatBytes(topologyBytes)} topology, ${formatBytes(statisticsBytes)} statistics)`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function downloadText(url) {
  return (await download(url)).text();
}

async function downloadBuffer(url) {
  return Buffer.from(await (await download(url)).arrayBuffer());
}

async function download(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "owenferg.com census data builder" },
  });
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return response;
}

function parsePopulation(csv) {
  const records = new Map();

  for (const row of csvParse(csv)) {
    if (row.SUMLEV !== "050" || EXCLUDED_STATE_FIPS.has(row.STATE)) continue;

    const fips = `${row.STATE}${row.COUNTY}`;
    assertNewFips(records, fips, "population");
    const population2020 = parseRequiredInteger(row.POPESTIMATE2020, `${fips} population 2020`);
    const population2024 = parseRequiredInteger(row.POPESTIMATE2024, `${fips} population 2024`);
    records.set(fips, {
      population2020,
      population2024,
      name: row.CTYNAME,
      state: row.STNAME,
    });
  }

  return records;
}

function parseIncome(text) {
  const records = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (line.length < 241) continue;

    const stateFips = line.slice(0, 2);
    const countyFips = line.slice(3, 6).trim().padStart(3, "0");
    if (countyFips === "000" || EXCLUDED_STATE_FIPS.has(stateFips)) continue;

    const fips = `${stateFips}${countyFips}`;
    assertNewFips(records, fips, "income");
    const rawIncome = line.slice(133, 139).trim();
    records.set(fips, {
      income: rawIncome === "." ? null : parseRequiredInteger(rawIncome, `${fips} income`),
      name: line.slice(193, 238).trim(),
      state: line.slice(239, 241),
    });
  }

  return records;
}

async function parseGeometry(zipBuffer, directory) {
  const archive = new AdmZip(zipBuffer);
  archive.extractAllTo(directory, true);

  const shapeEntry = archive.getEntries().find((entry) => entry.entryName.endsWith(".shp"));
  if (!shapeEntry) throw new Error("county archive does not contain a .shp file");

  const baseName = basename(shapeEntry.entryName, ".shp");
  const shape = await readFile(join(directory, `${baseName}.shp`));
  const database = await readFile(join(directory, `${baseName}.dbf`));
  const collection = await shapefile.read(shape, database, { encoding: "utf-8" });

  return collection.features
    .filter((county) => !EXCLUDED_STATE_FIPS.has(county.properties.STATEFP))
    .map((county) => {
      const fips = county.properties.GEOID;
      if (!/^\d{5}$/.test(fips)) throw new Error(`invalid geometry FIPS: ${fips}`);
      return {
        type: "Feature",
        id: fips,
        properties: {
          fips,
          name: county.properties.NAMELSAD,
          state: county.properties.STUSPS,
          stateName: county.properties.STATE_NAME,
          landAreaSquareMeters: Number(county.properties.ALAND),
        },
        geometry: county.geometry,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function validateSourceCoverage(features, populationByFips, incomeByFips) {
  assertUniqueFips(features.map((county) => county.id), "geometry");
  assertUniqueFips(populationByFips.keys(), "population");
  assertUniqueFips(incomeByFips.keys(), "income");

  if (features.length !== EXPECTED_COUNTY_COUNT) {
    throw new Error(`expected ${EXPECTED_COUNTY_COUNT} geometries, found ${features.length}`);
  }

  const geometryFips = new Set(features.map((county) => county.id));
  assertMatchingFips(geometryFips, populationByFips, "population");
  assertMatchingFips(geometryFips, incomeByFips, "income");

  const states = new Set(features.map((county) => county.properties.state));
  if (states.size !== EXPECTED_STATE_COUNT || !states.has("DC")) {
    throw new Error(`expected 50 states and DC, found ${states.size} state abbreviations`);
  }

  const nullIncomeFips = new Set(
    [...incomeByFips].filter(([, record]) => record.income === null).map(([fips]) => fips),
  );
  assertMatchingFips(KNOWN_NULL_INCOME_FIPS, nullIncomeFips, "documented null income");
}

function buildCountyStats(features, populationByFips, incomeByFips) {
  const counties = {};

  for (const county of features) {
    const { fips, landAreaSquareMeters } = county.properties;
    const population = populationByFips.get(fips);
    const income = incomeByFips.get(fips);
    if (!population || !income) throw new Error(`missing joined data for ${fips}`);

    if (landAreaSquareMeters <= 0) throw new Error(`invalid land area for ${fips}`);
    if (population.population2020 <= 0 || population.population2024 <= 0) {
      throw new Error(`invalid population for ${fips}`);
    }

    const growth =
      ((population.population2024 - population.population2020) / population.population2020) * 100;
    const landAreaSquareMiles = landAreaSquareMeters / SQUARE_METERS_PER_SQUARE_MILE;

    counties[fips] = {
      fips,
      name: county.properties.name,
      state: county.properties.state,
      population: population.population2024,
      growthPct: round(growth, 2),
      densityPerSqMi: round(population.population2024 / landAreaSquareMiles, 3),
      medianHouseholdIncome: income.income,
    };
  }

  return {
    vintage: 2024,
    countyCount: EXPECTED_COUNTY_COUNT,
    fields: {
      population: "July 1, 2024 resident population estimate",
      growthPct: "percent change from July 1, 2020 to July 1, 2024",
      densityPerSqMi: "July 1, 2024 residents per square mile of 2024 land area",
      medianHouseholdIncome: "2024 SAIPE median household income in dollars",
    },
    sources: SOURCES,
    counties,
  };
}

function buildCountyTopology(features) {
  // properties stay tiny because every statistic lives in the parallel FIPS lookup
  const compactFeatures = features.map((county) => ({
    type: "Feature",
    id: county.id,
    properties: {
      GEOID: county.id,
      NAME: county.properties.name,
      STUSPS: county.properties.state,
    },
    geometry: county.geometry,
  }));

  // 100k quantization keeps county edges crisp without shipping raw coordinates
  return makeTopology(
    {
      counties: {
        type: "FeatureCollection",
        features: compactFeatures,
      },
    },
    100_000,
  );
}

function validateOutputs(countyTopology, countyStats) {
  const geometries = countyTopology.objects.counties.geometries;
  if (geometries.length !== EXPECTED_COUNTY_COUNT) {
    throw new Error(`topology contains ${geometries.length} county geometries`);
  }
  if (Object.keys(countyStats.counties).length !== EXPECTED_COUNTY_COUNT) {
    throw new Error("statistics output lost county records");
  }

  for (const [fips, values] of Object.entries(countyStats.counties)) {
    if (!Number.isInteger(values.population) || values.population <= 0) {
      throw new Error(`invalid generated population for ${fips}`);
    }
    if (
      !Number.isFinite(values.growthPct) ||
      !Number.isFinite(values.densityPerSqMi) ||
      values.densityPerSqMi <= 0
    ) {
      throw new Error(`invalid generated rate for ${fips}`);
    }
    if (
      values.medianHouseholdIncome !== null &&
      (!Number.isInteger(values.medianHouseholdIncome) || values.medianHouseholdIncome <= 0)
    ) {
      throw new Error(`invalid generated income for ${fips}`);
    }
  }
}

function assertUniqueFips(fipsValues, label) {
  const values = [...fipsValues];
  const unique = new Set(values);
  if (values.length !== unique.size) throw new Error(`${label} contains duplicate FIPS codes`);
}

function assertNewFips(records, fips, label) {
  if (!/^\d{5}$/.test(fips)) throw new Error(`invalid ${label} FIPS: ${fips}`);
  if (records.has(fips)) throw new Error(`${label} contains duplicate FIPS ${fips}`);
}

function assertMatchingFips(expected, actual, label) {
  const missing = [...expected].filter((fips) => !actual.has(fips));
  const extra = [...actual.keys()].filter((fips) => !expected.has(fips));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} FIPS mismatch: ${missing.length} missing (${missing.slice(0, 5)}), ${extra.length} extra (${extra.slice(0, 5)})`,
    );
  }
}

function parseRequiredInteger(rawValue, label) {
  if (!/^-?\d+$/.test(rawValue)) throw new Error(`invalid ${label}: ${rawValue}`);
  return Number.parseInt(rawValue, 10);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function writeJson(url, value) {
  await writeFile(url, `${JSON.stringify(value)}\n`);
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
