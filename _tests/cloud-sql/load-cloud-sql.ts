import { mock } from "bun:test";

export type Captured = { kind: string; name: string; args: Record<string, any>; opts?: Record<string, any> };

export const captured: Captured[] = [];

function capturing(kind: string, outputs: (name: string) => Record<string, unknown> = () => ({})) {
  return class {
    constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
      captured.push({ kind, name, args, opts });
      Object.assign(this, outputs(name));
    }
  };
}

mock.module("@pulumi/gcp", () => ({
  sql: {
    DatabaseInstance: capturing("DatabaseInstance", (name) => ({
      name: `${name}-name`,
      connectionName: `proj:region:${name}-name`,
      publicIpAddress: `public-${name}`,
      privateIpAddress: `private-${name}`,
    })),
    Database: capturing("Database"),
    User: capturing("User"),
  },
  compute: { GlobalAddress: capturing("GlobalAddress", (name) => ({ name: `${name}-range` })) },
  servicenetworking: { Connection: capturing("Connection") },
}));

const output = (value: unknown): any => ({
  apply: (f: (x: unknown) => unknown) => output(f(value)),
  value,
});

mock.module("@pulumi/pulumi", () => ({
  output,
  secret: (value: unknown) => value,
  all: (values: unknown[]) => output(values),
}));

let definition: any;
let implementation: any;

mock.module("@sdlcworks/components", () => ({
  InfraComponent: class {
    constructor(value: unknown) {
      definition = value;
    }
    implement(_provider: string, value: unknown) {
      implementation = value;
    }
  },
  connectionHandler: (value: unknown) => value,
}));

mock.module("../../_internal/interfaces", () => ({
  PostgresCI: { name: "postgres" },
  MysqlCI: { name: "mysql" },
}));

let loaded: Promise<typeof import("../../cloud-sql/index")> | undefined;

export async function loadCloudSql() {
  loaded ??= import("../../cloud-sql/index");
  const module = await loaded;
  return { module, definition, implementation };
}

export function reset(): void {
  captured.length = 0;
}

export const naming = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);
