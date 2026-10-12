import "../pulumi-cloud-mocks";

export function loadSandboxHost(): Promise<typeof import("../../sandbox-host/index")> {
  return import("../../sandbox-host/index");
}
