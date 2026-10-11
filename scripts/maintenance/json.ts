/**
 * Чтение недоверенного JSON из внешних границ (gh, orca) без необъявленных приведений типа.
 *
 * Все значения приходят из сети или из RPC, поэтому каждое поле проверяется в рантайме; чтение отсутствующего
 * или неверно типизированного поля даёт `undefined`, а не выдуманную форму.
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
