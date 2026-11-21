// sdlc:claim rel:env:integration-world=task-provider-testimony=js/apps/task-provider-host
import test from "node:test";
import { runNodeTargetOwner } from "./test-support/node-target-owner";

test("the built host preserves each provider world's declared testimony", { timeout: 1_800_000 }, () => runNodeTargetOwner(new URL("./task-provider-world-testimony.node.ts", import.meta.url).pathname));
