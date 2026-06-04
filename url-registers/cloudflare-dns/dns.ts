import { RECORD_TYPE, type RecordType } from "./constants";

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const IPV6_CORE = /^[0-9a-fA-F:.]+$/;
const IPV6_SEGMENT = /^[0-9a-fA-F]{1,4}$/;
const MAX_OCTET_VALUE = 255;
const IPV6_MAX_SEGMENTS = 8;

export function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!IPV4_OCTET.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= MAX_OCTET_VALUE;
  });
}

export function isIPv6(value: string): boolean {
  // Strip optional [...] brackets and %zone-id suffix used in URIs.
  const unbracketed = value.replace(/^\[|\]$/g, "");
  const [core] = unbracketed.split("%");
  if (!core || !core.includes(":")) return false;
  if (!IPV6_CORE.test(core)) return false;

  const doubleColonCount = (core.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return false;

  let segments = core.split(":");

  // IPv4-mapped tail: e.g. ::ffff:192.0.2.1 → last segment is dotted-quad.
  const last = segments[segments.length - 1];
  if (last && last.includes(".")) {
    if (!isIPv4(last)) return false;
    // An embedded IPv4 occupies two 16-bit segments.
    segments = [...segments.slice(0, -1), "0", "0"];
  }

  if (segments.length > IPV6_MAX_SEGMENTS) return false;
  if (doubleColonCount === 0 && segments.length !== IPV6_MAX_SEGMENTS) return false;

  return segments.every((seg) => seg === "" || IPV6_SEGMENT.test(seg));
}

export function inferRecordType(host: string): RecordType {
  const trimmed = host.trim();
  if (isIPv4(trimmed)) return RECORD_TYPE.A;
  if (isIPv6(trimmed)) return RECORD_TYPE.AAAA;
  return RECORD_TYPE.CNAME;
}
