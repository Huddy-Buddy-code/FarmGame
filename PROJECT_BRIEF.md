# Farm Logistics Sim — Project Brief

> **Living doc.** Feed this to Claude Code at the start of every session. Update it when a decision changes. It is the single source of truth for scope, architecture, and design intent.

---

## 1. The Pitch

A browser-based farm-and-ranch **logistics & economy** simulator played from a top-down map view over **real satellite imagery** of a real US county. You buy land, draw fields, grow crops, and — the heart of the game — **move that produce profitably** to real buyers on real roads under real distance and fuel costs. The core fantasy is *planning*: forward-selling an uncertain harvest via contracts, then scheduling equipment and trucks to fulfill them.

**Core loop:** Draw field → plant (pay inputs, uncertain yield) → work fields over the season (equipment, wages, fuel) → sell via spot market and/or pre-signed contracts → route trucks on real roads to buyers → get paid → reinvest / service debt → repeat next season.

---

## 2. Platform & Stack (all free / open, web-native)

- **Renderer / map surface:** MapLibre GL JS (open fork of Mapbox — no licensing restrictions).
- **Game & economy logic:** TypeScript.
- **Satellite base layer:** USDA **NAIP** imagery (public domain, ~0.6–1m, US farmland). One county, served as tiles.
- **Roads + real destinations:** **OpenStreetMap** (extract via Geofabrik; buyers/elevators/mills via Overpass API). *License: ODbL — attribution required; revisit share-alike before monetizing.*
- **Routing engine:** OSRM or Valhalla, loaded for the single county only → real drive-time + distance.
- **Save/state:** IndexedDB in-browser.
- **Version control:** git from commit #1. Non-negotiable.

> ⚠️ **DO NOT** use Google Maps/Earth imagery, tiles, or elevation. Their terms explicitly prohibit tracing, terraforming, building on their content, and displaying near a non-Google map. NAIP is the sanctioned equivalent.

---

## 3. Coordinate System (decide once, convert at the edges)

**The #1 architecture trap. Get this wrong and fields, dots, and paint overlay silently drift apart.**

- **Internal game logic:** work in **UTM meters** for the county's zone. NAIP is already UTM; meters make distances, speeds, and areas real and trivial.
- **Rendering:** convert to lng/lat for MapLibre (uses proj4js at the boundary).
- **Data ingest (OSM / routing):** native lng/lat, converted in at the edge.
- Rule: **one internal metric space; convert only at ingest and render boundaries.**

---

## 4. Architecture Pillars (scaffold these from day one)

- **Single config object** — *every* balance-affecting number lives here (interest rate, demand recovery rate, fuel cost/mile, yield-range width, penalty severity, condition curve, etc.). Nothing balance-related is hardcoded. This object is how we (a) find the fun in playtesting and (b) get difficulty modes for free.
- **Simulation clock** — one authoritative sim-time, independent of framerate, with pause and time-compression built in. Agents, crop growth, wages, market, and contracts all read from it. Must support **queued future actions** (e.g. "dispatch 4 trucks on Oct 7").
- **Geo-referenced raster overlay engine** — ONE module powers three features: (1) the 2D "painter" edits, (2) field-status textures, (3) the fieldwork reveal. Paint in **geo-space, not screen-space.** Never modify NAIP tiles; composite edits on top so they're reversible and pinned to real coordinates.
- **Save-state shape** — define early; it's the backbone everything reads/writes (parcels, field status, agents, money, clock, contracts).

---

## 5. Economy Model — Hybrid Market

- **Global baseline:** each crop has a scripted base price with a seasonal curve + noise.
- **Local buyers:** finite capacity. Deliver too much to one buyer → their price drops.
- **Recovery:** **time-based** — each buyer refills capacity at its own steady rate. Learning those rhythms is player skill.
- **Background AI farmers:** NOT in v1. Design the buyer model so ambient actors can plug in later without a rewrite.
- **Three levers when a local price tanks** (this tension IS the game):
  1. **Store** — on-farm storage (costs money/capacity; a *bet* that prices recover).
  2. **Haul farther** — a better buyer exists, but drive-time + fuel eat the margin.
  3. **Sell anyway** — take the hit, keep cash flowing.

**Critical balance ratios (keep tunable, find via playtest):** buyer recovery rate vs. player output; fuel/haul cost curve; storage cost + capacity. These three ratios *are* the game's difficulty.

---

## 6. Contracts & Yield Uncertainty (the "planning" mechanic)

- **Contracts** = forward sales signed in advance (e.g. March) against a future harvest. Safer, known price; but you're locked in and exposed.
- **Terms on the paper:** crop, quantity, buyer/destination, **delivery window** (not a single hard day), locked price, shortfall penalty.
- **Fulfillment:** paid contract price per unit *delivered*; pay penalty on the *shortfall* quantity (partial credit, not all-or-nothing).
- **Scheduling:** player **pre-schedules** trucks/equipment against the future (requires the sim clock's queued-action support).
- **Contract board:** refreshes over time; choosing *which* to accept (safe-local vs. lucrative-distant) is itself a decision.
- **Yield uncertainty = genuinely uncertain, but TRANSPARENT.** This is the crux mechanic:
  - Show a **confidence range** that **narrows as harvest approaches** (wide in March, tight by August). True yield lands somewhere inside it.
  - Randomness around a *visible, narrowing* estimate = fair gambling (fun). Hidden randomness = feels arbitrary (rage-quit). **Show the range; don't hide the number.**
  - This rewards conservative over-planning — never contract more than your conservative estimate. Realistic *and* keeps the decision replayable forever.
  - Requires a **lightweight** yield model in v1: a value starting as a wide random range, narrowing over the season, nudged by a couple of weather events. Not a climate sim — just a narrowing number.

---

## 7. Progression & Difficulty

- **Open-ended growth**, no hard win state.
- **Soft milestones** mark progress (first tractor, acreage thresholds, first big contract, record season). **Same milestones in both difficulty modes** — difficulty changes how hard they are to reach, never whether they exist.
- **Optional debt/solvency pressure** — a loan / seasonal costs give the risk layer teeth.
- **Difficulty = two presets over the single config object** (not two games):
  - **Realistic/hard:** failure possible — worse interest, volatile demand, harsher/more frequent bad seasons, tighter yield uncertainty, stiffer penalties.
  - **Casual:** steady demand, favorable rates, gentle weather, forgiving penalties — effectively can't be forced out.

---

## 8. Cost Model (v1)

Every cost activates a system already being built — no decorative numbers.

- **Capital (lumpy):** land, equipment, trucks. (Loan-funded expansion lives here.)
- **Recurring (steady):** wages (idle workers = real loss), loan interest (the difficulty dial).
- **Variable (per-activity):** fuel (makes routing economic — the counterweight that makes distance & local demand matter; **do not cut this**), planting inputs (paid in spring vs. uncertain fall — reinforces the contract gamble).
- **Equipment condition → efficiency** (NOT failure yet): degrades with use; low condition = slower work + worse fuel economy + higher maintenance cost.
  - Make the condition→efficiency curve **non-linear** (90% feels fine; 40% hurts noticeably). Curve shape is a tunable constant.
  - Creates the "service now or squeeze another season?" decision, and lays the substrate for adding failure later.
- **Deferred:** breakdowns/failure events, insurance, taxes, storage upkeep.

---

## 9. Agents ("GPS dots")

- Player + all workers, tractors, equipment, trucks render as dots on the map.
- Each = a **state machine** (idle → drive to field → work → drive home) + a route.
- Routes: OSRM/Valhalla on real roads; simple A*/straight-line for off-road inside fields.
- Daily schedules key off the sim clock ("go home at night" = a time-of-day rule).
- Perf: dozens of agents = trivial; if scaling to hundreds, push to web workers and simplify off-screen agents.

---

## 10. Fieldwork & Textures

- Player designs the tractor+equipment **path** (offer both auto-generated efficient coverage AND hand-drawn); width + speed → realistic completion time. The efficient-vs-sloppy gap is an optimization.
- Fields run a **state machine**: stubble → tilled → planted → growing (stages) → ready → harvested → stubble.
- **Procedural texture fills** (chosen over baked images): tint/blend procedurally for crop, growth stage, season, and weather. Lighter and flexible.
- The tractor "performing the task" = progressively revealing the new texture along the swept path via the overlay engine (§4). Nearly free, deeply satisfying.

---

## 11. The 2D "Painter" (terraforming, reframed)

- **Clone-stamp / healing-brush model**, NOT 3D sculpting. Eyedropper samples a nearby patch of the *same* land type; clone it over an eyesore (building, road, forest).
- Uses the same geo-referenced overlay engine (§4). Paint into the overlay, never the NAIP tile. Geo-space so edits don't drift on zoom/pan.

---

## 12. v1 Vertical Slice (build in this order)

1. **Data spike FIRST (biggest unknown):** prove NAIP imagery renders in MapLibre for one chosen county, with OSM roads + routing loaded. Nothing else until this works.
2. Buy one parcel → draw one field (overlay engine).
3. Plant one crop (pay inputs, get an uncertain narrowing yield range) → grow via sim clock → harvest into tons.
4. One capacity-limited truck routes on **real roads** to a **real buyer**, costing drive-time + fuel.
5. Sell at local market price (with local-demand drop) → get paid → loop closes.
6. Then layer on: contracts, storage, multiple buyers, wages/workers, equipment condition, difficulty presets.

*If moving grain profitably in steps 1–5 is fun, the game works. Everything else is additive.*

---

## 13. Process Rules

- **git from commit #1.** Commit per working slice so a bad session is one `git reset` away.
- **This doc is fed to Claude Code every session** — keep it current; it prevents the codebase from drifting over a long project.
- **Build in playable vertical slices**, never all-systems-at-once. Every slice must be something you can actually *play*, even if ugly.
- **All balance numbers → the config object** (§4). No exceptions.
- **Legal:** NAIP public domain (fine). OSM is ODbL — attribution now, verify share-alike obligations before any monetization. Not a lawyer; confirm before money enters.
