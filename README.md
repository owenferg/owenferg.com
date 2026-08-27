# owenferg.com

The source for [owenferg.com](https://owenferg.com), Owen Ferguson's cartography, development, and design portfolio.

The landing page pairs a county-level United States map spelling the domain name with Census-based maps of population change, population density, and median household income. The map is rendered locally as SVG with D3 and TopoJSON; no map service or API key is required.

## Development

Requires Node.js 20.19 or newer.

```sh
npm ci
npm run dev
```

Useful commands:

- `npm run build` — type-check and create the production bundle in `dist/`
- `npm run preview` — serve the production bundle locally
- `npm run typecheck` — run TypeScript checks without building
- `npm run data:generate` — download current configured Census sources and regenerate the county data files

## Project structure

```text
.
├── index.html                       page markup and metadata
├── scripts/
│   └── generate-county-data.mjs     Census download and data-generation pipeline
└── src/
    ├── data/
    │   ├── county-statistics.json   generated county statistics
    │   ├── county-topology.json     generated county geometry
    │   └── domain-counties.json     counties selected to spell the domain
    ├── map/
    │   └── county-svg-renderer.ts   responsive SVG map renderer
    ├── main.ts                      map modes and page interactions
    └── styles.css                   site styles
```

## Data

The generated data uses the configured 2024 U.S. Census Bureau Population Estimates, SAIPE income estimates, and cartographic boundary files. Source URLs and validation expectations live in [`scripts/generate-county-data.mjs`](scripts/generate-county-data.mjs).

Generated JSON files are committed so the site can build without network access. Regenerating them requires internet access and may require updating the expected vintage or county counts when Census releases change.

## Deployment

`npm run build` produces a static site in `dist/`. Deploy that directory to any static host configured for the root of `owenferg.com`.
