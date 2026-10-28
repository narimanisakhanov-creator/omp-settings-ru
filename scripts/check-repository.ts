/**
 * Состав отслеживаемого дерева: личные материалы и служебные каталоги не публикуются.
 *
 * Проверяется ровно то, что попало в Git (`git ls-files -z`), а не рабочее дерево: игнорируемые локальные
 * файлы остаются личными и не удаляются. Совпадение описывается только путём и кодом — содержимое
 * найденного файла не читается и не печатается.
 */

// Точные имена каталогов, а не широкие glob-ы: проектные данные (`*.json`, `*.md`, снимки, отчёты)
// остаются разрешёнными, иначе защита запретила бы сам репозиторий.
const PRIVATE_DIRECTORIES: readonly string[] = [".kiro", ".tools", ".smoke", ".agents", ".hiro", ".triage", ".orca", ".firecrawl"];
const PRIVATE_SUFFIXES: readonly string[] = [".log", ".dump", ".tmp"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Код находки; управляющие символы в имени экранируются, чтобы путь не подделал строку журнала. */
export function privateArtifactCode(path: string): string {
  return `private-project-artifact:${CONTROL_CHARACTERS.test(path) ? JSON.stringify(path) : path}`;
}

/**
 * Нарушение для одного отслеживаемого пути либо `undefined`.
 *
 * Запрещены служебные каталоги агентов и трасс на любой глубине, корневые `*_PLAN.md`, json-копии
 * приватного канала, `.env`/`.env.*` кроме `.env.example`, а также журналы, дампы и временные файлы.
 */
export function trackedPathViolation(path: string): string | undefined {
  if (!path) return undefined;
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (segments.some(segment => PRIVATE_DIRECTORIES.includes(segment))) return privateArtifactCode(path);
  // Корневой план — черновик владельца; проектная документация внутри каталогов остаётся.
  if (segments.length === 1 && name.endsWith("_PLAN.md")) return privateArtifactCode(path);
  if (name.endsWith(".json") && name.includes("private-backup")) return privateArtifactCode(path);
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return privateArtifactCode(path);
  if (PRIVATE_SUFFIXES.some(suffix => name.endsWith(suffix))) return privateArtifactCode(path);
  return undefined;
}

/** Находки по списку путей в порядке перечисления; один путь даёт не больше одного кода. */
export function repositoryViolations(paths: readonly string[]): readonly string[] {
  const failures: string[] = [];
  for (const path of paths) {
    const violation = trackedPathViolation(path);
    if (violation) failures.push(violation);
  }
  return failures;
}

/** Отслеживаемые пути текущего checkout; отказ чтения — ошибка, а не пустой список. */
export function trackedPaths(cwd: string = process.cwd()): readonly string[] {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (listing.exitCode !== 0) throw new Error("tracked-files-unavailable");
  return listing.stdout.toString().split("\0").filter(path => path.length > 0);
}

function main(): void {
  const paths = trackedPaths();
  const failures = repositoryViolations(paths);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`repository-composition-invalid:${failures.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`repository-composition-ok:${paths.length}`);
}

if (import.meta.main) main();
