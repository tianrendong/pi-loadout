import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Skill,
  ToolDefinition,
  ToolExposure,
  ToolInfo,
  ToolLoadout,
  ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Container,
  fuzzyMatch,
  Input,
  Key,
  matchesKey,
  SettingsList,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";

const DESCRIPTION_LINES = 3;
const STATE_CUSTOM_TYPE = "pi-loadout:selection";
const LOG_CUSTOM_TYPE = "pi-loadout:loadout changed";
const GLOBAL_LOADOUT_PATH = join(homedir(), ".pi", "agent", "loadout.json");
const PROFILES_PATH = join(homedir(), ".pi", "agent", "loadout-profiles.json");
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODEMODE_TOOL = "codemode";
/**
 * Internal tool whose `prepareLoadout` hook hides the declarations of codemode-only tools (and
 * itself) from the model while keeping them active, so codemode scripts can still call them.
 */
const CODEMODE_ONLY_HELPER_TOOL = "pi_loadout_codemode_only";
const TOOL_MODES = ["direct", "codemode", "deferred", "off"] as const;
/** Mode names accepted by `/loadout mode` from earlier versions. */
const TOOL_MODE_ALIASES: Record<string, ToolMode> = { hidden: "off" };

/**
 * How a tool is reachable. The reachable modes are named after Pi's tool exposures (`ToolExposure`):
 * - `direct`: declared to the model (active).
 * - `codemode`: not declared; callable from `codemode` scripts and listed in the `codemode`
 *   tool's description.
 * - `deferred`: like `codemode`, but not listed; scripts find it with `searchTools()` /
 *   `describeTool()`. Keeps the description's inline budget for the tools that matter. Unlike a
 *   tool registered with `deferred` exposure, `tool_search` does not load it.
 * - `off`: not reachable, not even from scripts, until switched back (an inactive `direct` tool).
 *   Not Pi's `hidden` exposure, which withdraws a tool for good; and Pi also says "hidden" for
 *   declarations left out of requests while still callable, which is what `codemode` does.
 *
 * Tools registered with `codemode` or `deferred` exposure (such as MCP tools) show their own
 * exposure and can only be promoted to `direct`.
 */
type ToolMode = (typeof TOOL_MODES)[number];

type StoredState = {
  enabledTools: string[];
  enabledSkills?: string[];
  /** Tools with `direct` exposure presented as `codemode`: callable from scripts and listed. */
  codemodeTools?: string[];
  /** Tools with `direct` exposure presented as `deferred`: callable from scripts, not listed. */
  deferredTools?: string[];
  profileName?: string;
};

type Profile = {
  enabledTools: string[];
  enabledSkills: string[];
  codemodeTools?: string[];
  deferredTools?: string[];
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
  codemodeTools: Set<string>;
  deferredTools: Set<string>;
  enabledSkills: Set<string>;
};

/**
 * `tools` are declared directly. `codemode` and `deferred` (disjoint) are direct-exposure tools
 * presented with that exposure instead.
 */
type Selection = {
  tools: Set<string>;
  codemode: Set<string>;
  deferred: Set<string>;
  skills: Set<string>;
};

type LoadoutDiff = {
  toolsAdded: string[];
  toolsRemoved: string[];
  codemodeAdded: string[];
  codemodeRemoved: string[];
  deferredAdded: string[];
  deferredRemoved: string[];
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
  let codemodeTools = new Set<string>();
  let deferredTools = new Set<string>();
  let enabledSkills = new Set<string>();
  let skillLoadoutExplicit = false;
  let currentProfileName: string | undefined;
  // Tool names from a restored/applied loadout that are not registered yet (for example MCP tools
  // whose server is still connecting). They are applied once the tools show up.
  let pendingDirectTools = new Set<string>();
  let pendingCodemodeTools = new Set<string>();
  let pendingDeferredTools = new Set<string>();

  function allTools(): ToolInfo[] {
    const byName = new Map<string, ToolInfo>();
    for (const tool of pi.getAllTools()) {
      if (tool.name === CODEMODE_ONLY_HELPER_TOOL) continue;
      byName.set(tool.name, tool);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function allToolNames(): string[] {
    return allTools().map((tool) => tool.name);
  }

  function activeToolNames(): string[] {
    return pi.getActiveTools();
  }

  function toolExposure(tool: ToolInfo | undefined): ToolExposure {
    return tool?.exposure ?? "direct";
  }

  function isIndirectExposure(exposure: ToolExposure): boolean {
    return exposure === "codemode" || exposure === "deferred";
  }

  function codemodeRegistered(): boolean {
    return pi.getAllTools().some((tool) => tool.name === CODEMODE_TOOL);
  }

  /** Modes a tool can be set to, given its exposure. */
  function allowedToolModes(tool: ToolInfo, hasCodemode = codemodeRegistered()): ToolMode[] {
    const exposure = toolExposure(tool);
    // Tools with codemode/deferred exposure are always callable from scripts; they can only be
    // promoted to direct declarations.
    if (isIndirectExposure(exposure)) return ["direct", exposure as ToolMode];
    if (exposure === "direct" && hasCodemode && tool.name !== CODEMODE_TOOL) return ["direct", "codemode", "deferred", "off"];
    return ["direct", "off"];
  }

  function toolModeOf(
    tool: ToolInfo,
    direct: Set<string>,
    codemode: Set<string>,
    deferred: Set<string> = new Set(),
  ): ToolMode {
    if (direct.has(tool.name)) return "direct";
    const exposure = toolExposure(tool);
    if (isIndirectExposure(exposure)) return exposure as ToolMode;
    if (exposure === "direct" && codemode.has(tool.name)) return "codemode";
    if (exposure === "direct" && deferred.has(tool.name)) return "deferred";
    return "off";
  }

  /** Closest allowed mode for a tool, or undefined when the requested mode does not apply. */
  function clampToolMode(tool: ToolInfo, mode: ToolMode, hasCodemode = codemodeRegistered()): ToolMode | undefined {
    const allowed = allowedToolModes(tool, hasCodemode);
    if (allowed.includes(mode)) return mode;
    // Registered codemode/deferred tools cannot be turned off; demote them to their own exposure.
    const exposure = toolExposure(tool);
    if (mode === "off" && isIndirectExposure(exposure)) return exposure as ToolMode;
    return undefined;
  }

  /** Set a tool's mode in the given sets. Returns false when the mode does not apply to the tool. */
  function setToolMode(
    tool: ToolInfo,
    mode: ToolMode,
    direct: Set<string>,
    codemode: Set<string>,
    deferred: Set<string>,
    hasCodemode = codemodeRegistered(),
  ): boolean {
    const next = clampToolMode(tool, mode, hasCodemode);
    if (!next) return false;
    direct.delete(tool.name);
    codemode.delete(tool.name);
    deferred.delete(tool.name);
    if (next === "direct") direct.add(tool.name);
    else if (next === "codemode" && toolExposure(tool) === "direct") codemode.add(tool.name);
    else if (next === "deferred" && toolExposure(tool) === "direct") deferred.add(tool.name);
    return true;
  }

  /** Modes that reach the tool through `codemode` scripts. */
  function isIndirectMode(mode: ToolMode): boolean {
    return mode === "codemode" || mode === "deferred";
  }

  /** Codemode-only tools need the codemode tool itself; enable it if it is registered. */
  function ensureCodemodeEnabled(direct: Set<string>, ctx?: ExtensionContext): boolean {
    if (direct.has(CODEMODE_TOOL) || !codemodeRegistered()) return false;
    direct.add(CODEMODE_TOOL);
    ctx?.ui.notify("Enabled the codemode tool so codemode and deferred tools stay reachable.", "info");
    return true;
  }

  function countToolModes(
    direct: Set<string>,
    codemode: Set<string>,
    tools = allTools(),
    deferred: Set<string> = new Set(),
  ) {
    const counts: Record<ToolMode, number> = { direct: 0, codemode: 0, deferred: 0, off: 0 };
    for (const tool of tools) counts[toolModeOf(tool, direct, codemode, deferred)]++;
    return counts;
  }

  function formatToolCounts(direct: Set<string>, codemode: Set<string>, deferred: Set<string>): string {
    const tools = allTools();
    const counts = countToolModes(direct, codemode, tools, deferred);
    const indirect = counts.codemode + counts.deferred;
    const viaCodemode = indirect > 0 ? ` (+${indirect} via codemode)` : "";
    return `${counts.direct}/${tools.length} tools${viaCodemode}`;
  }

  /** Tools currently declared directly, excluding codemode-only tools and the helper. */
  function currentDirectTools(): Set<string> {
    return normalizeEnabledTools(
      activeToolNames().filter(
        (name) => name !== CODEMODE_ONLY_HELPER_TOOL && !codemodeTools.has(name) && !deferredTools.has(name),
      ),
    );
  }

  function currentSelection(): Selection {
    const tools = currentDirectTools();
    const codemode = normalizeCodemodeTools(codemodeTools, tools);
    return {
      tools,
      codemode,
      deferred: normalizeDeferredTools(deferredTools, tools, codemode),
      skills: normalizeEnabledSkills(activeSkillNames()),
    };
  }

  /** The active tool set: direct tools, then codemode/deferred tools and the helper that hides them. */
  function activeSetFor(direct: Set<string>, indirect: Set<string>): string[] {
    const names = [...direct].filter((name) => name !== CODEMODE_ONLY_HELPER_TOOL && !indirect.has(name));
    if (indirect.size === 0) return names;
    // The helper must come after `codemode` so its codemode description wins.
    return [...names, ...indirect, CODEMODE_ONLY_HELPER_TOOL];
  }

  function applyTools(direct: Set<string>, codemode: Set<string>, deferred: Set<string> = new Set()) {
    enabledTools = normalizeEnabledTools(direct);
    codemodeTools = normalizeCodemodeTools(codemode, enabledTools);
    deferredTools = normalizeDeferredTools(deferred, enabledTools, codemodeTools);
    pi.setActiveTools(activeSetFor(enabledTools, new Set([...codemodeTools, ...deferredTools])));
  }

  function setPendingTools(rawDirect: Iterable<string>, rawCodemode: Iterable<string>, rawDeferred: Iterable<string> = []) {
    const available = new Set(allToolNames());
    pendingDirectTools = new Set([...rawDirect].filter((name) => !available.has(name)));
    pendingCodemodeTools = new Set([...rawCodemode].filter((name) => !available.has(name) && !pendingDirectTools.has(name)));
    pendingDeferredTools = new Set(
      [...rawDeferred].filter(
        (name) => !available.has(name) && !pendingDirectTools.has(name) && !pendingCodemodeTools.has(name),
      ),
    );
  }

  /** Apply pending tools that have been registered since. Returns true when the loadout changed. */
  function resolvePendingTools(): boolean {
    if (pendingDirectTools.size === 0 && pendingCodemodeTools.size === 0 && pendingDeferredTools.size === 0) {
      return false;
    }
    const byName = new Map(allTools().map((tool) => [tool.name, tool]));
    const direct = currentDirectTools();
    const codemode = new Set(codemodeTools);
    const deferred = new Set(deferredTools);
    let changed = false;
    for (const name of [...pendingDirectTools]) {
      if (!byName.has(name)) continue;
      pendingDirectTools.delete(name);
      if (!direct.has(name)) changed = true;
      direct.add(name);
      codemode.delete(name);
      deferred.delete(name);
    }
    for (const [pending, mode] of [
      [pendingCodemodeTools, "codemode"],
      [pendingDeferredTools, "deferred"],
    ] as const) {
      for (const name of [...pending]) {
        const tool = byName.get(name);
        if (!tool) continue;
        pending.delete(name);
        const before = toolModeOf(tool, direct, codemode, deferred);
        if (setToolMode(tool, mode, direct, codemode, deferred) && before !== mode) changed = true;
      }
    }
    if (changed) applyTools(direct, codemode, deferred);
    return changed;
  }

  function ensureHelperOrder() {
    const active = activeToolNames();
    const helperIndex = active.indexOf(CODEMODE_ONLY_HELPER_TOOL);
    if (helperIndex === -1) return;
    if (active.indexOf(CODEMODE_TOOL) > helperIndex) {
      pi.setActiveTools([...active.filter((name) => name !== CODEMODE_ONLY_HELPER_TOOL), CODEMODE_ONLY_HELPER_TOOL]);
    }
  }

  // Captured definition of the built-in codemode tool, used to rebuild its description with
  // codemode-only tools listed. `null` when unavailable on this pi version.
  let codemodeDelegate: ToolDefinition | null | undefined;

  function getCodemodeDelegate(): ToolDefinition | undefined {
    if (codemodeDelegate !== undefined) return codemodeDelegate ?? undefined;
    codemodeDelegate = null;
    const factory = (piCodingAgent as unknown as { createCodemodeExtension?: () => (api: ExtensionAPI) => void })
      .createCodemodeExtension;
    if (typeof factory !== "function") return undefined;
    try {
      const capture = {
        registerTool: (definition: ToolDefinition) => {
          codemodeDelegate = definition;
        },
        appendEntry: (customType: string, data?: unknown) => pi.appendEntry(customType, data),
        getAllTools: () => pi.getAllTools(),
        getSettings: () => pi.getSettings(),
      };
      factory()(capture as unknown as ExtensionAPI);
    } catch {
      codemodeDelegate = null;
    }
    return codemodeDelegate ?? undefined;
  }

  /** Whether the registered codemode tool is pi's implementation (not a replacement extension). */
  function isStandardCodemode(delegate: ToolDefinition): boolean {
    const tool = pi.getAllTools().find((candidate) => candidate.name === CODEMODE_TOOL);
    return !!tool && tool.description === delegate.description;
  }

  function prepareCodemodeOnlyLoadout(loadout: ToolLoadout): ToolLoadoutChanges {
    const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
    const hidden = [...codemodeTools, ...deferredTools].filter(
      (name) => declaredNames.has(name) && loadout.getExposure(name) === "direct",
    );
    const hiddenDeclarations = [CODEMODE_ONLY_HELPER_TOOL, ...hidden];
    if (hidden.length === 0 || !declaredNames.has(CODEMODE_TOOL)) return { hiddenDeclarations };

    // List the codemode-only tools in the codemode description by presenting them to pi's
    // codemode hook with the exposure their mode names (`codemode` is listed, `deferred` is not).
    const delegate = getCodemodeDelegate();
    if (!delegate?.prepareLoadout || !isStandardCodemode(delegate)) return { hiddenDeclarations };
    const hiddenSet = new Set(hidden);
    const delegated = delegate.prepareLoadout({
      declared: loadout.declared.filter((tool) => tool.name !== CODEMODE_ONLY_HELPER_TOOL && !hiddenSet.has(tool.name)),
      callable: loadout.callable,
      registered: loadout.registered,
      getExposure: (name) =>
        hiddenSet.has(name) ? (deferredTools.has(name) ? "deferred" : "codemode") : loadout.getExposure(name),
      getNamespace: (name) => loadout.getNamespace(name),
      getPromptGuidelines: (name: string) =>
        (loadout as { getPromptGuidelines?: (name: string) => string[] }).getPromptGuidelines?.(name) ?? [],
    } as ToolLoadout);
    return {
      descriptions: delegated?.descriptions,
      hiddenDeclarations: [...hiddenDeclarations, ...(delegated?.hiddenDeclarations ?? [])],
    };
  }

  pi.registerTool({
    name: CODEMODE_ONLY_HELPER_TOOL,
    label: "loadout codemode-only",
    description: "Internal pi-loadout helper that hides codemode-only tools from the model. Not callable.",
    parameters: Type.Object({}),
    exposure: "model-only",
    defaultActive: false,
    prepareLoadout: (loadout) => prepareCodemodeOnlyLoadout(loadout),
    execute: async () => {
      throw new Error(`${CODEMODE_ONLY_HELPER_TOOL} is an internal pi-loadout helper and cannot be called.`);
    },
  });

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
    // Codemode/deferred tools (such as MCP tools) stay codemode-only in presets; only tools that
    // are declared by default are enabled as direct tools.
    const tools = allTools().filter((tool) => !isIndirectExposure(toolExposure(tool)));
    if (name === "full") return new Set(tools.map((tool) => tool.name));
    return new Set(tools.filter((tool) => isBuiltinSource(tool.sourceInfo)).map((tool) => tool.name));
  }

  function presetSkills(name: LoadoutPresetName): Set<string> {
    if (name === "full") return new Set(allSkillNames());
    return new Set(allSkills().filter((skill) => isBuiltinSource(skill.sourceInfo)).map((skill) => skill.name));
  }

  function presetProfile(name: LoadoutPresetName): Profile {
    return {
      enabledTools: sorted(presetTools(name)),
      enabledSkills: sorted(presetSkills(name)),
      codemodeTools: [],
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
      codemodeTools: sorted(state.codemodeTools ?? []),
      deferredTools: sorted(state.deferredTools ?? []),
      updatedAt: new Date(0).toISOString(),
    };
  }

  function selectionFromProfile(profile: Profile): Selection {
    const tools = normalizeEnabledTools(profile.enabledTools);
    const codemode = normalizeCodemodeTools(profile.codemodeTools ?? [], tools);
    return {
      tools,
      codemode,
      deferred: normalizeDeferredTools(profile.deferredTools ?? [], tools, codemode),
      skills: normalizeEnabledSkills(profile.enabledSkills),
    };
  }

  const RESERVED_PROFILE_NAMES = new Set([
    "default",
    "delete",
    "full",
    "help",
    "list",
    "minimal",
    "mode",
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

  /** Registered tools with `direct` exposure that are not declared directly. */
  function normalizeCodemodeTools(names: Iterable<string>, direct: Set<string>): Set<string> {
    const byName = new Map(allTools().map((tool) => [tool.name, tool]));
    return new Set(
      [...names].filter((name) => {
        const tool = byName.get(name);
        return !!tool && toolExposure(tool) === "direct" && name !== CODEMODE_TOOL && !direct.has(name);
      }),
    );
  }

  /** Like `normalizeCodemodeTools`; a tool in both sets stays `codemode`. */
  function normalizeDeferredTools(names: Iterable<string>, direct: Set<string>, codemode: Set<string>): Set<string> {
    return new Set([...normalizeCodemodeTools(names, direct)].filter((name) => !codemode.has(name)));
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
    const codemodeTools = Array.isArray(data.codemodeTools)
      ? data.codemodeTools.filter((name): name is string => typeof name === "string")
      : undefined;
    const deferredTools = Array.isArray(data.deferredTools)
      ? data.deferredTools.filter((name): name is string => typeof name === "string")
      : undefined;

    return { enabledTools, enabledSkills, codemodeTools, deferredTools, profileName };
  }

  function toStoredState(
    nextTools: Set<string>,
    nextSkills: Set<string>,
    profileName?: string,
    nextCodemode: Set<string> = new Set(),
    nextDeferred: Set<string> = new Set(),
  ): StoredState {
    // Keep tools that are not registered yet so a save made before an MCP server connects
    // does not drop them.
    const state: StoredState = {
      enabledTools: sorted([...nextTools, ...pendingDirectTools]),
      enabledSkills: sorted(nextSkills),
    };
    const codemode = sorted([...nextCodemode, ...pendingCodemodeTools]);
    if (codemode.length > 0) state.codemodeTools = codemode;
    const deferred = sorted([...nextDeferred, ...pendingDeferredTools]);
    if (deferred.length > 0) state.deferredTools = deferred;
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
            ...(Array.isArray(v.codemodeTools)
              ? { codemodeTools: v.codemodeTools.filter((n): n is string => typeof n === "string") }
              : {}),
            ...(Array.isArray(v.deferredTools)
              ? { deferredTools: v.deferredTools.filter((n): n is string => typeof n === "string") }
              : {}),
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
      codemodeTools: sorted(codemodeTools),
      deferredTools: sorted(deferredTools),
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
    const codemode = sorted(codemodeTools).join("\u0001");
    const deferred = sorted(deferredTools).join("\u0001");
    const target = selectionFromProfile(profile);
    return (
      tools !== sorted(target.tools).join("\u0001") ||
      skills !== sorted(target.skills).join("\u0001") ||
      codemode !== sorted(target.codemode).join("\u0001") ||
      deferred !== sorted(target.deferred).join("\u0001")
    );
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

  function computeDiff(current: Selection, target: Selection): LoadoutDiff {
    return {
      toolsAdded: setDifference(target.tools, current.tools),
      toolsRemoved: setDifference(current.tools, target.tools),
      codemodeAdded: setDifference(target.codemode, current.codemode),
      codemodeRemoved: setDifference(current.codemode, target.codemode),
      deferredAdded: setDifference(target.deferred, current.deferred),
      deferredRemoved: setDifference(current.deferred, target.deferred),
      skillsAdded: setDifference(target.skills, current.skills),
      skillsRemoved: setDifference(current.skills, target.skills),
    };
  }

  function hasDiff(diff: LoadoutDiff): boolean {
    return (
      diff.toolsAdded.length +
        diff.toolsRemoved.length +
        diff.codemodeAdded.length +
        diff.codemodeRemoved.length +
        diff.deferredAdded.length +
        diff.deferredRemoved.length +
        diff.skillsAdded.length +
        diff.skillsRemoved.length >
      0
    );
  }

  function formatInlineDiff(added: string[], removed: string[]): string {
    return [...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(" ");
  }

  function formatLoadoutLog(diff: LoadoutDiff): string {
    const lines: string[] = [];
    if (diff.toolsAdded.length + diff.toolsRemoved.length > 0) {
      lines.push(`Tools: ${formatInlineDiff(diff.toolsAdded, diff.toolsRemoved)}`);
    }
    if (diff.codemodeAdded.length + diff.codemodeRemoved.length > 0) {
      lines.push(`Codemode: ${formatInlineDiff(diff.codemodeAdded, diff.codemodeRemoved)}`);
    }
    if (diff.deferredAdded.length + diff.deferredRemoved.length > 0) {
      lines.push(`Deferred: ${formatInlineDiff(diff.deferredAdded, diff.deferredRemoved)}`);
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

  function applySelectionInMemory(next: Selection) {
    enabledSkills = normalizeEnabledSkills(next.skills);
    skillLoadoutExplicit = true;
    applyTools(next.tools, next.codemode, next.deferred);
  }

  function persistEnabled() {
    pi.appendEntry<StoredState>(
      STATE_CUSTOM_TYPE,
      toStoredState(enabledTools, enabledSkills, currentProfileName, codemodeTools, deferredTools),
    );
  }

  function normalizeSelection(selection: Selection): Selection {
    const tools = normalizeEnabledTools(selection.tools);
    const codemode = normalizeCodemodeTools(selection.codemode, tools);
    return {
      tools,
      codemode,
      deferred: normalizeDeferredTools(selection.deferred, tools, codemode),
      skills: normalizeEnabledSkills(selection.skills),
    };
  }

  function commitLoadout(
    previous: Selection,
    next: Selection,
    ctx: ExtensionContext,
    commandSource: string,
    nextProfileName?: string | null,
  ): LoadoutDiff {
    const target = normalizeSelection(next);
    const diff = computeDiff(previous, target);

    applySelectionInMemory(target);
    if (nextProfileName === null) currentProfileName = undefined;
    else if (typeof nextProfileName === "string") currentProfileName = nextProfileName;
    updateStatus(ctx);

    if (!hasDiff(diff) && nextProfileName === undefined) return diff;

    persistEnabled();
    if (hasDiff(diff)) logAppliedLoadout(diff, commandSource);
    return diff;
  }

  function saveGlobalLoadout(selection: Selection, ctx: ExtensionContext) {
    const target = normalizeSelection(selection);
    writeGlobalLoadout(toStoredState(target.tools, target.skills, currentProfileName, target.codemode, target.deferred));
    ctx.ui.notify(
      `Saved default loadout: ${formatToolCounts(target.tools, target.codemode, target.deferred)}, ${target.skills.size}/${allSkillNames().length} skills enabled. Future sessions will use it.`,
      "info",
    );
  }

  function applyProfileSelection(
    profile: Profile,
    ctx: ExtensionContext,
    commandSource: string,
    nextProfileName: string | null,
  ): { diff: LoadoutDiff; target: Selection } {
    const previous = currentSelection();
    setPendingTools(profile.enabledTools, profile.codemodeTools ?? [], profile.deferredTools ?? []);
    const target = selectionFromProfile(profile);
    const diff = commitLoadout(previous, target, ctx, commandSource, nextProfileName);
    return { diff, target };
  }

  function applyPreset(name: LoadoutPresetName, ctx: ExtensionContext, commandSource: string): LoadoutDiff {
    const { diff, target } = applyProfileSelection(presetProfile(name), ctx, commandSource, name);
    const label = name === "full" ? "Full" : "Minimal";
    const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
    ctx.ui.notify(
      `${label} preset applied: ${formatToolCounts(target.tools, target.codemode, target.deferred)}, ${target.skills.size}/${allSkillNames().length} skills enabled.${suffix}`,
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

    const { diff, target } = applyProfileSelection(
      profileFromStoredState(state),
      ctx,
      commandSource,
      state.profileName ?? null,
    );
    const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
    ctx.ui.notify(
      `Default loadout applied: ${formatToolCounts(target.tools, target.codemode, target.deferred)}, ${target.skills.size}/${allSkillNames().length} skills enabled.${suffix}`,
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

    const { diff, target } = applyProfileSelection(profile, ctx, commandSource, name);
    const suffix = hasDiff(diff) ? " Next response may miss prompt cache." : " Nothing changed.";
    ctx.ui.notify(
      `Preset ${name} applied: ${formatToolCounts(target.tools, target.codemode, target.deferred)}, ${target.skills.size}/${allSkillNames().length} skills enabled.${suffix}`,
      "info",
    );
    return diff;
  }

  function saveUserProfile(name: string, selection: Selection, ctx: ExtensionContext) {
    const error = validateProfileName(name);
    if (error) {
      ctx.ui.notify(error, "warning");
      return false;
    }

    const target = normalizeSelection(selection);
    const state = toStoredState(target.tools, target.skills, undefined, target.codemode, target.deferred);
    const file = readProfilesFile();
    file.profiles[name] = {
      enabledTools: state.enabledTools,
      enabledSkills: state.enabledSkills ?? [],
      ...(state.codemodeTools ? { codemodeTools: state.codemodeTools } : {}),
      ...(state.deferredTools ? { deferredTools: state.deferredTools } : {}),
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

  function formatProfileSummary(profile: Profile | undefined): string {
    if (!profile) return "not saved";
    const target = selectionFromProfile(profile);
    return `${formatToolCounts(target.tools, target.codemode, target.deferred)} · ${target.skills.size}/${allSkillNames().length} skills`;
  }

  function formatProfileList(): string {
    const lines = ["Loadout presets:"];
    lines.push(`  full      built-in · ${formatProfileSummary(presetProfile("full"))}`);
    lines.push(`  minimal   built-in · ${formatProfileSummary(presetProfile("minimal"))}`);
    const defaultState = readGlobalLoadout();
    lines.push(`  default   global · ${formatProfileSummary(defaultState ? profileFromStoredState(defaultState) : undefined)}`);

    const profiles = readProfilesFile().profiles;
    for (const name of Object.keys(profiles).sort()) {
      const profile = profiles[name];
      lines.push(
        `  ${name}${currentProfileName === name ? " *" : ""}  user · ${formatProfileSummary(profile)} · updated ${formatRelativeTime(profile.updatedAt)}`,
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
      enabledSkills = presetSkills(state.profileName);
      skillLoadoutExplicit = true;
      currentProfileName = state.profileName;
      setPendingTools([], []);
      applyTools(presetTools(state.profileName), new Set());
      return;
    }
    skillLoadoutExplicit = !!state?.enabledSkills;
    enabledSkills = state?.enabledSkills ? normalizeEnabledSkills(state.enabledSkills) : new Set(allSkillNames());
    currentProfileName = state?.profileName;
    if (!currentProfileName) {
      const file = readProfilesFile();
      if (file.defaultProfile && file.profiles[file.defaultProfile]) {
        currentProfileName = file.defaultProfile;
      }
    }
    if (state) {
      setPendingTools(state.enabledTools, state.codemodeTools ?? [], state.deferredTools ?? []);
      applyTools(
        new Set(state.enabledTools),
        new Set(state.codemodeTools ?? []),
        new Set(state.deferredTools ?? []),
      );
    } else {
      setPendingTools([], []);
      applyTools(presetTools("full"), new Set());
    }
  }

  function updateStatus(ctx: ExtensionContext) {
    const counts = `${formatToolCounts(currentDirectTools(), codemodeTools, deferredTools)} · ${activeSkillNames().length}/${allSkillNames().length} skills`;
    const prefix = currentProfileName ? `${currentProfileName}${isCurrentDirty() ? "*" : ""} · ` : "";
    ctx.ui.setStatus("loadout", `${prefix}${counts}`);
  }

  function replaceSkillsBlock(systemPrompt: string, nextSkills: Skill[]): string {
    const skillBlockPattern = /\n?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
    const nextBlock = formatSkillsForPrompt(nextSkills);
    if (skillBlockPattern.test(systemPrompt)) return systemPrompt.replace(skillBlockPattern, nextBlock ? `\n${nextBlock}` : "");
    return systemPrompt;
  }

  function supportsStructuredSections(options: unknown): boolean {
    const sections = (options as { sections?: unknown } | undefined)?.sections;
    return typeof sections === "object" && sections !== null;
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

  pi.on("before_agent_start", async (event, ctx) => {
    // Apply loadout entries for tools that registered late (e.g. MCP servers that connected after
    // session start), and keep the codemode-only helper after `codemode` in the active order.
    if (resolvePendingTools()) updateStatus(ctx);
    ensureHelperOrder();

    const skills = event.systemPromptOptions.skills ?? [];
    if (skills.length === 0) return;

    if (!skillLoadoutExplicit) return;

    const availableNames = new Set(skills.map((skill) => skill.name));
    const normalized = new Set([...enabledSkills].filter((name) => availableNames.has(name)));
    const filteredSkills = skills.filter((skill) => normalized.has(skill.name));
    if (filteredSkills.length === skills.length) return;

    // Newer pi builds the prompt from structured, named sections and diffs them into
    // mid-conversation system messages. Mutating systemPromptOptions.skills lets pi
    // append a small `skills` section patch instead of re-sending a forced prompt,
    // which keeps the cached prefix intact. Fall back to a full prompt override on
    // older pi versions without structured sections.
    if (supportsStructuredSections(event.systemPromptOptions)) {
      event.systemPromptOptions.skills = filteredSkills;
      return;
    }

    return { systemPrompt: replaceSkillsBlock(event.systemPrompt, filteredSkills) };
  });

  const TOOL_MODE_SYMBOLS: Record<ToolMode, string> = { direct: "●", codemode: "◆", deferred: "◇", off: "○" };

  function formatStatus(): string {
    const direct = currentDirectTools();
    const codemode = codemodeTools;
    const deferred = deferredTools;
    const activeSkills = new Set(activeSkillNames());
    const lines: string[] = [];
    lines.push(`Active: ${formatToolCounts(direct, codemode, deferred)} · ${activeSkills.size}/${allSkillNames().length} skills`);

    const toolGroups = groupTools(allTools());
    if (toolGroups.length > 0) {
      lines.push("", "Tools (● direct · ◆ codemode · ◇ deferred · ○ off):");
      for (const group of toolGroups) {
        const counts = countToolModes(direct, codemode, group.tools, deferred);
        lines.push(
          `  ${group.label} (${counts.direct} direct · ${counts.codemode} codemode · ${counts.deferred} deferred · ${counts.off} off)`,
        );
        for (const t of group.tools) {
          lines.push(`    ${TOOL_MODE_SYMBOLS[toolModeOf(t, direct, codemode, deferred)]} ${t.name}`);
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
      "  /loadout full     Enable every tool (codemode/deferred tools such as MCP keep their exposure) and skill",
      "  /loadout minimal  Enable only built-in tools and skills",
      "  /loadout default  Apply saved global default loadout",
      "  /loadout save <name>    Save current loadout as user preset",
      "  /loadout use <name>     Apply built-in, default, or user preset",
      "  /loadout list           List built-in and user presets",
      "  /loadout delete <name>  Delete user preset",
      "  /loadout mode <direct|codemode|deferred|off> <tool...>",
      "                    Set a tool's exposure: declared to the model, called from codemode",
      "                    scripts (listed), called from scripts but unlisted, or off",
      "                    (tool names accept * wildcards, e.g. mcp__linear__*)",
      "  /loadout status   Print current active tools and skills",
      "  /loadout reset    Alias for /loadout full",
      "  /loadout help     Show this help",
    ].join("\n");
  }

  function toolNamePattern(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  function setToolModesCommand(mode: ToolMode, patterns: string[], ctx: ExtensionContext) {
    const tools = allTools();
    const hasCodemode = codemodeRegistered();
    const previous = currentSelection();
    const next: Selection = {
      tools: new Set(previous.tools),
      codemode: new Set(previous.codemode),
      deferred: new Set(previous.deferred),
      skills: previous.skills,
    };
    const changed: string[] = [];
    const skipped: string[] = [];
    const unmatched: string[] = [];

    for (const pattern of patterns) {
      const regex = toolNamePattern(pattern);
      const matches = tools.filter((tool) => regex.test(tool.name));
      if (matches.length === 0) {
        unmatched.push(pattern);
        continue;
      }
      for (const tool of matches) {
        if (clampToolMode(tool, mode, hasCodemode) !== mode) {
          skipped.push(`${tool.name} (${toolExposure(tool)} exposure)`);
          continue;
        }
        if (setToolMode(tool, mode, next.tools, next.codemode, next.deferred, hasCodemode)) changed.push(tool.name);
      }
    }

    if (isIndirectMode(mode) && changed.length > 0) ensureCodemodeEnabled(next.tools, ctx);
    const diff = commitLoadout(previous, next, ctx, `/loadout mode ${mode} ${patterns.join(" ")}`);

    const messages: string[] = [];
    if (changed.length > 0) {
      messages.push(
        `Set ${changed.length} tool${changed.length === 1 ? "" : "s"} to ${mode}${hasDiff(diff) ? ". Next response may miss prompt cache." : " (already set)."}`,
      );
    }
    if (skipped.length > 0) messages.push(`Cannot set to ${mode}: ${skipped.join(", ")}`);
    if (unmatched.length > 0) messages.push(`No tools match: ${unmatched.join(", ")}`);
    ctx.ui.notify(messages.join("\n") || "Nothing changed.", unmatched.length + skipped.length > 0 ? "warning" : "info");
  }

  const LOADOUT_SUBCOMMANDS: { value: string; label: string; description: string }[] = [
    { value: "full", label: "full", description: "Enable every tool and skill (codemode/deferred tools such as MCP keep their exposure)" },
    { value: "minimal", label: "minimal", description: "Enable only built-in tools and skills" },
    { value: "default", label: "default", description: "Apply saved global default loadout" },
    { value: "save", label: "save", description: "Save current loadout as user preset" },
    { value: "use", label: "use", description: "Apply built-in, default, or user preset" },
    { value: "list", label: "list", description: "List built-in and user presets" },
    { value: "delete", label: "delete", description: "Delete user preset" },
    { value: "rm", label: "rm", description: "Delete user preset" },
    { value: "preset", label: "preset", description: "Apply a named preset" },
    { value: "preset full", label: "preset full", description: "Enable every tool and skill (codemode/deferred tools such as MCP keep their exposure)" },
    { value: "preset minimal", label: "preset minimal", description: "Enable only built-in tools and skills" },
    { value: "preset default", label: "preset default", description: "Apply saved global default loadout" },
    { value: "mode", label: "mode", description: "Set tool exposure: direct, codemode, deferred, or off" },
    { value: "mode direct", label: "mode direct", description: "Declare tools directly to the model" },
    { value: "mode codemode", label: "mode codemode", description: "Call tools only from codemode scripts; listed in its description" },
    { value: "mode deferred", label: "mode deferred", description: "Call tools only from codemode scripts; not listed (searchTools())" },
    { value: "mode off", label: "mode off", description: "Make tools unreachable" },
    { value: "status", label: "status", description: "Print current active tools and skills" },
    { value: "reset", label: "reset", description: "Alias for /loadout full" },
    { value: "help", label: "help", description: "Show /loadout subcommand list" },
  ];

  pi.registerCommand("loadout", {
    description: "Select tool exposure (direct, codemode, deferred, off) and skills for this session",
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.toLowerCase();
      const profileItems = Object.keys(readProfilesFile().profiles).flatMap((name) => [
        { value: `use ${name}`, label: `use ${name}`, description: "Apply user preset" },
        { value: `preset ${name}`, label: `preset ${name}`, description: "Apply user preset" },
        { value: `delete ${name}`, label: `delete ${name}`, description: "Delete user preset" },
      ]);
      const modeMatch = /^mode\s+(direct|codemode|deferred|off|hidden)\s+((?:\S+\s+)*)(\S*)$/i.exec(argumentPrefix);
      if (modeMatch) {
        const head = `mode ${modeMatch[1]} ${modeMatch[2]}`;
        const partial = modeMatch[3].toLowerCase();
        return allTools()
          .filter((tool) => tool.name.toLowerCase().startsWith(partial))
          .slice(0, 200)
          .map((tool) => ({
            value: `${head}${tool.name}`,
            label: tool.name,
            description: `${toolModeOf(tool, currentDirectTools(), codemodeTools, deferredTools)} · ${toolExposure(tool)} exposure`,
          }));
      }
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
        saveUserProfile(name, currentSelection(), ctx);
        return;
      }

      if (subcommand === "mode") {
        const word = words[1]?.toLowerCase() ?? "";
        const mode = TOOL_MODE_ALIASES[word] ?? word;
        const patterns = words.slice(2);
        if (!(TOOL_MODES as readonly string[]).includes(mode) || patterns.length === 0) {
          ctx.ui.notify("Usage: /loadout mode <direct|codemode|deferred|off> <tool...>", "warning");
          return;
        }
        setToolModesCommand(mode as ToolMode, patterns, ctx);
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
      const draftEnabledTools = currentDirectTools();
      const draftCodemodeTools = normalizeCodemodeTools(codemodeTools, draftEnabledTools);
      const draftDeferredTools = normalizeDeferredTools(deferredTools, draftEnabledTools, draftCodemodeTools);
      const hasCodemode = codemodeRegistered();
      const draftEnabledSkills = normalizeEnabledSkills(skillLoadoutExplicit ? enabledSkills : allSkillNames());
      const rowRefs = new Map<RowId, RowRef>();

      function draftToolMode(tool: ToolInfo): ToolMode {
        return toolModeOf(tool, draftEnabledTools, draftCodemodeTools, draftDeferredTools);
      }

      function toolGroupValue(group: ToolGroup): ToolMode | "mixed" {
        const modes = new Set(group.tools.map(draftToolMode));
        return modes.size === 1 ? [...modes][0] : "mixed";
      }

      function toolGroupModes(group: ToolGroup): ToolMode[] {
        const allowed = new Set(group.tools.flatMap((tool) => allowedToolModes(tool, hasCodemode)));
        return TOOL_MODES.filter((mode) => allowed.has(mode));
      }

      function draftSelection(): Selection {
        return {
          tools: new Set(draftEnabledTools),
          codemode: new Set(draftCodemodeTools),
          deferred: new Set(draftDeferredTools),
          skills: new Set(draftEnabledSkills),
        };
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
        const counts = countToolModes(draftEnabledTools, draftCodemodeTools, group.tools, draftDeferredTools);
        const collapsed = collapsedToolGroups.has(group.key) ? "collapsed" : "expanded";
        const modeCounts = hasCodemode
          ? `${counts.direct} direct · ${counts.codemode} codemode · ${counts.deferred} deferred · ${counts.off} off`
          : `${counts.direct}/${group.tools.length} enabled`;
        return `${group.label} · ${modeCounts} · ${collapsed} · Space cycles ${toolGroupModes(group).join("/")} for group · Enter expands/collapses`;
      }

      function toolDescription(group: ToolGroup, tool: ToolInfo): string {
        const exposure = toolExposure(tool);
        const exposureNote = exposure === "direct" ? "" : ` · ${exposure} exposure`;
        const base = tool.description ? `${group.label}${exposureNote} · ${tool.description}` : `${group.label}${exposureNote}`;
        return `${base} · Space cycles ${allowedToolModes(tool, hasCodemode).join("/")}`;
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
            values: toolGroupModes(group),
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
              description: toolDescription(group, tool),
              currentValue: draftToolMode(tool),
              values: allowedToolModes(tool, hasCodemode),
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

      const initialSelection = currentSelection();

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
                : pane === "tools" && hasCodemode
                  ? "Type to search • Tab switch pane • Space cycle direct/codemode/deferred/off • Enter collapse • Ctrl+S save default • ? shortcuts • Esc clear/close"
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
                settingsList.updateValue(`tool:${tool.name}`, draftToolMode(tool));
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

          const target = selectionFromProfile(row.profile);
          draftEnabledTools.clear();
          for (const name of target.tools) draftEnabledTools.add(name);
          draftCodemodeTools.clear();
          for (const name of target.codemode) draftCodemodeTools.add(name);
          draftDeferredTools.clear();
          for (const name of target.deferred) draftDeferredTools.add(name);
          draftEnabledSkills.clear();
          for (const name of target.skills) draftEnabledSkills.add(name);
          setPendingTools(row.profile.enabledTools, row.profile.codemodeTools ?? [], row.profile.deferredTools ?? []);
          applySelectionInMemory(draftSelection());
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
            if (trimmed === "direct") return theme.fg(selected ? "accent" : "success", "● direct");
            // Hue = how the model reaches the tool: green declared, blue via codemode, gray not at all.
            // Deferred is the one mode with a cost (the model must search for it), so it takes the
            // caution color; the hollow ◇ pairs it with codemode's ◆. Violet is reserved for selection.
            if (trimmed === "codemode") return theme.fg(selected ? "accent" : "mdLink", "◆ codemode");
            if (trimmed === "deferred") return theme.fg(selected ? "accent" : "warning", "◇ deferred");
            if (trimmed === "off") return theme.fg(selected ? "accent" : "dim", "○ off");
            if (trimmed === "mixed") return theme.fg(selected ? "accent" : "muted", "◐ mixed");
            return selected ? theme.fg("accent", text) : theme.fg("muted", text);
          },
          description: (text: string) => theme.fg("dim", text),
          hint: (text: string) =>
            theme.fg("dim", text.replace("Enter/Space to change", "Space to change · Enter collapse/expand")),
        };

        const listMaxVisible = Math.min(Math.max(items.length, 1), 18);
        settingsList = new SettingsList(
          items,
          listMaxVisible,
          listTheme,
          (id, newValue) => {
            const row = rowRefs.get(id as RowId);
            if (!row) return;

            if (row.kind === "preset") {
              applyPresetRow(row);
              return;
            }

            if (row.kind === "toolGroup") {
              const mode = newValue as ToolMode;
              for (const tool of row.group.tools) {
                setToolMode(tool, mode, draftEnabledTools, draftCodemodeTools, draftDeferredTools, hasCodemode);
              }
              if (isIndirectMode(mode)) ensureCodemodeEnabled(draftEnabledTools, ctx);
            } else if (row.kind === "tool") {
              const mode = newValue as ToolMode;
              setToolMode(row.tool, mode, draftEnabledTools, draftCodemodeTools, draftDeferredTools, hasCodemode);
              if (isIndirectMode(mode)) ensureCodemodeEnabled(draftEnabledTools, ctx);
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

            applySelectionInMemory(draftSelection());
            updateStatus(ctx);
            refreshValues();
            if (hasDiff(computeDiff(initialSelection, normalizeSelection(draftSelection())))) {
              cacheNoteText.setText(
                theme.fg(
                  "warning",
                  "Applied. Local session save happens when selector closes; next response may miss prompt cache.",
                ),
              );
            }
          },
          () => done({
              enabledTools: new Set(draftEnabledTools),
              codemodeTools: new Set(draftCodemodeTools),
              deferredTools: new Set(draftDeferredTools),
              enabledSkills: new Set(draftEnabledSkills),
            }),
        );

        // Fixed-height wrapper: SettingsList's height varies with item count, the scroll
        // indicator, and how many lines the selected description wraps to. Clamp the
        // description and pad each section so the layout doesn't shift while navigating.
        const fixedHeightList: Component = {
          render(width: number) {
            const selected = items[(settingsList as unknown as { selectedIndex: number }).selectedIndex];
            const fullDescription = selected?.description;
            if (selected && fullDescription) {
              const wrapped = wrapTextWithAnsi(fullDescription, Math.max(1, width - 4));
              if (wrapped.length > DESCRIPTION_LINES) {
                const kept = wrapped.slice(0, DESCRIPTION_LINES);
                kept[DESCRIPTION_LINES - 1] = truncateToWidth(
                  `${kept[DESCRIPTION_LINES - 1]} …`,
                  Math.max(1, width - 4),
                  "…",
                );
                selected.description = kept.join("\n");
              }
            }
            let lines: string[];
            try {
              lines = settingsList.render(width);
            } finally {
              if (selected) selected.description = fullDescription;
            }

            const hintLines = 2; // blank + hint, always appended by SettingsList
            const listRows =
              items.length === 0
                ? 1
                : Math.min(listMaxVisible, items.length) + (items.length > listMaxVisible ? 1 : 0);
            const listArea = lines.slice(0, listRows);
            const descArea = lines.slice(listRows, Math.max(listRows, lines.length - hintLines));
            const hintArea = lines.slice(Math.max(listRows, lines.length - hintLines));

            while (listArea.length < listMaxVisible + 1) listArea.push("");
            while (descArea.length < DESCRIPTION_LINES + 1) descArea.push("");
            return [...listArea, ...descArea.slice(0, DESCRIPTION_LINES + 1), ...hintArea];
          },
          invalidate: () => settingsList.invalidate(),
        };

        updateHeader();
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
        container.addChild(headerText);
        container.addChild(searchLabel);
        container.addChild(searchInput);
        container.addChild(hintText);
        container.addChild(cacheNoteText);
        container.addChild(fixedHeightList);
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
            `  ${theme.bold("Space")}    Toggle selected item or group (tools cycle direct → codemode → deferred → off)`,
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
              if (saveUserProfile(name, draftSelection(), ctx) && pane === "presets") {
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
                applySelectionInMemory(draftSelection());
                updateStatus(ctx);
                saveGlobalLoadout(draftSelection(), ctx);
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
              done({
              enabledTools: new Set(draftEnabledTools),
              codemodeTools: new Set(draftCodemodeTools),
              deferredTools: new Set(draftDeferredTools),
              enabledSkills: new Set(draftEnabledSkills),
            });
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
        initialSelection,
        result
          ? { tools: result.enabledTools, codemode: result.codemodeTools, deferred: result.deferredTools, skills: result.enabledSkills }
          : draftSelection(),
        ctx,
        "/loadout",
      );
    },
  });
}
