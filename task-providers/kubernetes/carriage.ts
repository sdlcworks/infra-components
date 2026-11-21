export function carriageSource(): string {
  return `import{readFileSync,writeFileSync,mkdirSync}from"node:fs";import{spawn}from"node:child_process";import{join}from"node:path";const root=process.argv[2];mkdirSync(root,{recursive:true});const manifest=JSON.parse(readFileSync(join(root,"delivery","manifest.json"),"utf8"));const runner=join(root,"runner");writeFileSync(runner,Buffer.from(manifest.runnerBase64,"base64"),{mode:0o700});const child=spawn(runner,[],{stdio:["pipe","pipe","inherit"]});child.stdout.pipe(process.stdout);child.on("exit",code=>process.exit(code??1));`;
}
