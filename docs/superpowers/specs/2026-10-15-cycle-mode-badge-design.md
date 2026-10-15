# Agent Mode In The HUD

**Date**: 2026-10-15
**Status**: Approved (Frank, 2026-10-15)

## Problem

Antigravity CLI 1.3.5 cycles four agent modes with `Shift+Tab`: the default, which asks before
acting, `accept-edits`, `auto` (edits and safe commands approved without asking) and `plan` (research
only). The mode decides how closely the user needs to watch the agent.

The CLI shows it in two places, measured on 1.3.5. The prompt placeholder
(`Auto mode: edits & safe commands auto-approved`) disappears as soon as the user types. The
built-in status line keeps it (`auto · Gemini 3.8 Flash · high`). A custom status line replaces the
built-in one, so agy-hud users currently lose the only persistent indicator.

The payload carries it as `cycle_mode`: `"plan"`, `"accept-edits"` or `"auto"`, and the key is
absent in the default mode.

## Contract

- The mode is appended to the model segment, after the plan tier and before the directory:
  `3.8 Flash High | Pro | Auto │ agy-hud-ts │ main │ Working`. It is a session setting like the model
  and plan, so it sits with them and away from the agent state, which changes every turn. Reading
  `Auto │ Idle` side by side invites it to be taken as one state.
- Labels: `plan` → `Plan`, `accept-edits` → `Accept Edits`, `auto` → `Auto`. An absent, empty or
  `default` value shows nothing, so the default mode renders exactly as before.
- An unknown value made only of ASCII letters, digits and hyphens, up to 24 characters, is shown
  title-cased by hyphen (`review-only` → `Review Only`), so a future mode still appears. Anything
  else is ignored: the value is never printed raw.
- Colour, when enabled: `Auto` orange, `Accept Edits` and unknown modes yellow, `Plan` cyan. The rest
  of the model segment keeps its blue.
- Because it is part of the model segment, it survives every narrow-terminal fallback that keeps the
  model, in both multiline and single-line layouts.
- `show_mode` (default `true`) turns it off.

## Acceptance

- Unit tests cover each label, absence, `default`, unknown and unsafe values, `show_mode: false`,
  colour, the single-line layout, and the position before the directory.
- The 1.3.5 fixture payload (`cycle_mode: "auto"`) renders `| Auto`.
