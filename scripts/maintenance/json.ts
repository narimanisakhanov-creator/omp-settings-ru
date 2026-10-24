/**
 * Чтение недоверенного JSON из файлов, API и RPC без необъявленных приведений типа.
 *
 * Внешние значения проверяются в рантайме; чтение отсутствующего или неверно типизированного
 * поля даёт `undefined`. Строгий парсер дополнительно запрещает неоднозначные повторные ключи.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readRecords(record: Record<string, unknown> | undefined, key: string): readonly Record<string, unknown>[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

/** Первое непустое строковое поле по цепочке вложенных объектов. */
export function readPath(value: unknown, ...keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return typeof current === "string" ? current : undefined;
}

/** Duplicate keys (including escaped spellings) make untrusted JSON ambiguous. */
export function parseStrictJSON(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const frames: (Set<string> | undefined)[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === "{") frames.push(new Set());
    else if (value === "[") frames.push(undefined);
    else if (value === "}" || value === "]") frames.pop();
    else if (/^\s*:/.test(text.slice(token.index! + value.length))) {
      const keys = frames[frames.length - 1];
      const key: string = JSON.parse(value);
      if (!keys || keys.has(key)) throw new Error("json-duplicate-key");
      keys.add(key);
    }
  }
  return parsed;
}
