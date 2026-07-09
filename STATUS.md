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

### NOT yet verified
- ⏳ **In-browser visual render.** The Chrome automation extension was offline and the
  in-app preview tool is pinned to a different project this session, so I could not
  screenshot the map. The dev server runs at http://localhost:5173 — open it and
  confirm all three HUD lines go green (NAIP ✓, OSM ✓, and a test route).

## Next
1. **Confirm the spike visually** (open localhost:5173) — this is the gate; nothing
   else proceeds until the map + roads + route are confirmed rendering.
2. Overlay engine (brief §4) — geo-referenced raster overlay, the ONE module behind
   painter edits, field textures, and fieldwork reveal.
3. Buy one parcel → draw one field into the overlay (brief §12 step 2).

## Notes / decisions
- Routing uses the **public OSRM demo server** for the spike. Before real gameplay,
  self-host OSRM/Valhalla on a Story County OSM extract (offline, fast, no rate limit).
- OSM roads currently drawn as a semi-transparent **raster overlay** (visual proof
  only). Real road geometry will come from the county extract as vector tiles.
