import { describe, expect, it, vi, afterEach } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { PresetSnapshot } from "../lib/preset";
import { readRemotePreset, pushRemotePreset } from "../lib/git";

vi.mock("../lib/git", () => ({
  readRemotePreset: vi.fn(),
  pushRemotePreset: vi.fn(async () => ({ pushed: false, head: "abc", changedFiles: [] })),
}));
afterEach(() => vi.clearAllMocks());

function fixture(settings: Record<string, boolean> = {}) {
  const config = {
    generalSettings: {
      defaultProviderId: null, providerOrder: [], showKeyboardHints: true,
      showUnhandledProviderEvents: false, steerActiveThreadOnEnter: true, streamerMode: false,
    },
    experiments: { editMessages: false }, keybindingOverrides: [],
    appearance: { themeId: "default", faviconColor: "default" as const },
  };
  const remote: PresetSnapshot = {
    schemaVersion: 1, capturedAt: "2026-11-16T00:00:00Z", bbVersion: "0.41.0",
    settings: {
      ...config,
      generalSettings: { ...config.generalSettings, showKeyboardHints: false },
      experiments: { editMessages: true },
      appearance: { themeId: "dark", faviconColor: "blue" },
    },
    plugins: [], marketplaces: [],
    pluginSettings: [{ id: "tasks", key: "view", value: "list" }],
  };
  vi.mocked(readRemotePreset).mockResolvedValue({ snapshot: remote, head: "abc" });
  const host = createFakePluginHost({
    pluginId: "preset-sync",
    settings: { repositoryUrl: "https://github.com/example/preset.git", ...settings },
    sdk: {
      system: {
        config: async () => config,
        version: async () => ({ currentVersion: "0.41.0" }),
        updateExperiments: async (flags) => {
          config.experiments = flags as typeof config.experiments;
          return flags;
        },
        updateGeneralSettings: async (settings) => {
          config.generalSettings = settings as typeof config.generalSettings;
          return settings;
        },
      },
      plugins: { list: async () => ({ plugins: [] }), marketplaces: { list: async () => [] } },
    },
  });
  return { ...host, config };
}

const excluded = {
  includeGeneralSettings: false, includeAppearance: false,
  includeExperiments: false, includeKeybindings: false, includePluginSettings: false,
};

describe("selective sync", () => {
  it("preserves current machine fields when applying portable general settings", async () => {
    const { bb, harness, config } = fixture({ ...excluded, includeGeneralSettings: true });
    const machine = {
      managedBranchPrefix: "ivan/", machineServerUrl: "https://machine.example.test",
      machineGitCredentialsEnabled: true, defaultMachineAccess: "full",
      providerCompletedTurnDisplay: { codex: "flat" },
    };
    Object.assign(config.generalSettings, machine);
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true });
      expect(result).toMatchObject({ ok: true, applied: ["Updated BB general settings"], errors: [] });
      expect(config.generalSettings).toMatchObject({ ...machine, showKeyboardHints: false });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("preserves remote plugin settings when the stage excluded them before re-enabling", async () => {
    const { bb, harness } = fixture({ includePluginSettings: false });
    try {
      await plugin(bb);
      await harness.behavior.callRpc("sync_capture", null);
      await harness.behavior.setSettings({ includePluginSettings: true });
      await harness.behavior.callRpc("sync_push", { fresh: false });
      expect(vi.mocked(pushRemotePreset).mock.calls[0]?.[0].preservePluginSettings).toBe(true);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("keeps excluded categories out of previews and pull operations", async () => {
    const { bb, harness, config } = fixture(excluded);
    const before = structuredClone(config);
    try {
      await plugin(bb);
      const status = await harness.behavior.callRpc("sync_status", null) as { pullChanges: unknown[]; pushChanges: unknown[] };
      expect(status.pullChanges).toEqual([]);
      expect(status.pushChanges).toEqual([]);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true });
      expect(result).toMatchObject({ ok: true, applied: [], errors: [] });
      expect(config).toEqual(before);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("applies the selected category while keeping other local preferences", async () => {
    const { bb, harness, config } = fixture({ ...excluded, includeExperiments: true });
    const before = structuredClone(config);
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true });
      expect(result).toMatchObject({ ok: true, applied: ["Updated BB experiments"], errors: [] });
      expect(config).toEqual({ ...before, experiments: { editMessages: true } });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("applies the current selection to a previously staged capture", async () => {
    const { bb, harness } = fixture();
    try {
      await plugin(bb);
      await harness.behavior.callRpc("sync_capture", null);
      await harness.behavior.setSettings(excluded);
      await harness.behavior.callRpc("sync_push", { fresh: false });
      const [options, snapshot] = vi.mocked(pushRemotePreset).mock.calls[0]!;
      expect(options.preservePluginSettings).toBe(true);
      expect(snapshot.settings).toEqual({});
      expect(snapshot.pluginSettings).toEqual([]);
    } finally { await harness.lifecycle.dispose(); }
  });
});
