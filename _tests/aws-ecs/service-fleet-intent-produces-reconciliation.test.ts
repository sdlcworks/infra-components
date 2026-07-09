import { expect, test } from "bun:test";

import { loadEcs } from "./load-ecs";

test.each([
  [false, { min: 1, max: 1 }, ["desiredCount"]],
  [false, { min: 1, max: 4 }, ["desiredCount"]],
  [true, { min: 1, max: 4 }, ["desiredCount"]],
  [true, { min: 2, max: 2 }, []],
])(
  "service-fleet-intent produces desired-count ownership for activated=%p scaling=%o",
  async (activated, scaling, expected) => {
    const { desiredCountIgnoreChanges } = await loadEcs();
    expect(desiredCountIgnoreChanges(activated, scaling)).toEqual(expected);
  },
);
