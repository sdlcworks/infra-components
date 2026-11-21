import type { AwsEc2Configuration } from "./schemas";

const encoder = new TextEncoder();

export function awsGuestCarriageProgram(configuration: AwsEc2Configuration): Uint8Array {
  const program = `import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const delivery = JSON.parse(await readFile(process.env.SDLC_DELIVERY, "utf8"));
const workspace = ${JSON.stringify(configuration.guest.workspaceRoot)};
const aws = ${JSON.stringify(configuration.guest.awsCliPath)};
await mkdir(workspace, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archive = await readFile(join(workspace, "task.archive"));
const runner = await readFile(join(workspace, "task-runner"));
if (hash(archive) !== delivery.content.archiveSha256) throw new Error("task-archive-digest-mismatch");
if (hash(runner) !== delivery.runnerSha256) throw new Error("task-runner-digest-mismatch");
const child = spawn(join(workspace, "task-runner"), [], { stdio: ["pipe", "pipe", "inherit"] });
let sequence = 0;
let commandSequence = 0;
let pending = "";
const metadata = Object.entries({
  "run-digest": delivery.carriage.association.runDigest,
  "configuration-digest": delivery.carriage.association.configurationDigest,
  "archive-sha256": delivery.carriage.association.archiveSha256,
  "tree-sha256": delivery.carriage.association.treeSha256,
  "runner-sha256": delivery.carriage.association.runnerSha256,
}).map(([key, value]) => key + "=" + value).join(",");
const put = (key, file) => {
  const result = spawnSync(aws, ["s3api", "put-object", "--bucket", delivery.carriage.bucket, "--key", delivery.carriage.runPrefix + "/" + key, "--body", file, "--if-none-match", "*", "--metadata", metadata], { stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error("immutable-status-write-failed");
};
child.stdout.setEncoding("utf8");
child.stdout.on("data", async (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\\n");
    if (end < 0) break;
    const frame = pending.slice(0, end); pending = pending.slice(end + 1);
    sequence += 1;
    const file = join(workspace, "status-" + String(sequence).padStart(20, "0") + ".json");
    await writeFile(file, frame);
    put("status/" + String(sequence).padStart(20, "0") + ".json", file);
  }
});
const poll = setInterval(async () => {
  const next = commandSequence + 1;
  const key = delivery.carriage.runPrefix + "/commands/" + String(next).padStart(20, "0") + ".json";
  const file = join(workspace, "command-" + String(next).padStart(20, "0") + ".json");
  const result = spawnSync(aws, ["s3api", "get-object", "--bucket", delivery.carriage.bucket, "--key", key, file], { stdio: ["ignore", "ignore", "ignore"] });
  if (result.status === 0) {
    child.stdin.write(await readFile(file)); child.stdin.write("\\n"); commandSequence = next;
  }
}, ${configuration.lifecycle.providerPollMilliseconds});
child.on("exit", () => clearInterval(poll));
`;
  return encoder.encode(program);
}

export function awsCloudInitProgram(
  configuration: AwsEc2Configuration,
  runPrefix: string,
): string {
  const guest = configuration.guest;
  const q = (value: string) => `'${value.split("'").join(`'"'"'`)}'`;
  const workspace = q(guest.workspaceRoot);
  const bucket = q(configuration.statusCarriage.bucket);
  const prefix = q(runPrefix);
  return `#!${guest.shellPath}
set -euo pipefail
export PATH=${q(guest.pathDirectories.join(":"))}
install -d -m 0700 ${workspace}
${guest.awsCliPath} s3 cp s3://${bucket}/${prefix}/task/archive ${workspace}/task.archive
${guest.awsCliPath} s3 cp s3://${bucket}/${prefix}/runner/task-runner ${workspace}/task-runner
${guest.awsCliPath} s3 cp s3://${bucket}/${prefix}/guest/carriage.mjs ${workspace}/carriage.mjs
${guest.awsCliPath} s3 cp s3://${bucket}/${prefix}/delivery.json ${workspace}/delivery.json
${guest.nodePath} -e 'const fs=require("fs"),crypto=require("crypto"),p=process.argv[1],d=process.argv[2];if(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==d)process.exit(1)' ${workspace}/task.archive __ARCHIVE_SHA256__
${guest.tarPath} -tzf ${workspace}/task.archive | while IFS= read -r member; do case "$member" in /*|../*|*/../*|*/..) exit 1;; esac; done
while ! ${guest.awsCliPath} s3 cp s3://${bucket}/${prefix}/launch-ready.json ${workspace}/launch-ready.json; do sleep 1; done
chmod 0700 ${workspace}/task-runner
SDLC_DELIVERY=${workspace}/delivery.json ${guest.nodePath} ${workspace}/carriage.mjs
`;
}
