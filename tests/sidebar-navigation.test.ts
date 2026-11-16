import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { readRemotePreset, pushRemotePreset } from "../lib/git";
import {
  buildPullPlan, buildPushChanges, mergePresetForPush, presetSnapshotSchema,
  readPresetSnapshot, writePresetSnapshot, type PresetSnapshot,
} from "../lib/preset";

vi.mock("../lib/git", () => ({
  readRemotePreset: vi.fn(),
  pushRemotePreset: vi.fn(async () => ({ pushed: false, head: "abc", changedFiles: [] })),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const localNavigation = { order: ["tasks/tasks", "github/github"], visible: ["tasks/tasks"] };
const remoteNavigation = { order: ["github/github", "tasks/tasks"], visible: ["github/github"] };
function snapshot(sidebarNavigation?: typeof localNavigation | { order: string[]; visible: null }): PresetSnapshot {
  return {
    schemaVersion: 1, capturedAt: "now", bbVersion: "0.41.0",
    settings: sidebarNavigation === undefined ? {} : { sidebarNavigation },
    plugins: [], marketplaces: [], pluginSettings: [],
  };
}

function fixture(settings: Record<string, boolean> = {}, remote = snapshot(remoteNavigation)) {
  const preferences = {
    "sidebar.pluginPanelOrder": { revision: 13, value: [...localNavigation.order] },
    "sidebar.visiblePluginPanels": { revision: 7, value: [...localNavigation.visible] as string[] | null },
    "sidebar.footerOrder": { revision: 2, value: ["builtin:mobile", "builtin:report-bug"] },
    "sidebar.hiddenFooterItems": { revision: 5, value: ["builtin:report-bug"] },
  };
  vi.mocked(readRemotePreset).mockResolvedValue({ snapshot: remote, head: "abc" });
  const host = createFakePluginHost({
    pluginId: "preset-sync",
    settings: {
      repositoryUrl: "https://example.test/preset.git", includeGeneralSettings: false,
      includeAppearance: false, includeExperiments: false, includeKeybindings: false,
      includePluginSettings: false, includeLocalPlugins: false, includeSidebarFooter: false, ...settings,
    },
    sdk: {
      system: {
        config: async () => ({
          generalSettings: {
            defaultProviderId: null, providerOrder: [], showKeyboardHints: true,
            showUnhandledProviderEvents: false, steerActiveThreadOnEnter: true, streamerMode: false,
          },
          experiments: {}, keybindingOverrides: [],
          appearance: { themeId: "default", faviconColor: "default" },
        }),
        version: async () => ({ currentVersion: "0.41.0" }),
        uiPreferences: {
          list: async () => structuredClone({ preferences }),
          set: async ({ key, expectedRevision, value }) => {
            const entry = preferences[key as keyof typeof preferences];
            if (entry.revision !== expectedRevision) throw new Error("revision conflict");
            entry.value = value as string[] | null;
            entry.revision++;
            return { key, ...entry };
          },
        },
      },
      plugins: { list: async () => ({ plugins: [] }), marketplaces: { list: async () => [] } },
    },
  });
  return { ...host, preferences };
}

async function stagedSnapshot(bb: ReturnType<typeof fixture>["bb"]) {
  return (await bb.storage.kv.get<{ snapshot: PresetSnapshot }>("staged-preset-v1"))!.snapshot;
}

describe("sidebar navigation sync", () => {
  it.each([
    { order: ["github/github", "tasks/tasks"], visible: [] },
    { order: [], visible: null },
  ])("round-trips navigation without losing order or visibility defaults: %j", async navigation => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sidebar-"));
    directories.push(directory);
    await writePresetSnapshot(directory, snapshot(navigation));
    expect((await readPresetSnapshot(directory)).settings).toEqual({ sidebarNavigation: navigation });
  });

  it("validates navigation values at the preset boundary", () => {
    expect(presetSnapshotSchema.safeParse(snapshot({ order: [], visible: null })).success).toBe(true);
    const invalid = { ...snapshot(), settings: { sidebarNavigation: { order: [false], visible: "all" } } };
    expect(presetSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("previews navigation changes in both directions", () => {
    const local = snapshot(localNavigation), remote = snapshot(remoteNavigation);
    expect(buildPullPlan({ repository: "test", branch: "main", remoteHead: "abc", local, remote }).changes)
      .toEqual([expect.objectContaining({ kind: "sidebar-navigation", risk: "configuration" })]);
    expect(buildPushChanges(local, remote))
      .toEqual([expect.objectContaining({ kind: "sidebar-navigation", risk: "configuration" })]);
  });

  it("captures only navigation values, leaving revisions and unrelated preferences local", async () => {
    const { bb, harness } = fixture();
    try {
      await plugin(bb);
      await harness.behavior.callRpc("sync_capture", null);
      expect((await stagedSnapshot(bb)).settings).toEqual({ sidebarNavigation: localNavigation });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("preserves remote navigation when excluded from a push", () => {
    expect(mergePresetForPush(snapshot(remoteNavigation), snapshot(), false).settings)
      .toEqual({ sidebarNavigation: remoteNavigation });
    expect(mergePresetForPush(snapshot(remoteNavigation), snapshot(localNavigation), false).settings)
      .toEqual({ sidebarNavigation: localNavigation });
  });

  it.each([{ visible: null }, { visible: [] }])("applies explicit default or empty visibility: %j", async ({ visible }) => {
    const { bb, harness, preferences } = fixture({}, snapshot({ order: [], visible }));
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, errors: [] });
      expect(preferences["sidebar.pluginPanelOrder"].value).toEqual([]);
      expect(preferences["sidebar.visiblePluginPanels"].value).toEqual(visible);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("applies remote order and visibility using current revisions", async () => {
    const { bb, harness, preferences } = fixture();
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true });
      expect(result).toMatchObject({ ok: true, errors: [] });
      expect(preferences).toEqual({
        "sidebar.pluginPanelOrder": { revision: 14, value: remoteNavigation.order },
        "sidebar.visiblePluginPanels": { revision: 8, value: remoteNavigation.visible },
        "sidebar.footerOrder": { revision: 2, value: ["builtin:mobile", "builtin:report-bug"] },
    "sidebar.hiddenFooterItems": { revision: 5, value: ["builtin:report-bug"] },
      });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("keeps navigation when pulling an older preset and avoids redundant writes", async () => {
    const { bb, harness, preferences } = fixture({}, snapshot());
    const before = structuredClone(preferences);
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, applied: [] });
      expect(preferences).toEqual(before);
      vi.mocked(readRemotePreset).mockResolvedValue({ snapshot: snapshot(localNavigation), head: "abc" });
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, applied: [] });
      expect(preferences).toEqual(before);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("excludes navigation from capture, previews, pull, and previously staged pushes when disabled", async () => {
    const { bb, harness, preferences } = fixture();
    const before = structuredClone(preferences);
    try {
      await plugin(bb);
      await harness.behavior.callRpc("sync_capture", null);
      await harness.behavior.setSettings({ includeSidebarNavigation: false });
      expect(await harness.behavior.callRpc("sync_status", null)).toMatchObject({ pullChanges: [], pushChanges: [] });
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, applied: [] });
      expect(preferences).toEqual(before);
      await harness.behavior.callRpc("sync_push", { fresh: false });
      expect(vi.mocked(pushRemotePreset).mock.calls[0]?.[1].settings).toEqual({});
      await harness.behavior.callRpc("sync_capture", null);
      expect((await stagedSnapshot(bb)).settings).toEqual({});
      // Reading the disabled category is unnecessary and must not block the other categories.
      harness.sdk.stub("system.uiPreferences.list", async () => { throw new Error("unavailable"); });
      await harness.behavior.callRpc("sync_capture", null);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("reports revision conflicts and preserves concurrent edits", async () => {
    const { bb, harness, preferences } = fixture();
    harness.sdk.stub("system.uiPreferences.set", async () => {
      preferences["sidebar.pluginPanelOrder"] = { revision: 14, value: ["concurrent/edit"] };
      throw new Error("revision conflict");
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true }) as { ok: boolean; errors: string[] };
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("revision conflict");
      expect(preferences["sidebar.pluginPanelOrder"].value).toEqual(["concurrent/edit"]);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("preserves navigation edited after capture while other pull changes are applying", async () => {
    const remote = snapshot(remoteNavigation);
    remote.settings.generalSettings = {
      defaultProviderId: null, providerOrder: [], showKeyboardHints: false,
      showUnhandledProviderEvents: false, steerActiveThreadOnEnter: true, streamerMode: false,
    };
    const { bb, harness, preferences } = fixture({ includeGeneralSettings: true }, remote);
    harness.sdk.stub("system.updateGeneralSettings", async settings => {
      preferences["sidebar.pluginPanelOrder"] = { revision: 14, value: ["concurrent/edit"] };
      return settings;
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true }) as { ok: boolean; errors: string[] };
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("revision conflict");
      expect(preferences["sidebar.pluginPanelOrder"].value).toEqual(["concurrent/edit"]);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("reports successful order changes when a later visibility write conflicts", async () => {
    const { bb, harness, preferences } = fixture();
    harness.sdk.stub("system.uiPreferences.set", async ({ key, value, expectedRevision }) => {
      if (key === "sidebar.visiblePluginPanels") throw new Error("visibility revision conflict");
      expect(expectedRevision).toBe(13);
      preferences["sidebar.pluginPanelOrder"] = { revision: 14, value };
      return { key, revision: 14, value };
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true }) as { ok: boolean; applied: string[]; errors: string[] };
      expect(result.ok).toBe(false);
      expect(result.applied).toEqual(["Updated sidebar navigation order"]);
      expect(result.errors.join(" ")).toContain("visibility revision conflict");
      expect(preferences["sidebar.pluginPanelOrder"].value).toEqual(remoteNavigation.order);
      expect(preferences["sidebar.visiblePluginPanels"].value).toEqual(localNavigation.visible);
    } finally { await harness.lifecycle.dispose(); }
  });
});

const localFooter = { order: ["builtin:mobile", "builtin:report-bug"], hidden: ["builtin:report-bug"] };
const remoteFooter = { order: ["builtin:report-bug", "builtin:mobile"], hidden: ["builtin:mobile"] };
function footerSnapshot(sidebarFooter?: typeof localFooter): PresetSnapshot {
  return { ...snapshot(), settings: sidebarFooter === undefined ? {} : { sidebarFooter } };
}
function footerFixture(settings: Record<string, boolean> = {}, remote = footerSnapshot(remoteFooter)) {
  return fixture({ includeSidebarNavigation: false, includeSidebarFooter: true, ...settings }, remote);
}

describe("sidebar footer sync", () => {
  it.each([remoteFooter, { order: [], hidden: [] }])("round-trips footer arrangement: %j", async footer => {
    const directory = await mkdtemp(join(tmpdir(), "preset-footer-"));
    directories.push(directory);
    await writePresetSnapshot(directory, footerSnapshot(footer));
    expect((await readPresetSnapshot(directory)).settings).toEqual({ sidebarFooter: footer });
  });

  it("previews footer changes in both directions and preserves an excluded remote footer", () => {
    const local = footerSnapshot(localFooter), remote = footerSnapshot(remoteFooter);
    expect(buildPullPlan({ repository: "test", branch: "main", remoteHead: "abc", local, remote }).changes)
      .toEqual([expect.objectContaining({ kind: "sidebar-footer", risk: "configuration" })]);
    expect(buildPushChanges(local, remote))
      .toEqual([expect.objectContaining({ kind: "sidebar-footer", risk: "configuration" })]);
    expect(mergePresetForPush(remote, snapshot(), false).settings).toEqual({ sidebarFooter: remoteFooter });
  });

  it("captures footer independently from navigation without revisions or unrelated preferences", async () => {
    const { bb, harness } = footerFixture();
    try {
      await plugin(bb);
      await harness.behavior.callRpc("sync_capture", null);
      expect((await stagedSnapshot(bb)).settings).toEqual({ sidebarFooter: localFooter });
    } finally { await harness.lifecycle.dispose(); }
  });

  it.each([remoteFooter, { order: [], hidden: [] }])("applies footer order and hidden items: %j", async footer => {
    const { bb, harness, preferences } = footerFixture({}, footerSnapshot(footer));
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, errors: [] });
      expect(preferences["sidebar.footerOrder"]).toEqual({ revision: 3, value: footer.order });
      expect(preferences["sidebar.hiddenFooterItems"]).toEqual({ revision: 6, value: footer.hidden });
      expect(preferences["sidebar.pluginPanelOrder"]).toEqual({ revision: 13, value: localNavigation.order });
      expect(preferences["sidebar.visiblePluginPanels"]).toEqual({ revision: 7, value: localNavigation.visible });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("preserves the footer for older presets and avoids redundant writes", async () => {
    const { bb, harness, preferences } = footerFixture({}, snapshot());
    const before = structuredClone(preferences);
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, applied: [] });
      vi.mocked(readRemotePreset).mockResolvedValue({ snapshot: footerSnapshot(localFooter), head: "abc" });
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, applied: [] });
      expect(preferences).toEqual(before);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("excludes the footer from staged pushes, previews, pull and new captures when disabled", async () => {
    const { bb, harness, preferences } = footerFixture();
    const before = structuredClone(preferences);
    try {
      await plugin(bb);
      await harness.behavior.callRpc("sync_capture", null);
      await harness.behavior.setSettings({ includeSidebarFooter: false });
      expect(await harness.behavior.callRpc("sync_status", null)).toMatchObject({ pullChanges: [], pushChanges: [] });
      expect(await harness.behavior.callRpc("sync_pull", { confirmed: true })).toMatchObject({ ok: true, applied: [] });
      expect(preferences).toEqual(before);
      await harness.behavior.callRpc("sync_push", { fresh: false });
      expect(vi.mocked(pushRemotePreset).mock.calls[0]?.[1].settings).toEqual({});
      harness.sdk.stub("system.uiPreferences.list", async () => { throw new Error("unavailable"); });
      await harness.behavior.callRpc("sync_capture", null);
      expect((await stagedSnapshot(bb)).settings).toEqual({});
    } finally { await harness.lifecycle.dispose(); }
  });

  it("keeps edits made during pull and reports partial footer application", async () => {
    const remote = footerSnapshot(remoteFooter);
    remote.settings.generalSettings = {
      defaultProviderId: null, providerOrder: [], showKeyboardHints: false,
      showUnhandledProviderEvents: false, steerActiveThreadOnEnter: true, streamerMode: false,
    };
    const { bb, harness, preferences } = footerFixture({ includeGeneralSettings: true }, remote);
    harness.sdk.stub("system.updateGeneralSettings", async settings => {
      preferences["sidebar.hiddenFooterItems"] = { revision: 6, value: ["concurrent/edit"] };
      return settings;
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.callRpc("sync_pull", { confirmed: true }) as { ok: boolean; applied: string[]; errors: string[] };
      expect(result.ok).toBe(false);
      expect(result.applied).toContain("Updated sidebar footer order");
      expect(result.errors.join(" ")).toContain("revision conflict");
      expect(preferences["sidebar.footerOrder"].value).toEqual(remoteFooter.order);
      expect(preferences["sidebar.hiddenFooterItems"].value).toEqual(["concurrent/edit"]);
    } finally { await harness.lifecycle.dispose(); }
  });
});
