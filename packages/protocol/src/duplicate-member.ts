/**
 * Duplicate-member detection shared by both frame decoders.
 *
 * A repeated JSON member has no single meaning: a streaming parser keeps
 * the first spelling or rejects it while `JSON.parse` folds to the last,
 * so the Rust and TypeScript implementations must both refuse such frames
 * lexically, before any interpretation. This marker lets callers map that
 * one lexical rule onto each direction's own error shape without leaking
 * parse internals into the public API.
 */
/** Marks the duplicate-member rejection so callers can map it per direction. */
export class DuplicateMemberError extends Error {
  constructor() {
    super('frame repeats a JSON member; repeated members are not part of the contract');
    this.name = 'DuplicateMemberError';
  }
}

/** Marks a JSON string token that is not a Unicode scalar sequence. */
export class InvalidUnicodeError extends Error {
  constructor() {
    super('JSON member names and string values must be well-formed Unicode');
    this.name = 'InvalidUnicodeError';
  }
}

const MAX_SCAN_DEPTH = 128;
const ARRAY_LEVEL = Symbol('array level');
type Level = Set<string> | typeof ARRAY_LEVEL | undefined;

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function decodedName(text: string, start: number, end: number): string | null {
  try {
    const value: unknown = JSON.parse(text.slice(start, end));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function endOfString(text: string, start: number): number | null {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  return null;
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Finds a string token containing a lone UTF-16 surrogate. This lexical pass
 * sees every token, including values that `JSON.parse` would discard while
 * folding duplicate members.
 */
export function findInvalidUnicode(text: string): InvalidUnicodeError | null {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const end = endOfString(text, index);
    if (end === null) return null;
    const decoded = decodedName(text, index, end);
    if (decoded !== null && !isWellFormedUnicode(decoded)) return new InvalidUnicodeError();
    index = end;
  }
  return null;
}

/**
 * Finds a repeated decoded member name at any object depth. The scan is
 * deliberately tolerant of other syntax errors: the normal JSON parser owns
 * those. Decoding the key token makes `"a"` and `"\\u0061"` the same name.
 */
export function findDuplicateMember(text: string): DuplicateMemberError | null {
  const levels: Level[] = [];
  let depth = 0;
  let index = 0;
  let stringStart = -1;
  let stringEnd = -1;

  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      stringStart = index;
      const end = endOfString(text, index);
      if (end === null) return null;
      index = end;
      stringEnd = end;
      continue;
    }
    if (char === '{') {
      depth += 1;
      if (depth > MAX_SCAN_DEPTH) return null;
      levels[depth] = new Set();
      index += 1;
      continue;
    }
    if (char === '[') {
      depth += 1;
      if (depth > MAX_SCAN_DEPTH) return null;
      levels[depth] = ARRAY_LEVEL;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      levels[depth] = undefined;
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === ':') {
      let before = index - 1;
      while (before >= 0 && isJsonWhitespace(text[before])) before -= 1;
      const level = levels[depth];
      if (
        before === stringEnd - 1 &&
        stringStart >= 0 &&
        level !== undefined &&
        level !== ARRAY_LEVEL
      ) {
        const name = decodedName(text, stringStart, stringEnd);
        if (name !== null) {
          if (level.has(name)) return new DuplicateMemberError();
          level.add(name);
        }
      }
    }
    index += 1;
  }
  return null;
}
