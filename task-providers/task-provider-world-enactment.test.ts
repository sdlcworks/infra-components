// sdlc:claim rel:js/apps/task-provider-host=task-provider-enactment=env:integration-world
import test from "node:test";
import { runNodeTargetOwner } from "./test-support/node-target-owner";

test("the built host produces each provider world's declared effects", { timeout: 1_800_000 }, () => runNodeTargetOwner(new URL("./task-provider-world-enactment.node.ts", import.meta.url).pathname));
