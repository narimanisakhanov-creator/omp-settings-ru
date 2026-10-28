import { compareVersions } from "./policy";
import { SUPPORT_WINDOW_SIZE } from "./paths";

/**
 * Целевое окно из реестра npm.
 *
 * Источник — полный packument пакета `@oh-my-pi/pi-coding-agent`: берутся три максимальные опубликованные
 * **стабильные** версии. `dist-tags.latest` не ограничивает окно: отставший тег не должен скрывать более
 * новую стабильную версию. Latest проверяется как существующая стабильная запись, но арифметикой patch
 * версии не выводятся.
 *
 * Модуль чистый: сеть и разбор ответа живут у вызывающего, здесь — только решение по уже прочитанным данным.
 */

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE = /-/;

/** Поле объекта без unchecked-приведения: доступ проверяется `in`/`typeof`. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** All published stable versions in numeric order; malformed packuments are rejected. */
export function publishedStableVersions(metadata: unknown): readonly string[] {
  const versions = field(metadata, "versions");
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) throw new Error("registry-window-invalid");
  const stable: string[] = [];
  for (const [version, value] of Object.entries(versions as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("registry-window-invalid");
    if (PRERELEASE.test(version) || !STABLE.test(version)) continue;
    stable.push(version);
  }
  return stable.sort(compareVersions);
}

/**
 * Три последние стабильные версии реестра.
 *
 * `latest` не расширяет и не сужает результат: он только обязан быть одной из стабильных записей, иначе
 * packument противоречив и решение по нему не принимается.
 */
export function selectUpstreamWindow(metadata: unknown): readonly string[] {
  const stable = publishedStableVersions(metadata);
  const tags = field(metadata, "dist-tags");
  const latestVersion = field(tags, "latest");
  if (typeof tags !== "object" || tags === null || Array.isArray(tags) || typeof latestVersion !== "string" || !STABLE.test(latestVersion) || !stable.includes(latestVersion)) {
    throw new Error("registry-window-invalid");
  }
  if (stable.length === 0) throw new Error("registry-window-invalid");
  return stable.slice(-SUPPORT_WINDOW_SIZE);
}

/** Очередь догоняния: члены окна новее принятого пина, от старой к новой. */
export function pendingWindowVersions(window: readonly string[], pinned: string): readonly string[] {
  return window.filter(version => compareVersions(version, pinned) > 0).sort(compareVersions);
}
