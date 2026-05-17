import type { ExtensionAPI, ExtensionContext, Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
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
const LOG_CUSTOM_TYPE = "pi-loadout:change-log";

type StoredState = {
  enabledTools: string[];
  enabledSkills?: string[];
};

type ToolGroup = {
  key: string;
  label: string;
  tools: ToolInfo[];
};

type SkillInfo = {
  name: string;
  commandName: string;
  description?: string;
  sourceInfo?: { source?: string; path?: string };
};

type SkillGroup = {
  key: string;
  label: string;
  skills: SkillInfo[];
};

type Pane = "tools" | "skills";
type RowId = `group:${string}` | `tool:${string}` | `skillgroup:${string}` | `skill:${string}`;

type RowRef =
  | { kind: "toolGroup"; group: ToolGroup }
  | { kind: "tool"; group: ToolGroup; tool: ToolInfo }
  | { kind: "skillGroup"; group: SkillGroup }
  | { kind: "skill"; group: SkillGroup; skill: SkillInfo };

type LoadoutResult = {
  enabledTools: Set<string>;
  enabledSkills: Set<string>;
};

type LoadoutDiff = {
  toolsAdded: string[];
  toolsRemoved: string[];
  skillsAdded: string[];
  skillsRemoved: string[];
};

type LoadoutLogDetails = {
  timestamp: string;
  previousLoadout: string;
  newLoadout: string;
  diff: LoadoutDiff;
  commandSource: string;
  cacheWarning: "acknowledged" | "--yes" | "not-applicable";
};

export default function loadoutExtension(pi: ExtensionAPI) {
  let enabledTools = new Set<string>();
  let enabledSkills = new Set<string>();
  let skillLoadoutExplicit = false;

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

  function allSkills(): SkillInfo[] {
    const byName = new Map<string, SkillInfo>();
    for (const command of pi.getCommands()) {
      if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
      const name = command.name.slice("skill:".length);
      byName.set(name, {
        name,
        commandName: command.name,
        description: command.description,
        sourceInfo: command.sourceInfo,
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function allSkillNames(): string[] {
    return allSkills().map((skill) => skill.name);
  }

  function activeSkillNames(): string[] {
    if (!skillLoadoutExplicit) return allSkillNames();
    const available = new Set(allSkillNames());
    return [...enabledSkills].filter((name) => available.has(name));
  }

  function sourceLabel(
    sourceInfo: { source?: string; path?: string } | undefined,
    labels: { fallback: string; builtin: string; sdk: string },
  ): string {
    const source = sourceInfo?.source;
    if (source === "builtin") return labels.builtin;
    if (source === "sdk") return labels.sdk;
    if (source && source !== "unknown") return source;

    const path = sourceInfo?.path;
    if (!path) return labels.fallback;
    if (path.startsWith("<builtin:")) return labels.builtin;
    return path;
  }

  function groupTools(tools: ToolInfo[]): ToolGroup[] {
    const byKey = new Map<string, ToolGroup>();

    for (const tool of tools) {
      const key = sourceLabel(tool.sourceInfo, {
        fallback: "Other tools",
        builtin: "Built-in tools",
        sdk: "SDK tools",
      });
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

  function groupSkills(skills: SkillInfo[]): SkillGroup[] {
    const byKey = new Map<string, SkillGroup>();

    for (const skill of skills) {
      const key = sourceLabel(skill.sourceInfo, {
        fallback: "Other skills",
        builtin: "Built-in skills",
        sdk: "SDK skills",
      });
      const group = byKey.get(key);
      if (group) group.skills.push(skill);
      else byKey.set(key, { key, label: key, skills: [skill] });
    }

    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  function normalizeEnabledTools(names: Iterable<string>): Set<string> {
    const available = new Set(allToolNames());
    return new Set([...names].filter((name) => available.has(name)));
  }

  function normalizeEnabledSkills(names: Iterable<string>): Set<string> {
    const available = new Set(allSkillNames());
    return new Set([...names].filter((name) => available.has(name)));
  }

  function sorted(names: Iterable<string>): string[] {
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  function setDifference(next: Set<string>, previous: Set<string>): string[] {
    return sorted([...next].filter((name) => !previous.has(name)));
  }

  function computeDiff(currentTools: Set<string>, targetTools: Set<string>, currentSkills: Set<string>, targetSkills: Set<string>): LoadoutDiff {
    return {
      toolsAdded: setDifference(targetTools, currentTools),
      toolsRemoved: setDifference(currentTools, targetTools),
      skillsAdded: setDifference(targetSkills, currentSkills),
      skillsRemoved: setDifference(currentSkills, targetSkills),
    };
  }

  function hasDiff(diff: LoadoutDiff): boolean {
    return diff.toolsAdded.length + diff.toolsRemoved.length + diff.skillsAdded.length + diff.skillsRemoved.length > 0;
  }

  function hasPromptImpact(diff: LoadoutDiff): boolean {
    return hasDiff(diff);
  }

  function formatDiffList(prefix: "+" | "-", names: string[]): string[] {
    return names.map((name) => `  ${prefix} ${name}`);
  }

  function formatLoadoutDiff(diff: LoadoutDiff): string {
    if (!hasDiff(diff)) return "Loadout unchanged.";

    const lines = ["Loadout diff:"];
    const toolsChanged = diff.toolsAdded.length + diff.toolsRemoved.length > 0;
    const skillsChanged = diff.skillsAdded.length + diff.skillsRemoved.length > 0;

    if (toolsChanged) {
      lines.push("", "Tools:", ...formatDiffList("+", diff.toolsAdded), ...formatDiffList("-", diff.toolsRemoved));
    }

    if (skillsChanged) {
      lines.push("", "Skills:", ...formatDiffList("+", diff.skillsAdded), ...formatDiffList("-", diff.skillsRemoved));
    }

    return lines.join("\n");
  }

  function formatCacheImpact(diff: LoadoutDiff): string {
    const toolsChanged = diff.toolsAdded.length + diff.toolsRemoved.length > 0;
    const skillsChanged = diff.skillsAdded.length + diff.skillsRemoved.length > 0;
    if (toolsChanged && skillsChanged) return "Tool definitions changed and available skills changed.";
    if (toolsChanged) return "Tool definitions changed.";
    if (skillsChanged) return "Available skills changed.";
    return "No prompt-cache impact.";
  }

  function formatCacheWarning(diff: LoadoutDiff): string {
    return [
      formatCacheImpact(diff),
      "Changing tools/skills changes the system prompt and/or tool definitions.",
      "Next LLM call may miss prompt cache and write a new cache entry.",
    ].join("\n");
  }

  function parseYesFlag(args: string): boolean {
    return args.split(/\s+/).filter(Boolean).some((arg) => arg === "--yes" || arg === "-y");
  }

  function logAppliedLoadout(diff: LoadoutDiff, cacheWarning: LoadoutLogDetails["cacheWarning"]) {
    // State-only audit entry. Not sent to LLM, not rendered in chat.
    // System prompt + tool schema regenerated each turn already reflect active loadout.
    pi.appendEntry<LoadoutLogDetails>(LOG_CUSTOM_TYPE, {
      timestamp: new Date().toISOString(),
      previousLoadout: "before",
      newLoadout: "after",
      diff,
      commandSource: "/loadout",
      cacheWarning,
    });
  }

  function applyEnabled(nextTools: Set<string>, nextSkills: Set<string>) {
    enabledTools = normalizeEnabledTools(nextTools);
    enabledSkills = normalizeEnabledSkills(nextSkills);
    skillLoadoutExplicit = true;
    pi.setActiveTools([...enabledTools]);
    pi.appendEntry<StoredState>(STATE_CUSTOM_TYPE, {
      enabledTools: [...enabledTools],
      enabledSkills: [...enabledSkills],
    });
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    let restoredTools: string[] | undefined;
    let restoredSkills: string[] | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      const data = entry.data as StoredState | undefined;
      if (Array.isArray(data?.enabledTools)) restoredTools = data.enabledTools;
      if (Array.isArray(data?.enabledSkills)) restoredSkills = data.enabledSkills;
    }

    enabledTools = restoredTools ? normalizeEnabledTools(restoredTools) : new Set(allToolNames());
    skillLoadoutExplicit = !!restoredSkills;
    enabledSkills = restoredSkills ? normalizeEnabledSkills(restoredSkills) : new Set(allSkillNames());
    pi.setActiveTools([...enabledTools]);
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "loadout",
      `${activeToolNames().length}/${allToolNames().length} tools · ${activeSkillNames().length}/${allSkillNames().length} skills`,
    );
  }

  function replaceSkillsBlock(systemPrompt: string, nextSkills: Skill[]): string {
    const skillBlockPattern = /\n?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
    const nextBlock = formatSkillsForPrompt(nextSkills);
    if (skillBlockPattern.test(systemPrompt)) return systemPrompt.replace(skillBlockPattern, nextBlock ? `\n${nextBlock}` : "");
    return systemPrompt;
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
    updateStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const skills = event.systemPromptOptions.skills ?? [];
    if (skills.length === 0) return;

    if (!skillLoadoutExplicit) return;

    const availableNames = new Set(skills.map((skill) => skill.name));
    const normalized = new Set([...enabledSkills].filter((name) => availableNames.has(name)));
    const filteredSkills = skills.filter((skill) => normalized.has(skill.name));
    if (filteredSkills.length === skills.length) return;

    return { systemPrompt: replaceSkillsBlock(event.systemPrompt, filteredSkills) };
  });

  pi.registerCommand("loadout", {
    description: "Select active tools and skills for this session",
    handler: async (args, ctx) => {
      const assumeYes = parseYesFlag(args);
      const tools = allTools();
      const skills = allSkills();
      if (tools.length === 0 && skills.length === 0) {
        ctx.ui.notify("No tools or skills available.", "warning");
        return;
      }

      const toolGroups = groupTools(tools);
      const skillGroups = groupSkills(skills);
      const draftEnabledTools = normalizeEnabledTools(activeToolNames());
      const draftEnabledSkills = normalizeEnabledSkills(skillLoadoutExplicit ? enabledSkills : allSkillNames());
      const rowRefs = new Map<RowId, RowRef>();

      function toolGroupValue(group: ToolGroup): "enabled" | "disabled" | "partial" {
        const count = group.tools.filter((tool) => draftEnabledTools.has(tool.name)).length;
        if (count === 0) return "disabled";
        if (count === group.tools.length) return "enabled";
        return "partial";
      }

      function skillGroupValue(group: SkillGroup): "enabled" | "disabled" | "partial" {
        const count = group.skills.filter((skill) => draftEnabledSkills.has(skill.name)).length;
        if (count === 0) return "disabled";
        if (count === group.skills.length) return "enabled";
        return "partial";
      }

      const collapsedToolGroups = new Set<string>();
      const collapsedSkillGroups = new Set<string>();
      let pane: Pane = tools.length > 0 ? "tools" : "skills";
      let visibleRowIds: RowId[] = [];
      const paneSelectedIndex: Record<Pane, number> = { tools: 0, skills: 0 };

      function toolGroupDescription(group: ToolGroup): string {
        const count = group.tools.filter((tool) => draftEnabledTools.has(tool.name)).length;
        const collapsed = collapsedToolGroups.has(group.key) ? "collapsed" : "expanded";
        return `${count}/${group.tools.length} enabled · ${collapsed} · Space toggles all · Enter expands/collapses ${group.label}`;
      }

      function skillGroupDescription(group: SkillGroup): string {
        const count = group.skills.filter((skill) => draftEnabledSkills.has(skill.name)).length;
        const collapsed = collapsedSkillGroups.has(group.key) ? "collapsed" : "expanded";
        return `${count}/${group.skills.length} enabled · ${collapsed} · Space toggles all · Enter expands/collapses ${group.label}`;
      }

      function buildToolItems(): SettingItem[] {
        const items: SettingItem[] = [];

        for (const group of toolGroups) {
          const groupId = `group:${group.key}` as RowId;
          const collapsed = collapsedToolGroups.has(group.key);
          rowRefs.set(groupId, { kind: "toolGroup", group });
          visibleRowIds.push(groupId);
          items.push({
            id: groupId,
            label: `${collapsed ? "▸" : "▾"} ${group.label}`,
            description: toolGroupDescription(group),
            currentValue: toolGroupValue(group),
            values: ["enabled", "disabled"],
          });

          if (collapsed) continue;

          group.tools.forEach((tool, index) => {
            const toolId = `tool:${tool.name}` as RowId;
            const branch = index === group.tools.length - 1 ? "╰─" : "├─";
            rowRefs.set(toolId, { kind: "tool", group, tool });
            visibleRowIds.push(toolId);
            items.push({
              id: toolId,
              label: `  ${branch} ${tool.name}`,
              description: tool.description ? `${group.label} · ${tool.description}` : group.label,
              currentValue: draftEnabledTools.has(tool.name) ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            });
          });
        }

        return items;
      }

      function buildSkillItems(): SettingItem[] {
        const items: SettingItem[] = [];

        for (const group of skillGroups) {
          const groupId = `skillgroup:${group.key}` as RowId;
          const collapsed = collapsedSkillGroups.has(group.key);
          rowRefs.set(groupId, { kind: "skillGroup", group });
          visibleRowIds.push(groupId);
          items.push({
            id: groupId,
            label: `${collapsed ? "▸" : "▾"} ${group.label}`,
            description: skillGroupDescription(group),
            currentValue: skillGroupValue(group),
            values: ["enabled", "disabled"],
          });

          if (collapsed) continue;

          group.skills.forEach((skill, index) => {
            const skillId = `skill:${skill.name}` as RowId;
            const branch = index === group.skills.length - 1 ? "╰─" : "├─";
            rowRefs.set(skillId, { kind: "skill", group, skill });
            visibleRowIds.push(skillId);
            items.push({
              id: skillId,
              label: `  ${branch} ${skill.name}`,
              description: skill.description ? `${group.label} · ${skill.description}` : group.label,
              currentValue: draftEnabledSkills.has(skill.name) ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            });
          });
        }

        return items;
      }

      function buildItems(): SettingItem[] {
        visibleRowIds = [];
        rowRefs.clear();
        return pane === "tools" ? buildToolItems() : buildSkillItems();
      }

      const result = await ctx.ui.custom<LoadoutResult | null>((tui, theme, _keybindings, done) => {
        let settingsList: SettingsList;
        let selectedIndex = paneSelectedIndex[pane];
        const items = buildItems();
        const headerText = new Text("", 1, 0);
        const hintText = new Text("", 1, 0);

        function updateHeader() {
          const toolsLabel = pane === "tools" ? theme.fg("accent", theme.bold("[Tools]")) : theme.fg("dim", "Tools");
          const skillsLabel = pane === "skills" ? theme.fg("accent", theme.bold("[Skills]")) : theme.fg("dim", "Skills");
          headerText.setText(`${toolsLabel}  ${skillsLabel}`);
          hintText.setText(theme.fg("dim", "Tab switch • Space toggle • Enter collapse/expand group • Ctrl+S save • ↑↓/J/K navigate • Esc cancel"));
        }

        function setSettingsSelectedIndex() {
          selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(items.length - 1, 0)));
          paneSelectedIndex[pane] = selectedIndex;
          (settingsList as unknown as { selectedIndex: number }).selectedIndex = selectedIndex;
        }

        function syncSelectedIndex() {
          selectedIndex = (settingsList as unknown as { selectedIndex: number }).selectedIndex;
          paneSelectedIndex[pane] = selectedIndex;
        }

        function rebuildItems(preferredId?: RowId) {
          const nextItems = buildItems();
          items.splice(0, items.length, ...nextItems);

          selectedIndex = paneSelectedIndex[pane];
          if (preferredId) {
            const preferredIndex = visibleRowIds.indexOf(preferredId);
            if (preferredIndex !== -1) selectedIndex = preferredIndex;
          }

          updateHeader();
          setSettingsSelectedIndex();
          tui.requestRender();
        }

        function refreshValues() {
          if (pane === "tools") {
            for (const group of toolGroups) {
              const groupId = `group:${group.key}`;
              settingsList.updateValue(groupId, toolGroupValue(group));
              const item = items.find((item) => item.id === groupId);
              if (item) item.description = toolGroupDescription(group);

              for (const tool of group.tools) {
                settingsList.updateValue(
                  `tool:${tool.name}`,
                  draftEnabledTools.has(tool.name) ? "enabled" : "disabled",
                );
              }
            }
          } else {
            for (const group of skillGroups) {
              const groupId = `skillgroup:${group.key}`;
              settingsList.updateValue(groupId, skillGroupValue(group));
              const item = items.find((item) => item.id === groupId);
              if (item) item.description = skillGroupDescription(group);

              for (const skill of group.skills) {
                settingsList.updateValue(
                  `skill:${skill.name}`,
                  draftEnabledSkills.has(skill.name) ? "enabled" : "disabled",
                );
              }
            }
          }
          tui.requestRender();
        }

        function toggleSelectedGroupCollapse() {
          const selectedId = visibleRowIds[selectedIndex];
          const row = rowRefs.get(selectedId);
          if (!row) return;

          if (row.kind === "toolGroup" || row.kind === "tool") {
            const groupId = `group:${row.group.key}` as RowId;
            if (collapsedToolGroups.has(row.group.key)) collapsedToolGroups.delete(row.group.key);
            else collapsedToolGroups.add(row.group.key);
            rebuildItems(groupId);
            return;
          }

          const groupId = `skillgroup:${row.group.key}` as RowId;
          if (collapsedSkillGroups.has(row.group.key)) collapsedSkillGroups.delete(row.group.key);
          else collapsedSkillGroups.add(row.group.key);
          rebuildItems(groupId);
        }

        function switchPane() {
          syncSelectedIndex();
          pane = pane === "tools" ? "skills" : "tools";
          selectedIndex = paneSelectedIndex[pane];
          rebuildItems();
        }

        const listTheme: SettingsListTheme = {
          cursor: theme.fg("accent", "→ "),
          label: (text: string, selected: boolean) => {
            const trimmed = text.trimStart();
            if (trimmed.startsWith("▸") || trimmed.startsWith("▾")) {
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
          hint: (text: string) =>
            theme.fg("dim", text.replace("Enter/Space to change", "Space to change · Enter collapse/expand group")),
        };

        settingsList = new SettingsList(
          items,
          Math.min(Math.max(items.length, 1), 18),
          listTheme,
          (id, newValue) => {
            const row = rowRefs.get(id as RowId);
            if (!row) return;

            if (row.kind === "toolGroup") {
              for (const tool of row.group.tools) {
                if (newValue === "enabled") draftEnabledTools.add(tool.name);
                else draftEnabledTools.delete(tool.name);
              }
            } else if (row.kind === "tool") {
              if (newValue === "enabled") draftEnabledTools.add(row.tool.name);
              else draftEnabledTools.delete(row.tool.name);
            } else if (row.kind === "skillGroup") {
              for (const skill of row.group.skills) {
                if (newValue === "enabled") draftEnabledSkills.add(skill.name);
                else draftEnabledSkills.delete(skill.name);
              }
            } else if (newValue === "enabled") {
              draftEnabledSkills.add(row.skill.name);
            } else {
              draftEnabledSkills.delete(row.skill.name);
            }

            refreshValues();
          },
          () => done(null),
        );

        updateHeader();
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
        container.addChild(headerText);
        container.addChild(hintText);
        container.addChild(settingsList);
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            if (matchesKey(data, Key.ctrl("s"))) {
              done({ enabledTools: new Set(draftEnabledTools), enabledSkills: new Set(draftEnabledSkills) });
              return;
            }

            if (matchesKey(data, Key.tab)) {
              switchPane();
              return;
            }

            if (matchesKey(data, Key.enter)) {
              toggleSelectedGroupCollapse();
              return;
            }

            if (data === "j" || data === "J") {
              settingsList.handleInput("\x1b[B");
            } else if (data === "k" || data === "K") {
              settingsList.handleInput("\x1b[A");
            } else {
              settingsList.handleInput(data);
            }
            syncSelectedIndex();
            tui.requestRender();
          },
        };
      });

      if (result === null || result === undefined) {
        ctx.ui.notify("Loadout unchanged.", "info");
        return;
      }

      const currentTools = normalizeEnabledTools(activeToolNames());
      const currentSkills = normalizeEnabledSkills(activeSkillNames());
      const targetTools = normalizeEnabledTools(result.enabledTools);
      const targetSkills = normalizeEnabledSkills(result.enabledSkills);
      const diff = computeDiff(currentTools, targetTools, currentSkills, targetSkills);

      ctx.ui.notify(formatLoadoutDiff(diff), "info");
      if (!hasDiff(diff)) return;

      let cacheWarning: LoadoutLogDetails["cacheWarning"] = "not-applicable";
      if (hasPromptImpact(diff)) {
        if (assumeYes) {
          cacheWarning = "--yes";
          ctx.ui.notify(formatCacheWarning(diff), "warning");
        } else {
          if (!ctx.hasUI) {
            ctx.ui.notify("Loadout change requires --yes in non-interactive mode.", "warning");
            return;
          }
          const confirmed = await ctx.ui.confirm("Loadout prompt-cache impact", formatCacheWarning(diff));
          if (!confirmed) {
            ctx.ui.notify("Loadout unchanged.", "info");
            return;
          }
          cacheWarning = "acknowledged";
        }
      }

      applyEnabled(targetTools, targetSkills);
      updateStatus(ctx);
      logAppliedLoadout(diff, cacheWarning);
      ctx.ui.notify(
        `Saved loadout: ${enabledTools.size}/${allToolNames().length} tools, ${activeSkillNames().length}/${allSkillNames().length} skills enabled.`,
        "info",
      );
    },
  });
}
