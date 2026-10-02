export {
  captured,
  resetCaptured,
  namingTag,
  type CapturedResource,
} from "../pulumi-cloud-mocks";

export function loadServerlessFn(): Promise<
  typeof import("../../serverless-fn/index")
> {
  return import("../../serverless-fn/index");
}
