import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { installLocalPlugin } from "../lib/install-local-plugin";
import type { LocalPluginBundle } from "../lib/local-plugins";

const { spawn, resolveNpmCommand } = vi.hoisted(() => ({ spawn: vi.fn(), resolveNpmCommand: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../lib/npm-command",()=>({resolveNpmCommand}));

let root: string;
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
let finish: () => void;
let registered: string[];
let bb: BbPluginApi;
let bundle: LocalPluginBundle;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "preset-local-install-"));
  registered = [];
  bb = { sdk: { plugins: { install: async ({ source }: { source: string }) => { registered.push(source); } } } } as unknown as BbPluginApi;
  bundle = {
    id: "example", hash: "a".repeat(64),
    files: [{ path: "package.json", content: Buffer.from(JSON.stringify({ name: "bb-plugin-example", version: "1.0.0", bb: { server: "./server.ts" } })).toString("base64"), executable: false },
      { path: "server.ts", content: Buffer.from("export default () => {};").toString("base64"), executable: false }],
  };
  bundle.hash = createHash("sha256").update(JSON.stringify(bundle.files)).digest("hex");
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); return true; }) });
  finish = () => { queueMicrotask(() => child.emit("close", 0)); };
  spawn.mockReset().mockImplementation(() => { finish(); return child; });
  resolveNpmCommand.mockReset().mockImplementation(async(args:string[])=>({command:"npm",args}));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function versions() {
  return readdir(join(root, "installed", "example")).catch(() => []);
}

async function oldSource() {
  const old = join(root, "installed", "example", "old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "sentinel"), "keep");
  return { source: `path:${old}`, rootDir: old };
}

describe("local plugin installation", () => {
  it.each([false,true])("launches a resolved Windows Node/npm entrypoint without a shell (lockfile: %s)",async withLock=>{
    if(withLock){
      bundle.files.unshift({path:"package-lock.json",content:Buffer.from("{}").toString("base64"),executable:false});
      bundle.hash=createHash("sha256").update(JSON.stringify(bundle.files)).digest("hex");
    }
    const node=String.raw`C:\Program Files\nodejs\node.exe`;
    const cli=String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
    resolveNpmCommand.mockImplementationOnce(async(args:string[])=>({command:node,args:[cli,...args]}));
    await installLocalPlugin(bb,bundle,join(root,"installed"));
    const args=withLock
      ? [cli,"ci","--include=dev","--ignore-scripts","--no-audit","--no-fund"]
      : [cli,"install","--include=dev","--ignore-scripts","--no-audit","--no-fund","--package-lock=false"];
    expect(spawn).toHaveBeenCalledWith(node,args,expect.objectContaining({shell:false,windowsHide:true}));
    expect(registered).toHaveLength(1);
  });

  it("materializes a fresh version and registers it only after dependencies succeed", async () => {
    finish = () => { queueMicrotask(() => { expect(registered).toEqual([]); child.emit("close", 0); }); };
    await installLocalPlugin(bb, bundle, join(root, "installed"));
    expect(registered).toHaveLength(1);
    const target = registered[0].slice(5);
    expect(target.startsWith(join(root, "installed", "example") + "/")).toBe(true);
    expect(await readFile(join(target, "server.ts"), "utf8")).toBe("export default () => {};");
    expect(spawn).toHaveBeenCalledWith("npm", ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], expect.objectContaining({ cwd: target, shell: false }));
  });

  it("uses npm ci with a captured lockfile and preserves captured source bytes", async () => {
    const lock = JSON.stringify({ name: "bb-plugin-example", version: "1.0.0", lockfileVersion: 3, packages: {} });
    bundle.files.unshift({ path: "package-lock.json", content: Buffer.from(lock).toString("base64"), executable: false });
    bundle.hash = createHash("sha256").update(JSON.stringify(bundle.files)).digest("hex");
    await installLocalPlugin(bb, bundle, join(root, "installed"));
    const target = registered[0].slice(5);
    expect(spawn).toHaveBeenCalledWith("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], expect.objectContaining({ cwd: target, shell: false }));
    expect(await readFile(join(target, "package-lock.json"), "utf8")).toBe(lock);
    for (const file of bundle.files) {
      expect(await readFile(join(target, file.path))).toEqual(Buffer.from(file.content, "base64"));
    }
  });

  it("does not create a lockfile when the captured source has none", async () => {
    await installLocalPlugin(bb, bundle, join(root, "installed"));
    const target = registered[0].slice(5);
    expect(await readdir(target)).toEqual(["package.json", "server.ts"]);
    for (const file of bundle.files) {
      expect(await readFile(join(target, file.path))).toEqual(Buffer.from(file.content, "base64"));
    }
    expect(spawn.mock.calls[0][1]).toContain("--package-lock=false");
  });

  it.each(["", "/nested/parent"])("rejects a symlink in installation storage before writing (%s)", async suffix => {
    const external = join(root, "external");
    await mkdir(external);
    const alias = join(root, "alias");
    await symlink(external, alias);
    await expect(installLocalPlugin(bb, bundle, alias + suffix)).rejects.toThrow(/directory|symlink/i);
    expect(await readdir(external)).toEqual([]);
    expect(registered).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves the old source and uses distinct directories on every installation", async () => {
    const current = await oldSource();
    await installLocalPlugin(bb, bundle, join(root, "installed"), current);
    await installLocalPlugin(bb, bundle, join(root, "installed"), current);
    expect(new Set(registered).size).toBe(2);
    expect(await readFile(join(current.rootDir, "sentinel"), "utf8")).toBe("keep");
    expect(await versions()).toHaveLength(3);
  });

  it("refuses non-path registrations without touching files or registration", async () => {
    await expect(installLocalPlugin(bb, bundle, join(root, "installed"), { source: "git:https://example.test/plugin", rootDir: root })).rejects.toThrow(/path/i);
    expect(registered).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(await versions()).toEqual([]);
  });

  it("cleans only the new version when dependencies fail and bounds sanitized errors", async () => {
    const current = await oldSource();
    finish = () => { queueMicrotask(() => { child.stderr.emit("data", Buffer.from("\x1b[31mhttps://user:secret@example.test/?token=hidden npm_TOKEN=hidden\n" + "x".repeat(20_000))); child.emit("close", 1); }); };
    const error = await installLocalPlugin(bb, bundle, join(root, "installed"), current).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/npm.*failed/i);
    expect(String(error)).not.toMatch(/secret|hidden|\x1b/);
    expect(String(error).length).toBeLessThan(5000);
    expect(registered).toEqual([]);
    expect(await versions()).toEqual(["old"]);
    expect(await readFile(join(current.rootDir, "sentinel"), "utf8")).toBe("keep");
  });

  it("cleans the new version if native registration fails", async () => {
    const current = await oldSource();
    bb.sdk.plugins.install = async () => { throw new Error("native install failed"); };
    await expect(installLocalPlugin(bb, bundle, join(root, "installed"), current)).rejects.toThrow("native install failed");
    expect(await versions()).toEqual(["old"]);
  });

  it("reports npm as a prerequisite when unavailable", async () => {
    finish = () => { queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }))); };
    await expect(installLocalPlugin(bb, bundle, join(root, "installed"))).rejects.toThrow(/npm.*(?:required|install|available)/i);
    expect(await versions()).toEqual([]);
  });

  it("rejects pre-canceled installs before creating a version", async () => {
    await expect(installLocalPlugin(bb, bundle, join(root, "installed"), undefined, AbortSignal.abort())).rejects.toThrow(/abort|cancel/i);
    expect(await versions()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills npm on cancellation and retains the existing version", async () => {
    const current = await oldSource();
    const controller = new AbortController();
    finish = () => { queueMicrotask(() => controller.abort()); };
    await expect(installLocalPlugin(bb, bundle, join(root, "installed"), current, controller.signal)).rejects.toThrow(/abort|cancel/i);
    expect(child.kill).toHaveBeenCalled();
    expect(await versions()).toEqual(["old"]);
    expect(registered).toEqual([]);
  });

  it("kills dependency installation after at most 180 seconds", async () => {
    const current = await oldSource();
    finish = () => { vi.useFakeTimers(); queueMicrotask(() => { void vi.advanceTimersByTimeAsync(180_000); }); };
    await expect(installLocalPlugin(bb, bundle, join(root, "installed"), current)).rejects.toThrow(/timed out|timeout/i);
    expect(child.kill).toHaveBeenCalled();
    expect(await versions()).toEqual(["old"]);
    expect(registered).toEqual([]);
  });
});
