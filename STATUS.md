# STATUS

_Update at the end of every session (brief §13)._

## Done

### Slice 0 — Scaffold + Data Spike (brief §12 step 1) — the hard gate
- Repo initialized (git from commit #1). Vite + TypeScript + MapLibre GL.
- County chosen: **Story County, Iowa** (UTM zone 15N).
- Architecture pillars stubbed from day one:
  - **Config object** (`src/config/gameConfig.ts`) — the only home for balance numbers.
  - **Coordinate system** (`src/geo/coords.ts`) — one internal UTM-meter space,
    conversion only at edges. Covered by a round-trip unit test (`tests/coords.test.ts`).
  - **Sim clock** (`src/sim/clock.ts`) — pause, time-compression, queued future actions.
  - **Save-state shape** (`src/state/saveState.ts`) — parcels/fields/agents/contracts.
- Data spike wired (`src/main.ts`): NAIP base + OSM roads overlay + click-to-route,
  with a live HUD reporting whether each of the three data sources loaded.

### Verified this session
- ✅ `npm run typecheck` clean; `npm test` green (3/3 coord tests).
- ✅ NAIP endpoint: USDA per-state ImageServers were **retired**; switched to the
  national mosaic `NAIP/USDA_CONUS_PRIME`. `exportImage` over Ames returns a real
  JPEG (verified via curl — correct content-type + magic bytes).
- ✅ OSRM routing: returns a real ~14.7 km Story County route (verified via curl).

### Gate: CONFIRMED ✅
- Visually confirmed in-browser (maintainer, 2026-07-08): all three HUD lines green —
  NAIP imagery, OSM roads, and a real-road route (12.0 km by road vs 5.7 km straight,
  routing along the section-line grid). **The brief's hard gate is passed.**

## Next
1. Overlay engine (brief §4) — geo-referenced raster overlay, the ONE module behind
   painter edits, field textures, and fieldwork reveal. Paint in geo-space.
2. Buy one parcel → draw one field into the overlay (brief §12 step 2).

## Notes / decisions
- Routing uses the **public OSRM demo server** for the spike. Before real gameplay,
  self-host OSRM/Valhalla on a Story County OSM extract (offline, fast, no rate limit).
- OSM roads currently drawn as a semi-transparent **raster overlay** (visual proof
  only). Real road geometry will come from the county extract as vector tiles.
