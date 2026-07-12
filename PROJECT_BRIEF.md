# Farm Logistics Sim — Project Brief

> **Living doc** fed to Claude Code each session. Single source of truth for scope,
> architecture, and design intent. History/session log lives in `STATUS.md`.

## 1. Pitch

Browser-based farm logistics & economy sim over real satellite imagery (one county).
**Core loop:** Buy land → grow crops → **move produce profitably** to real buyers on
real roads under real fuel/time cost. The fantasy is *planning* — forward-sell an
uncertain harvest via contracts, then schedule equipment/trucks to fulfill them.

## 2. Stack (all free/open)

- **Renderer:** MapLibre GL JS. **Logic:** TypeScript.
- **Imagery:** USDA NAIP (public domain, ~0.6–1m). **Roads:** OpenStreetMap (ODbL).
- **Routing:** OSRM or Valhalla. **Save:** IndexedDB. **VCS:** git from day one.

> ⚠️ Never Google Maps/Earth — ToS forbids tracing. NAIP is the approved equivalent.

## 3. Coordinate system

**Architecture rule #1.** Internal logic in **UTM meters** (NAIP's native space;
makes distance/speed/area trivial). Convert to lng/lat only at MapLibre render
boundary; OSM/routing data converts in at ingest.

## 4. Architecture pillars

- **Single config object** (`gameConfig.ts`) — all balance numbers live here, nothing
  hardcoded. Enables playtesting and free difficulty modes.
- **Sim clock** — one authoritative time source; pause + time-compression; queued
  future actions ("dispatch Oct 7").
- **Overlay engine** — powers painter edits, field textures, fieldwork reveals;
  paints in geo-space, never modifies NAIP tiles.
- **Save-state shape** — defined early (parcels, fields, agents, money, clock,
  contracts); everything else reads/writes it.

## 5. Economy — hybrid market

- Global baseline price (seasonal + noise) + local buyers with finite capacity
  (oversupply → price drop; recover over time at their own rate).
- **Core tension:** store on-farm (bet on recovery) vs. haul farther (better price,
  costs fuel/time) vs. sell anyway.
- Tunable levers: buyer recovery rate, fuel/haul curve, storage cost = difficulty.

## 6. Contracts & yield uncertainty

- Contracts = forward sales (crop, qty, buyer, window, locked price, shortfall
  penalty). Paid per unit delivered; penalty on shortfall only.
- Player pre-schedules trucks/equipment against the future.
- **Yield = uncertain but transparent:** show a confidence range that **narrows as
  harvest approaches** (wide in spring, tight by fall); true yield always lands
  inside it. Rewards conservative over-planning.

## 7. Progression & difficulty

- Open-ended, no hard win. Soft milestones (first tractor, acreage, first big contract).
- **Difficulty = two presets:** Realistic (worse interest, volatile demand, tighter
  yield uncertainty, stiffer penalties) vs. Casual (steady, favorable, forgiving).

## 8. Cost model

- **Capital:** land, equipment, trucks.
- **Recurring:** wages, loan interest (the difficulty dial).
- **Variable:** fuel (makes routing/distance matter), planting inputs (paid spring,
  uncertain fall payoff).
- **Equipment condition → efficiency:** degrades non-linearly with use.

## 9. Agents ("GPS dots")

Player + workers/tractors/trucks as map dots. State machine: idle → drive → work →
drive home. Routes via OSRM/Valhalla (roads) or straight/A* (off-road). Schedule
keyed to sim clock.

## 10. Fieldwork & textures

Coverage path (auto-generated or hand-drawn); width × speed → completion time.
Field lifecycle: stubble → tilled → planted → growing → ready → harvested →
stubble. Procedural textures (not baked images). Machine "working" = revealing
new texture along swept path.

## 11. 2D painter (terraforming, reframed)

Clone-stamp/healing-brush — eyedrop a nearby patch, stamp it elsewhere. Uses the
overlay engine; paints into geo-pinned overlay, never NAIP tile.

## 12. v1 vertical slice (build order)

1. Data spike: prove NAIP + MapLibre + OSM roads/routing for one county.
2. Buy parcel → draw field.
3. Plant → uncertain narrowing yield → grow → harvest.
4. One truck routes real roads to real buyer (fuel + drive-time cost).
5. Sell at local market (with demand drop) → get paid → loop closes.
6. **Then:** contracts, storage, multiple buyers, wages, equipment condition, difficulty.

**Critical gate:** *If moving grain profitably in 1–5 is fun, the game works.*

## 13. Process rules

- **git from commit #1.** Commit per working slice. Keep this doc current.
- Build **playable vertical slices**, never all-systems-at-once.
- **All balance numbers → config object.** No exceptions.
- OSM is ODbL — attribute now, confirm share-alike before monetizing.
