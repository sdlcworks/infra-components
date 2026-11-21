// sdlc:claim node:infra
import test from "node:test";
import { runNodeTargetOwner } from "./test-support/node-target-owner";

test("the authored infra bundle exposes and executes every committed provider scenario", { timeout: 1_800_000 }, () => runNodeTargetOwner(new URL("./task-providers.node.ts", import.meta.url).pathname));
