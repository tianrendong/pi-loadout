import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyMatch,
  Input,
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
const PROFILES_PATH = join(homedir(), ".pi", "agent", "loadout-profiles.json");
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type StoredState = {
  enabledTools: string[];
  enabledSkills?: string[];
  profileName?: string;
};

type Profile = {
  enabledTools: string[];
  enabledSkills: string[];
  updatedAt: string;
};

type ProfilesFile = {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
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

type Pane = "tools" | "skills" | "presets";
type LoadoutPresetName = "full" | "minimal";
type RowId =
  | `group:${string}`
  | `tool:${string}`
  | `skillgroup:${string}`
  | `skill:${string}`
  | `preset:${string}`;

type RowRef =
  | { kind: "toolGroup"; group: ToolGroup }
  | { kind: "tool"; group: ToolGroup; tool: ToolInfo }
  | { kind: "skillGroup"; group: SkillGroup }
  | { kind: "skill"; group: SkillGroup; skill: SkillInfo }
  | { kind: "preset"; name: string; source: "builtin" | "default" | "user"; profile?: Profile };

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
  let currentProfileName: string | undefined;

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

  function isBuiltinSource(sourceInfo: { source?: string; path?: string } | undefined): boolean {
    return sourceInfo?.source === "builtin" || !!sourceInfo?.path?.startsWith("<builtin:");
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
    if (isBuiltinSource(sourceInfo)) return labels.builtin;
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

  function presetTools(name: LoadoutPresetName): Set<string> {
    if (name === "full") return new Set(allToolNames());
    return new Set(allTools().filter((tool) => isBuiltinSource(tool.sourceInfo)).map((tool) => tool.name));
  }

  function presetSkills(name: LoadoutPresetName): Set<string> {
    if (name === "full") return new Set(allSkillNames());
    return new Set(allSkills().filter((skill) => isBuiltinSource(skill.sourceInfo)).map((skill) => skill.name));
  }

  function presetProfile(name: LoadoutPresetName): Profile {
    return {
      enabledTools: sorted(presetTools(name)),
      enabledSkills: sorted(presetSkills(name)),
      updatedAt: new Date(0).toISOString(),
    };
  }

  function isLoadoutPresetName(name: string): name is LoadoutPresetName {
    return name === "full" || name === "minimal";
  }

  function profileFromStoredState(state: StoredState): Profile {
    return {
      enabledTools: sorted(state.enabledTools),
      enabledSkills: sorted(state.enabledSkills ?? allSkillNames()),
      updatedAt: new Date(0).toISOString(),
    };
  }

  const RESERVED_PROFILE_NAMES = new Set([
    "default",
    "delete",
    "full",
    "help",
    "list",
    "minimal",
    "preset",
    "reset",
    "rm",
    "save",
    "status",
    "use",
  ]);

  function validateProfileName(name: string): string | undefined {
    if (!PROFILE_NAME_PATTERN.test(name)) return "Use 1-64 chars: letters, numbers, dot, underscore, dash; must start alphanumeric.";
    if (RESERVED_PROFILE_NAMES.has(name)) return `Reserved profile name: ${name}`;
    return undefined;
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
    const profileName = typeof data.profileName === "string" ? data.profileName : undefined;

    return { enabledTools, enabledSkills, profileName };
  }

  function toStoredState(nextTools: Set<string>, nextSkills: Set<string>, profileName?: string): StoredState {
    const state: StoredState = {
      enabledTools: sorted(nextTools),
      enabledSkills: sorted(nextSkills),
    };
    if (profileName) state.profileName = profileName;
    return state;
  }

  function readProfilesFile(): ProfilesFile {
    try {
      const parsed = JSON.parse(readFileSync(PROFILES_PATH, "utf8")) as Partial<ProfilesFile>;
      const profiles: Record<string, Profile> = {};
      if (parsed && typeof parsed === "object" && parsed.profiles && typeof parsed.profiles === "object") {
        for (const [name, value] of Object.entries(parsed.profiles)) {
          if (!value || typeof value !== "object") continue;
          const v = value as Partial<Profile>;
          if (!Array.isArray(v.enabledTools) || !Array.isArray(v.enabledSkills)) continue;
          profiles[name] = {
            enabledTools: v.enabledTools.filter((n): n is string => typeof n === "string"),
            enabledSkills: v.enabledSkills.filter((n): n is string => typeof n === "string"),
            updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : new Date(0).toISOString(),
          };
        }
      }
      const defaultProfile =
        parsed && typeof parsed === "object" && typeof parsed.defaultProfile === "string" && profiles[parsed.defaultProfile]
          ? parsed.defaultProfile
          : undefined;
      return { defaultProfile, profiles };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { profiles: {} };
      return { profiles: {} };
    }
  }

  function writeProfilesFile(file: ProfilesFile) {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    const ordered: ProfilesFile = { profiles: {} };
    if (file.defaultProfile) ordered.defaultProfile = file.defaultProfile;
    for (const name of Object.keys(file.profiles).sort()) ordered.profiles[name] = file.profiles[name];
    writeFileSync(PROFILES_PATH, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  }

  function profileSnapshotFromCurrent(): Profile {
    return {
      enabledTools: sorted(enabledTools),
      enabledSkills: sorted(enabledSkills),
      updatedAt: new Date().toISOString(),
    };
  }

  function profileForName(name: string): Profile | undefined {
    if (isLoadoutPresetName(name)) return presetProfile(name);
    if (name === "default") {
      const state = readGlobalLoadout();
      return state ? profileFromStoredState(state) : undefined;
    }
    return readProfilesFile().profiles[name];
  }

  function isUserProfileName(name: string | undefined): name is string {
    return !!name && !isLoadoutPresetName(name) && name !== "default";
  }

  function isCurrentDirty(): boolean {
    if (!currentProfileName) return false;
    const profile = profileForName(currentProfileName);
    if (!profile) return false;
    const tools = sorted(enabledTools).join("\u0001");
    const skills = sorted(enabledSkills).join("\u0001");
    return tools !== profile.enabledTools.join("\u0001") || skills !== profile.enabledSkills.join("\u0001");
  }

  function formatRelativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "unknown";
    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
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
    pi.appendEntry<StoredState>(STATE_CUSTOM_TYPE, toStoredState(enabledTools, enabledSkills, currentProfileName));
  }

  function commitLoadout(
    previousTools: Set<string>,
    previousSkills: Set<string>,
    nextTools: Set<string>,
    nextSkills: Set<string>,
    ctx: ExtensionContext,
    commandSource: string,
    nextProfileName?: string | null,
  ): LoadoutDiff {
    const targetTools = normalizeEnabledTools(nextTools);
    const targetSkills = normalizeEnabledSkills(nextSkills);
    const diff = computeDiff(previousTools, targetTools, previousSkills, targetSkills);

    applyEnabledInMemory(targetTools, targetSkills);
    if (nextProfileName === null) currentProfileName = undefined;
    else if (typeof nextProfileName === "string") currentProfileName = nextProfileName;
    updateStatus(ctx);

    if (!hasDiff(diff) && nextProfileName === undefined) return diff;

    persistEnabled();
    if (hasDiff(diff)) logAppliedLoadout(diff, commandSource);
    return diff;
  }

  function saveGlobalLoadout(nextTools: Set<string>, nextSkills: Set<string>, ctx: ExtensionContext) {
    const targetTools = normalizeEnabledTools(nextTools);
    const targetSkills = normalizeEnabledSkills(nextSkills);
    writeGlobalLoadout(toStoredState(targetTools, targetSkills, currentProfileName));
    ctx.ui.notify(
      `Saved default loadout: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled. Future sessions will use it.`,
      "info",
    );
  }

  function applyPreset(name: LoadoutPresetName, ctx: ExtensionContext, commandSource: string): LoadoutDiff {
    const previousTools = normalizeEnabledTools(activeToolNames());
    const previousSkills = normalizeEnabledSkills(activeSkillNames());
    const targetTools = presetTools(name);
    const targetSkills = presetSkills(name);
    const diff = commitLoadout(previousTools, previousSkills, targetTools, targetSkills, ctx, commandSource, name);
    const label = name === "full" ? "Full" : "Minimal";
    const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
    ctx.ui.notify(
      `${label} preset applied: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled.${suffix}`,
      "info",
    );
    return diff;
  }

  function readBranchLoadout(ctx: ExtensionContext): StoredState | undefined {
    let restored: StoredState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      restored = parseStoredState(entry.data);
    }
    return restored;
  }

  function applyDefaultLoadout(ctx: ExtensionContext, commandSource: string): LoadoutDiff | undefined {
    const state = readGlobalLoadout();
    if (!state) {
      ctx.ui.notify(
        `No saved default loadout found. Checked ${GLOBAL_LOADOUT_PATH}. Use Ctrl+S in /loadout to save one.`,
        "warning",
      );
      return undefined;
    }

    const previousTools = normalizeEnabledTools(activeToolNames());
    const previousSkills = normalizeEnabledSkills(activeSkillNames());
    const targetTools = normalizeEnabledTools(state.enabledTools);
    const targetSkills = state.enabledSkills ? normalizeEnabledSkills(state.enabledSkills) : new Set(allSkillNames());
    const diff = commitLoadout(previousTools, previousSkills, targetTools, targetSkills, ctx, commandSource, state.profileName ?? null);
    const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
    ctx.ui.notify(
      `Default loadout applied: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled.${suffix}`,
      "info",
    );
    return diff;
  }

  function applyNamedLoadout(name: string, ctx: ExtensionContext, commandSource: string): LoadoutDiff | undefined {
    if (isLoadoutPresetName(name)) return applyPreset(name, ctx, commandSource);
    if (name === "default") return applyDefaultLoadout(ctx, commandSource);

    const profile = readProfilesFile().profiles[name];
    if (!profile) {
      ctx.ui.notify(`Unknown loadout preset: ${name}. Try /loadout list.`, "warning");
      return undefined;
    }

    const previousTools = normalizeEnabledTools(activeToolNames());
    const previousSkills = normalizeEnabledSkills(activeSkillNames());
    const targetTools = normalizeEnabledTools(profile.enabledTools);
    const targetSkills = normalizeEnabledSkills(profile.enabledSkills);
    const diff = commitLoadout(previousTools, previousSkills, targetTools, targetSkills, ctx, commandSource, name);
    const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
    ctx.ui.notify(
      `Preset ${name} applied: ${targetTools.size}/${allToolNames().length} tools, ${targetSkills.size}/${allSkillNames().length} skills enabled.${suffix}`,
      "info",
    );
    return diff;
  }

  function saveUserProfile(name: string, nextTools: Set<string>, nextSkills: Set<string>, ctx: ExtensionContext) {
    const error = validateProfileName(name);
    if (error) {
      ctx.ui.notify(error, "warning");
      return false;
    }

    const file = readProfilesFile();
    file.profiles[name] = {
      enabledTools: sorted(normalizeEnabledTools(nextTools)),
      enabledSkills: sorted(normalizeEnabledSkills(nextSkills)),
      updatedAt: new Date().toISOString(),
    };
    writeProfilesFile(file);
    currentProfileName = name;
    persistEnabled();
    updateStatus(ctx);
    ctx.ui.notify(`Saved loadout preset: ${name}`, "info");
    return true;
  }

  function deleteUserProfile(name: string, ctx: ExtensionContext) {
    if (RESERVED_PROFILE_NAMES.has(name) || isLoadoutPresetName(name) || name === "default") {
      ctx.ui.notify(`Cannot delete built-in preset: ${name}`, "warning");
      return false;
    }

    const file = readProfilesFile();
    if (!file.profiles[name]) {
      ctx.ui.notify(`Unknown loadout preset: ${name}`, "warning");
      return false;
    }

    delete file.profiles[name];
    if (file.defaultProfile === name) delete file.defaultProfile;
    writeProfilesFile(file);
    if (currentProfileName === name) currentProfileName = undefined;
    persistEnabled();
    updateStatus(ctx);
    ctx.ui.notify(`Deleted loadout preset: ${name}`, "info");
    return true;
  }

  function formatProfileList(): string {
    const lines = ["Loadout presets:"];
    lines.push(`  full      built-in · ${allToolNames().length}/${allToolNames().length} tools · ${allSkillNames().length}/${allSkillNames().length} skills`);
    lines.push(`  minimal   built-in · ${presetTools("minimal").size}/${allToolNames().length} tools · ${presetSkills("minimal").size}/${allSkillNames().length} skills`);
    const defaultState = readGlobalLoadout();
    lines.push(
      defaultState
        ? `  default   global · ${normalizeEnabledTools(defaultState.enabledTools).size}/${allToolNames().length} tools · ${normalizeEnabledSkills(defaultState.enabledSkills ?? allSkillNames()).size}/${allSkillNames().length} skills`
        : "  default   global · not saved",
    );

    const profiles = readProfilesFile().profiles;
    for (const name of Object.keys(profiles).sort()) {
      const profile = profiles[name];
      lines.push(
        `  ${name}${currentProfileName === name ? " *" : ""}  user · ${normalizeEnabledTools(profile.enabledTools).size}/${allToolNames().length} tools · ${normalizeEnabledSkills(profile.enabledSkills).size}/${allSkillNames().length} skills · updated ${formatRelativeTime(profile.updatedAt)}`,
      );
    }
    return lines.join("\n");
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    const state = readBranchLoadout(ctx) ?? readGlobalLoadout();
    // Built-in presets are dynamic: re-expand them against the currently available
    // tools/skills instead of replaying a frozen list, so they self-heal when the
    // installed tool/skill set changes between sessions.
    if (state?.profileName && isLoadoutPresetName(state.profileName)) {
      enabledTools = presetTools(state.profileName);
      enabledSkills = presetSkills(state.profileName);
      skillLoadoutExplicit = true;
      currentProfileName = state.profileName;
      pi.setActiveTools([...enabledTools]);
      return;
    }
    enabledTools = state ? normalizeEnabledTools(state.enabledTools) : new Set(allToolNames());
    skillLoadoutExplicit = !!state?.enabledSkills;
    enabledSkills = state?.enabledSkills ? normalizeEnabledSkills(state.enabledSkills) : new Set(allSkillNames());
    currentProfileName = state?.profileName;
    if (!currentProfileName) {
      const file = readProfilesFile();
      if (file.defaultProfile && file.profiles[file.defaultProfile]) {
        currentProfileName = file.defaultProfile;
      }
    }
    pi.setActiveTools([...enabledTools]);
  }

  function updateStatus(ctx: ExtensionContext) {
    const counts = `${activeToolNames().length}/${allToolNames().length} tools · ${activeSkillNames().length}/${allSkillNames().length} skills`;
    const prefix = currentProfileName ? `${currentProfileName}${isCurrentDirty() ? "*" : ""} · ` : "";
    ctx.ui.setStatus("loadout", `${prefix}${counts}`);
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
      "  /loadout full     Enable every available tool and skill",
      "  /loadout minimal  Enable only built-in tools and skills",
      "  /loadout default  Apply saved global default loadout",
      "  /loadout save <name>    Save current loadout as user preset",
      "  /loadout use <name>     Apply built-in, default, or user preset",
      "  /loadout list           List built-in and user presets",
      "  /loadout delete <name>  Delete user preset",
      "  /loadout status   Print current active tools and skills",
      "  /loadout reset    Alias for /loadout full",
      "  /loadout help     Show this help",
    ].join("\n");
  }

  const LOADOUT_SUBCOMMANDS: { value: string; label: string; description: string }[] = [
    { value: "full", label: "full", description: "Enable every available tool and skill" },
    { value: "minimal", label: "minimal", description: "Enable only built-in tools and skills" },
    { value: "default", label: "default", description: "Apply saved global default loadout" },
    { value: "save", label: "save", description: "Save current loadout as user preset" },
    { value: "use", label: "use", description: "Apply built-in, default, or user preset" },
    { value: "list", label: "list", description: "List built-in and user presets" },
    { value: "delete", label: "delete", description: "Delete user preset" },
    { value: "rm", label: "rm", description: "Delete user preset" },
    { value: "preset", label: "preset", description: "Apply a named preset" },
    { value: "preset full", label: "preset full", description: "Enable every available tool and skill" },
    { value: "preset minimal", label: "preset minimal", description: "Enable only built-in tools and skills" },
    { value: "preset default", label: "preset default", description: "Apply saved global default loadout" },
    { value: "status", label: "status", description: "Print current active tools and skills" },
    { value: "reset", label: "reset", description: "Alias for /loadout full" },
    { value: "help", label: "help", description: "Show /loadout subcommand list" },
  ];

  pi.registerCommand("loadout", {
    description: "Select active tools and skills for this session",
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.toLowerCase();
      const profileItems = Object.keys(readProfilesFile().profiles).flatMap((name) => [
        { value: `use ${name}`, label: `use ${name}`, description: "Apply user preset" },
        { value: `preset ${name}`, label: `preset ${name}`, description: "Apply user preset" },
        { value: `delete ${name}`, label: `delete ${name}`, description: "Delete user preset" },
      ]);
      return [...LOADOUT_SUBCOMMANDS, ...profileItems].filter((item) => item.value.toLowerCase().startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcommand = words[0] ?? "";

      if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        ctx.ui.notify(loadoutHelp(), "info");
        return;
      }

      if (subcommand === "status") {
        ctx.ui.notify(formatStatus(), "info");
        return;
      }

      if (subcommand === "reset" || subcommand === "full") {
        applyPreset("full", ctx, `/loadout ${subcommand}`);
        return;
      }

      if (subcommand === "minimal") {
        applyPreset("minimal", ctx, "/loadout minimal");
        return;
      }

      if (subcommand === "default") {
        applyDefaultLoadout(ctx, "/loadout default");
        return;
      }

      if (subcommand === "list") {
        ctx.ui.notify(formatProfileList(), "info");
        return;
      }

      if (subcommand === "save") {
        const name = words[1] ?? (isUserProfileName(currentProfileName) ? currentProfileName : "");
        if (!name) {
          ctx.ui.notify("Usage: /loadout save <name>", "warning");
          return;
        }
        saveUserProfile(name, normalizeEnabledTools(activeToolNames()), normalizeEnabledSkills(activeSkillNames()), ctx);
        return;
      }

      if (subcommand === "use") {
        const name = words[1] ?? "";
        if (!name) {
          ctx.ui.notify("Usage: /loadout use <name>", "warning");
          return;
        }
        applyNamedLoadout(name, ctx, `/loadout use ${name}`);
        return;
      }

      if (subcommand === "delete" || subcommand === "rm") {
        const name = words[1] ?? "";
        if (!name) {
          ctx.ui.notify(`Usage: /loadout ${subcommand} <name>`, "warning");
          return;
        }
        deleteUserProfile(name, ctx);
        return;
      }

      if (subcommand === "preset") {
        const presetName = words[1] ?? "";
        if (presetName) {
          applyNamedLoadout(presetName, ctx, `/loadout preset ${presetName}`);
          return;
        }
        ctx.ui.notify("Usage: /loadout preset <name>", "warning");
        return;
      }

      if (subcommand !== "") {
        ctx.ui.notify(
          `Unknown subcommand: "${subcommand}". Try /loadout, /loadout list, /loadout save <name>, /loadout use <name>, or /loadout help.`,
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
      let searchQuery = "";
      let pane: Pane = tools.length > 0 ? "tools" : "skills";

      function matchesQuery(text: string): boolean {
        return fuzzyMatch(searchQuery, text).matches;
      }
      let visibleRowIds: RowId[] = [];
      const paneSelectedIndex: Record<Pane, number> = { tools: 0, skills: 0, presets: 0 };

      function toolGroupDescription(group: ToolGroup): string {
        const count = group.tools.filter((tool) => draftEnabledTools.has(tool.name)).length;
        const collapsed = collapsedToolGroups.has(group.key) ? "collapsed" : "expanded";
        return `${group.label} · ${count}/${group.tools.length} enabled · ${collapsed} · Space toggles group · Enter expands/collapses`;
      }

      function skillGroupDescription(group: SkillGroup): string {
        const count = group.skills.filter((skill) => draftEnabledSkills.has(skill.name)).length;
        const collapsed = collapsedSkillGroups.has(group.key) ? "collapsed" : "expanded";
        return `${group.label} · ${count}/${group.skills.length} enabled · ${collapsed} · Space toggles group · Enter expands/collapses`;
      }

      function buildToolItems(): SettingItem[] {
        const items: SettingItem[] = [];
        const query = searchQuery.trim();

        for (const group of toolGroups) {
          const groupMatch = query === "" || matchesQuery(group.label);
          const tools =
            query === "" || groupMatch ? group.tools : group.tools.filter((tool) => matchesQuery(tool.name));
          if (query !== "" && !groupMatch && tools.length === 0) continue;

          const groupId = `group:${group.key}` as RowId;
          const collapsed = query === "" && collapsedToolGroups.has(group.key);
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

          tools.forEach((tool, index) => {
            const toolId = `tool:${tool.name}` as RowId;
            const branch = index === tools.length - 1 ? "╰─" : "├─";
            rowRefs.set(toolId, { kind: "tool", group, tool });
            visibleRowIds.push(toolId);
            items.push({
              id: toolId,
              label: `  ${branch} ${tool.name}`,
              description: `${tool.description ? `${group.label} · ${tool.description}` : group.label} · Space toggles tool`,
              currentValue: draftEnabledTools.has(tool.name) ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            });
          });
        }

        return items;
      }

      function buildSkillItems(): SettingItem[] {
        const items: SettingItem[] = [];
        const query = searchQuery.trim();

        for (const group of skillGroups) {
          const groupMatch = query === "" || matchesQuery(group.label);
          const skills =
            query === "" || groupMatch ? group.skills : group.skills.filter((skill) => matchesQuery(skill.name));
          if (query !== "" && !groupMatch && skills.length === 0) continue;

          const groupId = `skillgroup:${group.key}` as RowId;
          const collapsed = query === "" && collapsedSkillGroups.has(group.key);
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

          skills.forEach((skill, index) => {
            const skillId = `skill:${skill.name}` as RowId;
            const branch = index === skills.length - 1 ? "╰─" : "├─";
            rowRefs.set(skillId, { kind: "skill", group, skill });
            visibleRowIds.push(skillId);
            items.push({
              id: skillId,
              label: `  ${branch} ${skill.name}`,
              description: `${skill.description ? `${group.label} · ${skill.description}` : group.label} · Space toggles skill`,
              currentValue: draftEnabledSkills.has(skill.name) ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            });
          });
        }

        return items;
      }

      function buildPresetItems(): SettingItem[] {
        const items: SettingItem[] = [];
        const query = searchQuery.trim();
        const defaultState = readGlobalLoadout();
        const presets: Array<{ name: string; source: "builtin" | "default" | "user"; profile?: Profile }> = [
          { name: "full", source: "builtin", profile: presetProfile("full") },
          { name: "minimal", source: "builtin", profile: presetProfile("minimal") },
          { name: "default", source: "default", profile: defaultState ? profileFromStoredState(defaultState) : undefined },
          ...Object.entries(readProfilesFile().profiles).map(([name, profile]) => ({ name, source: "user" as const, profile })),
        ];

        for (const preset of presets) {
          if (query !== "" && !matchesQuery(preset.name) && !matchesQuery(preset.source)) continue;
          const presetId = `preset:${preset.name}` as RowId;
          const toolsCount = preset.profile ? normalizeEnabledTools(preset.profile.enabledTools).size : 0;
          const skillsCount = preset.profile ? normalizeEnabledSkills(preset.profile.enabledSkills).size : 0;
          rowRefs.set(presetId, { kind: "preset", ...preset });
          visibleRowIds.push(presetId);
          items.push({
            id: presetId,
            label: preset.name,
            description:
              preset.source === "user"
                ? `${toolsCount}/${allToolNames().length} tools · ${skillsCount}/${allSkillNames().length} skills · updated ${formatRelativeTime(preset.profile?.updatedAt ?? "")} · Space/Enter applies · Ctrl+D deletes`
                : preset.source === "default"
                  ? preset.profile
                    ? `${toolsCount}/${allToolNames().length} tools · ${skillsCount}/${allSkillNames().length} skills · saved global default · Space/Enter applies`
                    : `No global default saved at ${GLOBAL_LOADOUT_PATH} · Ctrl+S saves one`
                  : `${toolsCount}/${allToolNames().length} tools · ${skillsCount}/${allSkillNames().length} skills · built-in · Space/Enter applies`,
            currentValue: currentProfileName === preset.name ? (isCurrentDirty() ? "active*" : "active") : preset.source,
            values: ["apply"],
          });
        }

        return items;
      }

      function buildItems(): SettingItem[] {
        visibleRowIds = [];
        rowRefs.clear();
        if (pane === "tools") return buildToolItems();
        if (pane === "skills") return buildSkillItems();
        return buildPresetItems();
      }

      const initialEnabledTools = normalizeEnabledTools(activeToolNames());
      const initialEnabledSkills = normalizeEnabledSkills(activeSkillNames());

      const result = await ctx.ui.custom<LoadoutResult | undefined>((tui, theme, _keybindings, done) => {
        let settingsList: SettingsList;
        let selectedIndex = paneSelectedIndex[pane];
        let helpVisible = false;
        const items = buildItems();
        const headerText = new Text("", 1, 0);
        const searchLabel = new Text("", 1, 0);
        const searchInput = new Input();
        searchInput.focused = true;
        const hintText = new Text("", 1, 0);
        const cacheNoteText = new Text("", 1, 0);

        function updateHeader() {
          const toolsLabel = pane === "tools" ? theme.fg("accent", theme.bold("[Tools]")) : theme.fg("dim", "Tools");
          const skillsLabel = pane === "skills" ? theme.fg("accent", theme.bold("[Skills]")) : theme.fg("dim", "Skills");
          const presetsLabel = pane === "presets" ? theme.fg("accent", theme.bold("[Presets]")) : theme.fg("dim", "Presets");
          headerText.setText(`${toolsLabel}  ${skillsLabel}  ${presetsLabel}`);
          searchLabel.setText(theme.fg("dim", pane === "presets" ? "Filter presets, or type a name then Ctrl+P to save:" : "Search (filter by tool, skill, or extension name):"));
          hintText.setText(
            theme.fg(
              "dim",
              pane === "presets"
                ? "Type to filter or name • Tab switch pane • Space/Enter apply • Ctrl+P save • Ctrl+D delete • ? shortcuts • Esc clear/close"
                : "Type to search • Tab switch pane • Space toggle • Enter collapse • Ctrl+S save default • ? shortcuts • Esc clear/close",
            ),
          );
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
          } else if (pane === "skills") {
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

          if (row.kind === "skillGroup" || row.kind === "skill") {
            const groupId = `skillgroup:${row.group.key}` as RowId;
            if (collapsedSkillGroups.has(row.group.key)) collapsedSkillGroups.delete(row.group.key);
            else collapsedSkillGroups.add(row.group.key);
            rebuildItems(groupId);
            return;
          }

          applyPresetRow(row);
        }

        function applyPresetRow(row: Extract<RowRef, { kind: "preset" }>) {
          if (!row.profile) {
            ctx.ui.notify(`No saved ${row.name} loadout found.`, "warning");
            return;
          }

          draftEnabledTools.clear();
          for (const name of normalizeEnabledTools(row.profile.enabledTools)) draftEnabledTools.add(name);
          draftEnabledSkills.clear();
          for (const name of normalizeEnabledSkills(row.profile.enabledSkills)) draftEnabledSkills.add(name);
          applyEnabledInMemory(draftEnabledTools, draftEnabledSkills);
          if (row.source === "default") {
            currentProfileName = readGlobalLoadout()?.profileName;
          } else {
            currentProfileName = row.name;
          }
          updateStatus(ctx);
          cacheNoteText.setText(theme.fg("warning", "Applied preset. Local session save happens when selector closes; next response may miss prompt cache."));
          rebuildItems(`preset:${row.name}` as RowId);
        }

        function switchPane() {
          syncSelectedIndex();
          pane = pane === "tools" ? "skills" : pane === "skills" ? "presets" : "tools";
          selectedIndex = paneSelectedIndex[pane];
          rebuildItems();
        }

        function applySearch() {
          paneSelectedIndex[pane] = 0;
          selectedIndex = 0;
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

            if (row.kind === "preset") {
              applyPresetRow(row);
              return;
            }

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
        container.addChild(searchLabel);
        container.addChild(searchInput);
        container.addChild(hintText);
        container.addChild(cacheNoteText);
        container.addChild(settingsList);
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

        const helpContainer = new Container();
        const helpTitle = new Text(theme.fg("accent", theme.bold("Loadout shortcuts")), 1, 0);
        const helpBody = new Text(
          [
            theme.fg("borderAccent", "Global"),
            `  ${theme.bold("Tab")}      Switch Tools / Skills / Presets`,
            `  ${theme.bold("↑ ↓")}      Navigate`,
            `  ${theme.bold("Type")}     Search / filter (Presets: also the new preset name)`,
            `  ${theme.bold("Ctrl+S")}   Save current selection as global default`,
            `  ${theme.bold("Esc")}      Clear search, or close picker`,
            "",
            theme.fg("borderAccent", "Tools / Skills"),
            `  ${theme.bold("Space")}    Toggle selected item or group`,
            `  ${theme.bold("Enter")}    Expand / collapse selected group`,
            "",
            theme.fg("borderAccent", "Presets"),
            `  ${theme.bold("Space")}    Apply selected preset`,
            `  ${theme.bold("Enter")}    Apply selected preset`,
            `  ${theme.bold("Ctrl+P")}   Save current selection as the typed preset name`,
            `  ${theme.bold("Ctrl+D")}   Delete selected user preset`,
          ].join("\n"),
          1,
          0,
        );
        const helpHint = new Text(theme.fg("dim", "? or Esc to close"), 1, 0);
        helpContainer.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
        helpContainer.addChild(helpTitle);
        helpContainer.addChild(helpBody);
        helpContainer.addChild(helpHint);
        helpContainer.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

        return {
          render: (width: number) => (helpVisible ? helpContainer.render(width) : container.render(width)),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            if (helpVisible) {
              if (data === "?" || matchesKey(data, Key.escape)) {
                helpVisible = false;
                tui.requestRender();
              }
              return;
            }

            if (data === "?") {
              helpVisible = true;
              tui.requestRender();
              return;
            }

            if (matchesKey(data, Key.ctrl("p"))) {
              const name = searchInput.getValue().trim() || (isUserProfileName(currentProfileName) ? currentProfileName : "");
              if (!name) {
                ctx.ui.notify("Type a preset name in the search field, then press Ctrl+P to save.", "warning");
                return;
              }
              if (saveUserProfile(name, draftEnabledTools, draftEnabledSkills, ctx) && pane === "presets") {
                rebuildItems(`preset:${name}` as RowId);
              }
              return;
            }

            if (pane === "presets" && matchesKey(data, Key.ctrl("d"))) {
              const selectedId = visibleRowIds[selectedIndex];
              const row = rowRefs.get(selectedId);
              if (!row || row.kind !== "preset") return;
              if (row.source !== "user") {
                ctx.ui.notify(`Cannot delete built-in preset: ${row.name}`, "warning");
                return;
              }
              if (deleteUserProfile(row.name, ctx)) rebuildItems();
              return;
            }

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

            if (matchesKey(data, Key.escape)) {
              if (searchQuery !== "") {
                searchInput.setValue("");
                searchQuery = "";
                applySearch();
                return;
              }
              done({ enabledTools: new Set(draftEnabledTools), enabledSkills: new Set(draftEnabledSkills) });
              return;
            }

            // Navigation and toggle keys are handled by the list; everything else
            // (printable characters, word-delete, etc.) edits the search field.
            if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === " ") {
              settingsList.handleInput(data);
              syncSelectedIndex();
              tui.requestRender();
              return;
            }

            if (matchesKey(data, Key.enter)) {
              toggleSelectedGroupCollapse();
              return;
            }

            const before = searchInput.getValue();
            searchInput.handleInput(data);
            const after = searchInput.getValue();
            if (after !== before) {
              searchQuery = after;
              applySearch();
            } else {
              tui.requestRender();
            }
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
