import {
  geoAlbers,
  geoConicEqualArea,
  geoPath,
  type GeoProjection,
} from "d3-geo";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  GeoJsonProperties,
} from "geojson";
import { feature, merge } from "topojson-client";
import type {
  GeometryCollection,
  MultiPolygon as TopologyMultiPolygon,
  Polygon as TopologyPolygon,
  Topology,
} from "topojson-specification";

export type CountyMapLayout = "personal" | "statistics";
export type CountyMapRegion = "conus" | "alaska" | "hawaii";
export type CountyMapGeography = "county" | "state";

export type CountyProperties = GeoJsonProperties & {
  name?: string;
  state?: string;
  NAME?: string;
  STUSPS?: string;
};

export type StateProperties = GeoJsonProperties & {
  abbreviation: string;
  stateFips: string;
};

export type CountyTopology = Topology<{
  counties: GeometryCollection<CountyProperties>;
}>;

export type CountyPointerDetails = {
  fips: string;
  region: CountyMapRegion;
  clientX: number;
  clientY: number;
  pointerType: string;
  properties: CountyProperties;
  originalEvent: PointerEvent;
};

export type StatePointerDetails = {
  state: string;
  region: CountyMapRegion;
  clientX: number;
  clientY: number;
  pointerType: string;
  properties: StateProperties;
  originalEvent: PointerEvent;
};

export type CountySvgRendererOptions = {
  topology: CountyTopology;
  selectedFips?: Iterable<string>;
  defaultFill?: string;
  selectedFill?: string;
  selectedFills?: ReadonlyMap<string, string>;
  lineColor?: string;
  ariaLabel?: string;
  mobileBreakpoint?: number;
  onCountyEnter?: (details: CountyPointerDetails) => void;
  onCountyMove?: (details: CountyPointerDetails) => void;
  onCountyLeave?: (details: CountyPointerDetails) => void;
  onCountyTap?: (details: CountyPointerDetails) => void;
  onStateEnter?: (details: StatePointerDetails) => void;
  onStateMove?: (details: StatePointerDetails) => void;
  onStateLeave?: (details: StatePointerDetails) => void;
  onStateTap?: (details: StatePointerDetails) => void;
};

type CountyFeature = Feature<Geometry, CountyProperties> & { id: string };
type StateFeature = Feature<Geometry, StateProperties> & { id: string };

type RegionLayer = {
  group: SVGGElement;
  countyGroup: SVGGElement;
  stateGroup: SVGGElement;
  counties: CountyFeature[];
  states: StateFeature[];
  countyByFips: Map<string, CountyFeature>;
  stateByAbbreviation: Map<string, StateFeature>;
  countyPaths: Map<string, SVGPathElement>;
  statePaths: Map<string, SVGPathElement>;
};

type Extent = [[number, number], [number, number]];

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ALASKA_STATE_FIPS = "02";
const HAWAII_STATE_FIPS = "15";
const VALID_STATE_FIPS = new Set([
  "01",
  "02",
  "04",
  "05",
  "06",
  "08",
  "09",
  "10",
  "11",
  "12",
  "13",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "29",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "38",
  "39",
  "40",
  "41",
  "42",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "50",
  "51",
  "53",
  "54",
  "55",
  "56",
]);

/** renders county or merged-state TopoJSON in one responsive SVG */
export class CountySvgRenderer {
  readonly svg: SVGSVGElement;

  private readonly container: HTMLElement;
  private readonly options: CountySvgRendererOptions;
  private readonly selectedFips: Set<string>;
  private readonly selectedFills: Map<string, string>;
  private readonly layers: Record<CountyMapRegion, RegionLayer>;
  private readonly resizeObserver: ResizeObserver;
  private fills = new Map<string, string>();
  private fallbackFill: string;
  private layout: CountyMapLayout = "personal";
  private geography: CountyMapGeography = "county";
  private hoveredFeature: string | null = null;
  private resizeFrame: number | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, options: CountySvgRendererOptions) {
    this.container = container;
    this.options = options;
    this.selectedFips = new Set(
      Array.from(options.selectedFips ?? [], normalizeFips).filter(isCountyFips),
    );
    this.selectedFills = new Map(
      Array.from(options.selectedFills ?? [], ([fips, color]) => [
        normalizeFips(fips),
        color,
      ]),
    );
    this.fallbackFill = options.defaultFill ?? "#141414";

    const countyRegions = splitCounties(options.topology);
    const stateRegions = splitStates(options.topology);
    this.svg = createSvgElement("svg");
    this.svg.classList.add(
      "county-map",
      "county-map--personal",
      "county-map--counties",
    );
    this.svg.setAttribute("viewBox", "0 0 960 600");
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", options.ariaLabel ?? "United States county map");
    this.svg.setAttribute("data-layout", this.layout);
    this.svg.setAttribute("data-geography", this.geography);

    this.layers = {
      conus: this.createRegionLayer("conus", countyRegions.conus, stateRegions.conus),
      alaska: this.createRegionLayer("alaska", countyRegions.alaska, stateRegions.alaska),
      hawaii: this.createRegionLayer("hawaii", countyRegions.hawaii, stateRegions.hawaii),
    };

    this.container.replaceChildren(this.svg);
    this.bindPointerEvents();

    // one render per animation frame keeps ResizeObserver bursts cheap
    this.resizeObserver = new ResizeObserver(this.scheduleResize);
    this.resizeObserver.observe(this.container);
    this.renderGeometry();
    this.paintFeatures();
  }

  /** changes between full CONUS and the three-region statistics composition */
  setLayout(layout: CountyMapLayout): void {
    if (this.destroyed || layout === this.layout) return;

    this.layout = layout;
    this.svg.dataset.layout = layout;
    this.svg.classList.toggle("county-map--personal", layout === "personal");
    this.svg.classList.toggle("county-map--statistics", layout === "statistics");
    this.renderGeometry();
    this.paintFeatures();
  }

  /** switches between county boundaries and merged state shapes */
  setGeography(geography: CountyMapGeography): void {
    if (this.destroyed || geography === this.geography) return;

    this.geography = geography;
    this.hoveredFeature = null;
    this.svg.dataset.geography = geography;
    this.svg.classList.toggle("county-map--counties", geography === "county");
    this.svg.classList.toggle("county-map--states", geography === "state");
    this.updateGeographyVisibility();
    this.renderGeometry();
    this.paintFeatures();
  }

  /** updates data fills without rebuilding paths */
  setFills(fills: ReadonlyMap<string, string>, fallbackFill = this.fallbackFill): void {
    if (this.destroyed) return;

    this.fills = new Map(
      Array.from(fills, ([key, color]) => [normalizeFillKey(key), color]),
    );
    this.fallbackFill = fallbackFill;
    this.paintFeatures();
  }

  /** releases observers and listeners before removing the SVG */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();

    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.svg.remove();
  }

  private createRegionLayer(
    region: CountyMapRegion,
    counties: CountyFeature[],
    states: StateFeature[],
  ): RegionLayer {
    const group = createSvgElement("g");
    group.classList.add("county-map__region", `county-map__region--${region}`);
    group.dataset.region = region;
    this.svg.append(group);

    const countyGroup = createSvgElement("g");
    countyGroup.classList.add("county-map__geography", "county-map__geography--county");
    group.append(countyGroup);

    const stateGroup = createSvgElement("g");
    stateGroup.classList.add("county-map__geography", "county-map__geography--state");
    stateGroup.style.display = "none";
    stateGroup.setAttribute("aria-hidden", "true");
    group.append(stateGroup);

    const countyPaths = new Map<string, SVGPathElement>();
    for (const county of counties) {
      const countyPath = createSvgElement("path");
      countyPath.classList.add("county-map__county");
      countyPath.dataset.fips = county.id;
      countyPath.dataset.region = region;
      countyPath.setAttribute("vector-effect", "non-scaling-stroke");
      countyPath.setAttribute("stroke", this.options.lineColor ?? "#2a2a2a");
      countyPath.setAttribute("stroke-width", "0.5");
      countyGroup.append(countyPath);
      countyPaths.set(county.id, countyPath);
    }

    const statePaths = new Map<string, SVGPathElement>();
    for (const state of states) {
      const statePath = createSvgElement("path");
      statePath.classList.add("county-map__state");
      statePath.dataset.state = state.id;
      statePath.dataset.region = region;
      statePath.setAttribute("vector-effect", "non-scaling-stroke");
      statePath.setAttribute("stroke", this.options.lineColor ?? "#2a2a2a");
      statePath.setAttribute("stroke-width", "0.75");
      stateGroup.append(statePath);
      statePaths.set(state.id, statePath);
    }

    return {
      group,
      countyGroup,
      stateGroup,
      counties,
      states,
      countyByFips: new Map(counties.map((county) => [county.id, county])),
      stateByAbbreviation: new Map(states.map((state) => [state.id, state])),
      countyPaths,
      statePaths,
    };
  }

  private renderGeometry(): void {
    const bounds = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || 960));
    const height = Math.max(1, Math.round(bounds.height || 600));
    const mobile = width < (this.options.mobileBreakpoint ?? 720);

    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.dataset.responsiveLayout = mobile ? "mobile" : "desktop";

    if (this.layout === "personal") {
      this.setRegionVisible(this.layers.alaska, false);
      this.setRegionVisible(this.layers.hawaii, false);
      this.setRegionVisible(this.layers.conus, true);
      const padding = Math.max(8, Math.min(width, height) * 0.045);
      this.drawRegion(
        this.layers.conus,
        createConusProjection(),
        [[padding, padding], [width - padding, height - padding]],
      );
      return;
    }

    this.setRegionVisible(this.layers.conus, true);
    this.setRegionVisible(this.layers.alaska, true);
    this.setRegionVisible(this.layers.hawaii, true);

    const extents = mobile
      ? createMobileExtents(width, height)
      : createDesktopExtents(width, height);

    this.drawRegion(this.layers.conus, createConusProjection(), extents.conus);
    this.drawRegion(this.layers.alaska, createAlaskaProjection(), extents.alaska);
    this.drawRegion(this.layers.hawaii, createHawaiiProjection(), extents.hawaii);
  }

  private drawRegion(layer: RegionLayer, projection: GeoProjection, extent: Extent): void {
    const features = this.geography === "county" ? layer.counties : layer.states;
    const collection = toFeatureCollection(features);
    projection.fitExtent(extent, collection);
    const makePath = geoPath(projection);

    const paths = this.geography === "county" ? layer.countyPaths : layer.statePaths;
    for (const mapFeature of features) {
      paths.get(String(mapFeature.id))?.setAttribute("d", makePath(mapFeature) ?? "");
    }
  }

  private setRegionVisible(layer: RegionLayer, visible: boolean): void {
    layer.group.style.display = visible ? "" : "none";
    layer.group.setAttribute("aria-hidden", String(!visible));
  }

  private updateGeographyVisibility(): void {
    for (const layer of Object.values(this.layers)) {
      const showCounties = this.geography === "county";
      layer.countyGroup.style.display = showCounties ? "" : "none";
      layer.countyGroup.setAttribute("aria-hidden", String(!showCounties));
      layer.stateGroup.style.display = showCounties ? "none" : "";
      layer.stateGroup.setAttribute("aria-hidden", String(showCounties));
    }
  }

  private paintFeatures(): void {
    const defaultFill = this.options.defaultFill ?? "#141414";
    const selectedFill = this.options.selectedFill ?? "#e10600";

    for (const layer of Object.values(this.layers)) {
      for (const [fips, countyPath] of layer.countyPaths) {
        const fill =
          this.layout === "personal"
            ? this.selectedFips.has(fips)
              ? (this.selectedFills.get(fips) ?? selectedFill)
              : defaultFill
            : (this.fills.get(fips) ?? this.fallbackFill);
        countyPath.setAttribute("fill", fill);
        countyPath.classList.toggle(
          "county-map__county--selected",
          this.layout === "personal" && this.selectedFips.has(fips),
        );
      }

      for (const [state, statePath] of layer.statePaths) {
        statePath.setAttribute("fill", this.fills.get(state) ?? this.fallbackFill);
      }
    }
  }

  private bindPointerEvents(): void {
    this.svg.addEventListener("pointerover", (event) => {
      const path = elementFeaturePath(event.target);
      const key = pathFeatureKey(path);
      if (!path || !key || key === this.hoveredFeature) return;
      this.hoveredFeature = key;

      if (this.geography === "county") {
        const details = this.countyPointerDetails(event, path);
        if (details) this.options.onCountyEnter?.(details);
      } else {
        const details = this.statePointerDetails(event, path);
        if (details) this.options.onStateEnter?.(details);
      }
    });

    this.svg.addEventListener("pointermove", (event) => {
      const path = elementFeaturePath(event.target);
      if (!path) return;

      if (this.geography === "county") {
        const details = this.countyPointerDetails(event, path);
        if (details) this.options.onCountyMove?.(details);
      } else {
        const details = this.statePointerDetails(event, path);
        if (details) this.options.onStateMove?.(details);
      }
    });

    this.svg.addEventListener("pointerout", (event) => {
      const path = elementFeaturePath(event.target);
      const key = pathFeatureKey(path);
      if (!path || !key) return;

      const nextPath = elementFeaturePath(event.relatedTarget);
      if (pathFeatureKey(nextPath) === key) return;
      this.hoveredFeature = null;

      if (this.geography === "county") {
        const details = this.countyPointerDetails(event, path);
        if (details) this.options.onCountyLeave?.(details);
      } else {
        const details = this.statePointerDetails(event, path);
        if (details) this.options.onStateLeave?.(details);
      }
    });

    // mouse hover already exposes details; pointerup covers touch and pen selection
    this.svg.addEventListener("pointerup", (event) => {
      if (event.pointerType === "mouse") return;
      const path = elementFeaturePath(event.target);
      if (!path) return;

      if (this.geography === "county") {
        const details = this.countyPointerDetails(event, path);
        if (details) this.options.onCountyTap?.(details);
      } else {
        const details = this.statePointerDetails(event, path);
        if (details) this.options.onStateTap?.(details);
      }
    });

    this.svg.addEventListener("pointerleave", (event) => {
      if (this.hoveredFeature === null) return;
      const key = this.hoveredFeature;
      this.hoveredFeature = null;

      if (this.geography === "county") {
        const details = this.countyPointerDetailsFromFips(event, key);
        if (details) this.options.onCountyLeave?.(details);
      } else {
        const details = this.statePointerDetailsFromAbbreviation(event, key);
        if (details) this.options.onStateLeave?.(details);
      }
    });
  }

  private countyPointerDetails(
    event: PointerEvent,
    path = elementFeaturePath(event.target),
  ): CountyPointerDetails | null {
    const fips = path?.dataset.fips;
    if (!path || !fips) return null;
    return this.countyPointerDetailsFromFips(event, fips, path);
  }

  private countyPointerDetailsFromFips(
    event: PointerEvent,
    fips: string,
    path?: SVGPathElement,
  ): CountyPointerDetails | null {
    const countyPath = path ?? this.findCountyPath(fips);
    const region = countyPath?.dataset.region;
    const county = this.findCounty(fips, region);
    if (!countyPath || !county || !isRegion(region)) return null;

    return {
      fips,
      region,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
      properties: county.properties ?? {},
      originalEvent: event,
    };
  }

  private findCountyPath(fips: string): SVGPathElement | undefined {
    for (const layer of Object.values(this.layers)) {
      const path = layer.countyPaths.get(fips);
      if (path) return path;
    }
    return undefined;
  }

  private findCounty(
    fips: string,
    region: string | undefined,
  ): CountyFeature | undefined {
    if (!isRegion(region)) return undefined;
    return this.layers[region].countyByFips.get(fips);
  }

  private statePointerDetails(
    event: PointerEvent,
    path = elementFeaturePath(event.target),
  ): StatePointerDetails | null {
    const abbreviation = path?.dataset.state;
    if (!path || !abbreviation) return null;
    return this.statePointerDetailsFromAbbreviation(event, abbreviation, path);
  }

  private statePointerDetailsFromAbbreviation(
    event: PointerEvent,
    abbreviation: string,
    path?: SVGPathElement,
  ): StatePointerDetails | null {
    const statePath = path ?? this.findStatePath(abbreviation);
    const region = statePath?.dataset.region;
    if (!statePath || !isRegion(region)) return null;

    const state = this.layers[region].stateByAbbreviation.get(abbreviation);
    if (!state) return null;

    return {
      state: abbreviation,
      region,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
      properties: state.properties,
      originalEvent: event,
    };
  }

  private findStatePath(abbreviation: string): SVGPathElement | undefined {
    for (const layer of Object.values(this.layers)) {
      const path = layer.statePaths.get(abbreviation);
      if (path) return path;
    }
    return undefined;
  }

  private readonly scheduleResize = (): void => {
    if (this.resizeFrame !== null || this.destroyed) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.renderGeometry();
    });
  };
}

function splitCounties(topology: CountyTopology): Record<CountyMapRegion, CountyFeature[]> {
  const raw = feature(topology, topology.objects.counties);
  const counties = raw.features.flatMap((county): CountyFeature[] => {
    const fips = normalizeFips(county.id);
    if (!isCountyFips(fips) || !VALID_STATE_FIPS.has(fips.slice(0, 2))) return [];
    return [{ ...county, id: fips } as CountyFeature];
  });

  return {
    conus: counties.filter((county) => {
      const stateFips = county.id.slice(0, 2);
      return stateFips !== ALASKA_STATE_FIPS && stateFips !== HAWAII_STATE_FIPS;
    }),
    alaska: counties.filter((county) => county.id.startsWith(ALASKA_STATE_FIPS)),
    hawaii: counties.filter((county) => county.id.startsWith(HAWAII_STATE_FIPS)),
  };
}

function splitStates(topology: CountyTopology): Record<CountyMapRegion, StateFeature[]> {
  const stateGeometries = new Map<
    string,
    Array<TopologyPolygon<CountyProperties> | TopologyMultiPolygon<CountyProperties>>
  >();

  // merging original arcs removes county borders instead of painting over them
  for (const geometry of topology.objects.counties.geometries) {
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") continue;

    const stateFips = normalizeFips(geometry.id).slice(0, 2);
    const abbreviation = geometry.properties?.STUSPS?.toUpperCase();
    if (!abbreviation || !VALID_STATE_FIPS.has(stateFips)) continue;

    const geometries = stateGeometries.get(abbreviation) ?? [];
    geometries.push(geometry);
    stateGeometries.set(abbreviation, geometries);
  }

  const states = Array.from(stateGeometries, ([abbreviation, geometries]) => {
    const stateFips = normalizeFips(geometries[0]?.id).slice(0, 2);
    return {
      type: "Feature" as const,
      id: abbreviation,
      properties: { abbreviation, stateFips },
      geometry: merge(topology, geometries),
    } satisfies StateFeature;
  });

  return {
    conus: states.filter(
      (state) =>
        state.properties.stateFips !== ALASKA_STATE_FIPS &&
        state.properties.stateFips !== HAWAII_STATE_FIPS,
    ),
    alaska: states.filter(
      (state) => state.properties.stateFips === ALASKA_STATE_FIPS,
    ),
    hawaii: states.filter(
      (state) => state.properties.stateFips === HAWAII_STATE_FIPS,
    ),
  };
}

function createConusProjection(): GeoProjection {
  return geoAlbers().parallels([29.5, 45.5]).rotate([96, 0]).center([0, 37.5]);
}

function createAlaskaProjection(): GeoProjection {
  // custom rotation keeps Aleutian coordinates together across the antimeridian
  return geoConicEqualArea().parallels([55, 65]).rotate([154, 0]).center([0, 62]);
}

function createHawaiiProjection(): GeoProjection {
  return geoConicEqualArea().parallels([8, 18]).rotate([157, 0]).center([0, 20.5]);
}

function createDesktopExtents(
  width: number,
  height: number,
): Record<CountyMapRegion, Extent> {
  const padding = Math.max(8, Math.min(width, height) * 0.035);
  const insetRight = Math.max(width * 0.21, padding + 1);
  const gap = Math.max(8, width * 0.025);
  const conusLeft = insetRight + gap;
  const splitY = height * 0.54;

  return {
    conus: [[conusLeft, padding], [width - padding, height - padding]],
    alaska: [[padding, padding], [insetRight, splitY - gap / 2]],
    hawaii: [[padding, splitY + gap / 2], [insetRight, height - padding]],
  };
}

function createMobileExtents(
  width: number,
  height: number,
): Record<CountyMapRegion, Extent> {
  const padding = Math.max(8, Math.min(width, height) * 0.035);
  const gap = Math.max(8, width * 0.025);
  const conusBottom = height * 0.69;
  const insetTop = conusBottom + gap;
  const midpoint = width / 2;

  return {
    conus: [[padding, padding], [width - padding, conusBottom]],
    alaska: [[padding, insetTop], [midpoint - gap / 2, height - padding]],
    hawaii: [[midpoint + gap / 2, insetTop], [width - padding, height - padding]],
  };
}

function toFeatureCollection(
  features: Array<Feature<Geometry, GeoJsonProperties>>,
): FeatureCollection<Geometry> {
  return { type: "FeatureCollection", features };
}

function elementFeaturePath(target: EventTarget | null): SVGPathElement | null {
  if (!(target instanceof Element)) return null;
  const path = target.closest("path[data-fips], path[data-state]");
  return path instanceof SVGPathElement ? path : null;
}

function pathFeatureKey(path: SVGPathElement | null): string | undefined {
  return path?.dataset.fips ?? path?.dataset.state;
}

function normalizeFips(value: unknown): string {
  return String(value ?? "").padStart(5, "0");
}

function normalizeFillKey(value: unknown): string {
  const key = String(value ?? "");
  return /^[a-z]{2}$/i.test(key) ? key.toUpperCase() : normalizeFips(key);
}

function isCountyFips(fips: string): boolean {
  return /^\d{5}$/.test(fips);
}

function isRegion(region: string | undefined): region is CountyMapRegion {
  return region === "conus" || region === "alaska" || region === "hawaii";
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tagName: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, tagName);
}
