# Farm Logistics Sim — Claude Code Instructions

> Session process/scope rules live here. Design/architecture rules live in
> `PROJECT_BRIEF.md`; session history lives in `STATUS.md`. Read all three at
> the start of a session.

## Verification: Browser Preview is back on (2026-08-12)

Browser Preview (`preview_start`, `computer`, `read_page`, `get_page_text`,
`javascript_tool`, etc.) was banned from 2026-07-11 through 2026-08-12 —
maintainer directive, after it repeatedly hung mid-session (NAIP tile fetch
stuck in the sandbox) and burned time/cost on screenshot round-trips before
that. Maintainer re-enabled it 2026-08-12.

- Prefer `npm run typecheck` and `npm test` first — they're cheap and catch
  most regressions — but use Browser Preview to actually verify UI/visual
  changes (layout, map rendering, calendar interactions) instead of asking
  the maintainer to eyeball every change themselves.
- **Known hang risk:** the previous ban was caused by NAIP tile fetches
  hanging the preview sandbox. If a preview session stalls on a map/imagery
  load again (not just a slow network tile — an actual non-responding hang),
  stop, tell the maintainer what triggered it, and fall back to
  typecheck+test verification for that change rather than burning time
  retrying. Don't silently re-ban the tool yourself — that's the
  maintainer's call.

## Editing this repo

- `src/sim/tasks.ts` and `src/main.ts` are large and dense — read the
  relevant section, not the whole file, once you know what you're looking for.
- Update `STATUS.md` at the end of a session (brief §13) — keep it terse,
  changed-files-and-why, not a narrative.
- **Never edit source files with PowerShell** (`Set-Content`, `Out-File`,
  `>`/`>>`). Windows PowerShell 5.1 writes a BOM and re-encodes the file's
  existing UTF-8 bytes as ANSI, so every `—`, `§`, `→` and `⚠️` in the comments
  turns into mojibake. It happened to `src/sim/tasks.ts` on 2026-07-25 while
  toggling one line for a revert-check: 16 real lines, 602 changed, and it
  compiled and passed all 630 tests because only comments were hit. Use the
  Edit/Write tools, which encode correctly.
  - Corollary: **check `git diff --stat` before committing.** A line count far
    larger than the change is the tell; `git checkout -- <file>` and redo it.
- `tools/` holds build-time data scripts (county index). Their OUTPUT
  (`public/counties/index.json`) is committed; the downloaded source data
  (Census shapefile zips) is not — keep it outside the repo.

## Machine sprites (2026-07-25)

Shipped sprites in `src/assets/Equipment/` must be **256×256** — they render at
60–78 px, and raw 1024×1024 generations were 84% of the built payload before
the resize (dist 31 MB → 5.3 MB). Workflow for new art:

1. Generate at full size (left-facing, transparent background, no brand
   logos — see `src/ui/machineImages.ts` header for the naming convention).
2. Save the full-res original to `art-source/Equipment/` (tracked in git,
   outside the Vite glob; `_drafts/` remains gitignored scratch).
3. Drop a 256×256 resize into `src/assets/Equipment/` under the same name —
   PowerShell System.Drawing with HighQualityBicubic works fine.
   **PAD a non-square source to a square on transparency FIRST**, then resize.
   `machineImgTag` renders into a forced-square `<img>`, so squashing e.g. a
   1536×1024 generation straight to 256×256 stretches the machine vertically
   (the windrower shipped that way until 2026-07-25). Letterboxing is correct.

Never put a 1024 px PNG in `src/assets/Equipment/`, and never leave a raw export
(`ChatGPT Image ….png`) there — every PNG in that directory is globbed into the
build, and an unparseable name silently registers as a junk sprite entry. Raw
exports belong in `_drafts/` (gitignored) or `art-source/` under a real name.

## Structure sprites (2026-07-30)

Same pipeline for BUILDINGS, in `src/assets/Structures/` — see that
directory's `README.md` for the naming table and art direction. Differences
from the machine sprites:

- **Naming is `<Kind>[_<Size>].png`**, no `sideleft` tag. Buildings have no
  heading and are never mirrored. Only `Silo` takes a size.
- **Front/side ELEVATION, base flush to the bottom edge.** Markers anchor at
  the bottom, so whitespace under the building makes it hover.
- **Image width = the real footprint width** (`structureWidthM` in
  `src/field/buildingRender.ts`), which is what keeps a grain bin and a
  machine shed proportioned against each other on the ground.
- **No baked drop shadow** — the CSS adds one; a baked one double-darkens.

Art is optional: with no PNG present each kind falls back to the hand-drawn
SVG in `src/ui/structureIcons.ts`, so the map always renders something.

## Map layers fail silently — validate them

A MapLibre symbol layer with a bad expression, a missing glyph stack, or a
collision default you didn't intend renders **nothing** and logs **nothing**.
With Browser Preview off, no other check catches it: the "I only see 1 field
label" bug (2026-07-30) shipped past a clean typecheck and 733 green tests,
because `text-allow-overlap` defaults to FALSE and adjacent fields culled each
other.

So: keep every layer's spec in an exported function (`fieldLabelLayer`,
`baleSymbolLayer`) and add it to `tests/mapLayers.test.ts`, which runs the real
`@maplibre/maplibre-gl-style-spec` validator over it and asserts the properties
that decide whether anything appears. Adding a layer inline in a
`map.addLayer({...})` call skips that net.
