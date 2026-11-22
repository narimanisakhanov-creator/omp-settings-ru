import { rm } from "node:fs/promises";

/**
 * Ожидание освобождения файла/каталога, который держит только что завершившийся нативный хост.
 *
 * На Windows маппинг `pi_natives*.node`, открытые дескрипторы и рабочий каталог дочернего процесса
 * освобождаются заметно позже `child.exited`, поэтому первый `rm`/`unlink` падает EPERM/EBUSY.
 * Это ожидание внешнего события ОС: сигнала, который можно было бы дождаться, нет, а поддельные
 * таймеры не могут разблокировать чужой file mapping. Бюджет ограничен десятью секундами — если
 * файл держат и дальше, это настоящая утечка, и ошибка обязана дойти до теста, а не превратиться
 * в зелёный прогон с мусором в TEMP.
 */
const RELEASE_CODES: Readonly<Record<string, true>> = { EPERM: true, EBUSY: true, EACCES: true, ENOTEMPTY: true };
const RELEASE_DEADLINE_MS = 10_000;

export async function withWindowsRelease<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + RELEASE_DEADLINE_MS;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || code === undefined || !Object.hasOwn(RELEASE_CODES, code) || Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

/** Удаление одноразового корня теста, под которым работал нативный хост. */
export async function removeOwnedTemp(path: string): Promise<void> {
  await withWindowsRelease(() => rm(path, { recursive: true, force: true }));
}
