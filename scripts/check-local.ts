import { isAbsolute } from "node:path";

/**
 * Локальный прогон того же suite, что `check.yml`.
 *
 * В CI хосты и окружение готовит job: `scripts/ci/prepare-host.ts` кладёт абсолютный
 * `OMP_UPDATER_EXECUTABLE`, а сам раннер выставляет `CI`. Локально эти условия надо воспроизвести,
 * иначе тесты падают не из-за кода: `updaterTestExecutable` требует явный хост при `CI`, а
 * `lockVerdict` требует ровно ту версию bun, что записана в `packageManager`.
 *
 * Скрипт ничего не проверяет вместо `check`: он только выравнивает среду и запускает его.
 */

const manifest = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as { packageManager?: unknown };
const pinned = typeof manifest.packageManager === "string" ? /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1] : undefined;
if (!pinned) throw new Error("check-local-package-manager-invalid");
if (Bun.version !== pinned) {
  console.error(`check-local: нужен bun ${pinned} из packageManager, запущен ${Bun.version}`);
  process.exit(1);
}

const executable = process.env.OMP_UPDATER_EXECUTABLE ?? Bun.which("omp");
if (!executable || !isAbsolute(executable)) {
  console.error("check-local: нужен абсолютный путь к omp; задай OMP_UPDATER_EXECUTABLE или положи omp в PATH");
  process.exit(1);
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
// CI-маркеры включают требование job-owned хоста; локально хост уже проверен выше.
delete env.CI;
delete env.GITHUB_ACTIONS;
env.OMP_UPDATER_EXECUTABLE = executable;

const child = Bun.spawn([process.execPath, "run", "check"], { env, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
