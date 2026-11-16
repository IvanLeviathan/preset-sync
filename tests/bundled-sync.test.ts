import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { captureLocalPlugin, LocalSourceStore } from "../lib/local-plugins";
import { readRemotePreset, pushRemotePreset } from "../lib/git";
import { installLocalPlugin } from "../lib/install-local-plugin";
import type { PresetSnapshot } from "../lib/preset";

vi.mock("../lib/git", () => ({readRemotePreset:vi.fn(),pushRemotePreset:vi.fn(async()=>({pushed:false,head:"abc",changedFiles:[]}))}));
vi.mock("../lib/install-local-plugin",()=>({installLocalPlugin:vi.fn(async()=>{})}));
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(includeLocalPlugins=true,id="demo") {
  const root=await mkdtemp(join(tmpdir(),"preset-service-source-"));roots.push(root);
  await writeFile(join(root,"package.json"),JSON.stringify({name:`bb-plugin-${id}`,bb:{server:"./server.ts"}}));
  await writeFile(join(root,"server.ts"),"export default function original() {}\n");
  const source=await captureLocalPlugin(id,root);
  const host=createFakePluginHost({pluginId:"preset-sync",settings:{repositoryUrl:"https://example.test/preset.git",includeLocalPlugins},sdk:{
    system:{config:async()=>({generalSettings:{defaultProviderId:null,providerOrder:[],showKeyboardHints:true,showUnhandledProviderEvents:false,steerActiveThreadOnEnter:true,streamerMode:false},experiments:{},keybindingOverrides:[],appearance:{themeId:"default",faviconColor:"default"}}),version:async()=>({currentVersion:"0.41.0"})},
    plugins:{list:async()=>({plugins:[{id,source:`path:${root}`,rootDir:root,enabled:true,hasSettings:false}]}),marketplaces:{list:async()=>[]}},
  }});
  return {...host,root,source};
}

describe("bundled source synchronization",()=>{
  it("preserves remote local sources when pushing a legacy stage without source metadata",async()=>{
    const {bb,harness}=await fixture();
    try {
      await plugin(bb);await harness.behavior.callRpc("sync_capture",null);
      const stage=await bb.storage.kv.get<{snapshot:PresetSnapshot;localPluginsIncluded?:boolean}>("staged-preset-v1");
      delete stage!.localPluginsIncluded;
      stage!.snapshot.plugins=[];delete stage!.snapshot.bootstrapSource;
      await bb.storage.kv.set("staged-preset-v1",stage);
      await harness.behavior.callRpc("sync_push",{fresh:false});
      expect(vi.mocked(pushRemotePreset).mock.calls[0]?.[0].preserveLocalPlugins).toBe(true);
    }finally{await harness.lifecycle.dispose();}
  });

  it("does not advertise replacing a disabled remote bundle with a managed plugin of the same id",async()=>{
    const {bb,harness,source}=await fixture(false);
    harness.sdk.stub("plugins.list",async()=>({plugins:[{id:"demo",source:"builtin:demo",enabled:true,hasSettings:false}]}));
    vi.mocked(readRemotePreset).mockImplementation(async options=>{
      options.sourceStore!.put(source);
      return {head:"abc",snapshot:{schemaVersion:1,capturedAt:"now",bbVersion:"0.41.0",settings:{},plugins:[{id:"demo",install:`bundle:${source.hash}`,enabled:true}],marketplaces:[],pluginSettings:[]}};
    });
    try {
      await plugin(bb);
      const status=await harness.behavior.callRpc("sync_status",null) as {pushChanges:Array<{target:string}>};
      expect(status.pushChanges.some(change=>change.target==="demo")).toBe(false);
    }finally{await harness.lifecycle.dispose();}
  });

  it("stages source references outside KV and retains staged bytes across reload",async()=>{
    const {bb,harness,root,source}=await fixture();
    let currentHarness=harness;
    try {
      await plugin(bb);await harness.behavior.callRpc("sync_capture",null);
      const stage=await bb.storage.kv.get<{snapshot:PresetSnapshot}>("staged-preset-v1");
      expect(stage?.snapshot.plugins).toContainEqual({id:"demo",install:`bundle:${source.hash}`,enabled:true});
      expect(JSON.stringify(stage)).not.toContain("export default function original");
      await writeFile(join(root,"server.ts"),"export default function changed() {}\n");
      currentHarness=(await harness.lifecycle.reload(plugin)).harness;
      await currentHarness.behavior.callRpc("sync_push",{fresh:false});
      const [options,snapshot]=vi.mocked(pushRemotePreset).mock.calls[0]!;
      expect(snapshot.plugins[0]?.install).toBe(`bundle:${source.hash}`);
      expect(options.sourceStore?.get("demo",source.hash)).toEqual(source);
    }finally{await currentHarness.lifecycle.dispose();}
  });

  it("previews and applies a source-only update to an existing path plugin",async()=>{
    const {bb,harness,root}=await fixture();
    await writeFile(join(root,"server.ts"),"export default function remote() {}\n");
    const remote=await captureLocalPlugin("demo",root);
    await writeFile(join(root,"server.ts"),"export default function original() {}\n");
    vi.mocked(readRemotePreset).mockImplementation(async options=>{
      options.sourceStore!.put(remote);
      return {head:"abc",snapshot:{schemaVersion:1,capturedAt:"now",bbVersion:"0.41.0",settings:{},plugins:[{id:"demo",install:`bundle:${remote.hash}`,enabled:true}],marketplaces:[],pluginSettings:[]}};
    });
    try {
      await plugin(bb);
      const plan=await harness.behavior.callRpc("sync_preview",null) as {changes:unknown[]};
      expect(plan.changes).toContainEqual(expect.objectContaining({target:"demo",action:"update",risk:"full-trust"}));
      const result=await harness.behavior.callRpc("sync_pull",{confirmed:true});
      expect(result).toMatchObject({ok:true,errors:[]});
      expect(installLocalPlugin).toHaveBeenCalledWith(bb,remote,expect.any(String),expect.objectContaining({source:`path:${root}`}),undefined);
    }finally{await harness.lifecycle.dispose();}
  });

  it("preserves remote source bundles when local source sync is disabled",async()=>{
    const {bb,harness}=await fixture(false);
    try {
      await plugin(bb);await harness.behavior.callRpc("sync_capture",null);
      const stage=await bb.storage.kv.get<{snapshot:PresetSnapshot}>("staged-preset-v1");
      expect(stage?.snapshot.plugins).toEqual([]);
      await harness.behavior.callRpc("sync_push",{fresh:false});
      expect(vi.mocked(pushRemotePreset).mock.calls[0]?.[0].preserveLocalPlugins).toBe(true);
    }finally{await harness.lifecycle.dispose();}
  });

  it("packages a bootstrap copy without automatically applying itself",async()=>{
    const {bb,harness,source}=await fixture(true,"preset-sync");
    try {
      await plugin(bb);await harness.behavior.callRpc("sync_capture",null);
      const stage=await bb.storage.kv.get<{snapshot:PresetSnapshot}>("staged-preset-v1");
      expect(stage?.snapshot.bootstrapSource).toBe(`bundle:${source.hash}`);
      expect(stage?.snapshot.plugins).toEqual([]);
      expect(new LocalSourceStore(bb.storage.database()).get("preset-sync",source.hash)).toEqual(source);
    }finally{await harness.lifecycle.dispose();}
  });
});
