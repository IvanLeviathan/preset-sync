import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNpmCommand } from "../lib/npm-command";
const { stat }=vi.hoisted(()=>({stat:vi.fn()}));
vi.mock("node:fs/promises",()=>({stat}));
afterEach(()=>vi.resetAllMocks());
function files(paths:string[]){stat.mockImplementation(async(path:string)=>{if(paths.includes(path))return{isFile:()=>true};throw Object.assign(new Error("not found"),{code:"ENOENT"});});}
const node=String.raw`C:\Users\dante\AppData\Local\nvm\v25.8.0`;
const args=["install","--ignore-scripts"];
describe("npm command resolution",()=>{
 it("resolves an NVM installation from case-insensitive Windows Path",async()=>{
  files([node+"\\node.exe",node+"\\node_modules\\npm\\bin\\npm-cli.js"]);
  expect(await resolveNpmCommand(args,"win32",{Path:`C:\\Windows\\System32;\"${node}\"`},String.raw`C:\BB\bb.exe`)).toEqual({command:node+"\\node.exe",args:[node+"\\node_modules\\npm\\bin\\npm-cli.js",...args]});
 });
 it("uses a separate Node runtime for a per-user npm installation",async()=>{
  const npm=String.raw`C:\Users\dante\AppData\Roaming\npm`;
  files([node+"\\node.exe",npm+"\\node_modules\\npm\\bin\\npm-cli.js"]);
  expect(await resolveNpmCommand(args,"win32",{Path:`${npm};${node}`})).toEqual({command:node+"\\node.exe",args:[npm+"\\node_modules\\npm\\bin\\npm-cli.js",...args]});
 });
 it("supports the NVM symlink when desktop Path omits it",async()=>{
  files([node+"\\node.exe",node+"\\node_modules\\npm\\bin\\npm-cli.js"]);
  expect((await resolveNpmCommand(args,"win32",{NVM_SYMLINK:node},String.raw`C:\BB\bb.exe`)).command).toBe(node+"\\node.exe");
 });
 it("reports the BB environment and restart step when Windows npm is unavailable",async()=>{
  files([]);
  await expect(resolveNpmCommand(args,"win32",{Path:String.raw`C:\Windows`},String.raw`C:\BB\bb.exe`)).rejects.toThrow(/BB.*Windows environment.*restart BB/i);
 });
 it.each(["linux","darwin"])("preserves native npm launch on %s",async platform=>{
  expect(await resolveNpmCommand(args,platform as NodeJS.Platform,{})).toEqual({command:"npm",args});
  expect(stat).not.toHaveBeenCalled();
 });
});
