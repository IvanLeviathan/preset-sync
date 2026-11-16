import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { validateBundle, writeBundleDirectory, type LocalPluginBundle } from "./local-plugins";
import { resolveNpmCommand } from "./npm-command";

const DEPENDENCY_TIMEOUT_MS = 180_000;

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Local plugin installation canceled.");
}

async function prepareDependencies(directory: string, signal?: AbortSignal): Promise<void> {
  const lock = await lstat(join(directory, "package-lock.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (lock !== undefined && (lock.isSymbolicLink() || !lock.isFile())) {
    throw new Error("Local plugin package-lock.json must be a regular file.");
  }
  const args = [lock === undefined ? "install" : "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (lock === undefined) args.push("--package-lock=false");
  const launcher = await resolveNpmCommand(args);
  checkCancellation(signal);
  return new Promise((resolveInstall, rejectInstall) => {
    // Dependency output can include registry credentials. Never retain or return it.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launcher.command, launcher.args, {
        cwd: directory,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      rejectInstall(dependencyStartError(error));
      return;
    }
    let stopped: Error | undefined;
    const stop = (error: Error) => {
      if (stopped !== undefined) return;
      stopped = error;
      // Wait for close before deleting the directory so npm cannot write after cleanup.
      child.kill("SIGKILL");
    };
    const onAbort = () => stop(new Error("Local plugin dependency installation canceled."));
    const timer = setTimeout(() => stop(new Error("npm dependency installation timed out after 180 seconds.")), DEPENDENCY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", error => {
      cleanup();
      rejectInstall(stopped ?? dependencyStartError(error));
    });
    child.once("close", code => {
      cleanup();
      if (stopped !== undefined) rejectInstall(stopped);
      else if (code === 0) resolveInstall();
      else rejectInstall(new Error(`npm dependency installation failed (${typeof code === "number" ? `exit code ${code}` : "process terminated"}). Check package dependencies and registry access.`));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function dependencyStartError(error: unknown): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new Error("npm is required to install local plugin dependencies. Install npm and ensure it is available on PATH.");
  }
  return new Error("npm dependency installation failed to start. Ensure npm is installed and executable.");
}

async function ensureInstallationDirectory(directory: string, signal?: AbortSignal): Promise<void> {
  const absolute = resolve(directory);
  let ancestor = parse(absolute).root;
  for (const part of absolute.slice(ancestor.length).split(sep).filter(Boolean)) {
    checkCancellation(signal);
    ancestor = join(ancestor, part);
    let info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) {
      await mkdir(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      info = await lstat(ancestor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Local plugin installation storage and its ancestors must be real directories, without symlinks.");
    }
  }
}

export async function installLocalPlugin(
  bb: BbPluginApi,
  bundle: LocalPluginBundle,
  installationRoot: string,
  current?: { source: string; rootDir: string },
  signal?: AbortSignal,
): Promise<void> {
  checkCancellation(signal);
  if (current !== undefined && !current.source.startsWith("path:")) {
    throw new Error("Cannot replace a non-path plugin registration with local source. The existing plugin was preserved.");
  }
  const validated = validateBundle(bundle);
  const pluginDirectory = join(resolve(installationRoot), validated.id);
  await ensureInstallationDirectory(pluginDirectory, signal);
  checkCancellation(signal);
  const target = await mkdtemp(join(pluginDirectory, `${validated.hash.slice(0, 12)}-`));
  try {
    await writeBundleDirectory(target, validated);
    await prepareDependencies(target, signal);
    checkCancellation(signal);
    // Native path-to-path installation preserves settings when changing the registration.
    await bb.sdk.plugins.install({ source: `path:${target}` });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
