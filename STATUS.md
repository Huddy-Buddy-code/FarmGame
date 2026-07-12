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
