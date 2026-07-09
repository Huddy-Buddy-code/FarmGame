# STATUS

_Update at the end of every session (brief §13)._

**Last session:** 2026-07-08. Built the geo-referenced raster **overlay engine**
(pillar 3) and shipped **slice 2**: buy one parcel → draw one field, rendered as a
procedural texture over NAIP. Repo is green (typecheck + 6 tests). Visually verified
in-browser (field renders + stays pinned to real ground on zoom).

---

## Where we are

The brief's **hard gate is passed** (§12 step 1): NAIP + OSM roads + real-road routing
over Story County, IA, organized as reusable **county packages**. Now the **overlay
engine is live** and has its first consumer: you can buy land and draw a field, which
renders as a geo-referenced texture composited over the imagery. Next: put the field
through its lifecycle (plant → grow via sim clock → harvest), then move grain (§12 3–5).

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

### Slice 1 — Overlay engine + first field ✅ (this session)
- **Pillar 3, the geo-referenced raster overlay engine** (`src/map/overlay.ts`). The
  ONE module behind painter edits, field textures, and the fieldwork reveal (brief §4).
  - `OverlayEngine` hands out named `Surface`s; each Surface is an off-DOM 2D canvas
    pinned to a patch of ground via a MapLibre **canvas source** (4 geo corners). You
    draw in **geo-space** (`paint()` / `tracePolygon()` take meters); NAIP tiles are
    never touched, so edits are reversible and glued to real coords on zoom/pan.
  - Per-patch (not one county-sized) canvas: raster is allocated only where the player
    paints, so it scales with owned land, not county size. `OVERLAY_METERS_PER_PIXEL`
    (~1 m/px, matches NAIP) is the quality knob — technical, NOT in gameConfig.
  - Idle-cheap: a static surface uploads for one frame on `markDirty()` then pauses.
- **Procedural field textures** (`src/field/fieldRender.ts`, brief §10) — per-status
  palette (stubble/tilled/planted/growing/ready/harvested) + seeded speckle, clipped
  to the field polygon. Seeded per field id so repaints are stable.
- **Slice 2 — buy one parcel → draw one field** (`src/field/fields.ts`, brief §12.2):
  draw a polygon on the map (click vertices, double-click to close) → stores a Parcel +
  Field in the save-state as **UTM meters** → deducts land cost → renders texture +
  white outline. First real economic transaction (money now means something).
- **Geometry helpers** (`src/geo/geometry.ts`): shoelace area (winding-independent),
  bbox, pad. Area in m²/ha/acres. Unit-tested (`tests/geometry.test.ts`).
- Config: added `landPricePerAcre` ($12k, Corn-Belt ballpark). Fixed a scaffold bug —
  `newGame()` now seeds `money` from `gameConfig.startingMoney` (was hardcoded 0).

### Dev convenience
- `start-dev.bat` — double-click to install (first run) + launch the dev server and
  open the browser at http://localhost:5173.

## How to run
- Double-click `start-dev.bat`, **or** `npm run dev` → http://localhost:5173.
- Checks: `npm run typecheck`, `npm test`.

## Next (in order)
1. **Plant → grow → harvest one crop** (brief §12 steps 3, §6, §10). Drive the field
   through its lifecycle status (stubble→tilled→planted→growing→ready→harvested),
   repainting the overlay per status (already supported). Growth ticks off the **sim
   clock** (`src/sim/clock.ts` — wire it into the loop). Pay planting inputs in spring;
   produce an **uncertain, narrowing yield range** (§6) that resolves to tons at harvest.
   Tunables (input cost, yield range width/narrowing, crop base yield) → gameConfig.
2. **Move grain** (brief §12 4–5): one capacity-limited truck routes on real roads
   (routing already works) to a real buyer, costing drive-time + fuel; sell at a local
   price with the local-demand drop → get paid → the core loop closes.
3. (Optional, small) A **county-picker UI** to make the multi-map structure visible.

### Notes for next session
- **Balance smell:** land at $12k/acre vs. $100k start = only ~8 affordable acres —
  fields end up tiny. Revisit starting money / land price / add the debt mechanism
  (§8) so a first farm is a realistic size. Pure config tuning, no code.
- The field-draw interaction lives in `main.ts` (`wireFieldDrawing`) alongside routing,
  gated by a shared `mode` flag. Double-click closes the polygon (drops the duplicate
  finishing vertex). Draw is in-memory only — **no IndexedDB persistence yet** (§2).

## Deferred / known
- ~~In-browser visual re-check pending for Slice 0.1.~~ **Resolved this session:**
  browser-verified clean NAIP + "Roads: 3558 loaded ✓" + the new field overlay
  rendering and staying geo-pinned on zoom.
- **Road extract provenance:** fetched once via public Overpass (which rate-limited us
  mid-session). If we add many counties, build a reproducible extract pipeline
  (Geofabrik `.osm.pbf` clip, or a scripted/throttled Overpass job). The story-ia
  extract is committed as data for now.
- **Routing** still uses the public OSRM demo server. Before real gameplay, self-host
  OSRM/Valhalla on a per-county extract (offline, fast, no rate limit). Same interface.
