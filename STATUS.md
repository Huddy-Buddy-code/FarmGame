# STATUS

_Update at the end of every session (brief §13)._

**Last session:** 2026-07-09. Shipped **slice 3 — the growing season**: calendar +
live clock, plant corn/soy, narrowing yield range (§6), multi-day harvest into a
grain bin — all under a new **cozy game UI**. Repo green (typecheck + 14 tests);
full plant→grow→harvest loop played through in-browser.

---

## Where we are

Hard gate passed (§12.1); county packages; overlay engine live. **The farm now runs a
real season**: buy land → plant corn/soybeans (pay inputs, planting windows) → watch
the field texture change as it grows on the sim clock → yield range narrows → harvest
over sim-days into the grain bin. §12 steps 1–3 are DONE. Next: **move the grain**
(§12 steps 4–5) — truck + real buyer + local price — which closes the core loop.

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

### Slice 3 — The growing season + cozy game UI ✅ (2026-07-09)
Design decisions (maintainer-interviewed):
- **Time:** 1× is LITERAL real time — the game works as a background idle game.
  Speed buttons 5×/10×; **Skip to Month** (dropdown, next 12 month-starts) is the
  main season lever, shown as a ~2.5 s **montage** that fully simulates the skipped
  time at high compression (no shortcuts/exploits).
- **Calendar** (`src/sim/calendar.ts`): 12 × 30-day months, campaign starts Mar 1 Yr 1
  (pre-planting). Seasons ride on months.
- **Crops:** corn 🌽 (Apr–May, 110 d, 5.5 t/ac base) + soybeans 🫘 (May–Jun, 100 d,
  1.6 t/ac). All numbers in gameConfig.
- **Yield (§6, the crux):** true yield rolled hidden at planting inside ±30%;
  player sees a **visible range that narrows** toward it (rangebar in field panel).
  Unit-tested: always contains truth, monotonically narrows.
- **Harvest:** takes sim-days (`harvestAcresPerDay`), grain flows into an **on-farm
  bin** (unlimited for now — storage limits arrive with the storage mechanic).
- **Farming sim** (`src/sim/farming.ts`) is pure/testable (no map/DOM); main.ts
  repaints field overlay textures when a status flips.
- **Cozy UI** (index.html rework): cream/wood panels, top HUD (📅 date, 💰 cash,
  🌽/🫘 bins), time controls, Buy Field toolbar, click-a-field side panel (crop
  picker w/ costs + windows, growth bar, narrowing yield bar, harvest progress),
  toasts. Data-spike statuses live in a small dev corner. Routing click-test
  removed (trucks bring routing back next slice; `src/map/routing.ts` untouched).
- `pointInPolygon` in geometry.ts for click→field hit-testing. Tests now 14.

### Dev convenience
- `start-dev.bat` — double-click to install (first run) + launch the dev server and
  open the browser at http://localhost:5173.

## How to run
- Double-click `start-dev.bat`, **or** `npm run dev` → http://localhost:5173.
- Checks: `npm run typecheck`, `npm test`.

## Next (in order)
1. **Move grain — close the core loop** (brief §12 4–5): buyers (real elevators/mills
   from OSM → county package `buyers.geojson`), one capacity-limited truck routing on
   real roads (`src/map/routing.ts` still works), fuel + drive-time cost, sell at a
   local price with the local-demand drop → get paid. *"If moving grain profitably in
   steps 1–5 is fun, the game works."*
2. **Persistence** (§2): save/load the SaveState to IndexedDB (+ clock time). Also
   persist the mid-harvest set (currently session-scoped in farming.ts).
3. (Optional) county-picker UI; tilled status/fieldwork pass (plant currently jumps
   stubble→planted; tilling belongs to the equipment/fieldwork slice, §10).

### Notes for next session
- **Balance smell (still open):** $12k/ac land + $100k start = tiny first farm.
  Consider the loan mechanism (§8) as the real fix rather than cheaper land.
- **Growing-stage textures:** growing fields use one green fill; per-stage tinting
  (§10) is procedural-ready in fieldRender.ts — do it when fieldwork lands.
- 1×-real-time idle pacing is untested for feel over hours; revisit after buyers
  exist (that's when leaving it running does something).

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
