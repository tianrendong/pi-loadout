# pi-loadout

Interactive tool and skill loadouts for [Pi](https://pi.dev) sessions.

`pi-loadout` adds a `/loadout` command for choosing which tools and skills are active in the current Pi session, grouped by source extension/package. Toggles apply live as you change them, the session branch is updated on close, and you can save the current selection as a global default for future sessions.

## Install

```bash
pi install npm:pi-loadout
```

## Usage

```text
/loadout          # open interactive picker
/loadout full     # enable every available tool and skill
/loadout minimal  # enable only built-in tools and skills
/loadout default  # apply saved global default loadout
/loadout save <name>    # save current loadout as a user preset
/loadout use <name>     # apply a built-in, default, or user preset
/loadout list           # list built-in and user presets
/loadout delete <name>  # delete a user preset
/loadout status   # print current active tools and skills
/loadout reset    # alias for /loadout full
/loadout help     # show subcommand list
```

### Picker controls

- Just start typing — filters tools/skills live by their name **or** their extension/source name (standard text editing, including word delete with Option/Alt+Delete)
- `Tab` — switch between Tools, Skills, and Presets panes
- `Space` — toggle the selected group/tool/skill, or apply the selected preset (applies immediately)
- `Enter` — collapse/expand the selected group, or apply the selected preset
- `Ctrl+P` — save current selection as a user preset using the search field as the preset name
- `Ctrl+D` — delete the selected user preset in the Presets pane
- `Ctrl+S` — save current selection as the global default (`~/.pi/agent/loadout.json`)
- `↑` / `↓` — navigate
- `Esc` — clear the search filter if one is active, otherwise close the picker (live changes are kept and persisted to the session branch)

## Why use `/loadout`?

Pi enables every installed tool and skill by default. As your package list grows, that becomes harder to manage. `/loadout` gives you grounded control over what each session can do:

- **Hide skills you don't want auto-suggested, keep them callable manually.** Disabled skills are removed from the model's `<available_skills>` system prompt block, but `/skill:name` invocation still works. Useful when a skill is helpful occasionally but distracting in normal turns.
- **Disable tools you don't want the model to reach for in this session** without uninstalling the package that provides them. Saved selection persists in the current session branch and is restored when you resume.
- **Run Pi on smaller or cheaper models** by trimming the tool definitions and skill block down to what the task actually needs.
- **Debug extensions** by toggling individual tools or whole packages on and off without an install/reinstall cycle.
- **Start from presets.** `/loadout full` enables everything; `/loadout minimal` enables only built-in tools and skills; `/loadout default` reapplies your saved global default.
- **Save reusable presets.** `/loadout save <name>` stores the current selection in `~/.pi/agent/loadout-profiles.json`; the interactive Presets pane can list, apply, save, and delete them too.
- **Set a sensible default once.** `Ctrl+S` in the picker writes the current selection to `~/.pi/agent/loadout.json`, which seeds new sessions until you override it per-branch.

## How it works

- **Live apply.** Each toggle in the picker calls Pi's active-tool API immediately. There is no separate "save" step inside the picker for the session; changes are in effect as you make them.
- **Branch-persisted on close.** When the picker closes (Esc, or selecting a confirmation), the current selection is appended to the session branch as a custom entry (`pi-loadout:selection`). Resuming or branching the session restores it.
- **Presets.** `full` selects all tools and skills. `minimal` selects only entries whose source is Pi built-in. `default` applies the saved global default from `~/.pi/agent/loadout.json`. User presets are full snapshots saved under `~/.pi/agent/loadout-profiles.json`.
- **Interactive Presets pane.** Press `Tab` to reach Presets. `Space`/`Enter` applies the selected preset. Type a name and press `Ctrl+P` to save the current selection. Select a user preset and press `Ctrl+D` to delete it.
- **Global default (`Ctrl+S`).** Writes the current selection to `~/.pi/agent/loadout.json`. New sessions without their own branch entry read this file.
- **Skill filtering.** The skill list shown to the model is filtered in `before_agent_start` by replacing the `<available_skills>` block. Explicit `/skill:name` invocations are unaffected.
- **Session log entries.** Loadout changes are logged as visible session messages (`pi-loadout:loadout changed`) for resume/export readability. These log entries are filtered out of context, compaction, and tree summarization, so they don't pollute model input.
- **Status bar.** While installed, the footer shows `N/total tools · N/total skills` for the current session.

### Group rows

- `● enabled` — every item in the group is enabled
- `◐ partial` — some items in the group are enabled
- `○ disabled` — no items in the group are enabled

Toggling a group toggles every item in that group. Toggling an item affects only that item.

## Caveats

- **Prompt-cache miss on change.** Changing tool definitions or available skills invalidates provider prompt caches. The next response after a loadout change is typically slower and more expensive. If you toggle frequently within a session, expect repeated cache misses.
- **Mid-session changes are silent to the model.** Loadout log entries are filtered out of the model's context. If a tool disappears mid-session the model may still attempt to call it on the next turn before adapting.
- **Preset snapshots are explicit.** User presets store exact tool and skill names. If extensions are later removed, missing entries are ignored when applying the preset.

## License

MIT
