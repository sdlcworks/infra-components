import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("@pulumi/pulumi", () => ({ dynamic: { Resource: class {} } }));
for (const name of [
  "@pulumi/gcp",
  "@pulumi/aws",
  "@pulumi/command",
  "@pulumi/tls",
  "@pulumi/kubernetes",
])
  mock.module(name, () => ({}));

let responses: Array<unknown> = [];
let requests: Array<{ method: string; destroyed: boolean }> = [];
mock.module("https", () => ({
  request: (options: any, callback: (response: any) => void) => {
    const request = new EventEmitter() as any;
    const observed = { method: options.method, destroyed: false };
    requests.push(observed);
    request.write = () => {};
    request.destroy = (error: Error) => {
      observed.destroyed = true;
      queueMicrotask(() => request.emit("error", error));
    };
    options.signal?.addEventListener(
      "abort",
      () => request.destroy(options.signal.reason),
      { once: true },
    );
    request.end = () =>
      queueMicrotask(() => {
        const next = responses.length > 1 ? responses.shift() : responses[0];
        if (next === "hang") return;
        if (next instanceof Error) return request.emit("error", next);
        const response = new EventEmitter() as any;
        response.statusCode = typeof next === "number" ? next : 200;
        response.headers = {};
        callback(response);
        if (next === "hang-body") return;
        queueMicrotask(() => {
          response.emit(
            "data",
            Buffer.from(next === "invalid-json" ? "{" : JSON.stringify(next)),
          );
          response.emit("end");
        });
      });
    return request;
  },
}));
const { default: component } = await import("../../k3s");
const deploy = component.providers.gcloud!.upsertArtifacts!;
let now = 0;
let timers: Array<{ at: number; callback: () => void; cancelled: boolean }> =
  [];
let logs: string[] = [];
function clock() {
  now = 0;
  timers = [];
  requests = [];
  logs = [];
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    const timer = { at: now + delay, callback, cancelled: false };
    timers.push(timer);
    return timer;
  }) as any);
  spyOn(globalThis, "clearTimeout").mockImplementation(((timer: any) => {
    if (timer) timer.cancelled = true;
  }) as any);
  spyOn(console, "error").mockImplementation((...parts) => {
    logs.push(parts.join(" "));
  });
}
afterEach(() => mock.restore());
function resource(kind = "Deployment", status: Record<string, unknown> = {}) {
  return {
    kind,
    metadata: { uid: "workload-uid", generation: 9 },
    spec: {
      replicas: 2,
      updateStrategy: { type: "RollingUpdate" },
      template: {
        spec: { containers: [{ name: "server", image: "image:new" }] },
      },
    },
    status: {
      observedGeneration: 9,
      replicas: 2,
      updatedReplicas: 2,
      availableReplicas: 2,
      readyReplicas: 2,
      desiredNumberScheduled: 2,
      updatedNumberScheduled: 2,
      numberAvailable: 2,
      currentRevision: "revision-new",
      updateRevision: "revision-new",
      conditions: [{ type: "Available", status: "True" }],
      ...status,
    },
  };
}
async function run(workloadType = "deployment", appComponentType = "default") {
  let settled = false;
  let error: unknown;
  const pending = deploy({
    buildArtifacts: { server: { artifact: { uri: "image:new" } } },
    envStore: {},
    state: {
      cloudProvider: "gcloud",
      kubeconfig: JSON.stringify({
        clusters: [
          {
            cluster: {
              server: "https://cluster.invalid",
              "certificate-authority-data": "",
            },
          },
        ],
        users: [
          { user: { "client-certificate-data": "", "client-key-data": "" } },
        ],
      }),
      allocations: {
        server: { workloadType, namespace: "components", appComponentType },
      },
    },
  } as any).then(
    () => {
      settled = true;
    },
    (caught: unknown) => {
      settled = true;
      error = caught;
    },
  );
  for (let step = 0; step < 5000 && !settled; step++) {
    for (let microtask = 0; microtask < 30; microtask++)
      await Promise.resolve();
    if (settled) break;
    timers.sort((a, b) => a.at - b.at);
    const timer = timers.find((item) => !item.cancelled);
    if (!timer) throw new Error("fixture has no pending timer");
    timer.cancelled = true;
    now = timer.at;
    timer.callback();
  }
  expect(settled).toBe(true);
  await pending;
  return error;
}
function refused(error: unknown, reason: string) {
  expect(String(error)).toContain(reason);
  expect(logs.some((line) => line.includes("Successfully deployed"))).toBe(
    false,
  );
}

test("old healthy replicas do not prove the new deployment rolled out", async () => {
  clock();
  responses = [
    resource(),
    resource("Deployment", {
      replicas: 3,
      updatedReplicas: 1,
      availableReplicas: 2,
    }),
    resource(),
  ];
  expect(await run()).toBeUndefined();
  expect(requests.filter((r) => r.method === "GET")).toHaveLength(2);
});
test("accepted deployment completes only after its generation is observed", async () => {
  clock();
  responses = [
    resource(),
    resource("Deployment", { observedGeneration: 8 }),
    resource(),
  ];
  expect(await run()).toBeUndefined();
  expect(requests).toHaveLength(3);
});
for (const [name, changed] of [
  ["generation", { metadata: { uid: "workload-uid", generation: 10 } }],
  ["UID", { metadata: { uid: "replacement", generation: 9 } }],
  [
    "image",
    {
      spec: {
        ...resource().spec,
        template: {
          spec: { containers: [{ name: "server", image: "image:other" }] },
        },
      },
    },
  ],
] as const)
  test(`superseded ${name} refuses`, async () => {
    clock();
    responses = [resource(), { ...resource(), ...changed }];
    refused(await run(), "rollout-superseded");
  });
test("progress deadline refuses without success", async () => {
  clock();
  responses = [
    resource(),
    resource("Deployment", {
      conditions: [
        {
          type: "Progressing",
          status: "False",
          reason: "ProgressDeadlineExceeded",
        },
      ],
    }),
  ];
  refused(await run(), "rollout-progress-deadline");
});
for (const [name, answer, reason] of [
  ["HTTP", 503, "rollout-read-failed"],
  ["malformed", { status: "broken" }, "rollout-observation-invalid"],
  ["invalid JSON", "invalid-json", "rollout-observation-invalid"],
  ["transport", new Error("credential-secret"), "rollout-read-failed"],
  ["hung read", "hang", "rollout-timeout"],
  ["hung response body", "hang-body", "rollout-timeout"],
] as const)
  test(`${name} never returns deployment success`, async () => {
    clock();
    responses = [resource(), answer];
    const error = await run();
    refused(error, reason);
    expect(String(error)).not.toContain("credential-secret");
    if (answer === "hang" || answer === "hang-body") {
      expect(now).toBe(300000);
      expect(requests.at(-1)?.destroyed).toBe(true);
    }
  });
test("pending deployment expires at the bounded window", async () => {
  clock();
  responses = [resource(), resource("Deployment", { updatedReplicas: 0 })];
  refused(await run(), "rollout-timeout");
  expect(now).toBe(300000);
});
test("missing accepted patch witness refuses", async () => {
  clock();
  responses = [{}];
  refused(await run(), "rollout-acceptance-invalid");
  expect(requests).toHaveLength(1);
});
test("zero desired replicas complete only without remaining replicas", async () => {
  clock();
  const zero = resource("Deployment", {
    replicas: 0,
    updatedReplicas: 0,
    availableReplicas: 0,
  });
  zero.spec.replicas = 0;
  responses = [
    zero,
    {
      ...zero,
      status: {
        ...zero.status,
        replicas: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    },
    zero,
  ];
  expect(await run()).toBeUndefined();
  expect(requests).toHaveLength(3);
});
for (const [kind, type, pending] of [
  ["StatefulSet", "stateful-set", { currentRevision: "old" }],
  ["DaemonSet", "daemon-set", { updatedNumberScheduled: 1 }],
] as const)
  test(`${kind} uses its own completion evidence`, async () => {
    clock();
    responses = [resource(kind), resource(kind, pending), resource(kind)];
    expect(await run(type)).toBeUndefined();
    expect(requests).toHaveLength(3);
  });
for (const [kind, type] of [
  ["StatefulSet", "stateful-set"],
  ["DaemonSet", "daemon-set"],
])
  test(`${kind} manual updates refuse automatic rollout`, async () => {
    clock();
    const manual = resource(kind);
    manual.spec.updateStrategy.type = "OnDelete";
    responses = [manual, manual];
    refused(await run(type), "rollout-strategy-unsupported");
  });
test("stateful partition completion uses its declared updated population", async () => {
  clock();
  const partitioned = resource("StatefulSet", {
    currentRevision: "old",
    updatedReplicas: 1,
  });
  (partitioned.spec.updateStrategy as any).rollingUpdate = { partition: 1 };
  responses = [partitioned, partitioned];
  expect(await run("stateful-set")).toBeUndefined();
});
test("Job and operator-managed workloads retain their skip semantics", async () => {
  clock();
  responses = [];
  expect(await run("job")).toBeUndefined();
  expect(await run("stateful-set", "postgres")).toBeUndefined();
  expect(requests).toHaveLength(0);
});
test("CronJob patch acceptance does not claim a scheduled job ran", async () => {
  clock();
  const accepted = resource("CronJob") as any;
  accepted.spec.jobTemplate = { spec: { template: accepted.spec.template } };
  responses = [accepted];
  expect(await run("cron-job")).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(logs.join(" ")).toContain("template");
});

for (const accepted of [
  { ...resource(), kind: "StatefulSet" },
  { ...resource(), metadata: { generation: 9 } },
  {
    ...resource(),
    spec: {
      ...resource().spec,
      template: { spec: { containers: [{ name: "server", image: "wrong" }] } },
    },
  },
])
  test("accepted patch must witness the requested workload and image", async () => {
    clock();
    responses = [accepted];
    refused(await run(), "rollout-acceptance-invalid");
    expect(requests).toHaveLength(1);
  });
test("patch HTTP failure exposes no response body", async () => {
  clock();
  responses = [403];
  refused(await run(), "rollout-patch-failed");
  expect(requests).toHaveLength(1);
});
