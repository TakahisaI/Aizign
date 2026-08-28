/** Version-independent lexical scan shared by both frame decoders. */

export type JsonTokenFailureKind = 'duplicate-member' | 'invalid-unicode' | 'noncanonical-number';

export interface JsonTokenFailure {
  readonly kind: JsonTokenFailureKind;
  readonly index: number;
  readonly inPayload: boolean;
  readonly message: string;
}

export interface JsonTokenScan {
  /** Fatal JSON grammar defect; callers must reject it before correlation recovery. */
  readonly syntaxError: {
    readonly index: number;
    readonly message: string;
  } | null;
  readonly failure: JsonTokenFailure | null;
  /** JSON text with every number token replaced by `0` for lossless probing. */
  readonly probeText: string;
  /** Whether the complete JSON value is an object at the root. */
  readonly topLevelObject: boolean;
  /** Losslessly recovered, well-formed top-level string values. */
  readonly topLevelStrings: ReadonlyMap<string, string>;
  /** Losslessly recovered top-level boolean values. */
  readonly topLevelBooleans: ReadonlyMap<string, boolean>;
  /** `error.code`, when `error` is a top-level object with a string code. */
  readonly errorCode: string | undefined;
  /** Raw top-level number spellings, before any JavaScript numeric coercion. */
  readonly topLevelNumbers: ReadonlyMap<string, string>;
}

const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;

interface ObjectLevel {
  readonly kind: 'object';
  readonly keys: Set<string>;
  readonly inPayload: boolean;
  readonly inError: boolean;
  pendingKey: string | undefined;
}

interface ArrayLevel {
  readonly kind: 'array';
  readonly inPayload: boolean;
  readonly inError: boolean;
}

type Level = ObjectLevel | ArrayLevel;

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
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

function decodedString(text: string, start: number, end: number): string | null {
  try {
    const value: unknown = JSON.parse(text.slice(start, end));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
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

function nextNonWhitespace(text: string, from: number): number {
  let index = from;
  while (isJsonWhitespace(text[index])) index += 1;
  return index;
}

function valueIsPayload(levels: readonly Level[]): boolean {
  const parent = levels.at(-1);
  if (parent === undefined) return false;
  if (parent.inPayload) return true;
  return levels.length === 1 && parent.kind === 'object' && parent.pendingKey === 'payload';
}

function valueIsError(levels: readonly Level[]): boolean {
  const parent = levels.at(-1);
  if (parent === undefined) return false;
  if (parent.inError) return true;
  return levels.length === 1 && parent.kind === 'object' && parent.pendingKey === 'error';
}

function consumePendingKey(levels: readonly Level[]): void {
  const parent = levels.at(-1);
  if (parent?.kind === 'object') parent.pendingKey = undefined;
}

function numberEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === undefined || isJsonWhitespace(char) || ',]}:'.includes(char)) break;
    index += 1;
  }
  return index;
}

/**
 * Scans every JSON string/member/number token before `JSON.parse` can fold or
 * coerce it. Other JSON grammar remains owned by the normal parser.
 */
export function scanJsonTokens(text: string): JsonTokenScan {
  try {
    JSON.parse(text);
  } catch {
    return {
      syntaxError: { index: 0, message: 'frame is not valid JSON' },
      failure: null,
      probeText: text,
      topLevelObject: false,
      topLevelStrings: new Map(),
      topLevelBooleans: new Map(),
      errorCode: undefined,
      topLevelNumbers: new Map(),
    };
  }
  const levels: Level[] = [];
  const topLevelStrings = new Map<string, string>();
  const topLevelBooleans = new Map<string, boolean>();
  const topLevelNumbers = new Map<string, string>();
  const replacements: Array<{
    start: number;
    end: number;
    replacement: '0' | 'null' | '\"\"';
  }> = [];
  let syntaxError: { index: number; message: string } | null = null;
  let failure: JsonTokenFailure | null = null;
  let errorCode: string | undefined;
  let index = 0;

  const fail = (candidate: JsonTokenFailure) => {
    if (failure === null || candidate.index < failure.index) failure = candidate;
  };

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;
    if (char === '"') {
      const end = endOfString(text, index);
      if (end === null) {
        syntaxError ??= {
          index,
          message: 'frame contains an unterminated JSON string',
        };
        break;
      }
      const decoded = decodedString(text, index, end);
      if (decoded === null) {
        syntaxError ??= {
          index,
          message: 'frame contains an invalid JSON string token',
        };
      }
      const after = nextNonWhitespace(text, end);
      const parent = levels.at(-1);
      const isMemberName = text[after] === ':' && parent?.kind === 'object';
      if (decoded !== null && !isWellFormedUnicode(decoded)) {
        fail({
          kind: 'invalid-unicode',
          index,
          inPayload: valueIsPayload(levels) || levels.at(-1)?.inPayload === true,
          message: 'JSON member names and string values must be well-formed Unicode',
        });
        replacements.push({
          start: index,
          end,
          replacement: isMemberName ? '""' : 'null',
        });
      }
      if (isMemberName && decoded !== null) {
        if (parent.keys.has(decoded)) {
          fail({
            kind: 'duplicate-member',
            index,
            inPayload: parent.inPayload || (levels.length === 1 && decoded === 'payload'),
            message: 'frame repeats a JSON member; repeated members are not part of the contract',
          });
        }
        parent.keys.add(decoded);
        parent.pendingKey = decoded;
      } else {
        if (decoded !== null && isWellFormedUnicode(decoded)) {
          if (levels.length === 1 && parent?.kind === 'object' && parent.pendingKey !== undefined) {
            topLevelStrings.set(parent.pendingKey, decoded);
          }
          if (parent?.kind === 'object' && parent.inError && parent.pendingKey === 'code') {
            errorCode = decoded;
          }
        }
        consumePendingKey(levels);
      }
      index = end;
      continue;
    }

    if (char === '{' || char === '[') {
      const inPayload = valueIsPayload(levels);
      const inError = valueIsError(levels);
      consumePendingKey(levels);
      levels.push(
        char === '{'
          ? {
              kind: 'object',
              keys: new Set(),
              inPayload,
              inError,
              pendingKey: undefined,
            }
          : { kind: 'array', inPayload, inError },
      );
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      levels.pop();
      index += 1;
      continue;
    }

    if (char === '-' || (char >= '0' && char <= '9')) {
      const end = numberEnd(text, index);
      const token = text.slice(index, end);
      if (!JSON_NUMBER.test(token)) {
        syntaxError ??= {
          index,
          message: 'frame contains an invalid JSON number token',
        };
        index = end;
        continue;
      }
      const parent = levels.at(-1);
      const topLevelKey =
        levels.length === 1 && parent?.kind === 'object' ? parent.pendingKey : undefined;
      if (topLevelKey !== undefined) topLevelNumbers.set(topLevelKey, token);
      const inPayload = valueIsPayload(levels);
      if (!CANONICAL_INTEGER.test(token)) {
        fail({
          kind: 'noncanonical-number',
          index,
          inPayload,
          message: 'Protocol numbers must use canonical integer spelling',
        });
      }
      replacements.push({ start: index, end, replacement: '0' });
      consumePendingKey(levels);
      index = end;
      continue;
    }

    if (char === 't' || char === 'f' || char === 'n') {
      const parent = levels.at(-1);
      const topLevelKey =
        levels.length === 1 && parent?.kind === 'object' ? parent.pendingKey : undefined;
      if (
        topLevelKey !== undefined &&
        (text.startsWith('true', index) || text.startsWith('false', index))
      ) {
        topLevelBooleans.set(topLevelKey, text.startsWith('true', index));
      }
      consumePendingKey(levels);
    }
    index += 1;
  }

  let probeText = '';
  let copied = 0;
  for (const replacement of replacements) {
    probeText += `${text.slice(copied, replacement.start)}${replacement.replacement}`;
    copied = replacement.end;
  }
  probeText += text.slice(copied);
  return {
    syntaxError,
    failure,
    probeText,
    topLevelObject: text.trimStart().startsWith('{'),
    topLevelStrings,
    topLevelBooleans,
    errorCode,
    topLevelNumbers,
  };
}
