import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SettingsList,
  Text,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";

const STATE_CUSTOM_TYPE = "pi-loadout:selection";

type StoredState = {
  enabledTools: string[];
};

type ToolGroup = {
  key: string;
  label: string;
  tools: ToolInfo[];
};

type RowId = `group:${string}` | `tool:${string}`;

type RowRef =
  | { kind: "group"; group: ToolGroup }
  | { kind: "tool"; group: ToolGroup; tool: ToolInfo };

export default function loadoutExtension(pi: ExtensionAPI) {
  let enabledTools = new Set<string>();

  function allTools(): ToolInfo[] {
    const byName = new Map<string, ToolInfo>();
    for (const tool of pi.getAllTools()) byName.set(tool.name, tool);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function allToolNames(): string[] {
    return allTools().map((tool) => tool.name);
  }

  function activeToolNames(): string[] {
    return pi.getActiveTools();
  }

  function sourceLabel(tool: ToolInfo): string {
    const source = tool.sourceInfo?.source;
    if (source === "builtin") return "Built-in tools";
    if (source === "sdk") return "SDK tools";
    if (source && source !== "unknown") return source;

    const path = tool.sourceInfo?.path;
    if (!path) return "Other tools";
    if (path.startsWith("<builtin:")) return "Built-in tools";
    return path;
  }

  function groupTools(tools: ToolInfo[]): ToolGroup[] {
    const byKey = new Map<string, ToolGroup>();

    for (const tool of tools) {
      const key = sourceLabel(tool);
      const group = byKey.get(key);
      if (group) group.tools.push(tool);
      else byKey.set(key, { key, label: key, tools: [tool] });
    }

    return [...byKey.values()].sort((a, b) => {
      if (a.label === "Built-in tools") return -1;
      if (b.label === "Built-in tools") return 1;
      return a.label.localeCompare(b.label);
    });
  }

  function normalizeEnabled(names: Iterable<string>): Set<string> {
    const available = new Set(allToolNames());
    return new Set([...names].filter((name) => available.has(name)));
  }

  function applyEnabled(next: Set<string>) {
    enabledTools = normalizeEnabled(next);
    pi.setActiveTools([...enabledTools]);
    pi.appendEntry<StoredState>(STATE_CUSTOM_TYPE, { enabledTools: [...enabledTools] });
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    let restored: string[] | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      const data = entry.data as StoredState | undefined;
      if (Array.isArray(data?.enabledTools)) restored = data.enabledTools;
    }

    enabledTools = restored ? normalizeEnabled(restored) : new Set(allToolNames());
    pi.setActiveTools([...enabledTools]);
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus("loadout", `${activeToolNames().length}/${allToolNames().length}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
    updateStatus(ctx);
  });

  pi.registerCommand("loadout", {
    description: "Select active tools for this session",
    handler: async (_args, ctx) => {
      const tools = allTools();
      if (tools.length === 0) {
        ctx.ui.notify("No tools available.", "warning");
        return;
      }

      const groups = groupTools(tools);
      const draftEnabled = normalizeEnabled(activeToolNames());
      const rowRefs = new Map<RowId, RowRef>();

      function groupValue(group: ToolGroup): "enabled" | "disabled" | "partial" {
        const count = group.tools.filter((tool) => draftEnabled.has(tool.name)).length;
        if (count === 0) return "disabled";
        if (count === group.tools.length) return "enabled";
        return "partial";
      }

      function groupDescription(group: ToolGroup): string {
        const count = group.tools.filter((tool) => draftEnabled.has(tool.name)).length;
        return `${count}/${group.tools.length} enabled · Space/Enter toggles all tools from ${group.label}`;
      }

      function buildItems(): SettingItem[] {
        const items: SettingItem[] = [];
        rowRefs.clear();

        for (const group of groups) {
          const groupId = `group:${group.key}` as RowId;
          rowRefs.set(groupId, { kind: "group", group });
          items.push({
            id: groupId,
            label: `◆ ${group.label}`,
            description: groupDescription(group),
            currentValue: groupValue(group),
            values: ["enabled", "disabled"],
          });

          group.tools.forEach((tool, index) => {
            const toolId = `tool:${tool.name}` as RowId;
            const branch = index === group.tools.length - 1 ? "╰─" : "├─";
            rowRefs.set(toolId, { kind: "tool", group, tool });
            items.push({
              id: toolId,
              label: `  ${branch} ${tool.name}`,
              description: tool.description ? `${group.label} · ${tool.description}` : group.label,
              currentValue: draftEnabled.has(tool.name) ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            });
          });
        }

        return items;
      }

      const result = await ctx.ui.custom<Set<string> | null>((tui, theme, _keybindings, done) => {
        let settingsList: SettingsList;
        const items = buildItems();

        function refreshValues() {
          for (const group of groups) {
            const groupId = `group:${group.key}`;
            settingsList.updateValue(groupId, groupValue(group));
            const item = items.find((item) => item.id === groupId);
            if (item) item.description = groupDescription(group);

            for (const tool of group.tools) {
              settingsList.updateValue(
                `tool:${tool.name}`,
                draftEnabled.has(tool.name) ? "enabled" : "disabled",
              );
            }
          }
          tui.requestRender();
        }

        const listTheme: SettingsListTheme = {
          cursor: theme.fg("accent", "→ "),
          label: (text: string, selected: boolean) => {
            const trimmed = text.trimStart();
            if (trimmed.startsWith("◆")) {
              const styled = theme.bold(text);
              return selected ? theme.fg("accent", styled) : theme.fg("borderAccent", styled);
            }
            if (trimmed.startsWith("├") || trimmed.startsWith("╰")) {
              return selected ? theme.fg("accent", text) : theme.fg("text", text);
            }
            return selected ? theme.fg("accent", text) : text;
          },
          value: (text: string, selected: boolean) => {
            const trimmed = text.trim();
            if (trimmed === "enabled") return theme.fg(selected ? "accent" : "success", "● enabled");
            if (trimmed === "partial") return theme.fg(selected ? "accent" : "warning", "◐ partial");
            if (trimmed === "disabled") return theme.fg(selected ? "accent" : "dim", "○ disabled");
            return selected ? theme.fg("accent", text) : theme.fg("muted", text);
          },
          description: (text: string) => theme.fg("dim", text),
          hint: (text: string) => theme.fg("dim", text),
        };

        settingsList = new SettingsList(
          items,
          Math.min(items.length, 18),
          listTheme,
          (id, newValue) => {
            const row = rowRefs.get(id as RowId);
            if (!row) return;

            if (row.kind === "group") {
              for (const tool of row.group.tools) {
                if (newValue === "enabled") draftEnabled.add(tool.name);
                else draftEnabled.delete(tool.name);
              }
            } else if (newValue === "enabled") {
              draftEnabled.add(row.tool.name);
            } else {
              draftEnabled.delete(row.tool.name);
            }

            refreshValues();
          },
          () => done(null),
        );

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Tool Loadout")), 1, 0));
        container.addChild(
          new Text(theme.fg("dim", "Space/Enter toggle • Ctrl+S save • ↑↓/J/K navigate • Esc cancel"), 1, 0),
        );
        container.addChild(settingsList);
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            if (matchesKey(data, Key.ctrl("s"))) {
              done(new Set(draftEnabled));
              return;
            }

            if (data === "j" || data === "J") {
              settingsList.handleInput("\x1b[B");
            } else if (data === "k" || data === "K") {
              settingsList.handleInput("\x1b[A");
            } else {
              settingsList.handleInput(data);
            }
            tui.requestRender();
          },
        };
      });

      if (result === null) {
        ctx.ui.notify("Loadout unchanged.", "info");
        return;
      }

      applyEnabled(result);
      updateStatus(ctx);
      ctx.ui.notify(`Saved loadout: ${enabledTools.size}/${allToolNames().length} tools enabled.`, "success");
    },
  });
}
