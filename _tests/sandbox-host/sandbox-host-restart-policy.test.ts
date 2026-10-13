import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSandboxHost } from "./load-sandbox-host";

const SLOW = 30_000;
const supervised: number[] = [];

afterEach(() => {
  for (const pid of supervised.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

function ledger(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "restart-policy-")), "runs");
}

function runs(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function supervise(script: string, file: string): { exited: Promise<void> } {
  const child = spawn("/bin/sh", ["-c", script], { env: { ...process.env, RUNS: file }, detached: true, stdio: "ignore" });
  supervised.push(child.pid!);
  return { exited: new Promise((resolve) => child.once("exit", () => resolve())) };
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function servedMarker(file: string, served: boolean): string {
  const marker = path.join(path.dirname(file), "served");
  if (served) fs.writeFileSync(marker, "");
  return marker;
}

const QUICK = { budget: 2, healthySeconds: 1, backoffSeconds: 0, backoffCeilingSeconds: 0 };

test("a command that never served stops after its budget", async () => {
  const { restartScript } = await loadSandboxHost();
  const file = ledger();
  const { exited } = supervise(
    restartScript(`echo run >> "$RUNS"; exit 3`, servedMarker(file, false), { budget: 3, healthySeconds: 5, backoffSeconds: 0, backoffCeilingSeconds: 0 }),
    file,
  );
  await exited;
  expect(runs(file)).toBe(3);
}, SLOW);

test("a command that stays up without ever serving still stops after its budget", async () => {
  const { restartScript } = await loadSandboxHost();
  const file = ledger();
  const { exited } = supervise(restartScript(`echo run >> "$RUNS"; sleep 2; exit 1`, servedMarker(file, false), QUICK), file);
  await exited;
  expect(runs(file)).toBe(QUICK.budget);
}, SLOW);

test("a command that served is restarted past its budget even when every run is short", async () => {
  const { restartScript } = await loadSandboxHost();
  const file = ledger();
  let exited = false;
  void supervise(restartScript(`echo run >> "$RUNS"; exit 1`, servedMarker(file, true), QUICK), file).exited.then(() => {
    exited = true;
  });
  expect(await until(() => runs(file) >= QUICK.budget * 3, 15_000)).toBe(true);
  expect(exited).toBe(false);
}, SLOW);
