import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SNAPSHOT_DIR } from "./paths";

/**
 * Доверенная среда измерения.
 *
 * Два блокера, которые это решает, — корректность, а не стиль:
 *
 * 1. **Lockfile.** Законный выпуск добавляет пин нового хоста, а значит и разрешение в `bun.lock`. Сравнение
 *    lock-файла с базой по байтам запрещало бы ровно то изменение, ради которого выпуск и делается. Здесь
 *    lock-файл кандидата сравнивается с тем, который Bun сам считает из **принятого** манифеста с наложенной
 *    строго проверенной дельтой. Дельта выводится из версии кандидата: `omp-host-<версия без точек>` и ровно
 *    `npm:@oh-my-pi/pi-coding-agent@<версия>`. Затравка — базовый lock-файл, поэтому граф посторонних
 *    зависимостей остаётся базовым. Сравнение нормализованное: формат lock-файла — не контракт, а граф
 *    разрешений им является (Bun не переписывает поле `version` рабочего пакета, и это не изменение графа).
 *
 * 2. **Окружение импорта.** Измерение разрешает хост из `node_modules` рабочего дерева, а `node_modules`
 *    игнорируется git, то есть лежит вне любого сравнения байтов. Здесь измерение идёт в отдельном корне:
 *    код и конфигурация — из принятого коммита, каталог и базовые снимки — из проверяемого дерева как
 *    **данные**, а установленный хост подтверждается SRI из lock-файла и пересчётом его каталогов.
 *
 * Отпечаток установленного хоста — свидетельство, а не аутентификация: авторитетно здесь значение SRI,
 * посчитанное по фактическому ответу реестра.
 */

export type EnvironmentFailure = { readonly failure: string };

/** Пин хоста, разрешённый к добавлению: имя выводится из версии, спецификация — точная запись реестра. */
export interface ApprovedHostPin {
  readonly alias: string;
  readonly version: string;
  readonly spec: string;
}

/**
 * Строго проверенная дельта кандидата: версия выпуска, пины новых хостов, диапазоны peer того же семейства и
 * обновлённые прямые пины `@oh-my-pi/pi-*`. Всё остальное манифеста обязано совпасть с принятым.
 */
export interface ApprovedDelta {
  readonly releaseVersion: string;
  readonly hostPins: readonly ApprovedHostPin[];
  readonly peers: readonly { readonly name: string; readonly value: string }[];
  readonly devPins: readonly { readonly name: string; readonly value: string }[];
}

export interface LockExpectation {
  readonly lock: string;
  readonly digest: string;
  readonly bunVersion: string;
}

export interface HostIdentity {
  readonly alias: string;
  readonly version: string;
  /** SRI из lock-файла для этого алиаса — авторитетное значение ответа реестра. */
  readonly integrity: string;
  /** Отпечаток установленных каталогов хоста и его прямых зависимостей. */
  readonly closureDigest: string;
}

const HOST_ALIAS = /^omp-host-([0-9]+)$/;
const HOST_SPEC = /^npm:@oh-my-pi\/pi-coding-agent@(\d+\.\d+\.\d+)$/;
const HOST_PACKAGE = /^@oh-my-pi\/pi-(coding-agent|natives|tui|utils)$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** Код и конфигурация измерения — только из принятого коммита. */
const TRUSTED_PATHS = ["scripts", "src", "tsconfig.json", "package.json", "bun.lock", "bunfig.toml"] as const;
/** Candidate inputs are data only; runtime and measuring code remain accepted bytes. */
const DATA_FILES = [
  "src/translations/ru-catalog.json", "src/translations/variant-review.json",
] as const;

/** Имя алиаса выводится из версии хоста — это и есть проверяемая связь имени и спецификации. */
export function hostAliasOf(version: string): string {
  return `omp-host-${version.replaceAll(".", "")}`;
}

/** Канонический вид значения: ключи отсортированы, поэтому порядок и форматирование записи не значат ничего. */
function canonical(value: unknown, dropWorkspaceVersion = false): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonical(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter(key => !(dropWorkspaceVersion && key === "version"))
      .map(key => `${JSON.stringify(key)}:${canonical(record[key], key === "workspaces" || dropWorkspaceVersion)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Строки манифеста — недоверенная граница: неверная форма даёт `undefined`, а не выдуманный объект. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringsOf(value: unknown): Record<string, string> | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") return undefined;
    result[key] = entry;
  }
  return result;
}

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    return recordOf(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** Члены диапазона `a || b || c`: версия подтверждается как отдельный член, а не подстрокой. */
function members(value: string): readonly string[] {
  return value.split("||").map(part => part.trim()).filter(Boolean);
}

/**
 * Дельта кандидата к принятому манифесту.
 *
 * Разрешено ровно то, из чего состоит выпуск хоста: версия плагина, прямые пины `@oh-my-pi/pi-*` на версию
 * кандидата, диапазоны peer того же семейства с названной версией и один пин нового хоста, имя которого
 * выводится из версии. Любое другое различие — произвольная зависимость, скрипт или поле — расширение
 * исполняемого кода за пределы измерения, поэтому отказ.
 */
export function approvedDelta(
  accepted: unknown, candidate: unknown, candidateVersion: string,
): { readonly ok: true; readonly delta: ApprovedDelta } | EnvironmentFailure {
  const before = recordOf(accepted);
  const after = recordOf(candidate);
  if (!before || !after) return { failure: "manifest-invalid" };
  if (!SEMVER.test(candidateVersion)) return { failure: "manifest-candidate-version-invalid" };

  const allowed = new Set(["version", "devDependencies", "peerDependencies"]);
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (allowed.has(key)) continue;
    if (canonical(before[key]) !== canonical(after[key])) return { failure: `manifest-field-changed:${key}` };
  }

  const releaseVersion = after.version;
  if (typeof releaseVersion !== "string" || !SEMVER.test(releaseVersion)) return { failure: "manifest-release-version-invalid" };
  if (releaseVersion === before.version) return { failure: "manifest-release-version-unverified" };

  const baseDev = stringsOf(before.devDependencies) ?? {};
  const nextDev = stringsOf(after.devDependencies);
  if (!nextDev) return { failure: "manifest-dependencies-invalid" };
  const devPins: { name: string; value: string }[] = [];
  const hostPins: ApprovedHostPin[] = [];
  for (const name of Object.keys(baseDev)) {
    if (!(name in nextDev)) return { failure: `manifest-dependency-removed:${name}` };
  }
  for (const name of Object.keys(nextDev).sort()) {
    const value = nextDev[name]!;
    if (baseDev[name] === value) continue;
    const alias = HOST_ALIAS.exec(name);
    if (alias) {
      if (name !== hostAliasOf(candidateVersion)) return { failure: `host-alias-unexpected:${name}` };
      const spec = HOST_SPEC.exec(value);
      if (!spec || spec[1] !== candidateVersion) return { failure: `host-pin-unverified:${name}` };
      hostPins.push({ alias: name, version: spec[1]!, spec: value });
      continue;
    }
    if (HOST_PACKAGE.test(name)) {
      if (value !== candidateVersion) return { failure: `package-pin-unverified:${name}` };
      devPins.push({ name, value });
      continue;
    }
    return { failure: `package-dependency-changed:${name}` };
  }
  if (hostPins.length === 0) return { failure: `host-pin-missing:${hostAliasOf(candidateVersion)}` };

  const basePeers = stringsOf(before.peerDependencies) ?? {};
  const nextPeers = stringsOf(after.peerDependencies);
  if (!nextPeers) return { failure: "manifest-peers-invalid" };
  const peers: { name: string; value: string }[] = [];
  for (const name of Object.keys({ ...basePeers, ...nextPeers }).sort()) {
    const value = nextPeers[name] ?? basePeers[name];
    if (value === undefined) continue;
    const previous = basePeers[name];
    if (!HOST_PACKAGE.test(name)) {
      if (previous !== value) return { failure: `peer-dependency-changed:${name}` };
      continue;
    }
    if (previous === value) continue;
    // Принятые члены диапазона обязаны выжить: поддержка исторических версий не сужается выпуском.
    if (previous !== undefined) {
      for (const member of members(previous)) {
        if (!members(value).includes(member)) return { failure: `peer-range-narrowed:${name}` };
      }
    }
    if (!members(value).includes(candidateVersion)) return { failure: `peer-range-unverified:${name}` };
    peers.push({ name, value });
  }
  return { ok: true, delta: { releaseVersion, hostPins, peers, devPins } };
}

/** Манифест измерения: принятый манифест с наложенной дельтой — иных различий в него попасть не может. */
export function manifestWithDelta(acceptedManifest: string, delta: ApprovedDelta): string | undefined {
  const manifest = parsed(acceptedManifest);
  if (!manifest) return undefined;
  const next: Record<string, unknown> = { ...manifest, version: delta.releaseVersion };
  if (delta.devPins.length > 0 || delta.hostPins.length > 0) {
    next.devDependencies = {
      ...(stringsOf(manifest.devDependencies) ?? {}),
      ...Object.fromEntries(delta.devPins.map(pin => [pin.name, pin.value])),
      ...Object.fromEntries(delta.hostPins.map(pin => [pin.alias, pin.spec])),
    };
  }
  if (delta.peers.length > 0) {
    next.peerDependencies = {
      ...(stringsOf(manifest.peerDependencies) ?? {}),
      ...Object.fromEntries(delta.peers.map(pin => [pin.name, pin.value])),
    };
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Запуск Bun-процесса с общим сроком всего измерения: установка не ждёт без предела, а остаток бюджета
 * расходуется на следующий шаг, а не выдаётся каждому шагу заново.
 */
function spawnBun(cwd: string, args: readonly string[], deadline: number): { code: number; stdout: string; stderr: string } {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { code: -1, stdout: "", stderr: "deadline" };
  const child = Bun.spawnSync(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: remaining });
  return { code: child.exitCode ?? -1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function gitShow(checkout: string, baseSha: string, path: string): Uint8Array | undefined {
  const child = Bun.spawnSync(["git", "show", `${baseSha}:${path}`], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  return child.exitCode === 0 ? child.stdout : undefined;
}

function committedPaths(checkout: string, baseSha: string): readonly string[] {
  const child = Bun.spawnSync(
    ["git", "ls-tree", "-r", "-z", "--name-only", baseSha, "--", ...TRUSTED_PATHS],
    { cwd: checkout, stdout: "pipe", stderr: "pipe" },
  );
  if (child.exitCode !== 0) throw new Error("accepted-tree-unavailable");
  return new TextDecoder().decode(child.stdout).split("\0").filter(Boolean);
}

/**
 * Ожидаемый lock-файл: Bun считает его из принятого манифеста с дельтой, затравкой служит **базовый**
 * lock-файл, поэтому граф посторонних зависимостей остаётся базовым, а не переразрешается заново.
 */
export async function expectedLock(input: {
  readonly acceptedManifest: string;
  readonly acceptedLock: string;
  readonly delta: ApprovedDelta;
  /** Собственная площадка: очищается здесь же и не может задеть разложенный принятый код. */
  readonly scratch: string;
  readonly cacheDir: string;
  readonly deadline: number;
  readonly registry?: string;
}): Promise<({ readonly ok: true } & LockExpectation) | EnvironmentFailure> {
  const manifest = manifestWithDelta(input.acceptedManifest, input.delta);
  if (!manifest) return { failure: "manifest-invalid" };
  try {
    await rm(input.scratch, { recursive: true, force: true });
    await mkdir(input.scratch, { recursive: true });
    await writeFile(join(input.scratch, "package.json"), manifest, "utf8");
    // Затравка — базовый lock-файл: базовый граф посторонних зависимостей сохраняется.
    await writeFile(join(input.scratch, "bun.lock"), input.acceptedLock, "utf8");
    const args = ["install", "--lockfile-only", "--ignore-scripts", "--cache-dir", input.cacheDir];
    if (input.registry) args.push(`--registry=${input.registry}`);
    const generated = spawnBun(input.scratch, args, input.deadline);
    if (generated.code !== 0) return { failure: "lock-generation-failed" };
    const lock = await readFile(join(input.scratch, "bun.lock"), "utf8").catch(() => undefined);
    if (lock === undefined) return { failure: "lock-generation-failed" };
    return { ok: true, lock, digest: digest(lock), bunVersion: Bun.version };
  } finally {
    await rm(input.scratch, { recursive: true, force: true });
  }
}

/** Разбор lock-файла Bun: он записан с висячими запятыми, поэтому строгий `JSON.parse` к нему неприменим. */
export function parseLock(text: string): Record<string, unknown> | undefined {
  try {
    return recordOf(JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Сверка lock-файла кандидата с ожидаемым.
 *
 * Сравнивается **граф разрешений** в каноническом виде, а не байты: формат записи — не контракт, контрактом
 * является набор пакетов, их версии, зависимости и значения SRI. Файл, отличающийся только форматированием,
 * принимается; файл с лишним пакетом, другой версией или другим SRI — нет. Версия Bun обязана совпасть:
 * сравнение lock-файлов разных версий доказывало бы не то, что нужно.
 */
export function lockVerdict(
  expected: LockExpectation, candidateLock: string, bunVersion: string,
): { readonly ok: true } | EnvironmentFailure {
  if (bunVersion !== expected.bunVersion) return { failure: "lock-bun-version-mismatch" };
  const wanted = parseLock(expected.lock);
  const actual = parseLock(candidateLock);
  if (!wanted) return { failure: "lock-unreadable" };
  if (!actual) return { failure: "lock-unreadable" };
  for (const key of ["lockfileVersion", "configVersion", "packages", "workspaces"] as const) {
    const drop = key === "workspaces";
    if (canonical(wanted[key], drop) !== canonical(actual[key], drop)) return { failure: `lock-mismatch:${key}` };
  }
  return { ok: true };
}

/** Отпечаток установленного каталога: имена и байты всех файлов, отсортированные по пути. */
async function closureDigest(directory: string): Promise<string | undefined> {
  const hasher = createHash("sha256");
  const walk = async (current: string, prefix: string): Promise<boolean> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return false;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const label = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!await walk(path, label)) return false;
        continue;
      }
      const bytes = await readFile(path).catch(() => undefined);
      if (!bytes) return false;
      hasher.update(label);
      hasher.update("\0");
      hasher.update(bytes);
      hasher.update("\0");
    }
    return true;
  };
  return await walk(directory, "") ? hasher.digest("hex") : undefined;
}

function lockEntry(lock: Record<string, unknown>, alias: string): { integrity: string; dependencies: readonly string[] } | undefined {
  const entry = recordOf(lock.packages)?.[alias];
  if (!Array.isArray(entry)) return undefined;
  const integrity = entry.find(value => typeof value === "string" && value.startsWith("sha512-"));
  const metadata = recordOf(entry[2]);
  return typeof integrity === "string"
    ? { integrity, dependencies: Object.keys(stringsOf(metadata?.dependencies) ?? {}) }
    : undefined;
}

/** Установленный хост: версия из его манифеста, SRI из lock-файла, отпечаток каталогов. */
export async function hostIdentity(root: string, alias: string, lockText: string): Promise<HostIdentity | EnvironmentFailure> {
  const lock = parseLock(lockText);
  if (!lock) return { failure: "lock-unreadable" };
  const entry = lockEntry(lock, alias);
  if (!entry) return { failure: `host-lock-entry-missing:${alias}` };
  const directory = join(root, "node_modules", ...alias.split("/"));
  const manifest = parsed(await readFile(join(directory, "package.json"), "utf8").catch(() => ""));
  if (!manifest) return { failure: `host-environment-missing:${alias}` };
  const identity = await closureDigest(directory);
  if (!identity) return { failure: `host-environment-missing:${alias}` };
  const parts = [identity];
  for (const name of [...entry.dependencies].sort()) {
    const nested = await closureDigest(join(root, "node_modules", ...name.split("/")));
    if (nested) parts.push(`${name}:${nested}`);
  }
  return {
    alias,
    version: typeof manifest.version === "string" ? manifest.version : "",
    integrity: entry.integrity,
    closureDigest: digest(parts.join("\0")),
  };
}

/** Все объявленные алиасы хостов: и принятые базой, и разрешённые дельтой. */
export function declaredHostAliases(acceptedManifest: string, delta: ApprovedDelta): readonly { alias: string; version: string }[] {
  const dev = stringsOf(parsed(acceptedManifest)?.devDependencies) ?? {};
  const declared = new Map<string, string>();
  for (const [name, value] of Object.entries(dev)) {
    if (!HOST_ALIAS.test(name)) continue;
    const spec = HOST_SPEC.exec(value);
    if (spec) declared.set(name, spec[1]!);
  }
  for (const pin of delta.hostPins) declared.set(pin.alias, pin.version);
  return [...declared].map(([alias, version]) => ({ alias, version }))
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export interface ToolRoot {
  readonly root: string;
  readonly lock: LockExpectation;
  readonly hosts: readonly HostIdentity[];
}

/**
 * Доверенный корень измерения.
 *
 * Код и конфигурация — из принятого коммита; данные каталога и снимки — из проверяемого дерева как данные.
 * Установка идёт по ожидаемому lock-файлу (`--frozen-lockfile --ignore-scripts`), поэтому посторонняя
 * зависимость в окружение попасть не может: её нет ни в базовом lock-файле, ни в дельте.
 *
 * Корень обязан **не существовать**: модуль создаёт его сам и потому удаляет только собственное. Каталоги
 * генерации и кэша живут рядом и удаляются на любом исходе, поэтому отказы не оставляют мусора.
 */
export async function prepareToolRoot(input: {
  readonly checkout: string;
  readonly baseSha: string;
  readonly root: string;
  readonly delta: ApprovedDelta;
  readonly deadlineMs: number;
  readonly registry?: string;
}): Promise<({ readonly ok: true } & ToolRoot) | EnvironmentFailure> {
  const checkout = resolve(input.checkout);
  const root = resolve(input.root);
  if (!isAbsolute(root)) return { failure: "root-path-invalid" };
  if (root === checkout || root.startsWith(`${checkout}${sep}`)) return { failure: "root-inside-checkout" };
  const lockScratch = `${root}.lock`;
  const cacheDir = `${root}.cache`;
  const deadline = Date.now() + input.deadlineMs;
  let created = false;
  let retained = false;
  try {
    // Существующий путь не удаляется: чужие данные не должны быть стёрты ошибкой в аргументе.
    if (existsSync(root)) return { failure: "root-exists" };
    let paths: readonly string[];
    try {
      paths = committedPaths(checkout, input.baseSha);
    } catch (error) {
      return { failure: error instanceof Error ? error.message : "accepted-tree-unavailable" };
    }
    await mkdir(root, { recursive: true });
    created = true;
    for (const path of paths) {
      const bytes = gitShow(checkout, input.baseSha, path);
      if (!bytes) return { failure: `accepted-blob-unavailable:${path}` };
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    const acceptedManifest = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
    const acceptedLock = await readFile(join(root, "bun.lock"), "utf8").catch(() => undefined);
    if (acceptedManifest === undefined) return { failure: "accepted-manifest-unavailable" };
    if (acceptedLock === undefined) return { failure: "accepted-lock-unavailable" };
    // Candidate data is a precondition of measurement, not of the install: refuse a missing
    // catalog/review file or snapshot directory before paying for a full dependency install,
    // so a real install failure can never masquerade as missing candidate data.
    for (const path of DATA_FILES) if (!existsSync(join(checkout, path))) return { failure: `candidate-data-missing:${path}` };
    if (!existsSync(join(checkout, SNAPSHOT_DIR))) return { failure: "candidate-baseline-missing" };

    const expectation = await expectedLock({
      acceptedManifest, acceptedLock, delta: input.delta,
      scratch: lockScratch, cacheDir, deadline, registry: input.registry,
    });
    if ("failure" in expectation) return expectation;
    const measurementManifest = manifestWithDelta(acceptedManifest, input.delta);
    if (measurementManifest === undefined) return { failure: "manifest-invalid" };
    await writeFile(join(root, "package.json"), measurementManifest, "utf8");
    await writeFile(join(root, "bun.lock"), expectation.lock, "utf8");

    const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts", "--cache-dir", cacheDir];
    if (input.registry) installArgs.push(`--registry=${input.registry}`);
    const installResult = spawnBun(root, installArgs, deadline);
    if (installResult.code !== 0) return { failure: "tools-install-failed" };

    // Inject JSON catalog/review data and snapshots, never candidate executable modules.
    // Snapshot deletion must remain observable rather than falling back to accepted copies.
    for (const path of DATA_FILES) {
      const bytes = await readFile(join(checkout, path)).catch(() => undefined);
      if (!bytes) return { failure: `candidate-data-missing:${path}` };
      await writeFile(join(root, path), bytes);
    }
    const snapshots = await readdir(join(checkout, SNAPSHOT_DIR)).catch(() => undefined);
    if (!snapshots) return { failure: "candidate-baseline-missing" };
    // Каталог снимков не входит в принятый код, поэтому его создаёт измерение: базовые снимки — данные
    // кандидата, и без этого шага писать их было бы некуда.
    await mkdir(join(root, SNAPSHOT_DIR), { recursive: true });
    const installed = await readdir(join(root, SNAPSHOT_DIR)).catch(() => [] as string[]);
    for (const name of installed.filter(name => name.endsWith(".json"))) {
      if (!snapshots.includes(name)) await rm(join(root, SNAPSHOT_DIR, name), { force: true });
    }
    for (const name of snapshots.filter(name => name.endsWith(".json")).sort()) {
      const bytes = await readFile(join(checkout, SNAPSHOT_DIR, name)).catch(() => undefined);
      if (!bytes) return { failure: `candidate-baseline-missing:${name}` };
      await writeFile(join(root, SNAPSHOT_DIR, name), bytes);
    }

    const hosts: HostIdentity[] = [];
    for (const declared of declaredHostAliases(acceptedManifest, input.delta)) {
      const identity = await hostIdentity(root, declared.alias, expectation.lock);
      if ("failure" in identity) return identity;
      // Разрешённый пин обязан подтвердиться установленной версией, а не именем алиаса в манифесте.
      if (identity.version !== declared.version) return { failure: `host-identity-mismatch:${declared.alias}` };
      hosts.push(identity);
    }
    retained = true;
    return { ok: true, root, lock: expectation, hosts };
  } finally {
    // Площадка генерации и кэш — служебные: они убираются на любом исходе. Корень же убирается на любом
    // **отказе**, чтобы неудачная попытка не оставляла мусора; на успехе он остаётся за вызывающим, который
    // обязан освободить его через `dispose`.
    await rm(lockScratch, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
    if (created && !retained) await rm(root, { recursive: true, force: true });
  }
}

/**
 * Выгрузка снимка хоста из доверенного корня.
 *
 * Снимок считается установленным пакетом, а не рабочим деревом кандидата: отпечаток каталогов хоста
 * сверяется до и после запуска, и расхождение означает, что мерили не то окружение.
 */
export async function exportHostSnapshot(input: {
  readonly root: string;
  readonly alias: string;
  readonly version: string;
  readonly platform: string;
  readonly lock: LockExpectation;
  readonly deadlineMs: number;
}): Promise<{ readonly ok: true; readonly snapshot: unknown; readonly identity: HostIdentity } | EnvironmentFailure> {
  const before = await hostIdentity(input.root, input.alias, input.lock.lock);
  if ("failure" in before) return before;
  if (before.version !== input.version) return { failure: `host-identity-mismatch:${input.alias}` };
  const child = spawnBun(
    input.root,
    ["scripts/matrix-registry-worker.ts", input.alias, input.version, input.platform],
    Date.now() + input.deadlineMs,
  );
  if (child.code !== 0) return { failure: `host-export-failed:${input.alias}` };
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(child.stdout) as unknown;
  } catch {
    return { failure: `host-export-failed:${input.alias}` };
  }
  const after = await hostIdentity(input.root, input.alias, input.lock.lock);
  if ("failure" in after) return after;
  if (after.closureDigest !== before.closureDigest) return { failure: `host-integrity-mismatch:${input.alias}` };
  return { ok: true, snapshot, identity: after };
}

/** Уборка корня измерения: окружение живёт ровно один прогон. */
export async function dispose(root: string): Promise<void> {
  const target = resolve(root);
  await rm(target, { recursive: true, force: true });
  await rm(`${target}.lock`, { recursive: true, force: true });
  await rm(`${target}.cache`, { recursive: true, force: true });
}
