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
/loadout default  # apply saved global default loadout
/loadout save <name>    # save current loadout as a user preset
/loadout use <name>     # apply the default or a user preset
/loadout list           # list the default and user presets
/loadout delete <name>  # delete a user preset
/loadout mode <direct|codemode|deferred|off> <tool...>  # set tool exposure (* wildcards ok)
/loadout status   # print current active tools and skills
/loadout reset    # reset to Pi's defaults: every tool and skill (MCP tools keep their exposure)
/loadout help     # show subcommand list
```

To start Pi with a preset, pass `--loadout <name>` (or `--loadout default`):

```bash
pi --loadout minimal
```

### Picker controls

The hint bar is contextual to the active pane, and the selected row's description spells out the actions available on it. Press `?` for the full shortcut overlay:

- Just start typing — filters tools/skills live by their name **or** their extension/source name (standard text editing, including word delete with Option/Alt+Delete)
- `?` — toggle the shortcut overlay
- `Tab` — switch between Tools, MCP, Skills, and Presets panes (MCP appears when MCP tools are registered)
- `Space` — toggle the selected skill/group, cycle the selected tool (or tool group) through `direct` → `codemode` → `deferred` → `off`, or apply the selected preset (applies immediately)
- `Enter` — collapse/expand the selected group, or apply the selected preset
- `Ctrl+P` — save current selection as a user preset using the search field as the preset name
- `Ctrl+D` — delete the selected user preset in the Presets pane
- `Ctrl+S` — save current selection as the global default (`~/.pi/agent/loadout.json`)
- `↑` / `↓` — navigate
- `Esc` — clear the search filter if one is active, otherwise close the picker (live changes are kept and persisted to the session branch)

### Tool modes

When Pi's `codemode` tool is available, each tool can be set to one of four modes. The three reachable ones are named after Pi's tool exposures (see "Tool exposure" in Pi's `docs/extensions.md`):

- `● direct` — declared to the model as a normal tool.
- `◆ codemode` — not declared; callable from `codemode` scripts (`tools.<name>(args)`) and listed in the `codemode` tool's description.
- `◇ deferred` — like `codemode`, but not listed; the model finds it with `searchTools()` / `describeTool()`. Use it for rarely used tools so the description's inline budget (`codemode.inlineBudget`, default 3000 tokens) goes to the tools you use most. Pi fills that budget cheapest-first, so tools with large schemas are the first to be silently left out. Unlike a tool registered with `deferred` exposure, `tool_search` does not load it.
- `○ off` — not reachable, not even from `codemode` scripts or when the model is asked to call it, until you switch it back. (Not Pi's `hidden` exposure, which withdraws a tool for good.)

Which modes apply depends on the tool's registered exposure:

| Tool exposure | Modes |
|---|---|
| `direct` (built-in and most extension tools) | direct, codemode, deferred, off |
| `codemode` / `deferred` (e.g. MCP tools) | direct, its own exposure, off (calls blocked) |
| `model-only` (e.g. `codemode` itself) | direct, off |

Set modes in the picker with `Space`, or from the command line:

```text
/loadout mode codemode read grep find   # call only from codemode scripts
/loadout mode deferred example_*        # call from scripts, but leave unlisted
/loadout mode direct mcp__example__*    # declare these MCP tools directly
/loadout mode off mcp__example__*       # turn off a whole MCP server
/loadout mode off write                 # `hidden` is accepted as an alias
```

Setting a tool to `codemode` or `deferred` enables the `codemode` tool if it is off. Those tools stay active, but their declarations are hidden through a `prepareLoadout` hook on an internal `pi_loadout_codemode_only` tool, the same mechanism Pi's `codemode.mode: "only"` setting uses, and the hook presents them to `codemode` with the matching exposure. Tool modes are saved with the session branch, the global default, and user presets (`codemodeTools`, `deferredTools`, `disabledTools`). Tools that are not registered yet when a loadout is applied (such as MCP tools of servers still connecting) are applied once they register.

### MCP pane

MCP tools get their own pane instead of being mixed into Built-in tools. Tools are grouped by server (`mcp__<server>`), with the resource tools (`list_mcp_resources`, …) in an `MCP resources` group. Servers start collapsed, so the pane reads as a list of servers with their tool counts.

- `Space` on a server cycles every tool of that server: `direct` → its exposure → `off`.

Pi registers MCP tools with `deferred` exposure, even for servers configured with `"exposure": "codemode"`: scripts can call them, but the `codemode` description lists only the server namespace, and the model finds the tools with `searchTools()`. This keeps the description unchanged, and the prompt cache intact, when servers connect, so the loadout does not offer listing them (`codemode`).
- `Space` on a tool cycles just that tool, so you can turn a server off and keep one or two of its tools (or the reverse).
- `Enter` expands/collapses a server. Typing filters by server or tool name.

MCP tools with `codemode`/`deferred` exposure are callable whenever registered, so `off` is enforced by the loadout: calls to them (directly, from `codemode` scripts, or after `tool_search` loads them) are blocked in a `tool_call` handler, they are left out of the `codemode` description and declarations, and servers whose tools are all off are left out of the `mcp_servers` system prompt section. `searchTools()` in codemode scripts can still list them. This is session-scoped; use `/mcp` to disable a server in its config.

## Why use `/loadout`?

Pi enables every installed tool and skill by default. As your package list grows, that becomes harder to manage. `/loadout` gives you grounded control over what each session can do:

- **Hide skills you don't want auto-suggested, keep them callable manually.** Disabled skills are removed from the model's `<available_skills>` system prompt block, but `/skill:name` invocation still works. Useful when a skill is helpful occasionally but distracting in normal turns.
- **Disable tools you don't want the model to reach for in this session** without uninstalling the package that provides them. Saved selection persists in the current session branch and is restored when you resume.
- **Run Pi on smaller or cheaper models** by trimming the tool definitions and skill block down to what the task actually needs.
- **Debug extensions** by toggling individual tools or whole packages on and off without an install/reinstall cycle.
- **Start from presets.** `/loadout default` reapplies your saved global default; `/loadout reset` goes back to Pi's defaults (everything enabled).
- **Save reusable presets.** `/loadout save <name>` stores the current selection in `~/.pi/agent/loadout-profiles.json`; the interactive Presets pane can list, apply, save, and delete them too.
- **Set a sensible default once.** `Ctrl+S` in the picker writes the current selection to `~/.pi/agent/loadout.json`, which seeds new sessions until you override it per-branch.

## How it works

- **Live apply.** Each toggle in the picker calls Pi's active-tool API immediately. There is no separate "save" step inside the picker for the session; changes are in effect as you make them.
- **Branch-persisted on close.** When the picker closes (Esc, or selecting a confirmation), the current selection is appended to the session branch as a custom entry (`pi-loadout:selection`). Resuming or branching the session restores it.
- **Presets.** `default` applies the saved global default from `~/.pi/agent/loadout.json`. User presets are full snapshots saved under `~/.pi/agent/loadout-profiles.json`.
- **Interactive Presets pane.** Press `Tab` to reach Presets. `Space`/`Enter` applies the selected preset. Type a name and press `Ctrl+P` to save the current selection. Select a user preset and press `Ctrl+D` to delete it.
- **Global default (`Ctrl+S`).** Writes the current selection to `~/.pi/agent/loadout.json`. New sessions without their own branch entry read this file.
- **Skill filtering.** The skill list shown to the model is filtered in `before_agent_start` by replacing the `<available_skills>` block. Explicit `/skill:name` invocations are unaffected.
- **Session log entries.** Loadout changes are logged as visible session messages (`pi-loadout:loadout changed`) for resume/export readability (skipped until the session has its first prompt). These log entries are filtered out of context, compaction, and tree summarization, so they don't pollute model input.
- **Status bar.** While installed, the footer shows `N/total tools · N/total skills` for the current session.

### Group rows

- `● enabled` — every item in the group is enabled
- `◐ partial` — some items in the group are enabled
- `○ disabled` — no items in the group are enabled

Toggling a group toggles every item in that group. Toggling an item affects only that item.

## Caveats

- **Prompt-cache impact on change.** On Pi versions with structured system prompt sections, loadout changes are appended as mid-conversation system messages (a `skills` section patch plus `toolsAdded`/`toolsRemoved`), so the earlier cached prefix is preserved on providers that support it. On older Pi versions, or providers that cannot represent the transition, a change may still invalidate the prompt cache and make the next response slower and more expensive.
- **Mid-session changes are silent to the model.** Loadout log entries are filtered out of the model's context. If a tool disappears mid-session the model may still attempt to call it on the next turn before adapting.
- **Preset snapshots are explicit.** User presets store exact tool and skill names. If extensions are later removed, missing entries are ignored when applying the preset.

## License

MIT
