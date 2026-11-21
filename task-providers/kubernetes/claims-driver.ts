import { registerKubernetesClaims, type KubernetesClaimApi } from "./claims";

const group = process.argv[process.argv.indexOf("--group") + 1] ?? "all";
const cases: Array<{ name: string; group: string; run: () => void | Promise<void> }> = [];
const api: KubernetesClaimApi = { test: (name, claimGroup, run) => cases.push({ name, group: claimGroup, run }) };
registerKubernetesClaims(api);
async function main() {
  for (const item of cases) {
    if (group !== "all" && item.group !== group) continue;
    try { await item.run(); console.log(`PASS ${item.group} ${item.name}`); } catch (error) { console.error(`FAIL ${item.group} ${item.name}`, error); process.exit(1); }
  }
}
void main();
