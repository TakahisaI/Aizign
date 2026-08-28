/** Small, dependency-free helpers for closed-schema checks. */

/** A JSON object literal: not null, not an array, not a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validates one closed DTO object without invoking source accessors. */
export function assertClosedObject(
  value: unknown,
  allowed: readonly string[],
  makeError: (message: string) => Error,
  path = 'value',
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw makeError(`${path} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw makeError(`${path} has an unsupported symbol key`);
    if (!allowed.includes(key)) throw makeError(`unknown field \`${key}\``);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw makeError(`${path}.${key} must be an own data property`);
    }
  }
}

/** Reads a required own data property after closed-object validation. */
export function ownDataValue(
  object: Record<string, unknown>,
  key: string,
  makeError: (message: string) => Error,
  path = 'value',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw makeError(`${path}.${key} must be a required own data property`);
  }
  return descriptor.value;
}

/** Validates a normal dense array without invoking source accessors. */
export function arrayValues(
  value: unknown,
  makeError: (message: string) => Error,
  path = 'value',
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw makeError(`${path} must be a plain array`);
  }
  const result: unknown[] = [];
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw makeError(`${path} has an unsupported own property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw makeError(`${path}[${index}] must be an own data property`);
    }
    Object.defineProperty(result, String(index), {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (keys.length !== result.length + 1) {
    throw makeError(`${path} must not contain out-of-range array properties`);
  }
  return result;
}

/** Throws `makeError` for any key of `object` not in `allowed`. */
export function assertOnlyKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  makeError: (message: string) => Error,
): void {
  assertClosedObject(object, allowed, makeError);
}

/** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$` */
export const ARTIFACT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}
