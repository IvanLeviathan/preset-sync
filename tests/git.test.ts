import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readExistingPreset, readRemotePreset, pushRemotePreset } from "../lib/git";
import { writePresetSnapshot, type PresetSnapshot } from "../lib/preset";
import Database from "better-sqlite3";
import { captureLocalPlugin, LocalSourceStore } from "../lib/local-plugins";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("preset repository initialization", () => {
  it("transfers bundled source trees and bootstrap through Git to a fresh source store", async () => {
    const directory=await mkdtemp(join(tmpdir(),"preset-source-git-"));temporaryDirectories.push(directory);
    await execFileAsync("git",["init","--bare",join(directory,"remote.git")]);
    vi.stubEnv("GIT_CONFIG_COUNT","2");
    vi.stubEnv("GIT_CONFIG_KEY_0",`url.file://${directory}/.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0","https://preset-sync.test/");
    vi.stubEnv("GIT_CONFIG_KEY_1","protocol.file.allow");vi.stubEnv("GIT_CONFIG_VALUE_1","always");
    const senderDb=new Database(join(directory,"sender.db"));const receiverDb=new Database(join(directory,"receiver.db"));
    try {
      const sender=new LocalSourceStore(senderDb);const receiver=new LocalSourceStore(receiverDb);
      for (const id of ["demo","preset-sync"]) {
        const source=join(directory,id);await mkdir(source);
        await writeFile(join(source,"package.json"),JSON.stringify({name:`bb-plugin-${id}`,bb:{server:"./server.ts"}}));
        await writeFile(join(source,"server.ts"),`export default function plugin() { /* ${id} */ }\n`);
        // The source must survive nested ignore rules in its own package.
        await writeFile(join(source,".gitignore"),"server.ts\n");
        sender.put(await captureLocalPlugin(id,source));
      }
      const demo=await captureLocalPlugin("demo",join(directory,"demo"));
      const bootstrap=await captureLocalPlugin("preset-sync",join(directory,"preset-sync"));
      const snapshot:PresetSnapshot={schemaVersion:1,capturedAt:"now",bbVersion:"0.41.0",settings:{},plugins:[{id:"demo",install:`bundle:${demo.hash}`,enabled:true}],marketplaces:[],pluginSettings:[],bootstrapSource:`bundle:${bootstrap.hash}`};
      const options={repositoryUrl:"https://preset-sync.test/remote.git",branch:"main",authorName:"Test",authorEmail:"test@example.test",message:"Local source sync",sourceStore:sender};
      expect((await pushRemotePreset(options,snapshot)).pushed).toBe(true);
      vi.stubEnv("GIT_CONFIG_COUNT","3");
      vi.stubEnv("GIT_CONFIG_KEY_2","core.autocrlf");vi.stubEnv("GIT_CONFIG_VALUE_2","true");
      const received=await readRemotePreset({...options,sourceStore:receiver});
      expect(received.snapshot.plugins).toEqual(snapshot.plugins);
      expect(receiver.get("demo",demo.hash)).toEqual(demo);
      expect(receiver.get("preset-sync",bootstrap.hash)).toEqual(bootstrap);
      expect((await pushRemotePreset(options,snapshot)).pushed).toBe(false);
      const off={...snapshot,plugins:[],bootstrapSource:undefined};
      expect((await pushRemotePreset({...options,preserveLocalPlugins:true},off)).pushed).toBe(false);
      expect((await readRemotePreset({...options,sourceStore:receiver})).snapshot.plugins).toEqual(snapshot.plugins);
      expect((await pushRemotePreset(options,off)).pushed).toBe(true);
      const removed=await readRemotePreset({...options,sourceStore:receiver});
      expect(removed.snapshot.plugins).toEqual([]);
      expect(removed.snapshot.bootstrapSource).toBeUndefined();
    }finally{senderDb.close();receiverDb.close();}
  });

  it("previews and initializes an empty repository on the configured branch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-empty-git-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--bare", join(directory, "remote.git")]);
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${directory}/.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://preset-sync.test/");
    vi.stubEnv("GIT_CONFIG_KEY_1", "protocol.file.allow");
    vi.stubEnv("GIT_CONFIG_VALUE_1", "always");
    const options = {
      repositoryUrl: "https://preset-sync.test/remote.git", branch: "chosen-branch",
      authorName: "Test", authorEmail: "test@example.test", message: "Initial selected settings",
    };
    const initial = await readRemotePreset(options);
    expect(initial.head).toBe("");
    expect(initial.snapshot.settings).toEqual({});
    const selected: PresetSnapshot = {
      schemaVersion: 1, capturedAt: "2026-11-16T00:00:00Z", bbVersion: "0.41.0",
      settings: { experiments: { editMessages: true } },
      plugins: [], marketplaces: [], pluginSettings: [],
    };
    expect((await pushRemotePreset(options, selected)).pushed).toBe(true);
    expect((await readRemotePreset(options)).snapshot.settings).toEqual(selected.settings);
    await expect(readRemotePreset({ ...options, branch: "missing-branch" })).rejects.toThrow("Git command failed");
  });

  it("pushes selected settings without replacing excluded remote configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-selective-git-"));
    temporaryDirectories.push(directory);
    const seed = join(directory, "seed");
    const bare = join(directory, "remote.git");
    await execFileAsync("git", ["init", "--bare", bare]);
    await execFileAsync("git", ["init", "-b", "main", seed]);
    const original: PresetSnapshot = {
      schemaVersion: 1, capturedAt: "2026-11-16T00:00:00Z", bbVersion: "0.41.0",
      settings: { appearance: { themeId: "dark", faviconColor: "blue" }, experiments: { editMessages: false } },
      plugins: [], marketplaces: [], pluginSettings: [{ id: "tasks", key: "view", value: "list" }],
    };
    await writePresetSnapshot(seed, original);
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Initial preset"], { cwd: seed });
    await execFileAsync("git", ["push", bare, "main"], { cwd: seed });
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${directory}/.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://preset-sync.test/");
    vi.stubEnv("GIT_CONFIG_KEY_1", "protocol.file.allow");
    vi.stubEnv("GIT_CONFIG_VALUE_1", "always");
    const options = {
      repositoryUrl: "https://preset-sync.test/remote.git", branch: "main",
      authorName: "Test", authorEmail: "test@example.test", message: "Selected settings",
      preservePluginSettings: true,
    };
    const selected = { ...original, settings: { experiments: { editMessages: true } }, pluginSettings: [] };
    expect((await pushRemotePreset(options, selected)).pushed).toBe(true);
    const remote = await readRemotePreset(options);
    expect(remote.snapshot.settings).toEqual({
      appearance: original.settings.appearance, experiments: { editMessages: true },
    });
    expect(remote.snapshot.pluginSettings).toEqual(original.pluginSettings);
    expect((await pushRemotePreset(options, selected)).pushed).toBe(false);
  });

  it("treats a repository with no preset files as uninitialized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sync-git-test-"));
    temporaryDirectories.push(directory);

    await expect(readExistingPreset(directory)).resolves.toBeNull();
  });

  it("refuses to replace a partially initialized preset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sync-git-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "preset"));
    await writeFile(join(directory, "preset", "settings.json"), "{}\n", "utf8");

    await expect(readExistingPreset(directory)).rejects.toThrow(
      "Preset repository is incomplete",
    );
  });
});
