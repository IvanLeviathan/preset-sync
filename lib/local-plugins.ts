import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const ignoredDirectories = new Set(["node_modules", "dist", "coverage", "logs", "secrets", "data", "runtime", "tmp", "temp", "vendor"]);
const ignoredNames = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|auth\.json)$/i;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".md", ".txt", ".html", ".yaml", ".yml", ".sh"]);
const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const credentials = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/;

const fileSchema = z.object({ path: z.string().min(1).max(512), content: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4), executable: z.boolean() }).strict();
const bundleSchema = z.object({ id: z.string().regex(idPattern), hash: z.string().regex(hashPattern), files: z.array(fileSchema).min(1).max(MAX_FILES) }).strict();
export type LocalPluginBundle = z.infer<typeof bundleSchema>;
export type BundleFile = LocalPluginBundle["files"][number];

export function bundleHash(source: string): string | null {
  return /^bundle:([a-f0-9]{64})$/.exec(source)?.[1] ?? null;
}

function allowedPath(path: string): boolean {
  const parts = path.split("/");
  if (path.includes("\\") || parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) return false;
  if (parts.some(part => (part.startsWith(".") && part !== ".gitignore") || ignoredDirectories.has(part.toLowerCase()) || ignoredNames.test(part))) return false;
  const name = parts.at(-1)!;
  return name === ".gitignore" || name === "LICENSE" || name === "NOTICE" || sourceExtensions.has(extname(name).toLowerCase());
}

export function hashBundleFiles(files: BundleFile[]): string {
  const normalized = [...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({path,content,executable}) => ({path,content,executable}));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function validateManifest(id: string, files: BundleFile[]): void {
  const manifestFile = files.find(file => file.path === "package.json");
  if (!manifestFile) throw new Error(`Local plugin ${id} has no package.json.`);
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(Buffer.from(manifestFile.content,"base64").toString("utf8")); }
  catch { throw new Error(`Local plugin ${id} has invalid package.json.`); }
  if (manifest === null || typeof manifest !== "object" || typeof manifest.name !== "string") throw new Error(`Local plugin ${id} has an invalid package name.`);
  const derived = manifest.name.split("/").at(-1)!.replace(/^bb-plugin-/, "").toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/^-+|-+$/g,"");
  if (derived !== id) throw new Error(`Local plugin identity does not match ${id}.`);
  const bb = manifest.bb as Record<string, unknown> | undefined;
  if (!bb || typeof bb !== "object" || typeof bb.server !== "string") throw new Error(`Local plugin ${id} has no BB server entry.`);
  for (const key of ["server","app","host"]) {
    const entry = bb[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !allowedPath(entry.replace(/^\.\//,"")) || !files.some(file => file.path === entry.replace(/^\.\//,""))) throw new Error(`Local plugin ${id} has a non-portable or missing ${key} entry.`);
  }
  for (const file of files.filter(file => file.path === "package.json" || file.path === "package-lock.json")) {
    const text = Buffer.from(file.content,"base64").toString("utf8");
    if (/"(?:file:|link:|workspace:|git\+file:)|https?:\/\/[^\s"/]*@|ssh:\/\/[^\s"/]*:[^\s"/]*@/i.test(text)) throw new Error(`Local plugin ${id} has non-portable dependencies or embedded credentials.`);
  }
  for (const group of ["dependencies","devDependencies","optionalDependencies","peerDependencies"]) {
    const dependencies = manifest[group];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const version of Object.values(dependencies)) {
      if (typeof version !== "string" || /^(?:[./]|~[\\/]|[a-z]:[\\/]|file:|link:|workspace:|git\+file:)/i.test(version)) throw new Error(`Local plugin ${id} has non-portable local dependencies.`);
    }
  }
}

export function validateBundle(value: unknown): LocalPluginBundle {
  const bundle = bundleSchema.parse(value);
  let bytes = 0;
  const seen = new Set<string>();
  const folded = new Set<string>();
  for (const file of bundle.files) {
    if (!allowedPath(file.path) || seen.has(file.path) || folded.has(file.path.toLowerCase())) throw new Error(`Unsafe or duplicate local plugin path: ${file.path}`);
    seen.add(file.path); folded.add(file.path.toLowerCase());
    const decoded = Buffer.from(file.content,"base64");
    if (decoded.toString("base64") !== file.content) throw new Error(`Invalid base64 in ${file.path}.`);
    bytes += decoded.length;
    if (decoded.length > MAX_FILE_BYTES || bytes > MAX_BUNDLE_BYTES) throw new Error("Local plugin source exceeds the size limit.");
    if (credentials.test(decoded.toString("utf8"))) throw new Error(`Credential-like content in local plugin file ${file.path}; source was not captured.`);
  }
  if (hashBundleFiles(bundle.files) !== bundle.hash) throw new Error(`Local plugin ${bundle.id} source hash mismatch.`);
  validateManifest(bundle.id,bundle.files);
  return bundle;
}

async function directory(path: string): Promise<void> {
  try { await mkdir(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Local plugin path is a symbolic link: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Local plugin path is not a directory: ${path}`);
}

export async function captureLocalPlugin(id: string, root: string): Promise<LocalPluginBundle> {
  if (!idPattern.test(id)) throw new Error("Invalid local plugin id.");
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Local plugin root is a symbolic link or not a directory: ${id}`);
  const files: BundleFile[] = [];
  let bytes = 0;
  let entries = 0;
  async function visit(relative: string): Promise<void> {
    for (const item of (await readdir(join(root,relative),{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      if ((item.name.startsWith(".") && item.name !== ".gitignore") || ignoredDirectories.has(item.name.toLowerCase()) || ignoredNames.test(item.name)) continue;
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (++entries > MAX_FILES * 4 || path.length > 512) throw new Error("Local plugin source exceeds the path/entry limit.");
      const full = join(root,path);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Local plugin contains a symbolic link: ${path}`);
      if (info.isDirectory()) { await visit(path); continue; }
      if (!info.isFile() || !allowedPath(path)) continue;
      if (info.nlink !== 1 || info.size > MAX_FILE_BYTES || files.length >= MAX_FILES || bytes + info.size > MAX_BUNDLE_BYTES) throw new Error(`Local plugin file is hard-linked or exceeds source limits: ${path}`);
      const handle = await open(full,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.nlink !== 1 || actual.size > MAX_FILE_BYTES) throw new Error(`Unsafe local plugin file: ${path}`);
        const data = await handle.readFile();
        bytes += data.length;
        if (data.length > MAX_FILE_BYTES || bytes > MAX_BUNDLE_BYTES) throw new Error("Local plugin source exceeds the size limit.");
        files.push({path,content:data.toString("base64"),executable:(actual.mode & 0o111) !== 0});
      } finally { await handle.close(); }
    }
  }
  await visit("");
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return validateBundle({id,hash:hashBundleFiles(files),files});
}

export async function writeBundleDirectory(root: string, raw: LocalPluginBundle): Promise<void> {
  const bundle = validateBundle(raw);
  await directory(root);
  for (const file of bundle.files) {
    const parts = file.path.split("/");
    let parent = root;
    for (const part of parts.slice(0,-1)) { parent = join(parent,part); await directory(parent); }
    const destination = join(parent,parts.at(-1)!);
    try { const info = await lstat(destination); if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error(`Local plugin destination is a symbolic link or unsafe file: ${file.path}`); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    const handle = await open(destination,constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,0o600);
    try { await handle.writeFile(Buffer.from(file.content,"base64")); await handle.chmod(file.executable ? 0o755 : 0o644); }
    finally { await handle.close(); }
  }
}

export class LocalSourceStore {
  readonly installationRoot: string;
  constructor(private readonly db: ReturnType<BbPluginApi["storage"]["database"]>) {
    db.exec("CREATE TABLE IF NOT EXISTS preset_local_sources (hash TEXT PRIMARY KEY NOT NULL, bundle TEXT NOT NULL)");
    this.installationRoot = join(dirname(db.name),"local-plugin-installs");
  }
  put(raw: LocalPluginBundle): void {
    const bundle = validateBundle(raw);
    this.db.prepare("INSERT OR IGNORE INTO preset_local_sources(hash,bundle) VALUES (?,?)").run(bundle.hash,JSON.stringify(bundle));
  }
  get(id: string, hash: string): LocalPluginBundle {
    if (!idPattern.test(id) || !hashPattern.test(hash)) throw new Error("Invalid local plugin source reference.");
    const row = this.db.prepare("SELECT bundle FROM preset_local_sources WHERE hash=?").get(hash) as {bundle:string} | undefined;
    if (!row) throw new Error(`Staged source for ${id} is unavailable; capture this machine again.`);
    const bundle = validateBundle(JSON.parse(row.bundle));
    if (bundle.id !== id || bundle.hash !== hash) throw new Error("Local plugin source identity/hash mismatch.");
    return bundle;
  }
}

type Reference = {id:string;install:string};
function references(entries: Reference[], bootstrapSource?: string): Reference[] {
  return [...entries.filter(entry => bundleHash(entry.install) !== null), ...(bootstrapSource ? [{id:"preset-sync",install:bootstrapSource}] : [])];
}

export async function writeRepositoryBundles(repo: string, entries: Reference[], store?: LocalSourceStore, bootstrapSource?: string): Promise<void> {
  const refs = references(entries,bootstrapSource);
  if (refs.length && !store) throw new Error("Local plugin source store is required.");
  await directory(resolve(repo)); await directory(join(repo,"preset"));
  const base = join(repo,"preset","local-plugins");
  await directory(base);
  // This directory contains only source trees managed by Preset Sync.
  await rm(base,{recursive:true,force:true}); await directory(base);
  const attributes = await open(join(base,".gitattributes"),constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o644);
  try {
    // Keep source hashes stable across Git autocrlf settings and external clean/smudge filters.
    await attributes.writeFile("* -text -filter\n");
  } finally { await attributes.close(); }
  for (const entry of refs) {
    const bundle = store!.get(entry.id,bundleHash(entry.install)!);
    const target = join(base,bundle.id);
    await directory(target); await writeBundleDirectory(target,bundle);
  }
}

export async function readRepositoryBundles(repo: string, entries: Reference[], store?: LocalSourceStore, bootstrapSource?: string): Promise<void> {
  const refs = references(entries,bootstrapSource);
  if (!refs.length) return;
  if (!store) throw new Error("This preset contains local plugins; use a Preset Sync version with local source support.");
  for (const part of [resolve(repo),join(repo,"preset"),join(repo,"preset","local-plugins")]) {
    const stat = await lstat(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Local plugin repository path is a symbolic link or not a directory.");
  }
  for (const entry of refs) {
    if (!idPattern.test(entry.id)) throw new Error("Invalid local plugin id.");
    const bundle = await captureLocalPlugin(entry.id,join(repo,"preset","local-plugins",entry.id));
    if (bundle.hash !== bundleHash(entry.install)) throw new Error(`Local plugin ${entry.id} source hash mismatch.`);
    store.put(bundle);
  }
}
