# STATUS

_Snapshot for picking up the project — current state and what's open. Full
change-by-change history lives in `git log`; this file no longer duplicates it._

## What this is

**Farm Logistics Sim** — a browser farm economy game over real satellite
imagery. Buy land in any of 3,109 CONUS counties (real NAIP imagery, real OSM
roads, real routing), grow crops, and move produce profitably to market. The
core fantasy is *planning*: uncertain yield that narrows as harvest
approaches, equipment/labor scheduled against a sim clock, and (eventually)
forward-selling a harvest via contracts before it's in the ground. Full design
intent lives in `PROJECT_BRIEF.md`; this file just tracks where the build is.

Stack: TypeScript, MapLibre GL JS, UTM-meter internal coordinates, IndexedDB
save/load, Vitest. No backend — everything runs client-side against public
data (USDA NAIP, OpenStreetMap, Census TIGERweb/county index, public OSRM).

**Status: playable, in active daily development.** 959/959 tests passing,
typecheck clean.

## Where things stand

- **World**: pick a farm in any CONUS county from a home-screen menu; bundled
  counties load instantly, others fetch OSM roads live and cache in IndexedDB.
  Persistent NAIP tile cache, county boundary/board rendering, field/building
  labels.
- **Core loop**: draw/buy fields → plow → plant → grow (hidden true yield,
  narrowing confidence range) → harvest → sell. 12-hour workday calendar,
  adjustable sim speed (pause → real-time → 1hr=1yr), multi-farm save slots
  with autosave.
- **Crops**: 8 grain crops (corn, soybeans, wheat, rye, oats, barley, canola,
  sunflowers); Grass & Alfalfa as perennial hay/baleage; Corn (Forage) as a
  separate chop-only crop feeding the silage bunker. Multi-year crop-rotation
  planner with a timeline editor.
- **Equipment**: tractor/implement hitching (plow, planter, sprayer, rake,
  mower), combine with crop-specific headers, windrower, forage harvester +
  wagons, balers (round/square/combi) + wrapper, bale spikes/trailers, grain
  carts. Smallest-first auto-assignment, real road-routed travel (A* +
  OSRM), headland-lap coverage paths, photographic machine sprites.
- **Storage & economy**: silos, bale storage (per-product, capacity +
  realistic spoilage — barns keep better than open pads), silage bunkers
  (per-building, per-product, ages fresh→cured), Sell Points. Seasonal
  pricing with a hauled-vs-instant-discount split, auto-sell scheduling,
  a 5-year cashflow ledger, and per-year financing/loans.
- **Buildings**: placeable structures with real elevation art, ground-anchored
  sizing so they scale correctly against the map.
- **UI**: Work Queue (active/queued/completed jobs with live fill bars),
  Equipment/Structures shops, Inventory (sell/haul/auto per product), Finance
  tab, Schedule calendar (the calendar IS the rotation editor), Settings
  (multi-farm), Home screen (county picker).

## Recent focus: silage/bale economy (Aug 2026)

The last few weeks' work built out a full silage/forage system and then spent
this week rebalancing it. Rough arc:

1. **Baleage** (wrapped bales) — a 4th pass on the existing mow→rake→bale
   pipeline, priced in dry matter, gated to the same calendar month a bale was
   made.
2. **Bulk silage** — forage harvester + wagons + bunker, with Corn Silage
   split off Corn into its own chop-only crop ("Corn (Forage)") so combining
   and chopping stay mutually exclusive.
3. **Grass/Alfalfa Silage** split from Grass/Alfalfa as separate rotation
   entries, and silage bunkers were rearchitected from one farm-wide pooled
   number to real per-building storage (matching how Bale Storage already
   worked) — needed once per-bunker product assignment became a real
   restriction, not cosmetic.
4. **This week**: full pricing/volume review against real 2024 USDA market
   data, on 4 rules from the maintainer — square bales cost the same $/ton as
   round (just bigger, 1.6x the weight), silage/baleage is always priced
   above what it started as, grass/alfalfa/corn silage are priced separately,
   and a crop's wrapped and dry bale counts per acre now match exactly (the
   old wrapped-bale bonus was dead code — never used by real bale
   generation). Also fixed a backwards bunker id/name mismatch (the id
   `cornSilage` used to *display* as "Corn Forage") — `cornForage` (fresh,
   $50/t) now correctly ages into `cornSilage` (cured, $55/t). Bale product
   count: 15. Migrations cover every renamed/retired id so old saves upgrade
   cleanly.
5. Alongside this, fixed two real crew-scaling bugs (a Haul Bales / Sell run
   never grew past one machine once its trigger events stopped firing) and a
   bunker double-booking risk.

All of the above is typecheck+test verified; most of it has NOT had a live
gameplay pass in Browser Preview (pricing/id changes, not new UI, so low
visual risk — but worth a real playthrough next time silage/bales come up).

## Open / Next steps

- **The v1 critical gate is still open** (`PROJECT_BRIEF.md` §4/§12 step 4):
  *"if moving grain profitably is fun, the game works"* — but there are still
  no real buyers with finite capacity or local demand drop, no per-buyer
  distance/price tradeoff. Today's economy is seasonal-price + haul-vs-instant
  only. This is the single biggest remaining design gap.
- **Needs eyes in Browser Preview** (re-enabled 2026-08-12 after a month off —
  a lot shipped logic-only during that window): rotation planner UI,
  cellular-decomposition coverage visuals, bale markers, machine icon
  flip/hitching, headland-lap frames, and the whole silage/bale economy
  rebalance above. A full gameplay session (buy land → grow → sell) hasn't
  happened recently — the NAIP county-fetch hang risk (see `CLAUDE.md`) means
  this is worth doing deliberately, not accidentally.
- **Contracts / forward-selling** (brief §6) — not started. This is the other
  half of the "planning" fantasy the game is pitched on.
- Rotation planner and Schedule drag-and-drop are unit-tested only, never
  played live.
- Routing runs on the public OSRM demo instance, not self-hosted.

## How to run

`npm run dev` → http://localhost:5173. Checks: `npm run typecheck`, `npm test`.
Browser Preview is on — see `CLAUDE.md` for the NAIP-hang caveat before a live
gameplay session.
