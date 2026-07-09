# Farm Logistics Sim

A browser-based farm-and-ranch **logistics & economy** simulator played over real
USDA satellite imagery of a real US county. See [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md)
for the full vision, scope, and architecture contracts — it is the single source of truth.

**County (v1):** Story County, Iowa (UTM zone 15N).

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts: `npm run typecheck`, `npm test`, `npm run build`.

## Where things are

| Path | What |
|------|------|
| `public/counties/<id>/` | **A playable "map" package** — `manifest.json` (identity, UTM zone, bounds, imagery) + `roads.geojson` (bundled OSM extract). Add a county = add a folder. |
| `src/county/types.ts` | County package types (`CountyManifest`, `CountyPackage`). |
| `src/county/registry.ts` | Lists available counties; loads a package by id. |
| `src/config/gameConfig.ts` | **Pillar 1** — the single config object (balance numbers only). |
| `src/geo/coords.ts` | **Coordinate system** — one internal UTM-meter space; `setProjection()` per county. |
| `src/sim/clock.ts` | **Pillar 2** — the sim clock (pause, time-compression, queued future actions). |
| `src/state/saveState.ts` | **Pillar 4** — the save-state shape. |
| `src/map/naip.ts` | NAIP satellite base layer, built from a county's imagery manifest. |
| `src/map/roadsLayer.ts` | Renders the county's bundled road extract as vector lines. |
| `src/map/routing.ts` | Real-road routing (OSRM). |
| `src/main.ts` | Entry point: loads the county package, then builds the map from it. |

## Adding a new county (playable map)

1. Create `public/counties/<id>/manifest.json` (copy story-ia's; set name, FIPS,
   UTM zone, bbox, center, imagery ImageServer).
2. Drop in `roads.geojson` — an OSM extract of the county's roads (public roads +
   tracks), each feature tagged `{ major: 0|1, hw }`.
3. Add `{ id, name }` to `COUNTIES` in `src/county/registry.ts`.

No engine or UI code changes — counties are pure data.

## Attribution / license

- Imagery: **USDA NAIP** — public domain.
- Roads & destinations: **© OpenStreetMap contributors** — ODbL (attribution now;
  verify share-alike before any monetization).
- Do **not** use Google/Esri imagery or elevation (brief §2).
