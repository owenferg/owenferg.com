import "./styles.css";

import countyStatisticsFile from "./data/county-statistics.json";
import countyTopologyFile from "./data/county-topology.json";
import domainCountiesFile from "./data/domain-counties.json";
import lastfmStateArtistsFile from "./data/lastfm-state-artists.json";
import {
  CountySvgRenderer,
  type CountyPointerDetails,
  type CountyTopology,
  type StatePointerDetails,
} from "./map/county-svg-renderer";

type MapMode = "personal" | "growth" | "music" | "income";
type StatisticMode = "growth" | "income";
type StatisticField = "growthPct" | "medianHouseholdIncome";

type CountyDatum = {
  fips: string;
  name: string;
  state: string;
  population: number;
  growthPct: number;
  densityPerSqMi: number;
  medianHouseholdIncome: number | null;
};

type CountyStatistics = {
  vintage: number;
  countyCount: number;
  counties: Record<string, CountyDatum>;
};

type TopArtist = {
  name: string;
  playcount: number;
  url: string;
};

type StateArtistDatum = {
  artistCount: number;
  scrobbleCount: number;
  topArtists: TopArtist[];
};

type LastfmStateArtists = {
  schemaVersion: number;
  generatedAt: string;
  username: string;
  period: string;
  sources: {
    lastfm: string;
    musicbrainz: string;
  };
  totals: {
    libraryArtistCount: number;
    mappedArtistCount: number;
    excludedArtistCount: number;
    unresolvedArtistCount: number;
    mappedScrobbleCount: number;
  };
  states: Record<string, StateArtistDatum>;
};

type StatisticDefinition = {
  mode: StatisticMode;
  title: string;
  field: StatisticField;
  thresholds: number[];
  colors: readonly [string, string, string, string, string];
  legendLabels: string[];
  sourceLabel: string;
  sourceHref: string;
  ariaLabel: string;
  formatValue: (value: number) => string;
};

const PERSONAL_FILL = "#000000";
const PERSONAL_SELECTED_FILL = "#e10600";
const NO_DATA_FILL = "#191919";
const NO_ARTISTS_FILL = "#111111";
const MUSIC_COLORS = [
  "#3f1c50",
  "#5e2a6d",
  "#833f81",
  "#af649c",
  "#e29dcc",
] as const;
const MAP_FADE_HALF_MS = 150;

const statistics = countyStatisticsFile as CountyStatistics;
const counties = statistics.counties;
const lastfmStateArtists = lastfmStateArtistsFile as LastfmStateArtists;
const stateArtists = lastfmStateArtists.states;
const selectedFips = (domainCountiesFile as unknown[]).map((fips) =>
  String(fips).padStart(5, "0"),
);
const personalSelectedFills = new Map(
  selectedFips.map((fips) => [fips, randomRedShade()]),
);
const incomeThresholds = quantileThresholds(
  Object.values(counties).flatMap((county) =>
    county.medianHouseholdIncome === null ? [] : [county.medianHouseholdIncome],
  ),
);
const musicThresholds = quantileThresholds(
  Object.values(stateArtists).flatMap((state) =>
    state.artistCount > 0 ? [state.artistCount] : [],
  ),
);
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const definitions: Record<StatisticMode, StatisticDefinition> = {
  growth: {
    mode: "growth",
    title: "population change, 2020–2024",
    field: "growthPct",
    thresholds: [-5, -1, 1, 5],
    colors: ["#4c216d", "#76518e", "#c9bdb0", "#d1ad3b", "#f2d95c"],
    legendLabels: ["< −5%", "−5 to −1%", "−1 to 1%", "1 to 5%", "≥ 5%"],
    sourceLabel: "Census Population Estimates Program, 2024",
    sourceHref:
      "https://www.census.gov/data/tables/time-series/demo/popest/2020s-counties-total.html",
    ariaLabel: "County population change in the United States from 2020 to 2024",
    formatValue: formatGrowth,
  },
  income: {
    mode: "income",
    title: "median household income, 2024",
    field: "medianHouseholdIncome",
    thresholds: incomeThresholds,
    colors: ["#431b33", "#7a3049", "#af5159", "#d77b63", "#efb878"],
    legendLabels: buildIncomeLegend(incomeThresholds),
    sourceLabel: "Census SAIPE, 2024",
    sourceHref: "https://www.census.gov/data/datasets/2024/demo/saipe/2024-state-and-county.html",
    ariaLabel: "Median household income by county in the United States in 2024",
    formatValue: formatIncome,
  },
};

const modes: MapMode[] = ["personal", "growth", "music", "income"];
const modeFills = new Map<StatisticMode, Map<string, string>>();
let activeIndex = 0;
let transitionTimer: number | undefined;
let touchTooltipPinned = false;

const stage = requireElement("#map-stage");
const mapFrame = requireElement(".map-frame");
const previousButton = requireButton("#map-previous");
const nextButton = requireButton("#map-next");
const titleElement = requireElement("#map-title");
const legendElement = requireElement("#map-legend");
const sourceLineElement = requireElement("[data-map-source-line]");
const sourceElement = requireAnchor("#map-source");
const sourceSecondaryContainer = requireElement("[data-map-source-secondary]");
const sourceSecondaryElement = requireAnchor("#map-source-secondary");
const tooltip = requireElement("#map-tooltip");
const tooltipName = requireElement(".county-hover-name");
const tooltipValue = requireElement(".county-hover-value");
const tooltipArtists = requireElement(".county-hover-artists");
const legendSwatches = requireElements<HTMLElement>("[data-legend-swatch]");
const legendLabels = requireElements<HTMLElement>("[data-legend-label]");
const legendSteps = requireElements<HTMLElement>(".map-legend-step");

const renderer = new CountySvgRenderer(stage, {
  topology: countyTopologyFile as unknown as CountyTopology,
  selectedFips,
  defaultFill: PERSONAL_FILL,
  selectedFill: PERSONAL_SELECTED_FILL,
  selectedFills: personalSelectedFills,
  lineColor: "#2a2a2a",
  ariaLabel: "A county map of the United States spelling owenferg.com",
  onCountyEnter: handleCountyEnter,
  onCountyMove: handleCountyMove,
  onCountyLeave: handleCountyLeave,
  onCountyTap: handleCountyTap,
  onStateEnter: handleStateEnter,
  onStateMove: handleStateMove,
  onStateLeave: handleStateLeave,
  onStateTap: handleStateTap,
});
renderer.svg.setAttribute("aria-describedby", "map-description");

previousButton.addEventListener("click", () => selectRelativeMode(-1));
nextButton.addEventListener("click", () => selectRelativeMode(1));
document.addEventListener("pointerdown", (event) => {
  if (touchTooltipPinned && !stage.contains(event.target as Node)) hideTooltip();
});

applyMode("personal");
initializeProjectReveals();

function selectRelativeMode(direction: -1 | 1): void {
  activeIndex = (activeIndex + direction + modes.length) % modes.length;
  const mode = modes[activeIndex];
  hideTooltip();

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    applyMode(mode);
    return;
  }

  window.clearTimeout(transitionTimer);
  mapFrame.classList.add("is-switching");
  transitionTimer = window.setTimeout(() => {
    applyMode(mode);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => mapFrame.classList.remove("is-switching"));
    });
  }, MAP_FADE_HALF_MS);
}

function applyMode(mode: MapMode): void {
  const personal = mode === "personal";
  stage.dataset.mapLayout = personal ? "personal" : "statistics";

  if (personal) {
    titleElement.textContent = "owenferg.com";
    delete document.documentElement.dataset.mapTheme;
    renderer.svg.setAttribute(
      "aria-label",
      "A county map of the United States spelling owenferg.com",
    );
    renderer.setLayout("personal");
    renderer.setGeography("county");
    renderer.setFills(new Map(), PERSONAL_FILL);
    legendElement.classList.add("map-legend--personal-hidden");
    legendElement.setAttribute("aria-hidden", "true");
    updateLegend(
      [PERSONAL_SELECTED_FILL, PERSONAL_FILL],
      ["my domain name", "not my domain name"],
    );
    sourceLineElement.hidden = false;
    sourceLineElement.classList.add("is-placeholder");
    sourceLineElement.setAttribute("aria-hidden", "true");
    sourceSecondaryContainer.hidden = true;
    return;
  }

  if (mode === "music") {
    titleElement.textContent = "music artists I listen to by state";
    document.documentElement.dataset.mapTheme = "music";
    renderer.svg.setAttribute(
      "aria-label",
      "Distinct artists in Fergo555's Last.fm library by United States state",
    );
    renderer.setLayout("statistics");
    renderer.setGeography("state");
    renderer.setFills(getMusicFills(), NO_ARTISTS_FILL);
    legendElement.classList.remove("map-legend--personal-hidden");
    legendElement.removeAttribute("aria-hidden");
    updateLegend(
      [NO_ARTISTS_FILL, ...MUSIC_COLORS],
      ["0 artists", "lowest 20%", "20–40%", "40–60%", "60–80%", "highest 20%"],
    );
    sourceLineElement.hidden = false;
    sourceLineElement.classList.remove("is-placeholder");
    sourceLineElement.removeAttribute("aria-hidden");
    sourceElement.textContent = "Fergo555 on Last.fm";
    sourceElement.href = "https://www.last.fm/user/Fergo555";
    sourceSecondaryElement.textContent = "MusicBrainz";
    sourceSecondaryElement.href = "https://musicbrainz.org/";
    sourceSecondaryContainer.hidden = false;
    return;
  }

  const definition = definitions[mode];
  titleElement.textContent = definition.title;
  document.documentElement.dataset.mapTheme = mode;
  renderer.svg.setAttribute("aria-label", definition.ariaLabel);
  renderer.setLayout("statistics");
  renderer.setGeography("county");
  renderer.setFills(getModeFills(definition), NO_DATA_FILL);
  legendElement.classList.remove("map-legend--personal-hidden");
  legendElement.removeAttribute("aria-hidden");
  updateLegend(definition.colors, definition.legendLabels);
  sourceLineElement.hidden = false;
  sourceLineElement.classList.remove("is-placeholder");
  sourceLineElement.removeAttribute("aria-hidden");
  sourceElement.textContent = definition.sourceLabel;
  sourceElement.href = definition.sourceHref;
  sourceSecondaryContainer.hidden = true;
}

function updateLegend(colors: readonly string[], labels: readonly string[]): void {
  legendElement.dataset.legendCount = String(colors.length);
  legendSteps.forEach((step, index) => {
    const swatch = legendSwatches[index];
    const label = legendLabels[index];
    const visible = index < colors.length;
    step.hidden = !visible;
    if (swatch) swatch.style.backgroundColor = colors[index] ?? "";
    if (label) label.textContent = labels[index] ?? "";
  });
}

function initializeProjectReveals(): void {
  const workItems = Array.from(
    document.querySelectorAll<HTMLElement>(".work-col > .heading, .project"),
  );
  if (workItems.length === 0 || !("IntersectionObserver" in window)) {
    return;
  }

  document.documentElement.classList.add("reveal-enabled");
  workItems.forEach((item) => item.classList.add("work-reveal-item", "reveal-pending"));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const item = entry.target as HTMLElement;
        item.classList.remove("reveal-pending");
        item.classList.add("is-revealed");
        observer.unobserve(item);
      });
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );

  let revealStarted = false;
  const beginReveal = (): void => {
    if (revealStarted) return;
    revealStarted = true;
    workItems.forEach((item) => observer.observe(item));
    window.removeEventListener("keydown", handleRevealKey);
  };

  const revealKeys = new Set(["ArrowDown", "PageDown", "End", " "]);
  function handleRevealKey(event: KeyboardEvent): void {
    if (revealKeys.has(event.key)) beginReveal();
  }

  window.addEventListener("wheel", beginReveal, { once: true, passive: true });
  window.addEventListener("touchmove", beginReveal, { once: true, passive: true });
  window.addEventListener("keydown", handleRevealKey);
  document.querySelector(".scroll-cue")?.addEventListener("click", beginReveal, {
    once: true,
  });
}

function getModeFills(definition: StatisticDefinition): Map<string, string> {
  const cached = modeFills.get(definition.mode);
  if (cached) return cached;

  const fills = new Map<string, string>();
  for (const county of Object.values(counties)) {
    const value = county[definition.field];
    if (typeof value !== "number") continue;
    fills.set(county.fips, classify(value, definition.thresholds, definition.colors));
  }
  modeFills.set(definition.mode, fills);
  return fills;
}

function getMusicFills(): Map<string, string> {
  const fills = new Map<string, string>();
  for (const [state, datum] of Object.entries(stateArtists)) {
    fills.set(
      state,
      datum.artistCount === 0
        ? NO_ARTISTS_FILL
        : classify(datum.artistCount, musicThresholds, MUSIC_COLORS),
    );
  }
  return fills;
}

function handleCountyEnter(details: CountyPointerDetails): void {
  if (details.pointerType !== "mouse") return;
  showTooltip(details);
}

function handleCountyMove(details: CountyPointerDetails): void {
  if (details.pointerType !== "mouse" || tooltip.hidden) return;
  positionTooltip(details.clientX, details.clientY);
}

function handleCountyLeave(details: CountyPointerDetails): void {
  if (details.pointerType === "mouse" && !touchTooltipPinned) hideTooltip();
}

function handleCountyTap(details: CountyPointerDetails): void {
  touchTooltipPinned = true;
  showTooltip(details);
}

function handleStateEnter(details: StatePointerDetails): void {
  if (details.pointerType !== "mouse") return;
  showStateTooltip(details);
}

function handleStateMove(details: StatePointerDetails): void {
  if (details.pointerType !== "mouse" || tooltip.hidden) return;
  positionTooltip(details.clientX, details.clientY);
}

function handleStateLeave(details: StatePointerDetails): void {
  if (details.pointerType === "mouse" && !touchTooltipPinned) hideTooltip();
}

function handleStateTap(details: StatePointerDetails): void {
  touchTooltipPinned = true;
  showStateTooltip(details);
}

function showTooltip(details: CountyPointerDetails): void {
  const mode = modes[activeIndex];
  const county = counties[details.fips];
  tooltipName.textContent = county ? `${county.name}, ${county.state}` : details.fips;
  tooltipArtists.replaceChildren();

  if (mode === "personal") {
    tooltipValue.textContent = "";
  } else if (mode !== "music") {
    const definition = definitions[mode];
    const value = county?.[definition.field];
    tooltipValue.textContent =
      typeof value === "number" ? definition.formatValue(value) : "data unavailable";
  } else {
    tooltipValue.textContent = "data unavailable";
  }

  tooltip.hidden = false;
  positionTooltip(details.clientX, details.clientY);
}

function showStateTooltip(details: StatePointerDetails): void {
  const datum = stateArtists[details.state];
  tooltipName.textContent = STATE_NAMES[details.state] ?? details.state;
  tooltipArtists.replaceChildren();

  if (!datum || datum.artistCount === 0) {
    tooltipValue.textContent = "No mapped artists";
  } else {
    tooltipValue.textContent = `${datum.artistCount.toLocaleString("en-US")} distinct ${datum.artistCount === 1 ? "artist" : "artists"}`;
    const artistRows = datum.topArtists.slice(0, 3).map((artist) => {
      const row = document.createElement("span");
      row.className = "county-hover-artist";
      row.textContent = `${artist.name} — ${artist.playcount.toLocaleString("en-US")} ${artist.playcount === 1 ? "scrobble" : "scrobbles"}`;
      return row;
    });
    tooltipArtists.replaceChildren(...artistRows);
  }

  tooltip.hidden = false;
  positionTooltip(details.clientX, details.clientY);
}

function positionTooltip(clientX: number, clientY: number): void {
  const viewportMargin = 8;
  const cursorGap = 10;
  const bounds = tooltip.getBoundingClientRect();
  const maximumLeft = Math.max(
    viewportMargin,
    window.innerWidth - bounds.width - viewportMargin,
  );
  const maximumTop = Math.max(
    viewportMargin,
    window.innerHeight - bounds.height - viewportMargin,
  );

  const preferredLeft = clientX + cursorGap;
  const preferredTop = clientY + cursorGap;
  const flippedLeft = clientX - bounds.width - cursorGap;
  const flippedTop = clientY - bounds.height - cursorGap;

  tooltip.style.left = `${clamp(
    preferredLeft <= maximumLeft ? preferredLeft : flippedLeft,
    viewportMargin,
    maximumLeft,
  )}px`;
  tooltip.style.top = `${clamp(
    preferredTop <= maximumTop ? preferredTop : flippedTop,
    viewportMargin,
    maximumTop,
  )}px`;
}

function hideTooltip(): void {
  touchTooltipPinned = false;
  tooltip.hidden = true;
  tooltipName.textContent = "";
  tooltipValue.textContent = "";
  tooltipArtists.replaceChildren();
}

function classify(
  value: number,
  thresholds: readonly number[],
  colors: readonly string[],
): string {
  const index = thresholds.findIndex((threshold) => value < threshold);
  return colors[index === -1 ? colors.length - 1 : index] ?? NO_DATA_FILL;
}

function randomRedShade(): string {
  const saturation = Math.round(72 + Math.random() * 24);
  const lightness = Math.round(34 + Math.random() * 24);
  return `hsl(0 ${saturation}% ${lightness}%)`;
}

function quantileThresholds(values: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  return [0.2, 0.4, 0.6, 0.8].map((quantile) => {
    const index = Math.floor((sorted.length - 1) * quantile);
    return sorted[index] ?? 0;
  });
}

function buildIncomeLegend(thresholds: number[]): string[] {
  const [first = 0, second = 0, third = 0, fourth = 0] = thresholds;
  return [
    `< ${formatCompactIncome(first)}`,
    `${formatCompactIncome(first)}–${formatCompactIncome(second)}`,
    `${formatCompactIncome(second)}–${formatCompactIncome(third)}`,
    `${formatCompactIncome(third)}–${formatCompactIncome(fourth)}`,
    `≥ ${formatCompactIncome(fourth)}`,
  ];
}

function formatGrowth(value: number): string {
  const rounded = value.toFixed(1);
  return `${value > 0 ? "+" : ""}${rounded}% population change`;
}

function formatIncome(value: number): string {
  return `${value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })} median household income`;
}

function formatCompactIncome(value: number): string {
  return `$${Math.round(value / 1_000)}k`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return element;
}

function requireButton(selector: string): HTMLButtonElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`missing ${selector}`);
  return element;
}

function requireAnchor(selector: string): HTMLAnchorElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLAnchorElement)) throw new Error(`missing ${selector}`);
  return element;
}

function requireElements<T extends Element>(selector: string): T[] {
  const elements = Array.from(document.querySelectorAll<T>(selector));
  if (elements.length === 0) throw new Error(`missing ${selector}`);
  return elements;
}
