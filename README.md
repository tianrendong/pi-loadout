# pi-loadout

Interactive tool and skill loadouts for Pi sessions.

`pi-loadout` adds one user-facing command, `/loadout`, for choosing which tools and skills are active in the current Pi session. Tools and skills are grouped by source extension/package, and group rows can toggle or collapse every item from that source.

All tools and skills are enabled by default. Selections apply immediately and save to the current session branch when `/loadout` closes. Press `Ctrl+S` inside `/loadout` to save the current loadout as the default for future sessions.

## Install

```bash
pi install npm:pi-loadout
```

## Usage

```text
/loadout
```

Controls:

- `Tab` — switch between tool loadout and skill loadout
- `Space` — toggle selected group, tool, or skill; changes apply immediately
- `Enter` — collapse/expand selected group; when on an item, collapse its parent group
- `Ctrl+S` — save current loadout as the default for future sessions (inside `/loadout`)
- `↑` / `↓` — navigate
- `J` / `K` — navigate down / up
- `Esc` — close selector

## Behavior

- Group rows show `● enabled` when all items in that group are enabled.
- Group rows show `◐ partial` when some items in that group are enabled.
- Group rows show `○ disabled` when no items in that group are enabled.
- Toggling a group enables/disables all tools or skills from that extension/package.
- Toggling a tool or skill affects only that item.
- Collapsing a group hides its item rows without changing enabled state.
- Changes apply immediately and save to the current session branch when the selector closes.
- `Ctrl+S` inside `/loadout` writes the current loadout to `~/.pi/agent/loadout.json` so future sessions use it by default.
- Tool/skill changes warn that the next LLM call may miss prompt cache because tool definitions or available skills changed.
- Applied changes are logged as visible session messages for resume/export reproducibility.
- Tool loadouts call Pi's active-tool API immediately after selection changes.
- Skill loadouts filter the skills shown to the model in future turns; explicit `/skill:name` commands remain available.
