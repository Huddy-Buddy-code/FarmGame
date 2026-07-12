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
