import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { backgroundIntervalMs, installPluginFromPreset } from "../lib/service";

function createHost(
  generalSettings: Record<string, unknown> = {},
  settings: Record<string, string | boolean> = {},
) {
  return createFakePluginHost({
    pluginId: "preset-sync",
    settings,
    sdk: {
      system: {
        config: async () => ({
          generalSettings: {
            defaultProviderId: null,
            providerOrder: [],
            showKeyboardHints: true,
            showUnhandledProviderEvents: false,
            steerActiveThreadOnEnter: true,
            streamerMode: false,
            ...generalSettings,
          },
          experiments: {
            changelogPreview: false,
            editMessages: true,
            mobileApp: false,
            timelineWindowing: false,
          },
          keybindingOverrides: [],
          appearance: { themeId: "default", faviconColor: "default" },
        }),
        version: async () => ({ currentVersion: "0.41.0" }),
      },
      plugins: {
        list: async () => ({
          plugins: [
            {
              id: "preset-sync",
              source: "path:/plugin",
              enabled: true,
              hasSettings: true,
            },
            {
              id: "tasks",
              source: "builtin:tasks",
              enabled: true,
              hasSettings: false,
            },
          ],
        }),
        marketplaces: {
          list: async () => [],
        },
      },
    },
  });
}

describe("plugin registration", () => {
  it("omits disabled categories from captures", async () => {
    const { bb, harness } = createHost({}, {
      includeGeneralSettings: false,
      includeExperiments: false,
      includeKeybindings: false,
      includeAppearance: false,
      includePluginSettings: false,
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.runCli(["capture", "--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const staged = await bb.storage.kv.get<{
        snapshot: { settings: unknown; pluginSettings: unknown };
      }>("staged-preset-v1");
      expect(staged?.snapshot.settings).toEqual({});
      expect(staged?.snapshot.pluginSettings).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("captures portable settings when BB adds general settings", async () => {
    const { bb, harness } = createHost({
      terminalCopyOnSelect: true,
      confirmThreadArchive: true,
      showDiagnosticEvents: false,
      keepHistoryAfterContextClear: true,
      summarizeShellCommands: true,
      providerCompletedTurnDisplay: "collapsed",
      allowFastServiceTier: true,
      telemetryEnabled: false,
      managedBranchPrefix: "ivan/",
      idleProviderSessionTimeoutMinutes: 30,
      machineServerUrl: "https://machine.example.test",
      machineGitCredentialsEnabled: true,
      defaultMachineAccess: "full",
      onboardingCompletedAt: "2026-11-16T00:00:00Z",
      earlyAdopter: true,
      futureSecret: "must-not-be-exported",
    });
    try {
      await plugin(bb);
      const result = await harness.behavior.runCli(["capture", "--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const staged = await bb.storage.kv.get<{
        snapshot: { settings: { generalSettings: unknown } };
      }>("staged-preset-v1");
      expect(staged?.snapshot.settings.generalSettings).toEqual({
        defaultProviderId: null,
        providerOrder: [],
        showKeyboardHints: true,
        showUnhandledProviderEvents: false,
        steerActiveThreadOnEnter: true,
        streamerMode: false,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("registers the preset CLI and stages a secret-safe capture", async () => {
    const { bb, harness } = createHost();
    await plugin(bb);

    expect(harness.inspection.registrations.cli?.name).toBe("preset");
    expect(harness.inspection.registrations.settingsDescriptors.githubToken).toEqual(
      expect.objectContaining({ secret: true }),
    );
    expect(
      harness.inspection.registrations.settingsDescriptors.repositoryUrl,
    ).not.toHaveProperty("default");
    expect(
      harness.inspection.registrations.settingsDescriptors.backgroundCheckInterval,
    ).toEqual(
      expect.objectContaining({
        type: "select",
        default: "5 minutes",
      }),
    );
    expect(harness.inspection.registrations.services.map((service) => service.name)).toEqual([
      "change-check",
    ]);
    await expect(harness.behavior.callRpc("sync_cached_check", null)).resolves.toBeNull();

    const result = await harness.behavior.runCli(["capture", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        pluginCount: 1,
        pluginSettingCount: 0,
        marketplaceCount: 0,
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("parses the supported background check intervals", () => {
    expect(backgroundIntervalMs("Off")).toBeNull();
    expect(backgroundIntervalMs("1 minute")).toBe(60_000);
    expect(backgroundIntervalMs("30 minutes")).toBe(30 * 60_000);
    expect(backgroundIntervalMs("unexpected")).toBe(5 * 60_000);
  });

  it.each(["machine-load", "machine-monitor", "mcp-hub"])(
    "restores official marketplace plugin %s without third-party source confirmation",
    async (entryId) => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "preset-sync",
        sdk: {
          plugins: {
            catalog: {
              installPlan: async () => ({
                kind: "marketplace",
                entryId,
                pluginId: entryId,
                displayName: entryId,
                source: `@get-bb/plugin-${entryId}`,
                marketplace: "bb-community",
                marketplaceDisplayName: "BB Community",
                official: true,
                author: { name: "BB", url: null },
                compatible: true,
                incompatibleReason: null,
                resolvedSource: { kind: "npm", package: `@get-bb/plugin-${entryId}` },
              }),
              install: async () => ({}) as never,
            },
          },
        },
      });

      await installPluginFromPreset(bb, `${entryId}@bb-community`);

      expect(harness.inspection.sdk.callsTo("plugins.install")).toEqual([]);
      expect(harness.inspection.sdk.callsTo("plugins.catalog.install")[0]?.[0]).toEqual({
        entryId,
        marketplace: "bb-community",
      });
      await harness.lifecycle.dispose();
    },
  );

  it("restores third-party marketplace plugins with confirmed catalog sources", async () => {
    const resolvedSource = {
      kind: "git" as const,
      url: "https://github.com/yusuf8834/bb-sidebar.git",
      range: "^0.2.0",
      resolvedCommit: "abc123",
      resolvedTag: "v0.2.4",
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "preset-sync",
      sdk: {
        plugins: {
          install: async () => {
            throw new Error("direct install must not handle catalog shorthand");
          },
          catalog: {
            installPlan: async ({ entryId, marketplace }) => ({
              kind: "marketplace",
              entryId,
              pluginId: entryId,
              displayName: "BB Sidebar",
              source: `${entryId}@${marketplace}`,
              marketplace: marketplace ?? "third-party",
              marketplaceDisplayName: "Third Party",
              official: false,
              author: { name: "Test", url: null },
              compatible: true,
              incompatibleReason: null,
              resolvedSource,
            }),
            install: async () => ({}) as never,
          },
        },
      },
    });

    await installPluginFromPreset(bb, "bb-sidebar@third-party");

    expect(harness.inspection.sdk.callsTo("plugins.install")).toEqual([]);
    expect(harness.inspection.sdk.callsTo("plugins.catalog.installPlan")[0]?.[0]).toEqual({
      entryId: "bb-sidebar",
      marketplace: "third-party",
      signal: undefined,
    });
    expect(harness.inspection.sdk.callsTo("plugins.catalog.install")[0]?.[0]).toEqual({
      entryId: "bb-sidebar",
      marketplace: "third-party",
      confirmedSource: resolvedSource,
    });
    await harness.lifecycle.dispose();
  });

  it("keeps direct Git sources on the direct install API", async () => {
    const source = "git:https://github.com/example/plugin.git@main";
    const { bb, harness } = createFakePluginHost({
      pluginId: "preset-sync",
      sdk: {
        plugins: {
          install: async () => ({}) as never,
        },
      },
    });

    await installPluginFromPreset(bb, source);

    expect(harness.inspection.sdk.callsTo("plugins.install")[0]?.[0]).toEqual({
      source,
    });
    expect(harness.inspection.sdk.callsTo("plugins.catalog.installPlan")).toEqual([]);
    expect(harness.inspection.sdk.callsTo("plugins.catalog.install")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("explains how to configure a repository before remote operations", async () => {
    const { bb, harness } = createHost();
    await plugin(bb);

    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Preset repository is not configured");

    await harness.lifecycle.dispose();
  });

  it("uses only the public plugin SDK", () => {
    const scan = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^@\//,
        /^react(?:-dom)?(?:\/.*)?$/,
        /^@radix-ui\/react-(?:checkbox|dialog|slot)$/,
        /^@hugeicons\/(?:core-free-icons|react)$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
        /^@testing-library\/react$/,
        /^vitest(?:\/.*)?$/,
        // Native SQLite is a declared test peer; production uses bb.storage.database().
        /^better-sqlite3$/,
      ],
    });
    expect(scan.privateDependencies).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});
