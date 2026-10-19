import {afterEach,expect,test} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {loadSandboxHost} from "./load-sandbox-host";
import type {ManagedEffectHistoricalDemand,ManagedEffectInvocation,ManagedEffectPlan,ManagedEffectAccount,ManagedRealizationObservation} from "@sdlcworks/components";
const {managedEffectPlanIdentity,managedEngineQualificationIdentity,managedOwnerObservationIdentity,validateManagedEffectAccount}=await import("@sdlcworks/components");

const cleanup:Array<()=>void>=[];
const saved={...process.env};
const keys=["E2B_SANDBOX_ID","SDLC_WORKSPACE_MACHINE_ID","SDLC_WORKSPACE_SESSION_ID","SDLC_WORKSPACE_ID","SDLC_WORKSPACE_GENERATION","SDLC_WORKSPACE_ROOT","SDLC_WORKSPACE_SESSION_FILE"];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}});
async function port(){const server=net.createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const value=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return value;}
async function fixture(){
 const module=await loadSandboxHost(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"resident-effect-source-"))),privateRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"resident-effect-owner-")));
 fs.chmodSync(privateRoot,0o700);fs.writeFileSync(path.join(root,"sdlc.toml"),"");
 const tuple={machine_id:"test-machine",session_id:randomUUID(),workspace_id:"test-workspace",generation:"1",workspace_root:root};
 const sample=module.readAdmissionClock(),clock={version:1 as const,kind:"suspend-inclusive-monotonic" as const,boot_identity:sample.boot_identity,not_after_ns:(BigInt(sample.now_ns)+BigInt(120000000000)).toString()};
 const session={protocol:"sdlc-workspace-session",...tuple,revision:"1",state:"ready",valid_until:new Date(Date.now()+120000).toISOString(),admission_clock:clock};
 const file=path.join(privateRoot,"session.json");const write=()=>{fs.writeFileSync(file+".next",JSON.stringify(session),{mode:0o600});fs.renameSync(file+".next",file);};write();
 for(const key of keys)delete process.env[key];Object.assign(process.env,{SDLC_WORKSPACE_MACHINE_ID:tuple.machine_id,SDLC_WORKSPACE_SESSION_ID:tuple.session_id,SDLC_WORKSPACE_ID:tuple.workspace_id,SDLC_WORKSPACE_GENERATION:tuple.generation,SDLC_WORKSPACE_ROOT:root,SDLC_WORKSPACE_SESSION_FILE:file});
 const binding=path.join(root,"binding.json");fs.writeFileSync(binding,JSON.stringify({protocol:module.BINDING_PROTOCOL,environment:"machine",...tuple,component:"api",runtime_path:process.env.PATH!.split(":").filter(v=>v.startsWith("/")).join(":")}));
 const digest=createHash("sha256").update(JSON.stringify(["sdlc-machine",tuple.machine_id,tuple.session_id,tuple.workspace_id,tuple.generation,root])).digest("hex"),namespace=path.join(fs.realpathSync(os.tmpdir()),"sdlc-sandbox-host","machine",digest),dir=path.join(namespace,"api");
 const sessionDigest=createHash("sha256").update(JSON.stringify(["sdlc-machine-session",tuple.machine_id,tuple.session_id])).digest("hex"),sessionRoot=path.join(fs.realpathSync(os.tmpdir()),"sdlc-sandbox-host","machine-sessions",sessionDigest);
 cleanup.push(()=>{try{for(const attempt of fs.readdirSync(path.join(dir,"attempts"))){try{const control=JSON.parse(fs.readFileSync(path.join(dir,"attempts",attempt,"control.json"),"utf8"));process.kill(-control.pid,"SIGKILL");}catch{}}}catch{}for(const location of [root,privateRoot,namespace,sessionRoot])fs.rmSync(location,{recursive:true,force:true});});
 const provider=module.default.providers[module.SANDBOX_REALIZATION]!;
 return {module,root,dir,namespace,tuple,clock,session,write,binding,provider};
}
async function invocation(f:Awaited<ReturnType<typeof fixture>>,effect:string){
 const identity="a".repeat(64),target={target_id:"target",phase:"deploy" as const,component_id:"host",realization_id:"selected-realization",source_identity:identity,artifact_identities:{api:{main:"binding"}},release_identities:{api:"r1"}};
 const coverage=await f.provider.managedEffects!.plan({version:1,definitions_identity:identity,selection_identity:identity,state_identity:identity,target,credential_key_ceiling:[]});expect(coverage.supported).toBe(true);expect(coverage.credential_keys).toEqual([]);
 const qualification={definitions_identity:identity,selection_identity:identity,state_identity:identity,target_id:target.target_id,phase:target.phase,worker_action:"deploy" as const,requirement:"outside-resource-engine" as const};
 const basis={version:1 as const,definitions_identity:identity,selection_identity:identity,state_identity:identity,targets:[{...coverage,engine_requirement:{...qualification,identity:managedEngineQualificationIdentity(qualification)}}]},plan:ManagedEffectPlan={...basis,identity:managedEffectPlanIdentity(basis)};
 return {attribution:{workspace_id:f.tuple.workspace_id,generation:f.tuple.generation,session_id:f.tuple.session_id,effect_id:effect,plan_identity:plan.identity,execution_id:effect,invocation_id:effect,definitions_identity:identity},plan,target_id:target.target_id,deadline:new Date(Date.now()+90000).toISOString(),local_admission_clock:f.clock} as ManagedEffectInvocation;
}
function history(i:ManagedEffectInvocation):ManagedEffectHistoricalDemand{return {attribution:i.attribution,plan:i.plan,target_id:i.target_id,observations:{},deadline:new Date(Date.now()+45000).toISOString(),drain_identity:randomUUID()};}
function append(d:ManagedEffectHistoricalDemand,base:ManagedRealizationObservation){const q=d.plan.targets[0]!.engine_requirement;const complete={...base,engine_state:"not-applicable" as const,engine_evidence:{kind:"outside-resource-engine" as const,qualification_identity:q.identity}};const observation={...complete,observation_id:managedOwnerObservationIdentity(complete)};d.observations[observation.observation_id]=observation;const account:ManagedEffectAccount={version:1,attribution:d.attribution,plan_identity:d.plan.identity,entered_targets:[d.target_id],observations:d.observations,operation_outcomes:{[d.target_id]:"succeeded"}};validateManagedEffectAccount(d.plan,d.attribution,null,account,base.interval_start,d.deadline);return observation;}
async function deploy(f:Awaited<ReturnType<typeof fixture>>,i:ManagedEffectInvocation,p:number){return f.provider.upsertArtifacts!({managedEffect:i,getCredentials:()=>{throw new Error("unexpected credentials");},buildArtifacts:{api:{artifact:{uri:`file://${f.binding}`,type:"file"}}},state:{ingress_domain:"unused.invalid"},envStore:{api:{}},servingPorts:{api:p},releaseIdentities:{api:"r1"},deploymentConfigs:{api:{command:`exec bun -e "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('alive')})"`}},currentOutputs:{}} as any);}

test("managed actual serving retains original references and drains after session closure",async()=>{
 const f=await fixture(),first=await invocation(f,"first"),p=await port();await deploy(f,first,p);expect(await(await fetch(`http://127.0.0.1:${p}`)).text()).toBe("alive");
 const a=history(first),observed=append(a,await f.provider.managedEffects!.observe(a));expect(observed.launches).toHaveLength(1);expect(observed.members[0]!.state).toBe("ongoing");expect(observed.sealed).toBe(false);
 const second=await invocation(f,"second");await deploy(f,second,p);const b=history(second),reference=append(b,await f.provider.managedEffects!.observe(b));expect(reference.launches).toHaveLength(0);expect(reference.referenced_launches[0]!.member.launch_id).toBe(observed.launches[0]!.member.launch_id);
 const attempt=fs.readFileSync(path.join(f.dir,"managed-attempt"),"utf8");expect(fs.readdirSync(path.join(f.dir,"attempts",attempt)).filter(v=>/^child-.*\.json$/.test(v)).length).toBeGreaterThanOrEqual(2);
 f.session.state="closed";f.write();await expect(deploy(f,await invocation(f,"third"),p)).rejects.toThrow("session-invalid");
 f.session.revision="2";f.session.state="ready";f.write();await expect(deploy(f,await invocation(f,"reopen"),p)).rejects.toThrow("session-invalid");
 let closed=append(b,await f.provider.managedEffects!.drain(b));
 if(closed.members[0]!.state!=="ceased"){await new Promise(r=>setTimeout(r,16000));closed=append(b,await f.provider.managedEffects!.drain(b));}
 expect(closed.sealed).toBe(true);expect(closed.members[0]!.state).toBe("ceased");expect(await f.module.listening(p)).toBe(false);
 const original=append(a,await f.provider.managedEffects!.observe(a));expect(original.members[0]!.state).toBe("ceased");expect(original.sealed).toBe(true);
 expect(JSON.stringify(closed)).not.toContain(f.root);expect(JSON.stringify(closed)).not.toContain("control.json");
},45000);

test("missing or expired original effect clock refuses before launch",async()=>{
 const f=await fixture(),i=await invocation(f,"expired"),p=await port();
 const absent={...i};delete absent.local_admission_clock;await expect(deploy(f,absent,p)).rejects.toThrow("clock-unavailable");
 const expired={...i,local_admission_clock:{...i.local_admission_clock!,not_after_ns:"0"}};await expect(deploy(f,expired,p)).rejects.toThrow("session-invalid");
 expect(fs.existsSync(path.join(f.dir,"attempts"))).toBe(false);
});

test("lost parent and supervisor association retains unknown attempted launch",async()=>{
 const f=await fixture(),i=await invocation(f,"lost-association"),p=await port(),original=fs.writeFileSync;
 fs.writeFileSync=((file:any,...args:any[])=>{
   const location=String(file);
   if(location.endsWith("/parent.json"))throw new Error("injected-parent-record-loss");
   const result=(original as any)(file,...args);
   if(location.endsWith("/attempt.json"))fs.mkdirSync(path.join(path.dirname(location),"supervisor.json"),{mode:0o700});
   return result;
 }) as typeof fs.writeFileSync;
 try{await expect(deploy(f,i,p)).rejects.toThrow("injected-parent-record-loss");}finally{fs.writeFileSync=original;}
 const demand=history(i),first=append(demand,await f.provider.managedEffects!.observe(demand));
 expect(first.launches).toHaveLength(1);expect(first.members[0]!.state).toBe("unknown");
 const drained=append(demand,await f.provider.managedEffects!.drain(demand));expect(drained.sealed).toBe(true);expect(drained.members[0]!.state).toBe("unknown");
 const foreign={...demand,attribution:{...demand.attribution,workspace_id:"foreign"}};await expect(f.provider.managedEffects!.drain(foreign)).rejects.toThrow();
});

test.skipIf(!process.env.SDLC_TEST_CLOCK_PROBE)("resident and CLI native clocks share the original boot epoch",async()=>{
 const {readAdmissionClock}=await loadSandboxHost();
 const before=readAdmissionClock();
 const actual=JSON.parse(execFileSync(process.env.SDLC_TEST_CLOCK_PROBE!,[],{encoding:"utf8",timeout:5000}));
 const after=readAdmissionClock();
 expect(actual.boot_identity).toBe(before.boot_identity);expect(actual.boot_identity).toBe(after.boot_identity);
 expect(BigInt(actual.now_ns)>=BigInt(before.now_ns)).toBe(true);expect(BigInt(actual.now_ns)<=BigInt(after.now_ns)).toBe(true);
});
