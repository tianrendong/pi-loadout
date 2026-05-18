import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const LOG_CUSTOM_TYPE = "pi-loadout:loadout changed";
const GLOBAL_LOADOUT_PATH = join(homedir(), ".pi", "agent", "loadout.json");

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

  function parseStoredState(value: unknown): StoredState | undefined {
    if (!value || typeof value !== "object") return undefined;
    const data = value as Partial<StoredState>;
    if (!Array.isArray(data.enabledTools)) return undefined;

    const enabledTools = data.enabledTools.filter((name): name is string => typeof name === "string");
    const enabledSkills = Array.isArray(data.enabledSkills)
      ? data.enabledSkills.filter((name): name is string => typeof name === "string")
      : undefined;

    return { enabledTools, enabledSkills };
  }

  function toStoredState(nextTools: Set<string>, nextSkills: Set<string>): StoredState {
    return {
      enabledTools: sorted(nextTools),
      enabledSkills: sorted(nextSkills),
    };
  }

  function readGlobalLoadout(): StoredState | undefined {
    try {
      return parseStoredState(JSON.parse(readFileSync(GLOBAL_LOADOUT_PATH, "utf8")));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  function writeGlobalLoadout(state: StoredState) {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(GLOBAL_LOADOUT_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

  function formatInlineDiff(added: string[], removed: string[]): string {
    return [...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(" ");
  }

  function formatLoadoutLog(diff: LoadoutDiff): string {
    const lines: string[] = [];
    if (diff.toolsAdded.length + diff.toolsRemoved.length > 0) {
      lines.push(`Tools: ${formatInlineDiff(diff.toolsAdded, diff.toolsRemoved)}`);
    }
    if (diff.skillsAdded.length + diff.skillsRemoved.length > 0) {
      lines.push(`Skills: ${formatInlineDiff(diff.skillsAdded, diff.skillsRemoved)}`);
    }
    return lines.join("\n");
  }

  function logAppliedLoadout(diff: LoadoutDiff, commandSource: string) {
    pi.sendMessage<LoadoutLogDetails>(
      {
        customType: LOG_CUSTOM_TYPE,
        content: formatLoadoutLog(diff),
        display: true,
        details: {
          timestamp: new Date().toISOString(),
          previousLoadout: "before",
          newLoadout: "after",
          diff,
          commandSource,
        },
      },
      { triggerTurn: false },
    );
  }

  function isLoadoutLogItem(item: unknown): boolean {
    return (item as { customType?: string }).customType === LOG_CUSTOM_TYPE;
  }

  function filterLoadoutLogItemsInPlace<T>(items: T[]) {
    items.splice(0, items.length, ...items.filter((item) => !isLoadoutLogItem(item)));
  }

  function applyEnabledInMemory(nextTools: Set<string>, nextSkills: Set<string>) {
    enabledTools = normalizeEnabledTools(nextTools);
    enabledSkills = normalizeEnabledSkills(nextSkills);
    skillLoadoutExplicit = true;
    pi.setActiveTools([...enabledTools]);
  }

  function persistEnabled() {
    pi.appendEntry<StoredState>(STATE_CUSTOM_TYPE, toStoredState(enabledTools, enabledSkills));
  }

  function commitLoadout(
    previousTools: Set<string>,
    previousSkills: Set<string>,
    nextTools: Set<string>,
    nextSkills: Set<string>,
    ctx: ExtensionContext,
    commandSource: string,
  ): LoadoutDiff {
    const targetTools = normalizeEnabledTools(nextTools);
    const targetSkills = normalizeEnabledSkills(nextSkills);
    const diff = computeDiff(previousTools, targetTools, previousSkills, targetSkills);

    applyEnabledInMemory(targetTools, targetSkills);
    updateStatus(ctx);

    if (!hasDiff(diff)) return diff;

    persistEnabled();
    logAppliedLoadout(diff, commandSource);
    return diff;
  }

  function saveGlobalLoadout(nextTools: Set<string>, nextSkills: Set<string>, ctx: ExtensionContext) {
    const targetTools = normalizeEnabledTools(nextTools);
    const targetSkills = normalizeEnabledSkills(nextSkills);
    writeGlobalLoadout(toStoredState(targetTools, targetSkills));
    ctx.ui.notify(
      `Saved default loadout: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled. Future sessions will use it.`,
      "info",
    );
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    let restored: StoredState | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      restored = parseStoredState(entry.data);
    }

    const state = restored ?? readGlobalLoadout();
    enabledTools = state ? normalizeEnabledTools(state.enabledTools) : new Set(allToolNames());
    skillLoadoutExplicit = !!state?.enabledSkills;
    enabledSkills = state?.enabledSkills ? normalizeEnabledSkills(state.enabledSkills) : new Set(allSkillNames());
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

  pi.on("session_before_compact", async (event) => {
    filterLoadoutLogItemsInPlace(event.preparation.messagesToSummarize);
    filterLoadoutLogItemsInPlace(event.preparation.turnPrefixMessages);
    filterLoadoutLogItemsInPlace(event.branchEntries);
  });

  pi.on("session_before_tree", async (event) => {
    filterLoadoutLogItemsInPlace(event.preparation.entriesToSummarize);
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isLoadoutLogItem(message)),
    };
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

  function formatStatus(): string {
    const activeTools = new Set(activeToolNames());
    const activeSkills = new Set(activeSkillNames());
    const lines: string[] = [];
    lines.push(
      `Active: ${activeTools.size}/${allToolNames().length} tools · ${activeSkills.size}/${allSkillNames().length} skills`,
    );

    const toolGroups = groupTools(allTools());
    if (toolGroups.length > 0) {
      lines.push("", "Tools:");
      for (const group of toolGroups) {
        const on = group.tools.filter((t) => activeTools.has(t.name)).length;
        lines.push(`  ${group.label} (${on}/${group.tools.length})`);
        for (const t of group.tools) {
          lines.push(`    ${activeTools.has(t.name) ? "●" : "○"} ${t.name}`);
        }
      }
    }

    const skillGroups = groupSkills(allSkills());
    if (skillGroups.length > 0) {
      lines.push("", "Skills:");
      for (const group of skillGroups) {
        const on = group.skills.filter((s) => activeSkills.has(s.name)).length;
        lines.push(`  ${group.label} (${on}/${group.skills.length})`);
        for (const s of group.skills) {
          lines.push(`    ${activeSkills.has(s.name) ? "●" : "○"} ${s.name}`);
        }
      }
    }

    return lines.join("\n");
  }

  function loadoutHelp(): string {
    return [
      "/loadout commands:",
      "  /loadout          Open interactive picker",
      "  /loadout status   Print current active tools and skills",
      "  /loadout reset    Re-enable every available tool and skill in this session",
      "  /loadout help     Show this help",
    ].join("\n");
  }

  const LOADOUT_SUBCOMMANDS: { value: string; label: string; description: string }[] = [
    { value: "status", label: "status", description: "Print current active tools and skills" },
    { value: "reset", label: "reset", description: "Re-enable every available tool and skill" },
    { value: "help", label: "help", description: "Show /loadout subcommand list" },
  ];

  pi.registerCommand("loadout", {
    description: "Select active tools and skills for this session",
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.toLowerCase();
      return LOADOUT_SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const subcommand = (args ?? "").trim().split(/\s+/)[0] ?? "";

      if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        ctx.ui.notify(loadoutHelp(), "info");
        return;
      }

      if (subcommand === "status") {
        ctx.ui.notify(formatStatus(), "info");
        return;
      }

      if (subcommand === "reset") {
        const previousTools = normalizeEnabledTools(activeToolNames());
        const previousSkills = normalizeEnabledSkills(activeSkillNames());
        const targetTools = new Set(allToolNames());
        const targetSkills = new Set(allSkillNames());
        const diff = commitLoadout(previousTools, previousSkills, targetTools, targetSkills, ctx, "/loadout reset");
        if (hasDiff(diff)) {
          ctx.ui.notify(
            `Loadout reset: ${targetTools.size} tools, ${targetSkills.size} skills enabled. Next response may miss prompt cache.`,
            "info",
          );
        } else {
          ctx.ui.notify("Loadout already at full set. Nothing changed.", "info");
        }
        return;
      }

      if (subcommand !== "") {
        ctx.ui.notify(
          `Unknown subcommand: "${subcommand}". Try /loadout, /loadout status, /loadout reset, or /loadout help.`,
          "warning",
        );
        return;
      }

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

      const initialEnabledTools = normalizeEnabledTools(activeToolNames());
      const initialEnabledSkills = normalizeEnabledSkills(activeSkillNames());

      const result = await ctx.ui.custom<LoadoutResult | undefined>((tui, theme, _keybindings, done) => {
        let settingsList: SettingsList;
        let selectedIndex = paneSelectedIndex[pane];
        const items = buildItems();
        const headerText = new Text("", 1, 0);
        const hintText = new Text("", 1, 0);
        const cacheNoteText = new Text("", 1, 0);

        function updateHeader() {
          const toolsLabel = pane === "tools" ? theme.fg("accent", theme.bold("[Tools]")) : theme.fg("dim", "Tools");
          const skillsLabel = pane === "skills" ? theme.fg("accent", theme.bold("[Skills]")) : theme.fg("dim", "Skills");
          headerText.setText(`${toolsLabel}  ${skillsLabel}`);
          hintText.setText(theme.fg("dim", "Tab switch • Space toggle/apply • Enter collapse/expand • Ctrl+S save default • ↑↓/J/K navigate • Esc close"));
          cacheNoteText.setText(
            theme.fg(
              "warning",
              "Note: Changing loadout will make next response slower and cost more due to prompt cache miss.",
            ),
          );
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
            theme.fg("dim", text.replace("Enter/Space to change", "Space to change · Enter collapse/expand")),
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

            applyEnabledInMemory(draftEnabledTools, draftEnabledSkills);
            updateStatus(ctx);
            refreshValues();
            if (hasDiff(computeDiff(initialEnabledTools, draftEnabledTools, initialEnabledSkills, draftEnabledSkills))) {
              cacheNoteText.setText(
                theme.fg(
                  "warning",
                  "Applied. Local session save happens when selector closes; next response may miss prompt cache.",
                ),
              );
            }
          },
          () => done({ enabledTools: new Set(draftEnabledTools), enabledSkills: new Set(draftEnabledSkills) }),
        );

        updateHeader();
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
        container.addChild(headerText);
        container.addChild(hintText);
        container.addChild(cacheNoteText);
        container.addChild(settingsList);
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            if (matchesKey(data, Key.ctrl("s"))) {
              try {
                applyEnabledInMemory(draftEnabledTools, draftEnabledSkills);
                updateStatus(ctx);
                saveGlobalLoadout(draftEnabledTools, draftEnabledSkills, ctx);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Failed to save default loadout: ${message}`, "error");
              }
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

      commitLoadout(
        initialEnabledTools,
        initialEnabledSkills,
        result?.enabledTools ?? draftEnabledTools,
        result?.enabledSkills ?? draftEnabledSkills,
        ctx,
        "/loadout",
      );
    },
  });
}
