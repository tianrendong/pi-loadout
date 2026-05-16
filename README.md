# pi-loadout

Interactive tool loadouts for Pi sessions.

`pi-loadout` adds one user-facing command, `/loadout`, for choosing which tools are active in the current Pi session. Tools are grouped by source extension/package, and group rows toggle every tool from that source.

All tools are enabled by default. Saved selections persist in the current session branch.

## Install

```bash
pi install npm:pi-loadout
```

## Usage

```text
/loadout
```

Controls:

- `Space` / `Enter` — toggle selected group or tool
- `Ctrl+S` — save and apply loadout
- `↑` / `↓` — navigate
- `J` / `K` — navigate down / up
- `Esc` — cancel without saving

## Behavior

- Group rows show `[x]` when all tools in that group are enabled.
- Group rows show `[-]` when some tools in that group are enabled.
- Group rows show `[ ]` when no tools in that group are enabled.
- Toggling a group enables/disables all tools from that extension/package.
- Toggling a tool affects only that tool.
