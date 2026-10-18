import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("actual Node runtime qualifies its native clock before resident disclosure",async()=>{
  const root=path.resolve(import.meta.dir,"../../.js");
  const file=path.join(root,`resident-node-qualification-${process.pid}.mjs`);
  try{
    const built=await Bun.build({entrypoints:[path.resolve(import.meta.dir,"../../sandbox-host/index.ts")],target:"node",format:"esm",outdir:root,naming:path.basename(file),external:["@sdlcworks/components","@pulumi/pulumi","zod"]});
    expect(built.success).toBe(true);
    const source=`import component from ${JSON.stringify(file)}; const result=await component.providers['e2b-local'].managedEffects.plan({target:{phase:'deploy'}});process.stdout.write(JSON.stringify(result));`;
    const result=spawnSync("node",["--input-type=module","-e",source],{encoding:"utf8",timeout:10000,env:{...process.env,SDLC_WORKSPACE_CLOCK_EXECUTABLE:""}});
    if(result.status!==0)throw new Error(result.stderr);
    const coverage=JSON.parse(result.stdout);
    expect(coverage.supported).toBe(process.platform==="linux");
    expect(coverage.refusal_reason).toBe(process.platform==="linux"?null:"resident-clock-unavailable");
    expect(coverage.credential_keys).toEqual([]);
  }finally{fs.rmSync(file,{force:true});}
});

test("native clock serializes into the actual CommonJS supervisor runtime",async()=>{
 const root=path.resolve(import.meta.dir,"../../.js");
 const file=path.join(root,`resident-clock-serialization-${process.pid}.mjs`);
 try{
  const built=await Bun.build({entrypoints:[path.resolve(import.meta.dir,"../../sandbox-host/index.ts")],target:"node",format:"esm",outdir:root,naming:path.basename(file),external:["@sdlcworks/components","@pulumi/pulumi","zod"]});
  expect(built.success).toBe(true);
  fs.appendFileSync(file,"\nexport {nativeAdmissionClock as serializedClock};\n");
  const source=`import {serializedClock} from ${JSON.stringify(file)}; import {spawnSync} from 'node:child_process'; const source='const readAdmissionClock='+serializedClock.toString()+'; try {process.stdout.write(JSON.stringify(readAdmissionClock(require)));} catch(error) {process.stdout.write(JSON.stringify({unavailable:true}));}'; const check=spawnSync(process.execPath,['--input-type=commonjs','--check'],{input:source,encoding:'utf8'}); if(check.status!==0)throw new Error(check.stderr); const result=spawnSync(process.execPath,['--input-type=commonjs','-e',source],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);process.stdout.write(result.stdout);`;
  const result=spawnSync("node",["--input-type=module","-e",source],{encoding:"utf8",timeout:10000,env:{...process.env,SDLC_WORKSPACE_CLOCK_EXECUTABLE:""}});
  expect(result.status).toBe(0);
  const sample=JSON.parse(result.stdout);
  if(process.platform==="linux"){
   expect(sample.boot_identity).toBe(fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim());
   expect(BigInt(sample.now_ns)).toBeGreaterThan(BigInt(0));
  }else{
   expect(sample.unavailable).toBe(true);
  }
 }finally{fs.rmSync(file,{force:true});}
});

const darwin = process.platform === "darwin" ? test : test.skip;

darwin("declared native capability qualifies Node and preserves the controller clock domain", async () => {
  const root = path.resolve(import.meta.dir, "../../.js");
  const file = path.join(root, `resident-darwin-clock-${process.pid}.mjs`);
  const executable = process.env.SDLC_TEST_CLOCK_EXECUTABLE ?? process.execPath;
  const {dlopen,FFIType,ptr} = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {mach_continuous_time:{args:[],returns:FFIType.u64},mach_timebase_info:{args:[FFIType.ptr],returns:FFIType.i32}});
  const ratio = new Uint32Array(2);
  expect(library.symbols.mach_timebase_info(ptr(ratio))).toBe(0);
  const now = () => BigInt(library.symbols.mach_continuous_time())*BigInt(ratio[0]!)/BigInt(ratio[1]!);
  try {
    const built = await Bun.build({entrypoints:[path.resolve(import.meta.dir,"../../sandbox-host/index.ts")],target:"node",format:"esm",outdir:root,naming:path.basename(file),external:["@sdlcworks/components","@pulumi/pulumi","zod"]});
    expect(built.success).toBe(true);
    fs.appendFileSync(file, "\nexport {nativeAdmissionClock as serializedClock};\n");
    const source = `import component,{readAdmissionClock,serializedClock} from ${JSON.stringify(file)};
import {spawnSync} from 'node:child_process';
const before=readAdmissionClock();
const coverage=await component.providers['e2b-local'].managedEffects.plan({target:{phase:'deploy'}});
const saved=process.env.SDLC_WORKSPACE_CLOCK_EXECUTABLE;
process.env.SDLC_WORKSPACE_CLOCK_EXECUTABLE='/unavailable/authored-replacement';
const retained=readAdmissionClock();
const code='const nativeAdmissionClock='+serializedClock.toString()+';process.stdout.write(JSON.stringify(nativeAdmissionClock(require,'+JSON.stringify(saved)+')));';
const child=spawnSync(process.execPath,['--input-type=commonjs','-e',code],{encoding:'utf8',env:{},timeout:5000});
if(child.status!==0)throw new Error(child.stderr);
process.stdout.write(JSON.stringify({before,coverage,retained,child:JSON.parse(child.stdout)}));`;
    const lower = now();
    const result = spawnSync("node", ["--input-type=module", "-e", source], {encoding:"utf8",timeout:10000,env:{...process.env,SDLC_WORKSPACE_CLOCK_EXECUTABLE:executable}});
    if(result.status!==0) throw new Error(result.stderr);
    const upper = now();
    const value = JSON.parse(result.stdout);
    const boot = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {encoding:"utf8"}).stdout.trim();
    expect(value.coverage.supported).toBe(true);
    expect(value.coverage.refusal_reason).toBe(null);
    for(const sample of [value.before,value.retained,value.child]) {
      expect(sample.boot_identity).toBe(boot);
      expect(BigInt(sample.now_ns)).toBeGreaterThanOrEqual(lower);
      expect(BigInt(sample.now_ns)).toBeLessThanOrEqual(upper);
    }
    expect(BigInt(value.retained.now_ns)).toBeGreaterThanOrEqual(BigInt(value.before.now_ns));
    expect(BigInt(value.child.now_ns)).toBeGreaterThanOrEqual(BigInt(value.retained.now_ns));
  } finally { library.close(); fs.rmSync(file,{force:true}); }
}, 15000);

darwin("Node refuses missing, relative and non-clock capabilities before effect coverage", async () => {
  const root = path.resolve(import.meta.dir, "../../.js");
  const file = path.join(root, `resident-darwin-refusal-${process.pid}.mjs`);
  try {
    const built = await Bun.build({entrypoints:[path.resolve(import.meta.dir,"../../sandbox-host/index.ts")],target:"node",format:"esm",outdir:root,naming:path.basename(file),external:["@sdlcworks/components","@pulumi/pulumi","zod"]});
    expect(built.success).toBe(true);
    for(const executable of ["", "bun", "/unavailable/clock", "/usr/bin/true"]) {
      const source = `import component from ${JSON.stringify(file)};process.stdout.write(JSON.stringify(await component.providers['e2b-local'].managedEffects.plan({target:{phase:'deploy'}})));`;
      const result = spawnSync("node", ["--input-type=module","-e",source], {encoding:"utf8",timeout:5000,env:{...process.env,SDLC_WORKSPACE_CLOCK_EXECUTABLE:executable}});
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({supported:false,refusal_reason:"resident-clock-unavailable",observation_supported:false,cessation_supported:false});
    }
  } finally { fs.rmSync(file,{force:true}); }
}, 20000);
