# Farm Logistics Sim — Claude Code Instructions

> Session process/scope rules live here. Design/architecture rules live in
> `PROJECT_BRIEF.md`; session history lives in `STATUS.md`. Read all three at
> the start of a session.

## Verification: no Browser Preview

Do not use the Browser Preview tool (`preview_start`, `computer`, `read_page`,
`get_page_text`, `javascript_tool`, etc.) in this project — maintainer
directive, 2026-07-11, after it repeatedly hung mid-session (NAIP tile fetch
stuck in the sandbox) and burned time/cost on screenshot round-trips before
that.

- Verify changes with `npm run typecheck` and `npm test` only.
- If a change is genuinely UI/visual and needs eyes on it, say so explicitly
  and ask the maintainer to check it themselves in their own browser — don't
  reach for the preview tool as a substitute.

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

Never put a 1024 px PNG in `src/assets/Equipment/`.
