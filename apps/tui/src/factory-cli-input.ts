import { isAbsolute, resolve } from "node:path";

const factoryTaskIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;

export function isNormalizedAbsolutePath(value: string | undefined): value is string {
  return (
    value !== undefined &&
    isAbsolute(value) &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= 4_096 &&
    resolve(value) === value
  );
}

export function isFactoryTaskId(value: string | undefined): value is string {
  return value !== undefined && factoryTaskIdPattern.test(value);
}

export function isSha256Digest(value: string | undefined): value is `sha256:${string}` {
  return value !== undefined && sha256DigestPattern.test(value);
}

export function isFactoryAuthorityReason(value: string | undefined): value is string {
  if (value === undefined) return false;
  return (
    value === value.trim() && value.length >= 1 && value.length <= 500 && !value.includes("\0")
  );
}
