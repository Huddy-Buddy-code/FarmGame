# STATUS

_Update at the end of every session (brief §13)._

**Last session:** 2026-07-09 (cont'd again). Sell-field-back, a Fields tab (list +
expected yield), rounded/soft-edged field rendering (no more sharp corners or a
crisp white border), and an editable days-per-month pace knob. 26 tests green.

---

## Where we are

Hard gate passed (§12.1); county packages; overlay engine live. **The farm now runs a
real season**: buy land → plow → plant corn/soybeans → watch realistic (now rounded,
soft-edged) textures change as it grows → yield range narrows → harvest over sim-days
into the grain bin → **sell grain** from Inventory or **sell the land back** from the
field panel. A **Fields tab** gives a fleet overview at a glance. §12 steps 1–3 and a
slice of 5 (placeholder sale) are DONE. Next: **move the grain for real** (§12 step
4) — truck + real buyer + local price/fuel — which replaces the placeholder sale.

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
- **Calendar** (`src/sim/calendar.ts`): 12 × 30-day months, campaign starts Mar 1 Yr 1
  (pre-planting). Seasons ride on months. **Skip to Month** (dropdown) fast-forwards
  via a ~2.5 s **montage** that fully simulates the skipped time (no shortcuts).
- **Crops:** corn 🌽 (Apr–May, 110 d, 5.5 t/ac base) + soybeans 🫘 (May–Jun, 100 d,
  1.6 t/ac). All numbers in gameConfig.
- **Yield (§6, the crux):** true yield rolled hidden at planting inside ±30%;
  player sees a **visible range that narrows** toward it (rangebar in field panel).
  Unit-tested: always contains truth, monotonically narrows.
- **Harvest:** takes sim-days (`harvestAcresPerDay`), grain flows into an **on-farm
  bin**.
- **Farming sim** (`src/sim/farming.ts`) is pure/testable (no map/DOM); main.ts
  repaints field overlay textures when a status flips.
- **Cozy UI**: cream/wood panels, top HUD, time controls, field side panel, toasts.
  `pointInPolygon` in geometry.ts for click→field hit-testing.

### Slice 4 — Persistence, plow, realistic textures, sale, idle auto-manage ✅ (2026-07-09, cont'd)
- **Persistence** (`src/state/persistence.ts`): localStorage save/load (SaveState +
  clock time + mid-harvest set), versioned + corrupt-safe. Auto-saves every 5s and
  on tab hide/close; a refresh drops you back exactly where you were. **🔄 Reset**
  button (top-left) wipes and starts a new farm — the only way saves get cleared now.
- **Plow step** (`plow()` in farming.ts): stubble/harvested → tilled (pays
  `plowCostPerAcre`) → *then* plant. Matches the brief's §10 field lifecycle.
- **Realistic field textures** (`src/field/fieldRender.ts` rewrite): muted
  satellite-toned palettes, multi-scale noise (soil-moisture blotches + fine
  speckle), and plow/crop/cut **rows oriented along each field's longest edge** —
  reads as part of NAIP, not a sticker on it. Growing fields are stage-aware (young
  rows → closing canopy → mature tone), repainting on 1/12-season buckets.
  Ready color is per-crop (corn golden-tan, soybeans ochre).
- **Inventory / v0 sale** (`src/sim/economy.ts` + toolbar panel): flat
  `sellPricePerTon` per crop, "Sell all" from the grain bin. Explicitly a
  placeholder — the real market slice (buyers, capacity, local-demand drop,
  hauling, brief §5) replaces its *internals*, not its call shape.
- **Idle auto-manage** (player-requested, this session): a per-field toggle in the
  field panel (`Field.autoManage` in saveState). When on, `autoManageField()` in
  farming.ts plows the instant it's stubble/harvested, plants the first crop (config
  order) whose window is open the instant it's tilled, and starts harvest the
  instant it's ready — all silently retried next tick if unaffordable/out of season
  (never throws). Runs inside `tickFarming()`, so it works at any speed including
  the fastest. Manual action buttons hide while a field is auto-managed; toasts narrate
  what happened (useful after leaving the tab). Unit-tested end-to-end: a fresh
  stubble field plows → waits out the off-season → plants on the window's first day
  → harvests → re-plows itself, with zero manual calls.
- **Speed buttons**: pause/1×/60×/3600× with exact real-time meanings — 1× is
  literal real time, 60× is 1 real second = 1 game minute, 3600× is 1 real second =
  1 game hour. Meant to pair with auto-manage for real walk-away play.
- **Crop Calendar** panel (toolbar): FS-style planting/harvest bands per crop,
  derived from gameConfig, with a "you are here" line. **Year bar** under the HUD:
  season-themed strip (🌱☀️🍂❄️) with a position marker.
- Starting money raised to $1,000,000 (was $100k — too little land was affordable).
- **Day progress bar**, stacked directly above the year bar in the same panel: a
  night→dawn→day→dusk→night gradient (midnight at both ends, noon in the middle),
  no text, with a marker showing time-of-day. Purely a mood/flavor readout for now —
  no gameplay reads day/night yet, but the sim clock already has the data (§4).

### Slice 5 — Sell field, Fields tab, rounded/soft rendering, editable calendar pace ✅ (2026-07-09, cont'd again)
- **Sell a field back** (`sellField()` in `src/field/fields.ts`): refunds exactly
  `field.purchaseCost` (stored at buy time — NOT recomputed at current land price,
  so it stays correct once pricing ever becomes dynamic). Falls back to
  `acres × landPricePerAcre` for pre-upgrade saves that lack the field. Refuses
  while mid-harvest (nothing sane to hand back). Removes the parcel, the field, its
  overlay texture surface, and its outline. A persistent **💰 Sell Field** button
  lives in the field detail panel (works regardless of status).
- **Fields tab** (toolbar → 🌾 Fields): every owned field at a glance — icon,
  status (incl. "harvesting"), acres, 🤖 auto-manage marker, and expected total
  yield range (reuses `yieldRange()`). Click a row to open that field's detail
  panel. Refreshes live while open (same ~2×/s cadence as the HUD).
- **Rounded, natural field rendering**: `smoothPolygon()` (new, `geo/geometry.ts`)
  applies Chaikin corner-cutting — display-only, the stored `field.boundary` used
  for area/hit-testing/auto-manage is never touched. Used for both the canvas
  texture's clip path (`fieldRender.ts`) and the outline polygon (`fields.ts`);
  crop-row direction still reads off the TRUE boundary so rows don't skew.
  Outline is now two soft-blurred layers (a wide low-opacity glow + a thin
  translucent core, warm cream instead of solid white) instead of a crisp 2px
  white line — reads like a natural tilled-ground edge, not a survey line.
- **Editable calendar pace** (maintainer request: lower month length toward 5
  days): `calendar.ts`'s `DAYS_PER_MONTH`/`MINUTES_PER_MONTH` consts became mutable
  module state (`getDaysPerMonth()` / `setDaysPerMonth()` / `minutesPerMonth()` —
  same pattern as `coords.ts`'s `setProjection`). A **dropdown in the time bar**
  (5/10/15/20/25/30 days) changes it live; the crop calendar's harvest-band offset
  (`growDays / daysPerMonth`) redraws immediately. Crop `growDays` stays in real
  days always — shortening a month changes how fast the CALENDAR turns, never how
  long a crop takes to grow. Persisted alongside the save (`PersistedGame.daysPerMonth`,
  optional so old saves still load and just default to 30).
- Tests: 26 total (up from 18) — new `tests/fields.test.ts` (sellField), calendar
  pace test, 3 new `smoothPolygon` shape tests in `geometry.test.ts`.

### Dev convenience
- `start-dev.bat` — double-click to install (first run) + launch the dev server and
  open the browser at http://localhost:5173.

## How to run
- Double-click `start-dev.bat`, **or** `npm run dev` → http://localhost:5173.
- Checks: `npm run typecheck`, `npm test`.

## Next (in order)
1. **Move grain for real — replace the v0 sale** (brief §12 step 4, §5): buyers (real
   elevators/mills from OSM → county package `buyers.geojson`) with capacity + local
   price, one capacity-limited truck routing on real roads (`src/map/routing.ts`
   still works, unused since the cozy-UI rewrite), fuel + drive-time cost. This
   supersedes `src/sim/economy.ts`'s flat price. *"If moving grain profitably in
   steps 1–5 is fun, the game works."*
2. **Auto-manage crop policy** is currently "first crop in config order whose window
   is open" (corn beats soybeans whenever both are plantable). Once contracts/price
   signals exist, this is the natural place to make it a real decision instead of a
   fixed order — surface a per-field "preferred crop" setting, or leave it as a
   deliberately dumb default players can override by switching auto-manage off.
3. (Optional) county-picker UI; a real fieldwork/equipment pass (plow/harvest are
   instant right now — tractor-path sweeps + the overlay's progressive reveal are
   ready in fieldRender.ts's row textures, just not wired to a time-over-distance model).

### Notes for next session
- **This session's changes (sell field, Fields tab, rounded/blurred rendering, the
  days-per-month dropdown) are typecheck+test verified but NOT yet visually
  confirmed in-browser** — the maintainer asked to stop using the browser-preview
  tool (too slow) partway through. Worth a real look next session, especially:
  the smoothed-corner texture + soft outline actually reading well over NAIP at
  various zooms, and the timebar not overflowing now that it has 4 buttons + 2
  dropdowns.
- **Idle auto-manage** still hasn't been played for real unattended hours; only
  unit-tested end-to-end plus one instant-toggle browser check from a prior
  session.
- **Balance smell (partially addressed):** starting money raised to $1M so land
  isn't as cramped. Still no debt/loan mechanism (§8) — the more realistic
  long-term lever if balance needs more room.
- Auto-manage state (`Field.autoManage`) persists through save/load like everything
  else on Field — no special-casing needed, confirmed by reading the persistence code.
- **Sell-field design note:** selling forfeits whatever crop is planted (no partial
  refund for inputs already paid) — deliberate, keeps the mechanic simple. Revisit
  if it feels punishing once real money pressure (contracts, debt) exists.

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
