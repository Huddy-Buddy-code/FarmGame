# STATUS

_Update at the end of every session (brief §13)._

**Last session:** 2026-07-08. Data spike passed its gate; counties restructured as
data-driven "map packs." Repo is green (typecheck + tests) with 5 commits.

---

## Where we are

The brief's **hard gate is passed** (§12 step 1): NAIP satellite imagery, OSM roads,
and real-road routing all render together over Story County, IA. On top of that, the
map is now organized as reusable **county packages** so we can add more playable
counties as pure data. Next up is the geo-referenced overlay engine → first parcel/field.

## Done

### Slice 0 — Scaffold + Data Spike (the hard gate) ✅
- Repo initialized (git from commit #1). Vite + TypeScript + MapLibre GL.
- Architecture pillars stubbed from day one:
  - **Config object** (`src/config/gameConfig.ts`) — the only home for balance numbers.
  - **Coordinate system** (`src/geo/coords.ts`) — one internal UTM-meter space,
    conversion only at edges. Round-trip unit tested (`tests/coords.test.ts`).
  - **Sim clock** (`src/sim/clock.ts`) — pause, time-compression, queued future actions.
  - **Save-state shape** (`src/state/saveState.ts`) — parcels/fields/agents/contracts.
- **Gate CONFIRMED in-browser** (maintainer, 2026-07-08): NAIP + roads + a real route
  (12.0 km by road vs 5.7 km straight, following the section-line grid).
- Endpoint notes: USDA retired per-state ImageServers → we use the national mosaic
  `NAIP/USDA_CONUS_PRIME`. Routing verified against the public OSRM demo server.

### Slice 0.1 — County packages (the playable "maps") ✅
- Each playable county is a self-contained DATA package under `public/counties/<id>/`,
  loaded by id at runtime. Adding a county = drop a folder + one registry line; **no
  code change**. ("county + save = session", mirroring the brief's "module + party =
  campaign".) How-to is in the README.
  - `public/counties/story-ia/manifest.json` — identity, UTM zone, bbox, center,
    imagery source, attribution.
  - `public/counties/story-ia/roads.geojson` — pre-built OSM road extract (1.38 MB,
    3,558 ways: public roads + field tracks; driveways/parking excluded). **Loads
    offline — no live Overpass at play time.**
  - `src/county/{types,registry}.ts` — package format + loader.
  - `src/map/roadsLayer.ts` — draws the extract as cased vector lines over NAIP
    (yellow = major road, white = local), so imagery stays clean (no green tint).
- Coordinate system is now **per-county**: `setProjection(zone, hemisphere)` is set
  from the loaded manifest at startup (a Palouse county is a different UTM zone).
- **Imagery decision:** roads are BUNDLED (small; Overpass is flaky), but full-county
  NAIP is gigabytes, so the manifest *describes* the imagery source and we serve it
  live from USDA (a reliable gov CDN). The manifest format is ready to swap to
  cached/self-hosted county tiles later without touching code.

### Dev convenience
- `start-dev.bat` — double-click to install (first run) + launch the dev server and
  open the browser at http://localhost:5173.

## How to run
- Double-click `start-dev.bat`, **or** `npm run dev` → http://localhost:5173.
- Checks: `npm run typecheck`, `npm test`.

## Next (in order)
1. **Overlay engine** (brief §4) — the geo-referenced raster overlay, the ONE module
   behind painter edits, field-status textures, and the fieldwork reveal. Paint in
   **geo-space, not screen-space**, composited over NAIP (never modify the tiles).
   This is the highest-leverage next piece — it powers three later features.
2. **Buy one parcel → draw one field** into the overlay (brief §12 step 2), stored in
   the save-state's `parcels`/`fields` as UTM meters.
3. (Optional, small) A **county-picker UI** to make the multi-map structure visible
   end to end.

## Deferred / known
- **In-browser visual re-check pending for Slice 0.1.** The county-package refactor is
  verified at typecheck/test/asset-serving level, but the Chrome automation extension
  was offline all session so I couldn't screenshot the refactored map. Maintainer
  should hard-refresh localhost:5173 and confirm clean NAIP + instant road lines +
  "Roads: 3558 loaded ✓".
- **Road extract provenance:** fetched once via public Overpass (which rate-limited us
  mid-session). If we add many counties, build a reproducible extract pipeline
  (Geofabrik `.osm.pbf` clip, or a scripted/throttled Overpass job). The story-ia
  extract is committed as data for now.
- **Routing** still uses the public OSRM demo server. Before real gameplay, self-host
  OSRM/Valhalla on a per-county extract (offline, fast, no rate limit). Same interface.
