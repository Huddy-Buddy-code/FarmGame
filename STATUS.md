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

## Latest changes (2026-07-13, Work Queue readability pass + equipment-name reorder)

- **Work Queue stays opaque always** — dropped the hover-to-reveal fade
  (`#queuepanel` split out of the shared `#todolist` opacity rule, which
  keeps its own fade unchanged).
- **Bigger icons**: the tractor/combine icon in each row's corner and the
  per-task implement icon both bumped up (18px→32px, 16px→30px).
- **Implement info line** for every active task ("Plow - Medium, 10 ft
  Working Width", "Grain Trailer - Medium, 60 t Capacity", …) —
  `implementInfoText()` in main.ts, reading straight from `gameConfig`.
- **Labeled fill bars** for Combine/Baler/Grain Wagon: current amount + %
  overlaid on the bar itself (e.g. "11.1 t · 23%"), total off to the right
  ("50 t"). Baler shows whole bales dropped/total instead of tonnage (it has
  no tonnage figure) — same current/total/% shape.
- **Equipment name format flipped everywhere**: "Small Tractor" → "Tractor -
  Small" (`sizedName`/`makeAgent` in tasks.ts, `buildingDisplayName`'s silo
  case, the equipment-shop button tooltip). Natural-language sentences
  ("a small tractor costs $X", "can't pull a small plow") were left as
  prose, not touched — only actual entity NAMES changed format. 3 tests
  updated for the new name strings; 174/174 total, typecheck clean.
- **UX needs eyes** (no Browser Preview): the new implement-row layout at
  280px queue-panel width — check nothing wraps awkwardly with long info
  lines (Large sizes, "Grain Trailer - Large, 100 t Capacity" is the
  longest case).

## Latest changes (2026-07-14, hour chip moved onto the day bar, 6am/6pm endpoints added)

- Continuing the vertical-space reclaim: the live hour-chip (was floating
  ABOVE `.daybar` in the panel's top padding) now sits ON the bar, vertically
  centered (`top:50%; transform:translate(-50%,-50%)`), same treatment as
  the month-chip already got relative to the season bar. `.daybar` grew
  10px→22px tall to match `.seasons` (maintainer request: "same size as the
  season [bar]").
- Added fixed `6am`/`6pm` endpoint labels flex-pinned to the bar's corners
  (`justify-content: space-between`) — distinct from the moving hour-chip,
  which still rides the middle showing the live rounded hour. They're plain
  flex children; the absolutely-positioned hour-chip is out of flow so it
  doesn't interfere with the two-item space-between.
- `#yearbar`'s top padding, no longer needed to clear a floating chip,
  dropped from 36px back to a plain 6px — the bulk of this session's
  "reclaim vertical space" ask. `#timebar` moved up to match
  (`top: 174px → 156px`).
- No JS changes: `placeChip` (main.ts) only ever set `.style.left`, and the
  chip's vertical position/centering is pure CSS — unaffected by moving it
  from "above the bar" to "on the bar".
- 188/188 passing, typecheck clean (HTML/CSS only).
- **UX needs eyes** (no Browser Preview): the hour-chip pill sitting on top
  of the gradient bar (contrast/legibility at different times of day), and
  whether it visually collides with the 6am/6pm endpoint labels when the
  live hour is near either edge (accepted per the request, not treated as
  a bug, but worth a look).

## Latest changes (2026-07-14, season labels moved into the bar — separate label row removed)

- Maintainer confirmed the hour-chip class-collision fix worked, then asked
  to reclaim vertical space: moved "🌱 Spring / ☀️ Summer / 🍂 Fall / ❄️
  Winter" OFF their own row and INTO the season bar's segments directly —
  `.seg` divs now hold the text (flex-centered), the bar grew 10px→22px tall
  to fit it, and the standalone `.labels` row + its dead CSS were deleted.
  Text color is `--wood-dark` on all four pastel segment backgrounds
  (spring/summer/fall/winter) — same token already used for the hour/month
  chip text, should read fine on light pastels but worth an eyeball.
  Season-name color-per-segment wasn't customized (see UX-needs-eyes below).
- Reclaimed the labels row's old `margin-top: 34px` (which existed only to
  clear the month-chip) as `#yearbar`'s own `padding-bottom: 34px` instead —
  same clearance, no separate row needed. Net: `#yearbar` shrank, so
  `#timebar` moved up to match (`top: 183px → 174px`).
- 188/188 passing, typecheck clean (HTML/CSS only, no JS/logic touched —
  `main.ts` never referenced the removed `.labels` markup).
- **UX needs eyes** (no Browser Preview): text contrast/readability on each
  of the 4 segment colors (spring green, summer yellow, fall orange, winter
  pale-blue) — `wood-dark` may read weaker on the lighter segments than it
  did on the cream panel background the old label row sat on.

## Latest changes (2026-07-14, ROOT CAUSE of the "time chip is cut off" saga: a CSS class collision)

- Real cause, after several wrong guesses (see the three entries below — all
  treated it as a sizing/spacing problem and none of them fixed it). The hour
  chip was `<div class="marker" id="day-marker">`, reusing the SAME class as
  the season track's 3px tick line. `#yearbar .marker` sets `width: 3px`, and
  `#yearbar .daybar .marker` (higher specificity, so it won on the props it
  declared) never declared a width — so `width: 3px` leaked straight in. With
  `white-space: nowrap`, the pill was a 3px-wide box that its own text spilled
  out of. The chip was never "too small": it was 3px wide by inheritance.
- Explains every symptom, including the ones that made the earlier fixes look
  arbitrary: raising font-size made the spill WORSE (more text, same 3px core);
  raising padding only grew a frame around the 3px core so it half-helped; and
  the month chip was ALWAYS fine in every screenshot because `.month-chip` is a
  different class that never touched the leak. The `marker` class was a leftover
  from when this was a sun/moon emoji — with no background/border, a 3px box
  with overflowing content still looked centred, so the bug hid until the pill
  got a visible outline.
- It also silently broke the previous commit's clamp: `placeChip` measured
  `offsetWidth` (26px — the 3px box + padding/border) while the text visually
  extended well past it, so it clamped against a phantom width. That fix should
  actually work now that the pill's box matches its text.
- Fix is structural, not another nudge: renamed the chip's class to `hour-chip`
  so it can't inherit the tick's rules by construction, merged the two
  now-identical chip rules into one `#yearbar .hour-chip, #yearbar .month-chip`
  block (position deltas split into one-liners), and left a comment on
  `#yearbar .marker` warning that its `width: 3px` is why a chip must not reuse
  that class. `main.ts` addresses both chips by id, so it needed no change.
- 188/188 passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): the hour pill should finally wrap its
  text properly — and with a real width, check the 6am/6pm clamp too.

## Latest changes (2026-07-14, clamp hour/month chips so they stop overhanging the panel)

- The long-running "chip looks cut off" problem the maintainer had been
  chasing. The chips are centred on their position (`translateX(-50%)`), so
  an unclamped pill hangs half its own width past the end of its track — and
  the `#yearbar` panel edge is only ~12px beyond that. NOT an edge case: the
  day chip hits it every morning at 6am (frac 0) and evening at 6pm (frac 1),
  and the month chip every March and February.
- Added `placeChip(chip, text, frac)` in `main.ts`: sets the text first (the
  clamp needs the chip's final rendered width), then centres it at
  `frac × trackWidth` clamped to `[half, trackWidth − half]` so the pill
  always lands fully inside its track. Has a guard for a chip wider than its
  own track (can't be clamped in — centres instead), and bails when the chip
  is `display:none` (`offsetParent` null). Replaced both markers' old
  `style.left = "N%"` assignments.
- Clamped in JS, not CSS, because it needs the RENDERED width — which depends
  on the chip's text ("6am" vs "12pm", "May." vs "Sep."), so CSS can't know it.
  Safe perf-wise: it reads layout, but `updateHud` runs ~2×/s (throttled), not
  per-frame, and already does heavier work (`netWorth` walks every field/agent/
  implement each call). Noted in the JSDoc not to call it per-frame.
- 188/188 passing, typecheck clean. Deliberately did NOT add a unit test: the
  clamp is a min/max, main.ts isn't importable from the DOM-less test env, and
  a test wouldn't have caught either real bug in this area (both were pure
  layout — `overflow:hidden` clipping, inherited `line-height`).
- **UX needs eyes** (no Browser Preview): scrub to 6am and 6pm, and to March
  and February, and confirm the pills stop flush inside the bars instead of
  hanging over the panel edge.

## Latest changes (2026-07-14, hour chip cut off — pinned line-height, reserved real room)

- Maintainer: the hour pill was still clipping its own text ("1pm" cut off).
  Root cause wasn't the pill being too small — it was OVERFLOWING the panel.
  The chip inherited the body's `font: 14px/1.45`, so at 12px font its line
  box was 17.4px; add padding + borders + the 4px offset and it needed
  ~30px above `.daybar`, but `#yearbar` only reserved 27px of top padding.
  The excess crossed `#yearbar`'s own 2px panel border, reading as a
  cut-off label.
- Fixed properly rather than by nudging: pinned `line-height: 1.35` on both
  chips so their height is predictable instead of inherited from a body rule
  meant for prose, then reserved room from that measured height —
  `#yearbar` padding-top 27→36px, `.labels` margin-top 24→34px, and
  `#timebar` top 164→183px to follow the taller panel. Also bumped chip
  padding 3px 9px→4px 10px for a bit more breathing room around the text.
- 188/188 passing, typecheck clean (CSS only).
- **UX needs eyes** (no Browser Preview): confirm "12pm"/"1pm" now sit fully
  inside their pill with the panel border clear of it.

## Latest changes (2026-07-14, hour/month chip was too small — bumped size)

- Maintainer: "the bubble around the time of day, it's too small" — text was
  nearly touching the pill's edges. Bumped both chips: font-size 10.5→12px,
  padding 1px 5px→3px 9px, border-radius 6→8px.
- Grew the space reserved for the now-taller chips to match: `#yearbar`'s
  top padding 20→27px, the season `.labels` row's top margin 17→24px
  (+14px total), and shifted `#timebar` down to match (`top:150px→164px`).
- 188/188 passing, typecheck clean (CSS only).
- **UX needs eyes** (no Browser Preview): confirm the chips now have
  comfortable breathing room and nothing crowds below the taller year bar.

## Latest changes (2026-07-14, hour/month chip shadow was too heavy for their size)

- Maintainer flagged the hour chip ("Check the time icon") after the
  overflow-clip fix — it rendered with a smudgy, tail-like blob under it
  instead of a crisp small label. Cause: both chips used `box-shadow:
  var(--shadow)` (`0 3px 10px rgba(60,40,15,0.35)`), a heavy shadow sized
  for full panels (topbar/yearbar/timebar), applied to a ~30×16px pill —
  the 10px blur radius on something that small reads as a shapeless smudge,
  not a shadow. Swapped both chips to a tight `0 1px 3px rgba(60,40,15,0.3)`
  scaled to their actual size.
- 188/188 passing, typecheck clean (CSS only).
- **UX needs eyes** (no Browser Preview): confirm both chips now read as
  clean small pill labels.

## Latest changes (2026-07-14, month-chip fix: was invisible, clipped by overflow:hidden)

- Maintainer reported the new month-chip (previous entry below) never
  appeared — only the hour chip showed. Root cause: `.month-chip` was a
  child of `#yearbar .seasons`, which has `overflow: hidden` (needed to clip
  the 4 colored segment divs to the bar's rounded-pill corners). The chip's
  `top: 100%` position placed it just outside `.seasons`'s own box, so the
  same overflow rule that rounds the bar was silently clipping the chip
  into nothing.
- Fixed by wrapping `.seasons` in a new `.season-track` (position: relative,
  no overflow clipping) and moving `#month-marker` OUT to be a sibling of
  `.seasons` instead of a child — same visual position (`top: 100%` of the
  wrapper lines up with the bottom of `.seasons` inside it), just no longer
  inside the clipped box. `main.ts`'s `$("month-marker")` lookup is
  unaffected (id-based, doesn't care about nesting depth).
- Noted in passing, not touched: the season-track's tick-line `#yearbar
  .marker` (`top:-3px; bottom:-3px`) is ALSO inside the clipped `.seasons`
  box, so its 3px protrusion above/below the bar has likely always been
  silently clipped too — pre-existing, out of scope for this fix.
- 188/188 passing, typecheck clean (HTML/CSS only).
- **UX needs eyes** (no Browser Preview — did not reach for it this time):
  confirm the month chip now actually renders below the season bar.

## Latest changes (2026-07-14, live hour/month chips replace the sun/moon icon)

- Day-bar and season-bar markers now show LIVE, rounded-to-the-unit text
  chips instead of an emoji: the day-bar marker reads the current clock hour
  ("6am"…"6pm", `hourLabel()` in `main.ts`, rounds `dayFraction` to the
  nearest hour across the 6am–6pm workday) floated just above the bar; a new
  `#month-marker` chip on the season bar reads the current month ("Jun.",
  "Oct.", via `MONTH_SHORT`) floated just below it, riding the same
  `yearFraction` position as the existing tick-line year-marker. Both are
  small pill-styled chips (cream bg, wood border) — no sun/moon emoji left
  anywhere.
- Made room per maintainer's "spread them out" note: `#yearbar`'s top
  padding grew 3px→20px (room for the hour chip above the day-bar) and the
  season `.labels` row's margin-top grew 1px→17px (room for the month chip
  below the season bar) — net +33px panel height, so `#timebar` (the speed
  buttons, stacked right below) moved from `top:117px` to `top:150px` to
  stay flush against the taller year bar.
- No sim-logic changes — pure display; 188/188 passing, typecheck clean.
- Accidentally reached for the (banned-in-this-project) Browser Preview tool
  out of habit while eyeballing a CSS layout change — caught it before
  navigating/screenshotting and stopped the server immediately. Verified via
  typecheck+tests and careful reading only, per this repo's process rule.
- **UX needs eyes** (no Browser Preview): whether the two new floating
  chips read clearly at the shared header width, and whether +33px of
  vertical panel height crowds anything below it (the Work Queue panel on
  the right sits independently at `top:170px` and wasn't touched — worth
  confirming it still clears the taller year bar visually).

## Latest changes (2026-07-14, fixed month/year speed tiers — they overshot)

- Maintainer asked to double-check the speed-tier descriptions after the
  12-hour-day + 3-day-month changes. Math check: 12× is EXACTLY "1 hr = 1
  day" unconditionally (day length is a fixed constant, not a knob) — no
  issue. But 60×/720× (labeled "1 hr = 1 month" / "1 hr = 1 year") were
  calibrated for the OLD 24h-day/30-day-month calendar; under the new 12h
  day + 3-day-month default they actually deliver ~1.67 months / ~1.67
  years per real hour — a 5/3× overshoot, not what the label promises.
- Replaced 60×→36× and 720×→432× (ids `spd-36`/`spd-432`), which land
  exactly on "1 hr = 1 month" / "1 hr = 1 year" at the 3-days/month default.
  Updated `SPEED_MULT` (restoreSpeed) and the tooltip text (now notes "at 3
  days/month" since a save carrying a pre-2026-07-14 days-per-month value —
  the dropdown is hidden but old saves still load their own value — will
  drift off this).
- 188/188 passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): confirm the "1 hr = 1 month" /
  "1 hr = 1 year" buttons now feel right (a real hour of Real-Time/12×/36×/
  432× play advancing roughly a day/month/year respectively).

## Latest changes (2026-07-14, 12-hour workday calendar + speed-tooltip ×s + 3-day months)

- **Confirmed with maintainer** (not a cosmetic-only change): a game "day" is
  now the 12-hour daylight workday, 6am–6pm — no night is modeled at all.
  `MINUTES_PER_DAY` (`sim/calendar.ts`) is now `12*60` instead of `24*60`.
  Every downstream calc (`dateOf`, `minutesPerMonth`, `daysBetween`, the
  day-position marker) derives from this one constant, so it cascaded
  cleanly — no other hardcoded 24h/1440 assumptions existed in source.
- **Days-per-month default dropped 30 → 3** (`DEFAULT_DAYS_PER_MONTH`); the
  days/month `<select>` is hidden (`style="display:none"`, not removed —
  same treatment as the pause/3600× speed buttons) and given a matching new
  "3 d/mo" option as its default-selected entry.
- **Day-position bar redrawn as all-daylight**: since the whole game day IS
  the workday, the gradient (`#yearbar .daybar`) dropped its midnight/night
  segments — dawn-to-noon-to-dusk only — and the marker is always ☀️ (no 🌙
  branch anymore).
- **Speed button tooltips now show the ×**: "Real time — 1 real second = 1
  game second (1×)", "...(12×)", "...(60×)", "...(720×)", "...(3600×)".
- **Test fallout + fix**: `tests/farming.test.ts` had several fixtures
  (`WINTER_1`, `APRIL_1`, a "seed on day 15" test) that implicitly relied on
  the module's default `daysPerMonth` staying 30 — some computed once at
  import time, others via a mid-file mutate-then-restore test whose restore
  value (hardcoded 30) no longer matched the new true default (3), so the
  frozen constants and later live calls drifted out of sync. Fixed by
  pinning `setDaysPerMonth(30)` explicitly at the top of that file (it's
  legitimately a "30-day-month world" fixture file, not a claim about the
  production default) rather than changing its many hardcoded day-offsets.
  Added `tests/calendarDefaults.test.ts` (a clean, unpinned file) to pin down
  the actual production defaults going forward.
- 188/188 passing (2 new), typecheck clean.
- **UX needs eyes** (no Browser Preview): the day-bar's new all-daylight
  gradient/marker, the hidden days/month dropdown, and the speed tooltips.

## Latest changes (2026-07-14, sim-speed ladder relabel: Real-Time / 1hr=1day / 1hr=1month / 1hr=1year)

- Renamed/re-tiered the time-control bar (`index.html` `#timebar`, wired in
  `main.ts` `wireTimeControls`): `1×` → "Real-Time"; new 12× button "1 hr =
  1 day"; `60×` relabeled "1 hr = 1 month" (unchanged multiplier); new 720×
  button "1 hr = 1 year". Pause (`spd-pause`) and the old `3600×` tier are
  hidden (`style="display:none"`) but NOT removed — still in the DOM and
  still wired, in case they're wanted back.
- Found and fixed a latent bug while wiring the new tiers: `restoreSpeed()`
  (used after the skip-month montage) had a hand-rolled 3-way ternary that
  only knew `spd-60`/`spd-3600`/default-1 — picking the new 12×/720× buttons
  and then skipping a month would have silently dropped back to 1× afterward.
  Replaced with a `SPEED_MULT` lookup table covering all 5 ids.
- `#timebar` CSS: added `flex-wrap`/`row-gap` and shrank `.spd` font-size
  slightly so the longer text labels don't overflow the shared `--hud-w`
  header width.
- No sim-logic changes; 186/186 passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): the new button labels/spacing at
  the shared header width, and that clicking each of the 4 visible tiers
  actually changes speed as expected.

## Latest changes (2026-07-14, round displayed $ figures to nearest $100)

- New `round100()` display-only helper (`main.ts`) — the underlying save-state
  numbers stay exact; only on-screen text coarsens. Applied to: HUD header
  (cash, net worth), Work Queue Completed rows' `-$cost`/`+$revenue`, Finance
  panel's cashflow table cells (`cfAmount`) and loan lines (pending balance,
  principal owed, monthly payment). Left EXACT (deliberately not rounded):
  transactional button labels that promise a specific charge/refund — "Cancel
  and refund $X", "Pay off $X" — since those are the literal amount that will
  move, not a summary figure.
- No logic/tests affected (display formatting only); 186/186 passing,
  typecheck clean.
- **UX needs eyes** (no Browser Preview): confirm the rounded figures read
  right at a glance, especially small completed-task costs (e.g. a $40 fert
  bill now shows as "—" in the cashflow table, $0 after rounding).

## Latest changes (2026-07-14, Active/Queued machine name + tighter row spacing)

- **Machine name on Active rows too** (previously Completed-only): `buildQueueRow`
  now prints `agent.name` under the title for active jobs (generic tasks and
  unloadHarvester), matching the Completed rows' `.qr-machine` styling.
- **Shorter rows**: trimmed `.queue-row` padding/margin, `.qr-impl`'s
  margin/padding-top, `.impl-fillrow` margin, and the progress bar's height/
  margin; tightened `line-height` on name/sub/machine text. Implement icon
  eased back from 42px to 36px (still bigger than the pre-session 30px) —
  net effect: noticeably shorter cards without losing the larger-text
  readability pass from earlier today.
- 186/186 passing, typecheck clean (no logic changed, styling/markup only).
- **UX needs eyes** (no Browser Preview): row height/spacing at a glance,
  especially with 3+ active jobs stacked.

## Latest changes (2026-07-14, Completed section: sales + machine name + readability)

- **Sales now log to the same Completed feed**: selling grain (Inventory),
  selling all bales of a product (Inventory), and selling one field's bales
  (field panel) each push a `sellGrain`/`sellBales` record via the new
  `appendCompletedTask` export (`sim/tasks.ts`) — done directly in `main.ts`
  (`logSale` helper) since a sale isn't a `FarmTask`, `economy.ts` stays a
  pure sell function. Records carry `revenue` (no `costPaid`) and a display
  `label` (crop or bale-product name) since a bulk bale sale isn't tied to one
  field. `CompletedTask.type` widened to `TaskType | "sellGrain" | "sellBales"`,
  `fieldId`/`acres`/`costPaid` now optional to fit sale-shaped records.
- **Machine name shown on completed task rows**: `recordCompletion` now takes
  the `Agent` and stores `agentName`; the completed row renders it under the
  title (`.qr-machine`, italic).
- **Green income / red expense**: completed rows color `-$cost` red
  (`.amt-neg`) and `+$revenue` green (`.amt-pos`), reusing the existing
  `--red`/`--green-dark` tokens.
- **Readability pass**: bumped Work Queue text sizes (task title 13→14px, sub
  11→12px, section headers 11→12px, implement name/detail/fill-label ~1px
  each) and the implement icon (`IMPLEMENT_QUEUE_ICON_PX` 30→42).
- 1 new test (`appendCompletedTask` logs a sale shape + caps at 200 entries)
  plus an `agentName` assertion added to the existing plow test. 186/186
  passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): the sale rows' wording/colors, the
  machine-name line, and whether the larger text/icons still fit the panel
  width without wrapping awkwardly.

## Latest changes (2026-07-14, Work Queue "Completed" section + baler fill-bar sync fix)

- **Baler fill-bar desync fix**: the Work Queue's dirty-check key (`refreshQueuePanel`)
  only bucketed `doneAcres` progress at 1% — implement `cargoTons` (the baler/
  harvester/trailer hopper) wasn't in the key at all, so at high sim speed the
  hopper could fill → tie → eject → reset several times between redraws and the
  fill bar read stale. Now keyed on a finer `cargoTons` bucket (0.02t) per active
  task too, so it redraws every meaningful hopper change independent of acreage.
- **New "Completed" section on the Work Queue panel**: shows this calendar
  month's finished jobs (plow/plant/harvest/mow/rake/bale/weed/fertilize) below
  Active/Queued, as small dashed-border rows — verb + field, then a stats line
  (acres, $ spent, tons, bales). Backed by a new bounded `save.completedTasks`
  log (`CompletedTask[]`, `state/saveState.ts`), since a `FarmTask` is discarded
  the instant it finishes and nothing previously recorded what a job produced.
  `recordCompletion()` (`sim/tasks.ts`) snapshots id/type/field/crop/acres/
  costPaid/tons/bales at both real completion sites (bale's hopper-discard path,
  and the shared plow/plant/harvest/mow/rake/weed/fertilize finish path — tons
  captured for harvest/bale specifically); capped at 200 entries. The panel
  filters to the current `dateOf(now)` year+month; migration `save.completedTasks
  ??= []` for old saves.
- 2 new tests (`tests/completedTasks.test.ts`): plow logs acres+cost with no
  tons; bale logs tons/bales matching `bales × baleTons`. 185/185 passing,
  typecheck clean.
- **UX needs eyes** (no Browser Preview): the new Completed rows' layout/
  wording, and that the baler bar now visibly tracks live at 60x.

## Latest changes (2026-07-14, baler hopper rework + perennial winter dormancy)

- **Baler now works like the combine**: it gathers forage TONS into a hopper
  on the baler implement (`Implement.cargoTons`, persists across save/reload);
  when the hopper holds a full bale's worth (`baleTons`) it stops, ties, and
  ejects a bale at its spot, emptying the hopper, then carries on; any partial
  load left when the field finishes is discarded (hopper cleared). Replaces the
  old work-distance bale spacing. Bale COUNT is unchanged — forage is even-
  divided into `round(acres × balesPerAcre)` whole bales (float-robust, keeps
  every forage/perennial test exact). The Work Queue baler fill bar now shows
  the real hopper tons instead of the old proxy. Removed the now-dead
  `baleDropped`/`baleJitter` runtime maps.
- **Perennial winter dormancy**: grass/alfalfa stands render light-brown dead/
  matted grass in winter (Dec–Feb) via a new `dormant` paint param
  (`isPerennialDormant` in farming.ts) that overrides the whole texture +
  palette; `repaintGrowthStages` repaints the brown/green flip at the Dec 1 /
  Mar 1 boundaries (status stays "growing" across those). Extracted the
  edge-feather into a reusable `featherEdge`.
- 2 new tests (hopper fills-then-clears, dormancy in/out of winter); 183/183
  passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): the hopper fill bar counting up and
  resetting per bale, and the brown winter perennial fields.

## Latest changes (2026-07-14, perennial forage: Grass & Alfalfa)

Two new PERENNIAL crops — planted once, cut 3× a year, never plowed/replanted.

- **Config**: `grass` & `alfalfa` crops (`perennial`, `harvestMonths` [May/
  Jun/Jul], `fertilizeMonth` [Apr], `producesGrain:false`). New `baleProducts`
  map (cornStover/hay/alfalfaHay/forage → price + balesPerAcre + color); corn
  mirrors the legacy forage numbers so it's unchanged. New `mower` implement
  (Small 10ft / Medium 20ft) + `mowCostPerAcre`. Looked-up yields/prices:
  grass hay 1.5 bales/ac/cut @ $65, alfalfa 1.6 @ $130.
- **Lifecycle** (`farming.ts`): `derivePerennialStatus` on FIXED monthly
  windows — READY while an opened cutting window is un-cut (`cutsThisYear`/
  `cutYear`, reset each year in tickFarming), `harvested` while awaiting rake/
  bale, else `growing` (regrowth/dormant/establishing). `applyMowDone` (cut +
  tally, keeps the stand), `applyBaleDone` branches perennial→regrow-growing
  vs corn→mulched and stamps `field.baleProduct`. Perennials seed on bare
  ground (`canSeedPerennial`), fertilize only in April, never weed.
- **Tasks**: new `mow` task = tractor + Mower (no combine/grain), then the
  existing rake→bale loop makes Hay. Perennial auto-manage: establish once →
  fertilize Apr → mow/rake/bale each window; plow refused; rotation planner
  shows Grass/Alfalfa as a single-plan crop (Fertilize+Bale toggles, no weed,
  no "add rotation year").
- **Textures**: green tall-grass / blooming-alfalfa (purple flecks) ready
  looks; hay-tinted windrows on the rake; bale marker tint by product (hay =
  light brown, alfalfa = dark green — same icon shape). Bale sale price/marker
  + Finance cashflow now per-product.
- **Crop calendar**: perennials draw a March plant bar + THREE separate,
  inset+outlined harvest bars (May/Jun/Jul) so it reads as 3 distinct cuttings.
- **Tests**: `tests/perennial.test.ts` (7) — seeding without plow, no-plow
  refusal, monthly ready windows, full cut→rake→bale=hay cycle, 3-cuts-then-
  next-year-no-replant, alfalfa-vs-grass product pricing, auto-manage
  establish-once. 181/181 total, typecheck clean.
- **UX needs eyes** (no Browser Preview): ready textures for both crops, the
  3-bar calendar layout, bale colors, and the mow→rake→bale flow end to end.

## Latest changes (2026-07-13, queue polish + weed/fertilize windows)

- **Reset button removed** (top-left 🔄) — the Settings tab's per-farm Delete
  covers the same "wipe and start over" job, scoped to a farm instead of a
  blanket single-slot reset. `clearSavedGame()` stays in persistence.ts
  (still tested) for any future UI that wants it.
- **Fertilizing** now opens the month after planting AND only once the crop
  has actually emerged (`field.status === "growing"`, not just "planted") —
  previously allowed the instant a field was planted. **Weeding** changed
  from a fixed June-onward calendar window to 2 months after planting, same
  "growing" gate. Both windows in `sim/farming.ts` (`canFertilizeNow`,
  `inWeedingWindow`, now `(field, now)` instead of `(t)`), enforced at
  enqueue, auto-manage, and task-pickup (`isStartable`).
- **Work Queue implement row**: each ACTIVE task's box now shows a second
  line — the implement doing the work (plow/planter/sprayer/rake/baler icon,
  or a new Grain Header icon for harvest — no separate buyable header
  exists, it's assumed). Combine, Baler, and Grain Wagon (the unload task's
  trailer) additionally get a small fill bar next to their icon: hopper/
  cargo tons ÷ capacity for the combine and trailer; for the baler, acres-
  worked mod one-bale's-worth (bales are spaced evenly by work distance, so
  this tracks the real gather→tie→drop cycle without exposing tasks.ts's
  internal per-tick runtime maps). New `grainHeaderIconSvg` in `ui/icons.ts`;
  `TASK_IMPLEMENT` exported from tasks.ts for the icon lookup.
- Updated 4 farming.test.ts cases that hard-coded the old calendar-June
  window / literal "planted" status to derive real growth via `tickFarming`
  first, matching how the window actually gates now. 174/174 total,
  typecheck clean.
- **UX needs eyes** (no Browser Preview): the new implement row + fill bars
  in the Work Queue panel, and the Reset button's removal (Settings tab is
  now the only reset path).

## Latest changes (2026-07-13, multi-farm settings tab)

- **New Settings tab** (⚙️ in the bottom toolbar): create/load/delete
  independent farms. `src/state/persistence.ts` reworked from a single
  localStorage slot to an INDEX (`farm-sim-index-v1`: farm id/name/timestamps
  + which one's active) plus one save-data key per farm
  (`farm-sim-farm-v1:<id>`). A v1 single-slot save from before this existed
  auto-migrates into "Farm 1" on first read.
- Switching/creating/deleting the active farm flushes the OUTGOING farm's
  state first, then reloads the page — same pattern the existing Reset
  button used, so every other module's live state (clock, calendar pace,
  id counters) boots up correct for whichever save is now active rather
  than needing a teardown/reinit path. The Reset button itself is
  unchanged (wipes the active farm's save, keeps its name).
- Each farm's row shows a live one-line summary (year/cash/acres) computed
  directly from its own saved `daysPerMonth`, without touching the shared
  calendar module's live pace setting (would corrupt the currently-playing
  farm's calendar math if read through the normal `dateOf`/`formatDate` path).
- 12 new tests in `tests/persistence.test.ts` (needed an in-memory
  `localStorage` polyfill — this Vitest project runs in plain Node, no
  jsdom global). 174/174 total, typecheck clean.
- **UX needs eyes** (no Browser Preview): the Settings panel layout/farm-row
  styling, and the create → reload → land-on-blank-farm flow end to end.

## Latest changes (2026-07-13, fertilizer visual + field access points)

- **Fertilizing is visible now**: the sprayer stamps a ~20% darkened copy of
  the field's current texture strip-by-strip (wet liquid spray; weeds stay
  visible under the sheen). `field.fertilizedAt` keeps the wet look through
  the applied month; tickFarming dries it off (repaint) on the month turn.
- **Field access points**: every field has two gates (`field.accessPoints`),
  auto-placed at creation — perimeter point nearest a road + the point half a
  perimeter away (`src/sim/access.ts`); older saves backfilled on load. ALL
  agent travel is gate-aware (`planAgentPath` in tasks.ts): exit via the
  origin field's nearest gate → roads → enter through the destination's gate;
  within-field moves unaffected. No map icons except the field panel's
  "Edit access points" mode (two draggable 🚪 markers, Done/close hides them).
- Perf fixes landed earlier same session: heap A* + spatial-grid snapping +
  cached route rejections (task-pickup lag), throttled reveal GPU uploads +
  ground-area texture budgeting (reveal stutter). Maintainer confirmed fixed.
- 157/157 tests, typecheck clean.

## Latest changes (2026-07-12, deep-sim pass: roads, weeds, textures, icons, shop, cashflow)

Five systems in one pass (maintainer request, "take some liberty"):

- **Road navigation** (`src/sim/roadNet.ts` + `driveToward` in `tasks.ts`): the
  county OSM extract now ingests into a node/edge graph (UTM, snapped at 1.5 m
  so separate ways connect at intersections); A* routes every point-to-point
  agent trip — to field, home, to combine, to silo — as off-road → nearest road
  point → roads → off-road. Falls back to straight for short hops (<120 m),
  detours >3.5× straight, or no network (tests set none, so all old behavior is
  preserved there). Routes are runtime-only (replan after reload); a moving
  combine only triggers a replan when it's drifted >25 m from the planned target.
- **Weeds**: standing crops flush weeds when the weeding window opens
  (`field.weedy`, once per crop via `field.weeded`, both reset at planting).
  Weed texture is painted on top of the crop; the weeding task is now in the
  sweep-reveal set with a "same status, weeds off" baked target, so the sprayer
  visibly cleans strip-by-strip. Field panel warns in red. No yield effect yet
  (visual/time/cost only — hook for a weed-pressure yield model later).
- **Textures**: overlay bumped to 0.5 m/px (sharper than NAIP, deliberate);
  every status texture enriched — real ~0.8 m row spacing, sprayer tramlines
  (paired ruts every ~24 m, fade as canopy closes), plow clods + dead furrows,
  header-width pass striping, chaff windrow + shadow, stubble volunteers.
- **Icons** (`src/ui/icons.ts`): realistic side-profile SVGs for tractor,
  combine (header+reel), plow, planter, sprayer, rake, baler, grain trailer,
  bale — one shared set for map dots, panels, queue rows, and shop. All face
  west (heading-mirror contract unchanged).
- **Equipment shop**: rebuilt as a dealer-lot grid — Machines / Implements /
  Buildings sections, one product line per row, size tiers in fixed aligned
  columns with spec + price on each card, em-dash placeholders for absent tiers.
- **Finance**: new cashflow ledger (`src/sim/ledger.ts`, persisted as
  `save.ledger`, last 5 years) — every money mutation books to
  year/category/item (Land & Equipment, Loan Expenses, Field Expenses, Crop
  Revenue; refunds net against their category). Finance tab: loans condensed to
  one line each (inline borrow/paydown/refi), plus a 5-year cashflow table
  (current year on top) with per-item hover-tooltip breakdowns and a Net column.
- 15 new tests (roadNet graph/routing + drive-the-road integration, weed
  lifecycle, ledger booking/pruning); 152/152 passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): new textures at 0.5 m/px, weed patch
  look, icon rendering at small sizes, shop grid layout, cashflow tooltips,
  and machines visibly following roads.

## Latest changes (2026-07-13, harvester self-heal follow-up)

- **Investigated a report of a harvester still stuck** after the self-heal
  fix. Traced it with an instrumented test: the underlying haul cycle is
  correct (confirmed no grain is lost — a `Math.min(capacity, ...)` clamp on
  banked grain was replaced with an unclamped add, since the distance-target
  clamp and the acres↔work-distance conversion aren't exact inverses across
  a coverage path's headland turns and could theoretically shave off a
  sliver of grain each fill cycle; belt-and-suspenders, not a confirmed loss
  source here). The actual stuck case: a **legacy leftover from before
  `lastCrop` was tracked, sitting alongside 2+ crops' worth of silos** — the
  same-crop-silo guess deliberately refuses to pick when it's ambiguous, and
  with no other trigger left to re-attempt, that specific hopper had no path
  to ever resolving itself.
- **New manual escape hatch**: a harvester holding grain with no `lastCrop`
  on record now shows a "Which crop is onboard?" dropdown right in its
  Equipment-panel row — picking one (`setHarvesterCrop`) sets `lastCrop` and
  the normal dispatch machinery takes it from there. Guarantees every stuck
  hopper is recoverable regardless of how it got stuck.
- 2 new tests (the ambiguous-crop case now resolves via the escape hatch;
  `setHarvesterCrop`'s guards).

## Latest changes (2026-07-13, harvester self-heal)

- **Bug fixed:** a harvester that finished a field with grain still onboard
  but no silo yet built would get permanently stuck — its one-shot
  `ensureUnloadTask` call fired at that exact moment and never again, so
  building a silo *afterward* did nothing; the combine just sat there
  forever holding grain with no task.
- **Fix:** an idle harvester with grain onboard and no Unload Harvester trip
  coming now re-checks EVERY tick, not just at the moment the grain first
  banked. `Agent.lastFieldId`/`lastCrop` remember where/what a hopper came
  from so a trip can still be routed long after the harvest task itself (and
  `field.crop`) are gone. Legacy saves from before this tracking existed
  fall back to a same-crop-silo guess (`guessLeftoverCrop`) — only acts when
  exactly one crop has a silo assigned, otherwise leaves it alone rather
  than guessing wrong.
- Also fixed two related gaps this surfaced: the field-vanished guard and
  the task-pickup query both required `fieldId` to resolve to a real field,
  which an Unload Harvester task doesn't need (its `fieldId` is display-only) —
  both now skip that requirement for this task type.
- 4 new tests in `tests/harvestUnload.test.ts` covering the stuck-then-
  recovers case, the legacy single-silo guess, and the ambiguous-crop
  (deliberately-doesn't-guess) case.

## Latest changes (2026-07-17, Structures tab card grid)

- **Structures' owned-buildings list now uses the same card-grid look as
  Equipment** (`buildStructuresList` in `src/main.ts`, `.equip-grid` on
  `#structures-list` in `index.html`): 5-per-row, big icon (30px font-size —
  buildings use an emoji glyph, not an SVG function, so this sizes the icon
  differently than Equipment's `svg { width/height }` rule but lands the
  same visual size), name/status/dot, actions row.
- **New "assigned" dot/tint variant**: a silo actually assigned to a crop
  reads as active — solid green, deliberately not pulsing like Equipment's
  `.working` (a silo has no in-progress state to animate, unlike a machine
  mid-task). Everything else (bale storage, barns, farm yard) stays gray —
  no ownership/activity model exists yet for those.

## Latest changes (2026-07-17, Equipment card height trim)

- **Dropped the forced `aspect-ratio: 1/1`** on `.equip-card` — content now
  hugs the top (`justify-content: flex-start`, padding trimmed to
  `1px 3px 4px`) instead of being vertically centered in a square, so cards
  are only as tall as their content needs (maintainer feedback: too much
  empty space above the icon). No longer perfectly square, but noticeably
  shorter.

## Latest changes (2026-07-17, Bale Movement & Storage)

Big feature — bales can now be HAULED off the field into Bale Storage (before
this they only sat in `field.baleLocations` and sold from there). Built all at
once per maintainer; modeled closely on the grain-cart `unloadHarvester` relay.

- **Two new implements** (`gameConfig`, `saveState.Implement.kind`, icons):
  **Hay Spikes** (tractor implement, Small 1 bale / Medium 2 — the in-field
  collector) and **Bale Trailer** (Small 10 / Medium 20 — the bulk hauler,
  like the Grain Trailer). Both in the Equipment shop + fleet cards; new SVG
  icons in `ui/icons.ts`.
- **New task `haulBales`** (`sim/tasks.ts`) — a two-tractor relay handled
  point-to-point in `tickAgent` (branches by role, like unloadHarvester):
  a Hay-Spikes tractor (`task.agentId`) collects bales in-field; if an idle
  tractor+Bale-Trailer exists it's auto-recruited (`assignTrailerHelper`,
  `task.trailerAgentId`) to stage at the field entrance, get loaded, and run
  full loads to storage. No trailer → the spikes tractor hauls its 1–2 bales
  straight to storage. Blocks (`waitingForStorage` ⚠️) when there's nowhere to
  put bales, mirroring `waitingForSilo`.
- **Trigger (both):** auto-queues the instant a bale run finishes (hook in the
  baler completion), AND a manual "🚜 Haul to Storage" button in the field
  panel. `queueHaulBales` / `fieldHasLooseBales` guard against double-dispatch.
- **Storage** (`sim/buildings.ts`, `saveState.Building`): each Bale Barn/Area
  now holds a per-product tally (`storedBales`), optional product assignment
  (`assignedProduct`; unassigned accepts any, may hold a mix). **Bale Storage
  Area is now UNLIMITED** (`gameConfig.buildings.baleArea.capacityBales =
  Infinity`); only the Barn caps and blocks. Inventory tab rewritten to show
  stored counts + an assign dropdown + per-product sell (`sellStoredBalesFrom`
  in economy.ts); map popup + Structures list show stored/capacity.
- **Tests:** new `tests/baleHaul.test.ts` (8) — direct haul, trailer relay,
  barn-full blocking + unblock, product assignment, no-storage wait, dispatch
  guards, and auto-queue-after-baling. Full suite 215 green, typecheck clean.
- **Sell guards:** `sellImplement` refuses an implement still holding bales;
  the existing idle-guard on `sellAgent` covers a mid-haul tractor.

### Follow-up same day (2026-07-17)

- **Trailer relay DISABLED for now** (`TRAILER_RELAY_ENABLED = false` gating
  `assignTrailerHelper` in `sim/tasks.ts`): the two-tractor relay confused the
  collector — it oscillated between field and storage chasing the trailer. All
  hauls are now plain Hay-Spikes-direct trips; relay code left intact to
  re-enable once fixed. Relay test flipped to assert the disabled behavior.
- **Bale-drop jitter restored:** the tons-hopper baler rewrite (60b002b) had
  dropped bales exactly at `agent.pos`, landing them in a rigid lattice along
  the coverage lanes. Re-added a random offset per drop (falls back to the
  on-field point if the jitter would push it off-field). Uses the tick `rand`,
  so deterministic tests (`rand: () => 0.5`) see zero offset and are unaffected.

### Follow-up #2 (2026-07-17)

- **Collector oscillation fixed** (the "tractor drives back and forth between
  storage and the field entrance until you move the gate" report): the
  Hay-Spikes brain re-chose "nearest bale" every tick, so as it moved, which
  bale was nearest — and thus which gate the road route used — flipped, and it
  thrashed. Now it LOCKS onto one target bale for the whole trip
  (`haulTargetRuntime`, same fix pattern as the grain cart's locked staging
  gate), re-locking only once that bale is loaded.
- **Jitter magnitude bumped** ±20%→±75% of swath — ±20% was too subtle to
  visibly break the lane grid. NOTE: only NEW bale runs jitter; bales already
  sitting on the ground keep their recorded lattice positions.
- New tests: jitter-is-wired-to-rand (varying rand moves >50% of drops); relay
  test asserts the disabled behavior. 216 green, typecheck clean.

### Follow-up #3: Sell Point structure (2026-07-17)

- **New building `sellPoint`** (`$10,000`, no capacity — config/saveState/
  buildings.ts/buildingRender.ts icon 💵): a bale hauler's fallback
  destination. Haulers now PREFER Bale Storage; only when none exists or all
  of it's full do they drive to the nearest Sell Point and sell the load on
  the spot at the flat bale price (recorded as a normal `sellBales` entry —
  shows in the Work Queue's Completed section + cashflow same as a manual
  sale, even though no click triggered it).
- New shared decision helper `chooseBaleDest` (`sim/tasks.ts`) picks
  storage-or-sell once per trip; the choice is LOCKED on the task
  (`haulDest`/`trailerDest`) so arrival always matches what was decided
  rather than re-resolving mid-drive (same locking discipline as the
  bale-target and staging-gate fixes above). Wired into both the Hay-Spikes
  direct-haul path and the (currently disabled) trailer relay path.
- Structures shop gets a "Sell Point" tile (flat price, no size tiers, like
  Farm Yard); Structures list + map popup show it via the existing generic
  building rendering (no special-casing needed — it was already data-driven).
- 4 new tests: sells when no storage exists; storage still wins when both
  exist; barn-overflow spills to the sell point instead of jamming; never sets
  `waitingForStorage` when a Sell Point is available. 219 green, typecheck
  clean.

### Follow-up #4: jitter was real but imperceptible (2026-07-17)

- Root cause of "bales did not jitter": the offset was sized off the baler's
  WORKING WIDTH (`path.swath`), which is only a few meters (25 ft baler ≈
  7.6 m) — even at 75% that's ±5.7 m, invisible against a typical ~200 m gap
  between drops on a real field. Rebased the jitter off the actual DROP
  SPACING along the path (`path.total / totalBales`, avg meters between
  bales) instead — the thing the eye actually reads as a "row." New config
  knob `gameConfig.forage.baleDropJitterFraction = 0.3` (maintainer request:
  "raise it significantly, try 30%") — 30% of a ~200 m spacing is ~±64 m,
  over 10× the old absolute magnitude.
- Also hardened the off-field fallback: instead of one reject-and-give-up
  attempt (which was silently collapsing most edge-lane drops back onto the
  lattice), it now retries at half magnitude up to 4 times before falling
  back to the exact on-field spot.
- Existing jitter test (moved-fraction check) still passes unmodified against
  the new spacing-based magnitude. 219 green, typecheck clean.

## Latest changes (2026-07-17, Equipment grid 5-per-row)

- **Equipment cards now 5 per row** (was 4, briefly 2) — `.equip-grid` to
  `grid-template-columns: repeat(5, 1fr)`. Card padding tightened further to
  make room, but icon/text/dot went back UP a notch from the 4-per-row pass
  (icon 24→30px, name 11→12px, status/sub ~9→10/9.5px, dot 7→9px) per
  maintainer feedback that the 4-per-row version read too small. Still
  near-square, still full text on hover via `title`.

## Latest changes (2026-07-17, Equipment card polish — square + dot indicator)

- **Cards are now near-square** (`aspect-ratio: 1/1`) and denser: dropped the
  progress bar, single-line-truncated name/status/sub text (ellipsis +
  `title` tooltip for the full string). Working % now folds into the status
  text itself ("Mowing Field 1 · 42%") instead of a separate bar.
- **New corner status dot + card tint** replace the old plain status line as
  the "is it working" signal: pulsing green while actively working, gold
  while driving, red for a harvester blocked waiting on a Grain Trailer,
  gray otherwise. Implements inherit their host tractor's state (green/gold
  if the tractor's mid-job, gray in the yard or hitched-but-idle).

## Latest changes (2026-07-17, Equipment tab card grid)

- **Machines/Implements condensed from a one-per-row list into a 2-column
  card grid** (`index.html` `.equip-grid`/`.equip-card`, `src/main.ts`
  `buildEquipMachines`/`buildEquipImplements`), with bigger icons (34px, up
  from 20-22) since the card layout has room for them. New CSS is additive
  (`.equip-row` stays untouched — the Structures tab's owned-buildings list
  still uses it), so this only touches the two Equipment sections. Card
  markup: icon → name → status → sub/progress/select → an `.ec-actions` row
  for locate/sell buttons at the bottom.

## Latest changes (2026-07-17, Structures tab)

- **Buildings shop split out of the Equipment tab into its own toolbar tab,
  "🏗️ Structures"** (`index.html`, `src/main.ts`), styled to match Equipment
  exactly: fleet list of owned buildings by default (`buildStructuresList`,
  reusing `.equip-row`), shop tucked behind a "＋ Buy structures" toggle
  (`buildStructuresShop`). Equipment's own shop toggle now sells only
  Machines/Implements. Extracted the dealer-lot row/section builders
  (`shopSection`/`shopLine`) so both shops share the same grid rendering.
  Silo crop assignment still lives in Inventory; Structures' sell button is
  the plain full-refund sell used everywhere else. Updated the "no silos
  built yet" inventory hint to point at Structures instead of Equipment.

## Latest changes (2026-07-13, unload trigger)

- **"Unload Harvester" now queues as soon as the combine has ANY grain
  onboard**, not just once the hopper's completely full — hauling runs in
  parallel with ongoing cutting rather than only kicking in at capacity. The
  combine itself still physically stops once truly full (hopper capacity is
  a real limit); the trigger for DISPATCHING a trailer is now "any product,"
  matching the maintainer's request. New test pins this down explicitly.

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
