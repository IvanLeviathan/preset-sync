import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureLocalPlugin, validateBundle, hashBundleFiles, writeBundleDirectory,
  LocalSourceStore, writeRepositoryBundles, readRepositoryBundles,
} from "../lib/local-plugins";

const roots: string[] = [];
async function root() { const p = await mkdtemp(join(tmpdir(), "preset-source-test-")); roots.push(p); return p; }
async function source() {
  const p = await root();
  await writeFile(join(p,"package.json"), JSON.stringify({ name: "bb-plugin-demo", version: "1.0.0", bb: { name: "Demo", server: "./server.ts" } }));
  await writeFile(join(p,"server.ts"), "export default async function plugin() {}\n");
  return p;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p,{recursive:true,force:true}))); });

describe("local plugin source bundles", () => {
  it("captures portable code and resources without runtime data", async () => {
    const p = await source();
    for (const name of ["node_modules","dist",".git","logs","secrets","data"]) {
      await mkdir(join(p,name)); await writeFile(join(p,name,"leak.json"), "private");
    }
    for (const name of [".env",".npmrc","credentials.json","data.db","private.pem"]) await writeFile(join(p,name),"private");
    await mkdir(join(p,"assets")); await writeFile(join(p,"assets","mark.png"),Buffer.from([0,1,255]));
    const bundle = await captureLocalPlugin("demo",p);
    expect(bundle.files.map(f => f.path)).toEqual(["assets/mark.png","package.json","server.ts"]);
    expect((await captureLocalPlugin("demo",p)).hash).toBe(bundle.hash);
    await writeFile(join(p,"server.ts"),"export default function changed() {}\n");
    expect((await captureLocalPlugin("demo",p)).hash).not.toBe(bundle.hash);
    const target = await root(); await writeBundleDirectory(target,bundle);
    expect(await readFile(join(target,"assets/mark.png"))).toEqual(Buffer.from([0,1,255]));
  });

  it("rejects source symlinks and mismatched manifest identities", async () => {
    const p = await source();
    await symlink(join(p,"server.ts"),join(p,"linked.ts"));
    await expect(captureLocalPlugin("demo",p)).rejects.toThrow(/symbolic link/i);
    await rm(join(p,"linked.ts"));
    await expect(captureLocalPlugin("other",p)).rejects.toThrow(/identity|name|id/i);
  });

  it("matches BB identity derivation without collapsing repeated hyphens", async () => {
    const p=await source();
    await writeFile(join(p,"package.json"),JSON.stringify({name:"bb-plugin-foo--bar",bb:{server:"./server.ts"}}));
    await expect(captureLocalPlugin("foo-bar",p)).rejects.toThrow(/identity/i);
    await expect(captureLocalPlugin("foo--bar",p)).resolves.toHaveProperty("id","foo--bar");
  });

  it("rejects tampering and unsafe extraction paths", async () => {
    const b = await captureLocalPlugin("demo",await source());
    expect(() => validateBundle({...b,hash:"0".repeat(64)})).toThrow(/hash/i);
    for (const path of ["../outside.ts","/outside.ts","a\\outside.ts",".env","node_modules/leak.json","C:/outside.ts","CON.ts","assets/name?.ts"]) {
      const files = [...b.files,{path,content:Buffer.from("bad").toString("base64"),executable:false}];
      expect(() => validateBundle({...b,files,hash:hashBundleFiles(files)})).toThrow();
    }
    const target = await root(); const outside = await root();
    await symlink(outside,join(target,"assets"));
    const files=[...b.files,{path:"assets/payload.ts",content:Buffer.from("bad").toString("base64"),executable:false}];
    await expect(writeBundleDirectory(target,{...b,files,hash:hashBundleFiles(files)})).rejects.toThrow(/symbolic link/i);
  });

  it("rejects credential-bearing manifests and local dependencies", async () => {
    const p=await source();
    for (const dep of ["file:/home/user/private","https://user:password@example.test/pkg.tgz","../private","/home/user/private","git+file:///home/user/private"]) {
      await writeFile(join(p,"package.json"),JSON.stringify({name:"bb-plugin-demo",bb:{server:"./server.ts"},dependencies:{lib:dep}}));
      await expect(captureLocalPlugin("demo",p)).rejects.toThrow(/portable|credential|local/i);
    }
  });

  it("rejects oversized source files before storing a bundle", async () => {
    const p=await source();
    await writeFile(join(p,"oversized.ts"),Buffer.alloc(5*1024*1024+1));
    await expect(captureLocalPlugin("demo",p)).rejects.toThrow(/limit/i);
  });

  it("accepts portable npm version ranges", async () => {
    const p=await source();
    await writeFile(join(p,"package.json"),JSON.stringify({name:"bb-plugin-demo",bb:{server:"./server.ts"},dependencies:{one:"~1.2.12",two:"^4.0.0",three:"npm:other@^1.0.0"}}));
    await expect(captureLocalPlugin("demo",p)).resolves.toHaveProperty("hash");
  });

  it("persists staged bundles outside KV and round-trips readable repository sources", async () => {
    const p=await source(); const b=await captureLocalPlugin("demo",p);
    const dbPath=join(await root(),"data.db"); const db=new Database(dbPath);
    try {
      const store=new LocalSourceStore(db); store.put(b);
      const reopened=new LocalSourceStore(db);
      expect(reopened.get("demo",b.hash)).toEqual(b);
      const repo=await root(); const entries=[{id:"demo",install:`bundle:${b.hash}`}];
      await writeRepositoryBundles(repo,entries,reopened);
      expect(await readFile(join(repo,"preset/local-plugins/demo/server.ts"),"utf8")).toContain("plugin");
      const otherDb=new Database(join(await root(),"data.db"));
      try {
        const other=new LocalSourceStore(otherDb);
        await readRepositoryBundles(repo,entries,other);
        expect(other.get("demo",b.hash)).toEqual(b);
        await writeFile(join(repo,"preset/local-plugins/demo/server.ts"),"tampered");
        await expect(readRepositoryBundles(repo,entries,other)).rejects.toThrow(/hash/i);
      } finally {otherDb.close();}
    } finally {db.close();}
  });
});
