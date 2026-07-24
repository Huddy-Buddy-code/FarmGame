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

### Fertilizer cost split out of planting, and made per-crop (2026-07-17)

- Bug (maintainer catch): `inputCostPerAcre` (paid at planting) was already
  bundling "seed, fertilizer, chemicals" into one number, but there's ALSO a
  separate Fertilize task with its own charge — the fertilizer material cost
  was being paid twice. And the Fertilize task's cost was a single global
  flat rate (`fertilizeCostPerAcre: 35`) applied to every crop alike, which
  is unrealistic — corn is a heavy N user, soybeans fix their own nitrogen,
  hay crops need an annual topdress. $35/ac undercounts real fertilizer by
  roughly an order of magnitude for corn.
- Fix: moved `fertilizeCostPerAcre` from a flat `GameConfig` number to a
  per-crop `CropConfig` field (`gameConfig.crops[crop].fertilizeCostPerAcre`,
  `sim/tasks.ts` `taskCost()`), and rebalanced both numbers per crop against
  Corn Belt extension-budget ballparks (seed+chem only at planting, fert
  material + ~$20/ac pass fee at fertilize time):
  - Corn: inputCostPerAcre 450→240, fertilizeCostPerAcre (new) 230
  - Soybeans: inputCostPerAcre 300→250, fertilizeCostPerAcre (new) 70
  - Grass: inputCostPerAcre 120→100, fertilizeCostPerAcre (new) 110
  - Alfalfa: inputCostPerAcre 180→160, fertilizeCostPerAcre (new) 90
  Total planting+fertilize $/ac lands close to the old combined number for
  corn/soy, just correctly split across the two tasks that actually charge
  for it. No test depended on the old flat rate — 220 green, typecheck clean.

### Skip to Spring button (2026-07-17)

- New "🌱 Skip to Spring" button at the end of `#timebar`, next to Skip month.
  Reuses the existing `runMontage()` skip-ahead animation, targeting
  `nextMonthStart(clock.time(), 2)` (March, 0-based) — always jumps to the
  NEXT March 1, even mid-March. No new sim logic, UI-only wiring in `main.ts`.

### Follow-up #5: mid-dump storage-fill now reroutes the rest of the load (2026-07-17)

- Bug: when a load only PARTIALLY fit (barn had room for 1 of the 2 bales on
  board), the leftover cargo set `waitingForStorage=true` and parked at that
  same barn with `budget=0` forever — the Sell Point fallback only ran when
  deciding a NEW trip's destination, not mid-dump on the current one.
- Fix: on a partial `haulBalesInto`, re-run `chooseBaleDest` for what's left
  right there (both the direct Hay-Spikes path and the trailer path) instead
  of just flagging `waitingForStorage`. It'll find another storage building
  with room, or fall back to a Sell Point, or (only if truly nothing exists)
  still wait.
- New test: medium Hay Spikes (2-bale load) against a barn with exactly 1
  slot free + a Sell Point built — asserts the barn gets the 1 it had room
  for and the other bale sells, no stall. 220 green, typecheck clean.

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

## Latest changes (2026-07-20, Bale Trailer relay re-enabled)

- **`TRAILER_RELAY_ENABLED` flipped back to `true`** (`sim/tasks.ts`). The
  two-tractor bale relay is live again after the earlier oscillation was
  root-caused: the Hay-Spikes collector was steering at the trailer's LIVE
  (moving) position, so the road router flip-flopped its route.
- **Fix — a single locked rendezvous gate.** New `haulStagingGate(task, field)`
  picks the field gate nearest the BALES' centroid (maintainer choice: the
  collector shuttles far more often than the trailer hauls, so minimize the
  shuttle) and caches it in `haulEntranceRuntime`. Both brains read that one
  fixed point. The collector now only drives to the trailer when it's actually
  PARKED (`trailerPhase === "waiting"`) with room — while the trailer is
  arriving or off on a storage run, the collector holds its load in-field and
  waits, exactly as specified. Never targets the live trailer position again.
- **Selection is fully automatic** (maintainer choice, 2026-07-20): any idle
  tractor that has — or can hitch — a Bale Trailer is auto-recruited when a
  Haul Bales job starts (`assignTrailerHelper`, unchanged logic, just
  un-gated). No spare tractor → the collector hauls direct, as before.
- Tests: the old "relay is DISABLED" assertion was rewritten to verify the
  relay engages, the trailer carries the load, and a 12-bale field fully
  delivers via a small (10-bale) trailer + small (1-bale) spikes without
  stalling; added a "no spare tractor → hauls direct" case. 221 green,
  typecheck clean. **Not visually verified** (Browser Preview off) — worth
  watching a real relay run in `npm run dev` to confirm no residual jitter.

## Latest changes (2026-07-20, bale hauling polish — 3 updates)

1. **Trailer + tractor both in the Work Queue.** The Haul Bales job now renders
   a SECOND implement sub-row for the Bale Trailer (its bales-loaded fill bar +
   phase: "Waiting to load" / "Hauling to storage" / "Unloading"), alongside the
   collector's Hay-Spikes row. Refactored `implementRowHtml` in `main.ts`: the
   row-wrapping is now a shared `implRow(...)` helper, and `implRowForBaleTrailer`
   builds the trailer's row (new `TRAILER_PHASE_TEXT` map).
2. **Trailer waits AT the nearest bale, not the field gate.** `haulStagingGate`
   (nearest gate to the bale centroid) → `haulRendezvous` (nearest *remaining
   bale* to the trailer, locked in `haulRendezvousRuntime`). The lock is cleared
   whenever the trailer heads back from a storage run, so it re-picks the nearest
   bale and follows the work inward as the field clears (maintainer choice:
   "reposition on return"). Collector reads the lock read-only. Pre-lock removed
   from `assignTrailerHelper` (the trailer locks lazily on its first staging).
3. **Bale drops: ±30% fill-distance variance instead of perpendicular jitter.**
   The old jitter offset each drop sideways off the coverage lane by a fraction
   of the drop spacing — big enough (±~64m) to fling bales onto un-baled ground.
   Removed entirely. Instead each bale now fills to a randomized threshold
   (`baleTons × (1 ± baleFillVariance)`, new config, 0.3; re-rolled per bale via
   `baleTargetRuntime`), so the *drive distance* before each tie varies and the
   ON-PATH spacing staggers naturally — every bale lands on baled ground. Config
   `forage.baleDropJitterFraction` → `forage.baleFillVariance`. Bale COUNT now
   varies a little run to run (maintainer choice: "let count vary");
   `recordCompletion` records the ACTUAL dropped count. `rand()=0.5` (test
   default) still fills to exactly `baleTons`, so deterministic tests keep exact
   counts.

Tests: rewrote the old "jittered off the lattice" test (now: spacing varies with
rand, count stays near nominal, **all bales inside the field**), the forage
"exact count" test (now: count near nominal, may vary), and added a test that the
trailer parks INSIDE the field (at a bale) while waiting. 223 green, typecheck
clean. **Not visually verified** (Browser Preview off) — worth eyeballing the
bale scatter and the two-row queue entry in `npm run dev`.

## Latest changes (2026-07-20, patchy wind-lodging texture)

- **`ready`-status grain no longer lodges in uniform parallel bands.** New
  `lodgingPatches` (`field/fieldRender.ts`) scatters a handful of irregular
  flattened patches instead — each its own size/orientation, streaked at its
  own wind angle independent of the crop-row angle, matching how real lodging
  follows gusts rather than the planter's rows. Replaces the old single
  `rows(..., 12, dark, 2.2, 0.1)` "lodged/leaning bands" line.
- Prompted by reviewing real aerial farmland photos (maintainer-supplied) against
  a demo artifact porting the game's actual texture-drawing functions — confirmed
  the field painter is fully procedural (no bitmap textures, nothing to license)
  and identified uniform lodging bands as the one visible gap vs. real photos.

Typecheck clean, 223 tests green (no test changes needed — no existing test
pinned the old uniform-band behavior). **Not visually verified** (Browser
Preview off) — worth checking a `ready` grain field in `npm run dev` for patch
size/frequency.

## Latest changes (2026-07-20, grain cart: join-mid-job + Sell Point divert)

1. **Proactive cart recruitment (the baler's "join mid-job", for grain).** A
   combine sitting with grain now pulls in a free tractor+Grain Trailer ahead of
   queued field work, instead of the cart only arriving via the generic
   task-order loop:
   - `assignGrainCart(save, task, events)` (mirrors `assignTrailerHelper`) grabs
     an idle cart-capable tractor, auto-hitching a loose Grain Trailer, and sets
     the unload active.
   - A pre-pass at the top of `tickTasks` runs `ensureUnloadTask` for every
     combine with grain (creates the trip AND recruits) BEFORE the agent loop, so
     a free tractor is claimed for the combine before it can start a plow.
   - `shouldReserveForHarvest` holds a cart-capable tractor back from STARTING
     field work while a harvest (active or queued) still needs a cart — capped so
     surplus tractors still get field work, and no-ops if the fleet has no
     combine. Fixes the tick-1 race (tractor grabbing a plow the instant before
     the combine banks its first grain). No agent-ordering change (that perturbed
     timing-sensitive tests); reserving on queued-too covers the cold start.
2. **Full-silo divert to Sell Point (mirrors the bale-storage fix).** When a
   crop's silos are full/absent, the cart now offloads at a Sell Point instead of
   stalling `waitingForSilo` — including a PARTIAL dump where the silo fills
   mid-unload (the leftover reroutes). New `chooseGrainDest` (nearest silo with
   room → else nearest Sell Point), `sellHauledGrain` (flat crop price, recorded
   as a `sellGrain` completed task), `finishUnload` helper, and a
   `task.unloadDest` per-trip lock. The `toSilo`/`dumping` phases route through
   these. A full silo with NO Sell Point still waits, as before.

Tests: +2 in `harvestUnload.test.ts` (full-silo→Sell-Point divert; proactive
recruit beats a queued plow). 225 green, typecheck clean. **Not visually
verified** (Browser Preview off).

## Latest changes (2026-07-20, Inventory tab now live-refreshes)

- Bug: the Inventory tab went stale while open — it wasn't in the game loop's
  ~2×/s refresh block (unlike Fields/Equipment/Structures/Finance), so e.g.
  delivered grain / hauled bales didn't show until you reopened it.
- Fix: brought `refreshInventory` up to the same pattern as the other tabs —
  (1) added it to the `tickWorld` refresh block; (2) early-return when the panel
  is hidden; (3) a content-key diff (pooled grain, each building's
  assignment + stored bales, in-field bale tallies) so it only rebuilds the DOM
  when that data changes, not every frame — which would reset a half-open
  crop/product dropdown or the sell buttons. Opening the tab forces a rebuild
  (`refreshInventory(true)`). Panel id is `inventory` (not `inventorytab`).
- Confirmed no other data tab was missing: the crop calendar's moving "now"
  marker is already updated in `updateHud` (live), Settings has no live data.
- UI-only; typecheck + 225 tests green. **Not visually verified** (Browser
  Preview off) — worth watching Inventory update during a harvest/haul in
  `npm run dev`.

## Latest changes (2026-07-20, auto Skip-Month when idle)

- New: if the farm has NO work (no queued or active tasks) for 1 minute of real
  time, it fires the Skip-Month montage on its own, so idle downtime doesn't
  need repeated clicks. `maybeAutoSkipMonth` in `main.ts`, called from the game
  loop; `AUTO_SKIP_IDLE_MS = 60_000`, targets the start of the next month (same
  as the Skip Month button). Gated on the clock running and no montage in
  flight; any pending task (including system hauls/unloads) resets the idle
  clock; re-arms after each auto-skip (so it steps one month per idle minute).
- Toggle: a "⏩ Auto" button in the timebar turns it on/off (`.active` = on),
  persisted in `localStorage` (`farm.autoSkip`), default ON. `maybeAutoSkipMonth`
  bails immediately when off.
- UI/timing only; typecheck + 225 tests green. **Not visually verified**
  (Browser Preview off). Possible refinement if it feels intrusive: also
  suppress the auto-skip while a toolbar menu is open.

## Latest changes (2026-07-20, photographic machine sprites)

- New workflow: AI-generated PNGs dropped into `src/assets/Equipment/` are
  auto-discovered by filename and preferred over the hand-drawn SVGs. New file
  `src/ui/machineImages.ts` — `import.meta.glob` builds a `kind|size → url`
  registry; `machineImageUrl(kind, size?)` (exact size → size-agnostic → any
  size fallback) and `machineImgTag(url, px)`. Filename convention
  `<Kind>_<Size>_sideleft.png` (e.g. `Tractor_Medium_sideleft.png`); "Combine"
  aliases the `harvester` kind; art faces WEST like the SVGs (main.ts mirrors).
- `main.ts`: new `machineIconHtml(kind, size, px)` helper picks image-or-SVG;
  wired into map markers, active Work-Queue rows, fleet cards, and the Tractor/
  Combine shop rows. Dropped now-unused `combineIconSvg` import. `.machine-img`
  CSS rule added in `index.html`.
- First test asset in place: `Tractor_Medium_sideleft.png`. **⚠️ It has a dark
  baked-in background** — needs a TRANSPARENT version or it shows as an opaque
  box over the map in-field. Prompt going forward must include "transparent
  background, transparent PNG".
- Typecheck + 225 tests green. **Not visually verified** (Browser Preview off) —
  needs eyes in `npm run dev`: in-field marker, shop/fleet thumbnails, and the
  heading flip on the photo.

## Latest changes (2026-07-20, headland laps — per-task perimeter passes)

Real fieldwork isn't always straight lanes edge to edge: many operations drive
2-8 laps around the boundary first or last, then fill the interior in straight
rows. Maintainer spec: plow (last, 6 laps), plant (last, 3), fertilize/weed
(last, 1), mow/rake/bale/harvest (first, 3). Both the coverage-path (so the
tractor actually drives it) and the texture (so a finished field visually
shows the frame, not straight rows to the edge) needed it.

- **`geo/geometry.ts`**: new `offsetPolygonInward(ring, distance)` — inward
  polygon offset (each edge's line moved along its own inward normal, then
  re-intersected). Guards: rejects a distance that would invert an edge's
  direction (offsetting past what an edge's local geometry allows doesn't
  collapse the shape to nothing — it turns it inside out, but a point-
  reflection through the polygon's center doesn't flip the shoelace sign, so
  that's not a usable signal; per-edge direction is), and rejects a result
  under 15% of the input area (a sliver too small to be worth another lap).
- **`sim/coverage.ts`**: extracted `accumulatePath` (pure refactor) out of
  `buildCoveragePath`'s tail so new code can reuse the cum/work accounting.
  New `buildHeadlandLaps` (traces ring CENTERLINES one implement-width apart,
  the first inset half a swath — same convention the interior lane-fill
  already uses for its own first/last lane, so a lap's outer edge touches the
  true boundary rather than the tractor driving ON the property line) and
  `buildHeadlandCoveragePath(boundary, swath, laps, order)` (stitches ring
  loops + the **unmodified** `buildCoveragePath` interior fill, with a
  non-work transit between phases — reuses ALL of the existing cellular
  decomposition/concave-notch handling untouched). New exported
  `TASK_HEADLANDS` config table (laps + first/last per task type) — the
  single source of truth both the sim and the renderer read.
- **`sim/tasks.ts`**: `getActivePath` branches on `TASK_HEADLANDS[task.type]`
  to call the headland builder instead of the plain one. No new persisted
  save field: `doneAcres` already resumes any path (verified directly, not
  assumed) since `buildHeadlandCoveragePath` is a pure deterministic function
  of its inputs — reload rebuilds the identical path and re-derives position
  via the existing `distanceAtWork`/`workDoneAt` round-trip.
- **`field/fieldRender.ts`**: row-bearing statuses whose task has a headland
  config (tilled/planted/growing/ready-grain/harvested/mulched — perennial
  hay/alfalfa `ready` has no row geometry to frame, so it's excluded) now clip
  their interior rows to the shrunken inner boundary and draw a new
  `headlandFrame` — each ring stroked at swath width with a lit centerline,
  same "lit edge" trick `rows()` already uses. New `swathM?` param on
  `FieldPaintParams`: the active-task reveal bake (`main.ts`) passes the
  task's real `path.swath`; the idle static repaint falls back to a
  representative medium-implement default (same pattern `estimateTaskHours`
  already uses for queued tasks).
- Found a real geometry bug in review, not just in testing: the first attempt
  placed ring centerlines exactly ON the true boundary (off by half a swath),
  which put driven positions (and dropped bales, for the bale task) exactly
  on the field edge — caught by the existing bale-scatter test
  (`pointInPolygon` failing on an edge point), fixed by insetting the first
  ring's centerline by `swath/2` like the plan specified.

Tests: `offsetPolygonInward` (geometry.test.ts — shrink math, offset
composition, both collapse-guard cases); headland lap tracing, graceful
degradation on a too-small field, first/last ordering, area coverage, and the
resume round-trip property (coverage.test.ts); an end-to-end plow-with-6-laps
completion test (farming.test.ts); a `drawFieldTexture` smoke test against a
hand-rolled no-op canvas context, since there's no canvas polyfill in this
test environment (fieldRender.test.ts, new file). 239 green, typecheck clean.
**Not visually verified** (Browser Preview off) — worth eyeballing a plow
(6-lap) and a mow (3-lap, headlands-first) field in `npm run dev` for frame
thickness and corner turns.

## Latest changes (2026-07-20, interior texture tracks implement swath)

- `src/field/fieldRender.ts`: the non-headland (interior) pass texture now
  scales with implement size, mirroring the headland frame's logic. New local
  `passPx = Math.max(6, swathM * pxPerM)` (same `swathM` the frame uses — real
  task swath during the sweep-reveal, medium default on idle repaint). Wired
  into every "machine pass" feature: `passStripes` in harvested-grain,
  harvested-hay, and mulched, plus the two per-pass chaff-windrow `rows()` in
  harvested-grain (spacing + phase now `passPx`/`passPx/2`). Crop/furrow rows
  left at their fixed agronomic constants on purpose (planter width ≠ corn-row
  spacing).
- Effect: Large combine → wide passes/chaff; Small → tight. Like the frame,
  it's most visible DURING the job; idle repaints fall back to medium swath
  (persisting per-field swath would need it stored on the field — not done).
- Typecheck + 239 tests green. **Not visually verified** (Browser Preview off).
- Follow-up: rake windrow overlay (`p.windrowed`) was still spacing its rows at
  a hardcoded `15` — the one forage feature not tracking the implement. Switched
  the three windrow `rows()` to `passPx` so windrow spacing = rake swath, like
  mow/bale. Mow (harvested-hay) + bale (mulched) already used `passPx`; no
  change needed there. Caveat: during the rake reveal `passPx` = real rake
  swath (correct); on an idle repaint it falls back to `defaultSwathM` which
  keys off status "harvested" → returns MOWER-medium width, not rake width (the
  windrowed overlay isn't a status, so the default can't tell it apart). Close
  enough (rake 25 ft vs mower 20 ft); a precise fix would thread a rake default.
- Follow-up 2: windrow overlay ignored the headland — it was drawn OUTSIDE the
  headland-aware block, so its straight rows ran edge-to-edge through the frame
  band instead of turning to follow the perimeter like mow/bale rows do (user
  screenshot). Fixed: straight windrows now clip to `innerBoundary`, and a new
  `windrowFrame()` traces one piled windrow per headland ring so the perimeter
  laps curve with the boundary. Same treatment the status rows already got.
- Follow-up 3: weed/fertilize reveals showed a bogus wide perimeter band. They
  bake the crop's SAME status ("growing") but were handed the sprayer's
  `path.swath` (60–120 ft), redrawing the crop's headland frame at sprayer
  width instead of planter width. Fix in `main.ts` updateReveals: pass
  `swathM` only for geometry-defining tasks; weed/fertilize now omit it and
  fall back to `defaultSwathM` (planter width for growing). Rake still passes
  its swath (windrows want it).

## Latest changes (2026-07-21, Haul Bales queue row: pair each tractor with its own implement)

- Bug: the Work Queue's Haul Bales card only ever rendered the collector
  tractor's icon at the top, even though the subtitle text already named both
  machines once the Bale Trailer auto-recruits (`task.trailerAgentId`) — the
  second tractor was invisible despite visibly being at work.
- First pass stacked both tractor icons at the card's top (`icon-dual`); maintainer
  asked to instead pair each tractor with its OWN implement row, which reads
  better than a separate icon block disconnected from the machine names. Final:
  `implementRowHtml`'s haulBales branch and `implRowForBaleTrailer` (`main.ts`)
  now prefix each implement's icon with `machineIconHtml(agent.kind, agent.size,
  IMPLEMENT_QUEUE_ICON_PX)` — Hay Spikes row shows the Small tractor, Bale
  Trailer row shows its own tractor. Card's top-level icon dropped entirely for
  haulBales rows (redundant now). New `gap: 4px` on `.qr-impl .impl-icon`
  (index.html) so the paired icons don't touch.
- No logic changes, display-only. 239/239 passing, typecheck clean.
- **UX needs eyes** (no Browser Preview): confirm the tractor+implement icon
  pairs read clearly at the 280px panel width.

## Latest changes (2026-07-21, crop-rotation yield bonus)

- New mechanic (maintainer request): +10% yield when a field's current crop
  differs from the one it grew immediately before; +0% for replanting the same
  crop; no bonus on a field's first-ever crop (nothing to rotate away from).
- `Field.lastCrop` (`state/saveState.ts`) — set in `applyHarvestDone`
  (`sim/farming.ts`) right before `field.crop` is cleared, so it survives past
  harvest for the next planting to compare against. `applyPlant` doesn't touch
  it, so it stays stable as "last year's crop" for the whole new crop's cycle.
- `productivityMultiplier` (`sim/farming.ts`) now adds
  `gameConfig.rotationBonusPct` (0.1, new config field) whenever
  `field.crop !== field.lastCrop` and both are defined — stacks with the
  existing weed/fertilize modifiers, and flows automatically into every reader
  (yieldRange estimate, actual harvest/bale tonnage, the map-hover boost badge)
  since they all already read this one function.
- 7 new tests in `tests/productivity.test.ts`: unit cases (rotated/same/first-
  crop/stacking) plus `applyHarvestDone` sets `lastCrop`, plus an integration
  test confirming a rotated corn field actually harvests 10% more tons than an
  identical repeat-cropped one. 245/245 passing, typecheck clean.
- Perennials: `lastCrop` only ever changes via `applyHarvestDone`, which
  perennial mowing/baling never calls — so establishing a stand can earn the
  bonus once (if it followed a different annual crop) but it then persists for
  the stand's whole life rather than re-evaluating yearly. Not addressed;
  out of scope for this request (framed around annual rotation).

## Latest changes (2026-07-21, Field panel: 4 side tabs — View/Schedule/Finances/Settings)

Big structural rework (maintainer request), built in 3 phases per the approved plan (`~/.claude/plans/linked-sprouting-pebble.md`):

- **Phase 1 — tab-strip scaffold**: `#fieldpanel` split into a left vertical
  icon strip (🌾 View / 📅 Schedule / 💵 Finances / ⚙️ Settings, `.fp-tabstrip`)
  + a right content pane (`#fp-main`, `.fp-wide` toggled for Schedule/
  Finances only — View/Settings stay narrow). New `fieldPanelTab` state +
  `switchFieldPanelTab()` in `main.ts`; the old monolithic `refreshFieldPanel`
  split into a thin dispatcher (`refreshFieldPanelHeader` + per-tab functions),
  each with its OWN change-detection cache (mirroring `refreshPlanEditor`'s
  existing `lastPlansKey` pattern) instead of one shared key. Auto-manage
  toggle + the rotation-plan editor moved onto Schedule; access-points editor
  moved onto Settings (`startAccessEdit`/`stopAccessEdit` needed zero logic
  changes — driven by module state, not DOM location).
- **Phase 2 — Field Finances tab**: new `src/sim/fieldLedger.ts`
  (`recordFieldCash`/`fieldCategoryTotal`/`fieldNetCashflow`/
  `fieldLedgerYears`), mirroring `sim/ledger.ts`'s shape but keyed by field id
  too — additive, booked ALONGSIDE the existing global ledger calls, never
  replacing them. New `save.fieldLedger` (optional, migrated `??= {}`).
  Booking sites: land purchase (`field/fields.ts`, one-time "Land Purchase"
  expense line, maintainer-confirmed to appear in the P&L per the purchase
  year), `enqueueTask`/`cancelTask` (task cost + refund, `sim/tasks.ts`), and
  harvest/bale completion (modeled REVENUE = tons/bales × the flat config
  sell price — under this game's static-price economy that's not an
  approximation, it's exactly what it'll sell for whenever actually sold,
  which sidesteps grain/bales pooling farm-wide with no per-field trace once
  physically moved). New `refreshFieldFinancesTab` reuses the global Finance
  tab's `.cf-table` styling verbatim, with a new 2-category `.fp-cf-row`
  modifier (Expenses/Revenue, vs. the global table's 4 categories). 8 new
  tests (`tests/fieldLedger.test.ts`): field-separation (two fields, same
  crop, correctly-separated totals — the core problem this exists to solve),
  modeled-revenue exactness, 5-year-per-field pruning.
- **Phase 3 — Field Schedule tab (calendar + drag-drop overrides)**: new
  `FieldPlan.schedule?: Partial<Record<"plow"|"plant"|"weed"|"fertilize"|
  "harvest", number>>` (optional, fully backward-compatible) and new
  `src/sim/schedule.ts` (`legalMonthsFor`/`effectiveMonthFor`/
  `setScheduleOverride`) computing which calendar months are legal per task —
  Plow/Plant/Weed/Fertilize get a full override (any real legal month);
  Harvest is DELAY-ONLY (can push later than the natural ready month, never
  earlier — a ready crop never spoils in this game, so waiting is always
  safe without breaking the yield mechanic). Mow (perennial)/Rake/Bale have
  no override — perennial cutting is a fixed 3-times-a-year mechanic, and
  rake/bale have never had a calendar gate at all (fire immediately after
  harvest, whatever month that lands in). `autoManageField` (`sim/tasks.ts`)
  now consults a new `monthMatches(now, plan.schedule?.X)` helper at every
  relevant dispatch site — a missed scheduled month (e.g. unaffordable that
  tick) keeps retrying every tick for the rest of the legal window, same as
  today's un-overridden behavior (maintainer-confirmed soft-retry, never
  worse than the status quo). Manual View-tab queue buttons are NOT
  restricted by overrides (auto-manage-only, consistent with the existing
  weed/fertilize/bale toggles). Calendar UI: 12-column grid (6 rows: Plow/
  Plant/Weed/Fertilize/Harvest-or-Mow/Rake-Bale), drag-and-drop mirroring the
  Work Queue's existing `draggingTaskId` pattern (separate `draggingScheduleCell`
  state), click-to-set as a lower-friction alternative, a Yr-N-of-the-plan
  year switcher (rotation-plan-relative, distinct from Finances' campaign-year
  labels — two different "year" concepts in two different tabs). 15 new
  tests (`tests/fieldSchedule.test.ts` — legal-month math including a
  cross-check against the real `inWeedingWindow`/`canFertilizeNow` gates) + 6
  new integration tests in `tests/plans.test.ts` (override skip/fire
  behavior for plow/plant/harvest/weed, plus an explicit regression guard:
  `schedule: undefined` behaves byte-identical to before).
- 273/273 passing (was 245 at session start), typecheck clean throughout all
  3 phases.
- **UX needs eyes** (no Browser Preview — maintainer directive): the vertical
  tab strip, the `.fp-wide` panel-width toggle, and especially the calendar's
  drag-and-drop feel/legibility at the panel's width — none of this has been
  visually verified, only logic-tested.

### Follow-up (2026-07-21): Schedule calendar was "cryptic" — legibility pass

- **Root-cause bug**: the calendar's container `#fp-schedule-grid` was styled
  by class `.fp-cal-grid` (`display:grid`), but that class was never actually
  put on the element — so `display:grid` never applied and every label/cell
  div flowed as a jumbled stack of tiny inline-flex boxes instead of a
  12-column table. Fixed by building a real inner `<div class="fp-cal-grid">`
  (plus a legend) INTO the host container, rather than appending cells to the
  unstyled host directly.
- **Legibility overhaul** (`main.ts` `refreshScheduleCalendar` +
  `renderScheduleTaskRow`/`renderScheduleAutoRow`, CSS in `index.html`):
  every cell now has a faint background track so the grid reads AS a grid;
  three clear cell states — gold-filled `.scheduled` (drag/click to move),
  dashed `.legal` "available month", muted `.auto` (non-schedulable); a
  toggled-off optional task (weed/fert/bale) shows one dim hollow `.off`
  marker (click to re-enable) instead of cluttering the row. Added a legend
  (Scheduled / Available / Automatic), per-row emoji icons (🚜🌱💦🌿🌾📦),
  and switched the 12 columns to the game's Mar→Feb season order (matching the
  Crop Calendar tab) so the lifecycle reads left-to-right — plant near the
  left, harvest through fall, plow at the far right — instead of Jan-Dec
  splitting the winter plow window across both edges.
- When Auto-manage is OFF the tab now shows an explanatory hint (the schedule
  only drives the auto-manager) instead of rendering blank.
- No logic changes — pure UI. 273/273 still passing, typecheck clean.
- **Still UX-needs-eyes** (no Browser Preview): confirm the grid now reads
  clearly and the three cell states are visually distinct at the panel width.

### Follow-up (2026-07-21): vertical calendar + polish batch

Six maintainer-requested changes in one pass:

- **Calendar rotated to VERTICAL** (`main.ts` `refreshScheduleCalendar` +
  new `scheduleCell` helper, replacing the old per-row renderers): months run
  DOWN the rows (Mar→Feb season order), tasks ACROSS the columns — much
  narrower than the old 13-column horizontal grid. Each month label is
  season-tinted with the year bar's exact pastel colors (`.fp-vmonth.spring/
  summer/fall/winter`) and shows the season icon (🌱☀️🍂❄️) on that season's
  first month. Task columns are dynamic (6 for annuals, 5 for perennials);
  `grid-template-columns` set inline. Same 3-state cell language (scheduled/
  legal/auto/off) + drag-drop, unchanged logic.
- **"Reset to automatic timing" (Defaults) button** below the calendar —
  clears `plan.schedule` (all month overrides) for the viewed year; disabled
  when there are none.
- **Plan-editor task toggles removed** (`refreshPlanEditor`): the weed/
  fertilize/bale 💦🌿📦 buttons are gone — those toggle on the calendar now
  (click a task's cell). Crop dropdown + rotation-year management stay.
- **Field hover badge behind panels** (`index.html` `#field-badge` z-index
  45→14): it now tucks behind the top/side/bottom panels instead of floating
  over them, still above the map.
- **Parked machines hidden** (`main.ts` `isAgentInStorage` + `updateAgentMarkers`):
  a machine idle AND at a Tractor Barn / Farm Yard has its map marker (and its
  nested implement glyph) hidden, to declutter the farmstead. Idle-in-a-field
  or no-barn-built machines still show.
- **Field Finances rows show the crop + icon** (`FieldLedgerYear.crop` in
  `sim/fieldLedger.ts` + new `recordFieldCrop`, stamped at plant enqueue /
  harvest / mow-bale completion in `sim/tasks.ts`; rendered as a small line
  under the year in `refreshFieldFinancesTab`). Covers perennial mow years
  that never re-plant (field.crop stays set).
- **Uniform compact panel width**: all four tabs now share one 320px `.fp-main`
  width (dropped the `.fp-wide` toggle) — the vertical calendar + 4-column
  finance table both fit.
- 2 new fieldLedger tests (recordFieldCrop unit + plant-task-stamps-crop).
  275/275 passing, typecheck clean.
- **UX-needs-eyes** (no Browser Preview): the vertical calendar's season
  colors/icons + drag feel, the parked-machine hiding, and that all four tabs
  look right at the shared 320px width.

## Latest changes (2026-07-21, Seasonal prices + auto-scheduled sell task)

Turned the flat economy into a timing game (approved plan
`~/.claude/plans/linked-sprouting-pebble.md`), in 4 stages:

- **Stage 1 — seasonal pricing** (`sim/market.ts` new, `gameConfig.market`):
  a product's price = base × a seasonal multiplier anchored to its last-
  possible-harvest month (config-derived, fixed annual pattern) — `+25%` four
  months out, `+15%`/`+10%` at ±1/±2, base elsewhere (no discounts). Corn
  peaks Jan, soybeans Feb; bale products (from Sep cuttings) peak Jan. All six
  sale paths (`economy.ts` ×4, `tasks.ts` sell-point dumps ×2) now take `now`
  and price at the current month; Inventory + field-panel labels show the live
  price with a `+N%` badge (`priceBadge`).
- **Stage 2 — sale-time field revenue** (decision: book at actual sale time &
  price). Harvested grain / hauled bales pool with no field tag, so added
  `save.produceStock` (product→fieldId→amount) via `addProduce` at harvest/bale
  completion (REPLACING the old production-time revenue booking), consumed by
  `attributeSale` at every sale — pooled sales split pro-rata across
  contributing fields, a field's own loose-bale sale credits it directly. Field
  Finances revenue now lands in the SALE year at the real price (disclaimer
  updated). Migration seeds provenance from existing inventory (grain bin +
  storage unattributed `""`, field loose bales per field).
- **Stage 3 — auto-sell** (`save.sellSchedule` product→{month,auto} +
  `sellLastMonthAbs` cursor; `tickAutoSell` in `economy.ts`, wired into
  `tickWorld` after `tickLoans`). Mirrors the loan-payment elapsed-months loop
  so it fires once per crossed month, survives time-compression/skip-month, and
  never retro-fires on load. `sellAllOfProduct` sweeps grain bin + every bale
  store + field loose bales, logging to the Completed feed.
- **Stage 4 — Inventory "Auto-Sell Schedule" UI** (`buildSellScheduleSection`):
  one row per sellable product with a live price + badge, an auto-sell toggle,
  and a compact horizontal 12-month price strip (season order) shaded by premium
  so the curve is visible; click / drag the 💰 marker to set the sell month.
- Economy is now genuinely non-flat, so **STATUS's "Economy is placeholder"
  gap below is partly addressed** — seasonal prices exist, though there are
  still no buyers/capacity/local-demand.
- Tests: new `tests/market.test.ts` (price math + `tickAutoSell` firing/
  time-compression/retro-fire-guard); `tests/fieldLedger.test.ts` reworked to
  sale-time booking + pro-rata attribution; ~8 existing sale-call sites updated
  to pass a base-price `now`. 289/289 passing, typecheck clean.
- **UX-needs-eyes** (no Browser Preview): the Inventory price-strip legibility +
  drag feel + toggle, the price badges across Inventory/field panel, and an
  auto-sell actually firing at the scheduled month in `npm run dev`.

## Latest changes (2026-07-21, Mulch task — optional post-harvest residue pass)

New optional task like fertilizing: shred annual crop residue back into the
surface (returns the field to stubble) for a flat **+7%** on the NEXT crop's
yield. Annuals only; only on residue that wasn't baled.

- **New `mulcher` implement** (`gameConfig`): Small 15′/$20k, Medium 25′/$40k,
  Large 35′/$75k — all three sold. `mulchCostPerAcre: 8`. Added to
  `ImplementKind`/`Implement.kind`, `IMPLEMENT_CONFIG`, `IMPLEMENT_NAME`,
  `IMPLEMENT_KIND_NAME`, shop line, and a new `mulcherIconSvg` (flail shredder)
  in `icons.ts` + `IMPLEMENT_ICON_SVG`.
- **New `mulch` TaskType** (tractor + mulcher): `$8/ac`, headland pattern
  `{laps:3, order:"first"}` like the mower. `TASK_AGENT_KIND`/`TASK_IMPLEMENT`/
  `FIELD_EXPENSE_ITEM`/`TASK_PAST_VERB`/`LIFECYCLE_TASKS`/`REVEALS_TEXTURE`
  arms added. Completion → `status="stubble"`, `residueMulched=true`, clears
  `forageReady`/`windrowed` (mulch is the alternative to baling).
- **Yield**: `productivityMultiplier` adds a flat +0.07 when
  `field.residueMulched` (additive, per maintainer); `applyHarvestDone` consumes
  it (the boost lifts exactly the next harvest). `applyPlant` re-arms the
  once-per-cycle `autoMulchDone` guard.
- **Eligibility** (`canMulch`): `harvested` + annual (`!isPerennial(crop|lastCrop)`)
  + not already mulched + no rake/bale queued. Enforced in `enqueueTask`,
  `isStartable`, `effectiveStatus` (queued mulch → `stubble`).
- **Auto-manage**: fires in the `harvested` case between baling and plowing —
  `plan.mulch && !autoMulchDone && canMulch && !inPlowWindow && monthMatches`.
  A late harvest that lands in plow season just skips straight to plowing.
- **Schedule tab**: `legalMonthsFor("mulch")` = months after the natural
  harvest up to Nov (before the Dec plow window); new Mulch column (🍂,
  `toggleProp:"mulch"`, off by default) between Harvest and Rake/Bale; covered
  by "Reset to automatic timing". **View tab**: 🍂 Queue Mulch button when
  `canMulch`. `FieldPlan.mulch` + `schedule.mulch` added.
- Tests: new `tests/mulch.test.ts` (14) — `canMulch` gates, +7% additive stack,
  harvest-consumes-flag, `legalMonthsFor` window, cost, and two auto-manage
  integration runs (fires when on / no-op when off). **303/303 passing,
  typecheck clean.**
- **UX-needs-eyes** (no Browser Preview): the mulcher shop icon, the 🍂 Mulch
  column + toggle on the Schedule calendar, the Queue Mulch button, and the
  in-field stubble reveal as the mulcher drives — check in `npm run dev`. Drop a
  `Mulcher_<Size>_sideleft.png` into `src/assets/Equipment/` for photo art
  (falls back to the SVG until then).

## Latest changes (2026-07-21, seasonal price re-anchored to a fixed December peak)

The seasonal curve was per-product (peaked 4 months after each product's last
harvest — corn Jan, soy Feb). Maintainer request: **every product now peaks in
December**, tapering the same way around it.

- `gameConfig.market`: replaced `seasonalBonusByOffset` (offset-from-harvest)
  with `peakMonth: 11` + `seasonalBonusByDistance: {0:0.25, 1:0.15, 2:0.1}`
  (|months from Dec|). So **Dec +25%, Nov/Jan +15%, Oct/Feb +10%, else base.**
- `market.ts`: dropped `lastHarvestMonth` / `BALE_SOURCE_CROP` / `isGrain`;
  `seasonalMultiplier` now keys off distance-from-`peakMonth` (product-independent
  — `_product` kept in the signature for a possible future per-product curve).
  New `peakSaleMonth()` (= config `peakMonth`) replaces `peakSellMonth`; the
  auto-sell default month + the Inventory price strips now center on December.
- Tests: `market.test.ts` rewritten for the Dec peak + "identical across
  products"; `fieldLedger.test.ts` sale-at-peak moved Jan→Dec. **302/302,
  typecheck clean.**

## Latest changes (2026-07-22, background-tab sim + field revenue at harvest)

**Sim runs while tab hidden/minimized:** rAF freezes in background tabs and the
old 1s frame clamp discarded hidden time. `main.ts`: extracted `advanceSim()`
(shared sim step), added `startBackgroundTick()` — a 1s `setInterval` that
advances the sim off wall-clock whenever the tab is hidden or rAF stalls >2s.
Background-timer throttling just makes the catch-up chunkier (tickWorld already
handles month-sized deltas). Auto-skip is suppressed while hidden (its montage
needs rAF). OS sleep still pauses (clamp absorbs it, as before).

**Field Finances revenue re-worked (maintainer request):** sale-time provenance
attribution (2026-07-21's `produceStock` + `addProduce`/`attributeSale`) was
inconsistent — REMOVED. Per-field revenue is now booked once, at
harvest/bale-run completion, as tons/bales x the BASE config price
(`recordFieldCash` in `tasks.ts`). Sales no longer touch the field ledger at
all (global `recordCash` cashflow unchanged; seasonal prices still apply to
actual cash).
- `market.ts`: provenance section deleted. `economy.ts`: 3 `attributeSale`
  calls removed. `tasks.ts`: `sellHauledGrain`/`sellHauledBales` lost their
  `fieldId` param. `saveState.ts`: `produceStock` field removed (stale keys in
  old saves ignored); `main.ts` migration block deleted; Finances-tab caption
  updated.
- Tests: `fieldLedger.test.ts` sale-time tests rewritten for harvest-time
  booking (pro-rata test dropped). **301/301, typecheck clean.**

## Latest changes (2026-07-22, polish: six new crops + Inventory & Fields tab reworks)

**Six new annual crops** (`gameConfig.ts`): Winter Wheat (Sep–Oct plant, 9-month
overwinter, straw), Oats & Barley (cheap early-spring small grains, straw),
Canola & Sunflowers (oilseeds — sunflowers ready Oct/Nov, riding the Dec price
ramp), Potatoes (~2× corn's net/acre but ~$1k/ac sunk cost + ±45% yield risk +
14 t/ac of silo pressure). Balance targets documented inline in the config.
- New `straw` BaleProduct; `baleProductForField` now falls back via
  `field.lastCrop` so post-harvest annual residue routes correctly
  (corn→stover, small grains→straw). Grass emoji 🌾→🌿 (ceded to wheat).
- `newGame()` seeds grain keys from config; load migration backfills any
  missing crop keys. Ready-palette tints per crop in `fieldRender.ts`.
- Crop calendar bands now WRAP the display-year edge (winter wheat overflowed
  it — real bug, fixed with split bands).
- New `tests/crops.test.ts` (config invariants + straw routing).

**Inventory tab rework** (was "very busy"): the per-product 12-month price
strips are GONE — the seasonal curve is identical for every product, so it's
one note line now. New "Market" section: one compact row per product showing
holdings wherever they sit (bin/storage/field), today's price + badge, a
Sell-all button (routes through `sellAllOfProduct`, same as auto-sell), and
the auto-sell month dropdown + toggle. Absorbs the old Unassigned-Grain and
In-Field-Bales sections; per-silo/per-storage sell rows removed (silo rows are
assignment + fill bar only). Panel retitled "Inventory & Market".

**Fields tab rework** (was sparse): now a sortable management table — columns
Field/Acres/Status/Yield/Net-this-year (from fieldLedger), inline auto-manage
switch (same behavior as the field panel's, incl. seeding a starter plan) and
a locate button per row, topped by a whole-farm summary strip (fields, acres,
growing count, bales down, net YTD). Click headers to sort; numbers sort
big-first on first click.

**307/307 tests, typecheck clean.** UI changes are logic-tested only — the new
Inventory/Fields layouts and the 10-crop calendar need eyes in a browser.

## Latest changes (2026-07-23, big batch: rotation sequence → sell task, 8 commits)

Maintainer's ~20-item list, built as 8 commits. **411/411 tests (was 307),
typecheck + build clean.**

- **Rotation is a SEQUENCE, not one plan per campaign year** (`6fd254a`).
  `plans` is now ordered Current→Next→…, with `Field.rotationIndex` instead of
  `plans[(year-1) % len]`. Advances when the next step's PLANT TASK STARTS
  (`FarmTask.advancesRotation`) — not at harvest (residue work stays owned by
  the outgoing crop) and not at enqueue (a canceled plant would strand the
  pointer). `autoManageField` juggles two steps: `plan` (running) owns weed/
  fert/harvest/mulch/bale; `upcoming` owns plow/plant. Saves migrate:
  `rotationIndex = (year-1) % len`. **Fixed the Winter Wheat blank rows** as a
  side effect — `legalMonthsFor` clamped at December, so wheat's harvest asked
  for `rangeClamped(17, 11)` = empty.
- **Schedule tab: crop chips** (`5afa35f`) replacing the dropdown rows and the
  `‹ Yr N ›` stepper. Bale icon on balable crops, Fertilize before Weed,
  rotation NAME + Copy/Paste (module clipboard, deep-copied both ways),
  overwintering crops get a faded/striped "next year" band. `removeRotationStep`
  lives in tasks.ts with tests — a naive splice silently changes which crop the
  field is growing.
- **⚠️ `npm run build` was corrupting the test suite** (fixed in `5afa35f`):
  `"tsc && vite build"` with no `noEmit` wrote a `.js` beside every `.ts` in
  `src/`, and **Vite resolves `.js` before `.ts`**, so tests ran against stale
  compiled output. Found via a fresh export reporting "not a function". Set
  `noEmit` in tsconfig, deleted 32 files, gitignored the pattern.
- **Display fixes** (`4002158`): mulch showed as "Harvesting" (`taskVerb` had no
  branch, fell through to the harvest default); field panel keeps its tab across
  field clicks; header shows total acres instead of grain; field badge gets a
  44px crop icon, acres, rotation name. Net Worth needed no change — verified
  against the three existing tests.
- **Balance** (`aa57295`): harvest costs $30/ac (was free). Mulch on every
  annual at two rates — 7% whole residue, 3% if baled off first
  (`Field.residueBaled`). Corn no longer bales. Straw skips the rake
  (`needsRakeBeforeBaling`). Loan borrow/paydown finally book to the ledger —
  they booked *nothing* before, so Net disagreed with the bank balance.
- **Headlands on concave fields** (`866d52d`): `offsetPolygonInward` chose each
  edge's inward normal by pointing at the CENTROID, which is only valid on
  convex shapes — a notch edge got flipped, tripped the edge-reversal check,
  returned null, and `buildHeadlandCoveragePath` silently degraded to a plain
  path. Now derived from ring WINDING. New `headlandShapes.test.ts` (17):
  L-shape, plus, notched rectangle.
- **Harvest windows + withering** (`7a1698e`): annuals are harvestable for
  `harvestWindowMonths` (2) from ripening; miss it and the crop is a TOTAL loss.
  New `withered` status + texture (standing dead crop — the read that matters is
  against `stubble`, which was *cut*). Never interrupts an active combine; a
  stranded queued harvest is cancelled and refunded. Field panel counts down the
  remaining months and explains the loss. Crop Calendar gained bale icons and its
  harvest band now draws the real window.
- **Crews + rig selection + blocked warnings** (`edf6182`): hauling jobs run up
  to `maxCrewSize` (3) rigs as PARALLEL TASKS, so each keeps the proven
  single-agent brain. Assignment inverted — biggest implement first, then the
  smallest tractor that can pull it (was: smallest tractor grabs it, then hitches
  the biggest tool *it* can pull — a 5ft plow on 400 acres with a large tractor
  idle). New "Blocked" section surfaces missing equipment + cash shortfalls via a
  typed `InsufficientFundsError`; out-of-season stays silent.
- **Sell task** (`b6489e6`): selling is now a choice. Instant from Inventory =
  base −10%, no seasonal premium. Hauled to a Sell Point (now FREE) = full
  seasonal price — ~39% better at the December peak. Auto-sell queues a run,
  falling back to instant only when a run is impossible.

**UX-needs-eyes (no Browser Preview — maintainer directive).** None of this
session's UI has been seen in a browser:
- Crop chips at the 320px panel width (long names, 3-crop rotations; the green
  "current" dot vs the gold "selected" fill).
- The Winter Wheat calendar wrap — faded rows + the `↑ next year` divider.
- The **withered texture** — chiefly whether it reads as distinct from stubble
  at map zoom.
- Blocked ⚠️ rows, the sell-run queue row, and the Inventory "🚜 Haul" button.

**Save-compat note:** a crop sitting ripe in an old save will WITHER shortly
after loading — the harvest window is enforced from `plantedAt`.

## Known gaps / unverified

- **Field panel Schedule calendar drag-and-drop is logic-tested only** — no
  visual/interactive verification (no Browser Preview in this project).
- **Economy is partly real now** (2026-07-23) — seasonal prices, and produce is
  physically hauled to a Sell Point for full price vs. an instant discounted
  sale. Still NO buyers with capacity, no local demand drop, no per-buyer
  distance/price tradeoff (brief §5's core tension).
- Rotation planner unplayed in real sessions (unit-tested only).
- Drag-reorder in Work Queue unmanually verified.
- Routing uses public OSRM demo (not self-hosted).
- **Browser Preview is OFF** (maintainer directive). New unseen: rotation planner UI,
  cellular-decomposition visuals (transits crossing notches), updated bale markers,
  machine icon flip, headland-lap frames + drive paths — logic tested, UX needs eyes.

## How to run

`npm run dev` → http://localhost:5173. Checks: `npm run typecheck`, `npm test`.
**Do not use Browser Preview** — see CLAUDE.md.
