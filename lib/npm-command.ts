import { stat } from "node:fs/promises";
import { win32 } from "node:path";

export interface NpmCommand {
  command: string;
  args: string[];
}

/** Resolve Windows npm shims to their Node entrypoint without invoking a shell. */
export async function resolveNpmCommand(
  args: string[],
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executable = process.execPath,
): Promise<NpmCommand> {
  if (platform !== "win32") return { command: "npm", args };
  const env = (name: string) => environment[Object.keys(environment).sort().find(key => key.toLowerCase() === name.toLowerCase()) ?? name];
  const expand = (value: string) => value.replace(/%([^%]+)%/g, (match, key: string) => env(key) ?? match);
  const directories = [...new Set([
    ...(env("PATH") ?? "").split(";"),
    env("NVM_SYMLINK") ?? "",
    env("APPDATA") ? win32.join(env("APPDATA")!, "npm") : "",
    win32.basename(executable).toLowerCase() === "node.exe" ? win32.dirname(executable) : "",
  ].map(value => expand(value.trim().replace(/^"(.*)"$/, "$1"))).filter(value => win32.isAbsolute(value)))];
  const exists = async (path: string) => {
    try { return (await stat(path)).isFile(); }
    catch (cause) {
      if (["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) return false;
      throw cause;
    }
  };
  for (const directory of directories) {
    const cli = win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (!await exists(cli)) continue;
    // npm.cmd uses the sibling node.exe when available, then Node from PATH.
    for (const nodeDirectory of [directory, ...directories.filter(value => value !== directory)]) {
      const node = win32.join(nodeDirectory, "node.exe");
      if (await exists(node)) return { command: node, args: [cli, ...args] };
    }
  }
  throw new Error("npm could not be found in BB's Windows environment. If npm works in a terminal, completely restart BB after changing Node.js/nvm or PATH.");
}
