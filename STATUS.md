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

## Recent focus: Field Schedule tab rewrite (2026-08-16)

The "Auto Manage" UI (Field panel → Schedule tab) was rebuilt from scratch,
replacing the tasks-across-the-top / literal-months-down-the-side grid
(2026-07-31 design) with a horizontal timeline matching the Crop Calendar's
look: months fixed across the top, one row per rotation step, green/gold
plant/harvest window bars. New on top of that: an expandable per-row task
key (click a crop to show every optional task — weed/fertilize/mulch/bale/
wrap/silage — as on/off toggle pills; plow/plant/harvest stay mandatory and
always visible), real SVG task icons replacing the old emoji set (which had
two collisions: plant/silage both 🌱, harvest/mow both 🌾; `wrap` gets a
genuinely new icon — it had none before and silently drew a plow icon), and
continuous drag-and-click retiming (always-visible legal ticks positioned by
%, replacing discrete grid cells). The Field panel's Schedule tab alone
grows to 640px (`.fp-main.wide`) to fit; the other three tabs stay compact.

**This initial pass was a pure rendering-layer rewrite** — `sim/rotationTimeline.ts`,
`sim/schedule.ts`, and `FieldPlan`/`Field` in `state/saveState.ts` were
untouched and didn't need to be; `projectRotation`/`legalMonthsFor`/
`setScheduleOverride` already had everything the new renderer needed.
Confirmed via the existing test suite: 965/965 unchanged, zero test files
touched (neither `tests/rotationTimeline.test.ts` nor
`tests/fieldSchedule.test.ts` reaches into `main.ts`). Typecheck clean.
(A same-day follow-up below DID change `sim/schedule.ts` — real rule
changes the maintainer asked for after seeing the rewrite in action.)

**NOT verified live this round** — a Browser Preview session hit a real
tooling problem (not a code problem): screenshots failed with "the Browser
pane is not displayed," and clicks stopped actually reaching the page (Fields
panel wouldn't open even via repeated clicks + a full reload). This is the
first time that's happened this session — distinct from the documented
NAIP-tile-hang risk — so flagging it here rather than guessing at a fix.
**This whole rewrite needs a real eyes-on pass before trusting it in play**:
build a multi-step rotation (bale crop + silage crop + a perennial, to hit
every branch), confirm the header stays pinned while scrolling, bars/icons
render at the right months, the key expands/collapses per row, and both
click-to-move and drag-to-move actually call through to `setScheduleOverride`
(watch for the error text on an illegal drop). The implementation plan this
was built from is at `C:\Users\Hudson\.claude\plans\sunny-squishing-wozniak.md`.

### Follow-up (2026-08-16): plow/mulch rule changes + wider drop targets

Three maintainer-requested changes on top of the rewrite above — the first
two are genuine RULE changes in `sim/schedule.ts`, not just rendering:

- **Plow now defaults to the LAST legal month** (right before, or the same
  month as, planting) instead of "January, else the month after harvest."
  Old default put an overwintering cover crop's plow right after its OWN
  harvest ("the end of the life cycle"); new default puts every crop's plow
  right ahead of its next planting. Trade-off, called out in the code: the
  soft-retry cushion (`plowDueAt`'s "at or after chosen month") now has
  nowhere later to fall back to if the last legal month is missed, since
  there's nothing past it in the ordering — deliberate, not an oversight.
  `DEFAULT_PLOW_MONTH` removed as dead code.
- **Mulch's legal window widened** from a fixed `mulchWindowMonths` (3) cap
  to the same harvest→next-planting gap plow gets — "any months, as long as
  it is after everything else." Confirmed by tracing the sim that this is
  safe: weed/fertilize's own windows always end strictly before harvest by
  construction, so harvest is already the chronologically last of the other
  tasks in every case; only the mulch window's END needed to change.
  `gameConfig.schedule.mulchWindowMonths` removed (now fully unused).
- **Drag-and-drop landing targets widened** from a 3px centered line to a
  full month-wide rectangle (`.fp-sc-legal`, `index.html`) — visually "the
  12 months of the year," matching the header columns above.

8 tests updated/added across `tests/fieldSchedule.test.ts`,
`tests/farming.test.ts`, `tests/mulch.test.ts` — each confirmed via
revert-check to fail against the old code. Typecheck clean, 966/966 tests.
Live browser verification hit the same tooling problem as the initial
rewrite (see above) — still needs an eyes-on pass, same checklist plus:
confirm a field's plow now schedules right before its next planting, not
right after harvest, and that the new drop-target rectangles are actually
easier to hit than the old thin line was.

### Follow-up (2026-08-16): drag-and-drop replaced with click-to-pick

The wider drop targets above exposed a real bug, not just a UI complaint:
plow and mulch now share an identical legal window, so their always-visible
legal ticks landed at the exact same positions and later-painted DOM
elements silently ate earlier ones' clicks — explaining all three symptoms
in the maintainer's report at once ("boxes everywhere," plow not
draggable, mulch "all over the place"). Rather than patch drag-and-drop to
handle the collision, the maintainer asked to drop dragging entirely:

- One transparent slot per display month, not one tick per task — inherently
  collision-free, since there's only ever one clickable element per month.
  A click applies directly when exactly one task is legal there; with more
  than one (now common) it opens a small `.fp-sc-picker` popup to choose.
- Bigger, transparent-by-default slots (dashed outline only on legal months)
  and bigger task-icon chips (28px, 20px icon, up from 20/14).
- All drag machinery removed: `draggingScheduleChip` state, pointer-move/up
  handlers, the `movable`/`dragging` CSS.

### Follow-up (2026-08-16): task-icon stacking, centering fix, label column removed

Three more refinements on the same tab:

- **Same-month task icons now stack vertically** instead of fully
  overlapping — grouped per display month, ordered by `TASK_STACK_ORDER`
  (a real completion-order list, not just cosmetic: e.g. mulch always sorts
  after harvest/mow/bale/wrap/silage since `canMulch` requires the field
  already harvested), and rendered top-to-bottom growing down below the
  plant/harvest bars. Each row's lane height is now computed from its own
  tallest stack instead of a fixed 48px every row paid for.
- **Fixed a centering bug**: chips were positioned at each month's LEFT EDGE
  (`dispAbs(abs)/12*100%`) instead of its center — off by half a month-width
  for every chip, not just the mandatory ones the maintainer flagged.
  Corrected to `(dispAbs(abs)+0.5)/12*100%`.
- **Removed the row-label column** (`.fp-sc-label`, a redundant small
  crop-emoji cell — the name's already on the row header above) and gave
  the freed ~130px back to the 12-month lane. `.fp-sc-grid`'s
  `grid-template-columns` dropped its leading fixed column; `.fp-sc-lane`
  and `.fp-sc-key` now span the full grid width.

Typecheck clean, 966/966 tests (main.ts/index.html only — no sim-layer
changes, so no test file needed updating). Verified this round: zero
console errors on load, and read the live stylesheet directly to confirm
`.fp-sc-grid`/`.fp-sc-lane`/`.fp-sc-chip` compiled with the new rules and
`.fp-sc-label`/`.fp-sc-corner` are gone with no orphaned rules left behind.
**Did not get a full interactive click-through** — the loaded save had no
fields yet (0 ac) so there was no live rotation to open the Schedule tab
against, and drawing one + building a multi-crop rotation to reproduce a
same-month task collision was more setup than this round's tooling budget
covered. Still needs a real eyes-on pass: build a rotation with two tasks
sharing a month (e.g. plow and mulch), confirm the icons actually stack
instead of overlap, confirm the plant/harvest/plow icons visually center
over their month column, and confirm the picker popup and slot clicks still
work now that the lane spans the full width.

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
- **The just-rewritten Field Schedule tab needs a live pass** (see "Recent
  focus" above) — typecheck/tests are clean but nobody has actually clicked
  through it in a browser yet.
- Routing runs on the public OSRM demo instance, not self-hosted.

## How to run

`npm run dev` → http://localhost:5173. Checks: `npm run typecheck`, `npm test`.
Browser Preview is on — see `CLAUDE.md` for the NAIP-hang caveat before a live
gameplay session.
