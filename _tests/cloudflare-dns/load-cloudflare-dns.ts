export {
  captured,
  resetCaptured,
  namingTag,
  type CapturedResource,
} from "../pulumi-cloud-mocks";

export function loadCloudflareDns(): Promise<
  typeof import("../../url-registers/cloudflare-dns/index")
> {
  return import("../../url-registers/cloudflare-dns/index");
}
