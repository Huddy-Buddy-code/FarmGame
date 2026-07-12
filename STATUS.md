# STATUS

_End-of-session snapshot. Detailed history in git log._

## Where we are

Hard gate passed: NAIP + OSM roads + real routing for one county. Farm runs a
full season: buy land → plow (winter) → plant corn/soybeans → grow (visible
textures, narrowing yield) → harvest → sell grain (flat price placeholder).
Fieldwork is physical — machines drive coverage paths, textures reveal strip-by-strip.
Equipment is tractor/implement hitching (plow, planter, sprayer). Work queues are
drag-reorderable. Finance tab has per-year loans at 5%, 15-year amortization.

**v1 checklist (§12):** steps 1–3 done. Step 4 (real market: buyers, capacity,
routing) is the critical gate — *"if moving grain profitably is fun, the game works."*

## Systems in place

- **Core:** UTM-meter coords; sim clock (pause/1×/60×/3600×, editable pace); indexed
  save/load with auto-save.
- **Land & growth:** draw fields, buy/sell, corn/soybeans. Hidden true yield with
  narrowing confidence range. Month-keyed growth (pace-independent).
- **Fieldwork:** plow → plant → harvest as queued tasks; agents drive coverage paths
  (boustrophedon cellular decomposition skips concave cutouts properly). Textures
  reveal strip-by-strip; machines never plow through notches.
- **Equipment:** tractors (small/medium/large) hitch one impl at a time (plow,
  planter, sprayer). Combine self-contained. Auto-swap on pickup. Smallest-first
  assignment.
- **Tasks:** side-tasks (weed June+, fertilize month-after-plant) independent of
  lifecycle. Window-gated, once-per-crop guards.
- **Plowing:** winter only (Dec–Feb). Auto-manage waits for window like any gated step.
- **Rotation planner:** 1–5 per-year plans in field panel. Crop dropdown + toggles
  (Weed/Fertilize/Bale). Advance Jan 1, loop after last. Each plan auto-runs its
  lifecycle. Weed/fert once per crop (reset at plant). Bale is forage-only; plan
  without Bale plows residue under.
- **Forage baling:** rake (25 ft, Small) + baler (Medium) after corn harvest. Baler
  pauses ~10 s per bale to tie & drop. Bales stored as drop coords; persist until
  sold. All bales render (incremental append, even subsampling if >600).
- **Finance:** open year balance (±$50k/click, no cap) → locks in as loan on Jan 1
  (5% fixed, 15yr amort, monthly payment). Locked loans separate, with payoff &
  refinance buttons (+$15k flat fee, resets term).
- **Net worth:** cash + land value + equipment value − debt. Values = actual refund
  if sold now.
- **95/95 tests passing** (added 5 rotation-planner tests). Typecheck clean.

## Latest changes (2026-07-12, harvester hopper + Grain Trailer hauling)

- **Combines have a real hopper now, sized like tractors** (Small 30t/Medium
  50t/Large 80t). Grain banks into the combine's `grainOnboard`, not straight
  into `save.grain` — a single sim-tick's travel is now capacity-clamped so
  it stops EXACTLY at the fill point (a real bug caught in testing: without
  this, a large tick at high time-compression could drive the combine past
  what its hopper holds and silently discard the excess).
- **New implement: Grain Trailer** (Small 40t/Medium 60t/Large 100t) — a
  normal one-hitch-slot implement like a plow. New "Grain Trailers" shop
  group in the Equipment panel.
- **"Unload Harvester" auto-queues** the instant a hopper fills (or, for the
  last partial load, the instant the field finishes) — no player action. A
  tractor+Grain Trailer picks it up via the same generic task-assignment/
  auto-hitch machinery every other task uses. Four phases (`toHarvester` →
  `onloading` → `toSilo` → `dumping`), each a real point-to-point drive +
  10-sim-second pause (same convention as the baler's tie-and-drop).
- **Dumps into the silo assigned to that crop**; if none exists or the
  crop's pooled silo capacity is full, the trailer waits in place
  (`waitingForSilo`) — surfaced as a ⚠️ on the tractor, the harvester, and
  the queue-panel row, and auto-resumes once the player frees room or
  assigns a silo. An undersized trailer just takes a partial load; a fresh
  trip auto-queues once the hopper fills again — no multi-trip bookkeeping
  needed, it emerges from the normal fill/empty cycle.
- Gotcha fixed: `applyHarvestDone` clears `field.crop` the moment the
  harvest task itself completes, but the trailer for the LAST load doesn't
  arrive until after that — the crop is now captured on the unload task at
  creation time, not re-read from the field later.
- `sellAgent` refuses to sell a harvester with grain onboard. A full
  harvester doesn't participate in the drive-home-when-idle behavior (stays
  put until relieved).
- 9 new tests in `tests/harvestUnload.test.ts`; existing harvest-driving
  tests in `farming.test.ts`/`forage.test.ts`/`plans.test.ts` updated to
  give their fixtures a silo + Grain Trailer (harvest no longer completes
  for free into an unlimited bin).

## Latest changes (2026-07-12, equipment homing)

- **Tractors/harvesters now drive home when idle** (`homeTargetFor` in
  `src/sim/tasks.ts`): after finishing a task with nothing else queued, an
  agent drives to the nearest Tractor Barn with a free slot (occupancy =
  other idle tractors/harvesters already parked at that barn's spot), or the
  nearest Farm Yard if every barn's full/none exists. With no buildings at
  all it stays put — exactly the old behavior. Fills in the gap left by the
  buildings feature (was previously computed-but-unused).
- Implements still don't home (they have no map position of their own —
  they're either hitched or abstractly "in the yard").
- 4 new tests in `tests/homing.test.ts`.

## Latest changes (2026-07-12, buildings)

- **Farm buildings added:** Silo, Bale Storage Barn, Bale Storage Area, Tractor
  Barn, Implement Barn, Farm Yard — placeable via a click-to-place button in
  the Equipment panel's new "Buildings" group, single map click drops it and
  pays `gameConfig.buildings[kind].price`. Click a building's marker for a
  popup with capacity info + a sell button (full refund, same rule as
  land/equipment).
- **Scope note (deliberate cut):** capacity numbers (silo tons, bale-storage
  counts, barn slots) are computed (`src/sim/buildings.ts`) and shown in the
  UI, but nothing yet BLOCKS on them — harvest still banks into the unlimited
  grain bin, bales still sit in-field untouched, and equipment still parks
  wherever a job finishes (no drive-to-barn/yard state exists in `tasks.ts`
  to hook into). New equipment purchases DO spawn at the nearest Farm Yard
  if one's built (falls back to the old county-center spot otherwise). Wiring
  the actual caps/homing is a follow-up pass.
- New save-state array `buildings: Building[]`; migrates old saves to `[]`.

## Latest changes (2026-07-12)

- **Rotation planner UX:** auto-manage is now a plan designer — 1–5 rows per year,
  each with crop + op toggles (Weed/Fertilize/Bale). Plans loop yearly.
- **Concave-field fixes:** cellular decomposition means tractors skip notches (don't
  work through them). Fixes texture run-out, completion snap, and bale placement.
- **Machine icon flip:** now mirror (scaleX) when driving east; stay upright always.
- **Bale marker rendering:** all bales now render (was capped 150); incremental
  append + even subsampling for huge fields.

## Known gaps / unverified

- **Economy is placeholder** — flat sell price. No buyers, capacity, or hauling yet.
- Rotation planner unplayed in real sessions (unit-tested only).
- Drag-reorder in Work Queue unmanually verified.
- Routing uses public OSRM demo (not self-hosted).
- **Browser Preview is OFF** (maintainer directive). New unseen: rotation planner UI,
  cellular-decomposition visuals (transits crossing notches), updated bale markers,
  machine icon flip — logic tested, UX needs eyes.

## How to run

`npm run dev` → http://localhost:5173. Checks: `npm run typecheck`, `npm test`.
**Do not use Browser Preview** — see CLAUDE.md.
