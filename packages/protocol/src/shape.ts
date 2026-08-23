/** Small, dependency-free helpers for closed-schema checks. */

/** A JSON object literal: not null, not an array, not a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Throws `makeError` for any key of `object` not in `allowed`. */
export function assertOnlyKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  makeError: (message: string) => Error,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw makeError(`unknown field \`${key}\``);
  }
}

/** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$` */
export const ARTIFACT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}
