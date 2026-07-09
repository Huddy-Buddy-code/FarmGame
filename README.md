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
| `src/config/gameConfig.ts` | **Pillar 1** — the single config object. Every balance number lives here. |
| `src/geo/coords.ts` | **Coordinate system** — one internal UTM-meter space; convert only at edges. |
| `src/sim/clock.ts` | **Pillar 2** — the sim clock (pause, time-compression, queued future actions). |
| `src/state/saveState.ts` | **Pillar 4** — the save-state shape. |
| `src/map/naip.ts` | NAIP satellite base layer (USDA public-domain imagery). |
| `src/map/roads.ts` | OSM roads overlay (ODbL — attribution required). |
| `src/map/routing.ts` | Real-road routing (OSRM). |
| `src/main.ts` | Data-spike entry point wiring the three above together. |

## Attribution / license

- Imagery: **USDA NAIP** — public domain.
- Roads & destinations: **© OpenStreetMap contributors** — ODbL (attribution now;
  verify share-alike before any monetization).
- Do **not** use Google/Esri imagery or elevation (brief §2).
