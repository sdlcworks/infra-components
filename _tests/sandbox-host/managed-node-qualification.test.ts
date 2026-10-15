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
    const result=spawnSync("node",["--input-type=module","-e",source],{encoding:"utf8",timeout:10000});
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
  const result=spawnSync("node",["--input-type=module","-e",source],{encoding:"utf8",timeout:10000});
  expect(result.status).toBe(0);
  const sample=JSON.parse(result.stdout);
  if(process.platform==="linux"){
   expect(sample.boot_identity).toBe(fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim());
   expect(BigInt(sample.now_ns)).toBeGreaterThan(0n);
  }else{
   expect(sample.unavailable).toBe(true);
  }
 }finally{fs.rmSync(file,{force:true});}
});
