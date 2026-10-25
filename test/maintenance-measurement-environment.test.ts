import { describe, expect, onTestFinished, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedDelta, declaredHostAliases, dispose, expectedLock, exportHostSnapshot, hostAliasOf, hostIdentity,
  lockVerdict, manifestWithDelta, parseLock, prepareToolRoot,
} from "../scripts/maintenance/measurement-environment";
import { SNAPSHOT_DIR, snapshotPath } from "../scripts/maintenance/paths";
import { withInstallLock } from "./bun-install-lock";

/**
 * Среда измерения: проверяется на настоящем Bun и настоящих пакетах.
 *
 * Фикстуры — реальные tarball-пакеты в temp, реальный HTTP-реестр на loopback и реальные команды
 * `bun install --registry=…`. Запросы наружу не идут: реестр-фикстура обслуживает ровно объявленные пакеты,
 * а всё прочее отвечает отказом и попадает в журнал запросов, который тест проверяет.
 *
 * Поэтому пин хоста в фикстуре — настоящая запись реестра (`npm:…@версия`), а не `file:`-подстановка:
 * сравнение lock-файлов, SRI и отпечатки каталогов считаются по фактическому ответу реестра.
 */

/** Every resource registers with the test that created it; parallel tests must never share cleanup state. */
async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `maint-env-${label}-`));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** Срок каждой установки в дочернем процессе: незавершённая установка — это зависший тест, а не долгий. */
const INSTALL_DEADLINE = 30_000;
/** Срок тяжёлого теста целиком: фикстура, установка корня и выгрузка снимка. */
const HEAVY_TEST_DEADLINE = 90_000;

/**
 * Синхронный запуск Bun: установка идёт в дочернем процессе, поэтому процесс реестра продолжает отвечать.
 * Просроченный ребёнок гасится по сроку, а не остаётся висеть после теста.
 */
function run(args: readonly string[], cwd: string, timeout = INSTALL_DEADLINE): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGKILL" });
  return { code: child.exitCode ?? -1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

/** Установка обязана завершиться успешно, иначе тест показывает фактический код и stderr, а не «что-то не так». */
async function install(args: readonly string[], cwd: string, timeout = INSTALL_DEADLINE): Promise<void> {
  const result = await withInstallLock(() => run(args, cwd, timeout));
  if (result.code !== 0) throw new Error(`bun ${args.join(" ")}: код ${result.code}, stderr: ${result.stderr.trim()}`);
}

function git(args: readonly string[], cwd: string): string {
  const child = Bun.spawnSync(
    ["git", "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

/** Настоящий tarball пакета: npm-раскладка `package/`, обязательная для локальной установки. */
async function tarball(root: string, name: string, version: string, files: Record<string, string>): Promise<string> {
  const stage = join(root, "stage");
  const directory = join(stage, "package");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, main: "index.js" }, null, 2));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  const out = join(stage, `${name.replaceAll(/[^\w.-]/g, "_")}-${version}.tgz`);
  const child = Bun.spawnSync(["tar", "-czf", out, "-C", stage, "package"], { stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`tar: ${child.stderr.toString()}`);
  await rm(directory, { recursive: true, force: true });
  return out;
}

/** Контрольные суммы tarball-а: их видит Bun в ответе реестра и переносит в lock-файл как SRI. */
function integrity(bytes: Uint8Array): { sha512: string; sha1: string } {
  return {
    sha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha1: createHash("sha1").update(bytes).digest("hex"),
  };
}

/**
 * Реестр-фикстура — **отдельный процесс** на loopback.
 *
 * Отдельный процесс, а не сервер внутри теста: установка запускается синхронно в том же процессе, поэтому
 * сервер в нём не успевал бы отвечать. Пакеты берутся из подготовленного каталога, а каждый запрос пишется
 * в журнал — тест затем проверяет, что за пределы объявленного набора не ушло ничего.
 */
const FIXTURE_REGISTRY = `
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const [logPath, dataDir] = process.argv.slice(2);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    appendFileSync(logPath, \`\${request.method} \${pathname}\\n\`);
    if (pathname.endsWith(".tgz")) {
      const file = join(dataDir, "tarballs", pathname.split("/").pop());
      return existsSync(file)
        ? new Response(readFileSync(file), { headers: { "content-type": "application/octet-stream" } })
        : new Response("missing", { status: 404 });
    }
    const key = pathname.split("/").filter(Boolean).join("%2F");
    const packument = join(dataDir, "packuments", \`\${key}.json\`);
    return existsSync(packument)
      ? new Response(readFileSync(packument, "utf8"), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  },
});
console.log(\`ready \${server.port}\`);
`;

interface Registry {
  readonly url: string;
  readonly requests: () => Promise<readonly string[]>;
}

/** Registry processes are owned by the test that starts them, never by a module-global stack. */
async function startRegistry(dataDir: string): Promise<Registry> {
  const logPath = join(dataDir, "requests.log");
  await writeFile(logPath, "");
  const script = join(dataDir, "registry.ts");
  await writeFile(script, FIXTURE_REGISTRY);
  const child = Bun.spawn(["bun", script, logPath, dataDir], { stdout: "pipe", stderr: "pipe" });
  let stopped = false;
  onTestFinished(async () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGKILL");
    await child.exited;
  });
  // Готовность — сигнал процесса: сервер сам выбирает свободный порт и сообщает его, исключая гонку probe→bind.
  const decoder = new TextDecoder();
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let announced = "";
  while (!/ready \d+/.test(announced)) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = await new Response(child.stderr as ReadableStream).text().catch(() => "");
      throw new Error(`реестр-фикстура завершился до готовности: ${stderr.trim()}`);
    }
    announced += decoder.decode(chunk.value, { stream: true });
  }
  const port = Number(announced.match(/ready (\d+)/)![1]);
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    requests: async () => (await readFile(logPath, "utf8")).split("\n").map(line => line.trim()).filter(Boolean),
  };
}
/** Публикация tarball-а: packument с абсолютной ссылкой и SRI — ровно то, что реестр отвечает клиенту. */
async function publish(dataDir: string, tarballPath: string, name: string, version: string, registry: Registry): Promise<void> {
  const bytes = await readFile(tarballPath);
  const sums = integrity(bytes);
  const file = `${name.split("/").pop()}-${version}.tgz`;
  await mkdir(join(dataDir, "tarballs"), { recursive: true });
  await writeFile(join(dataDir, "tarballs", file), bytes);
  await mkdir(join(dataDir, "packuments"), { recursive: true });
  await writeFile(join(dataDir, "packuments", `${name.replaceAll("/", "%2F")}.json`), JSON.stringify({
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name, version, dependencies: {},
        dist: { tarball: `${registry.url}${name}/-/${file}?nonce=${crypto.randomUUID()}`, integrity: sums.sha512, shasum: sums.sha1 },
      },
    },
  }));
}

interface Fixture {
  readonly checkout: string;
  readonly baseSha: string;
  readonly hostAlias: string;
  readonly hostVersion: string;
  /** Спецификация хоста — настоящая запись реестра, как в выпуске. */
  readonly hostSpec: string;
  readonly registry: string;
  readonly requests: () => Promise<readonly string[]>;
}

const HOST_VERSION = "18.9.0";
const RELEASE_VERSION = "0.6.0";

/** Запросы, которые реестр-фикстура вправе увидеть: объявленные пакеты и их tarball-ы. Всё прочее — утечка наружу. */
const ALLOWED_REQUESTS: Record<string, true> = {
  "GET /@oh-my-pi/pi-base-helper": true,
  "GET /@oh-my-pi/pi-coding-agent": true,
  "GET /@oh-my-pi/pi-base-helper/-/pi-base-helper-1.0.0.tgz": true,
  [`GET /@oh-my-pi/pi-coding-agent/-/pi-coding-agent-${HOST_VERSION}.tgz`]: true,
};

/** Ни один запрос не вышел за объявленный набор пакетов: посторонняя зависимость не запрашивалась. */
async function assertNoUnexpectedRequests(fixtureValue: Fixture): Promise<void> {
  const unexpected = (await fixtureValue.requests()).filter(line => ALLOWED_REQUESTS[line] !== true);
  expect(unexpected).toEqual([]);
}

/** Метка, зашитая в содержимое пакета-фикстуры: по ней видно, чьи байты реально импортированы. */
const HOST_MARKER = `fixture-host-${HOST_VERSION}`;

/**
 * Рабочий модуль выгрузки в принятом коммите фикстуры.
 *
 * Повторяет контракт настоящего `scripts/matrix-registry-worker.ts`: аргументы «алиас, версия, платформа»,
 * импорт `config/all-settings` **из установленного пакета**, снимок в stdout. Метка берётся из содержимого
 * импортированного модуля, поэтому выгруженный снимок привязан именно к установленным байтам.
 */
const FIXTURE_WORKER = `
const [alias, version, platform] = process.argv.slice(2);
const settings = await import(\`\${alias}/config/all-settings\`);
const ordered = settings.orderedSettings();
const snapshot = { version, platform, marker: settings.marker, settings: {} };
for (const setting of ordered) snapshot.settings[setting.id] = setting.definition;
console.log(JSON.stringify(snapshot));
`;

/** `config/all-settings` пакета-фикстуры: именно это импортирует измерение. */
function hostConfigModule(marker: string): string {
  return `
export const marker = ${JSON.stringify(marker)};
export function orderedSettings() {
  return [{ id: "fixture.setting", definition: { type: "string", default: "" } }];
}
`;
}

/**
 * База в реальном git с настоящим lock-файлом плюс локальный tarball кандидата-хоста.
 *
 * Базовая зависимость и пин кандидата указывают на локальные tarball-ы: так проверяется механизм целиком без
 * обращения к сети. Верификатор о таком происхождении не знает — он видит SRI в lock-файле и отпечаток
 * каталогов.
 */
async function fixture(): Promise<Fixture> {
  const parent = await tempRoot("fixture");
  const checkout = join(parent, "checkout");
  await mkdir(checkout, { recursive: true });
  const dataDir = join(parent, "registry");
  await mkdir(dataDir, { recursive: true });
  const registry = await startRegistry(dataDir);
  const baseTarball = await tarball(parent, "@oh-my-pi/pi-base-helper", "1.0.0", { "index.js": "export const base = true;\n" });
  const hostTarball = await tarball(parent, "@oh-my-pi/pi-coding-agent", HOST_VERSION, {
    "index.js": "export const host = 'fixture';\n",
    "config/all-settings.ts": hostConfigModule(HOST_MARKER),
  });
  await publish(dataDir, baseTarball, "@oh-my-pi/pi-base-helper", "1.0.0", registry);
  await publish(dataDir, hostTarball, "@oh-my-pi/pi-coding-agent", HOST_VERSION, registry);

  const baseManifest = {
    name: "omp-settings-ru",
    version: "0.5.0",
    devDependencies: { "@oh-my-pi/pi-base-helper": "1.0.0" },
  };
  await writeFile(join(checkout, "package.json"), `${JSON.stringify(baseManifest, null, 2)}\n`);
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await writeFile(join(checkout, "scripts", "check-coverage.ts"), "// принятый измерительный код\n");
  await writeFile(join(checkout, "scripts", "matrix-registry-worker.ts"), FIXTURE_WORKER);
  await mkdir(join(checkout, "src", "translations"), { recursive: true });
  await writeFile(join(checkout, "src", "report.ts"), "// принятый вспомогательный модуль\n");
  await writeFile(join(checkout,"src/translations/ru-catalog.json"),'{"locale":"ru","settings":{}}\n');
  await writeFile(join(checkout,"src/translations/variant-review.json"),'{"variants":[]}\n');
  await mkdir(join(checkout, SNAPSHOT_DIR), { recursive: true });
  await writeFile(join(checkout, snapshotPath(HOST_VERSION, "win32")), JSON.stringify({ settings: {} }));
  // Базовый lock-файл — настоящий: его считает Bun по ответу реестра-фикстуры, а не тест.
  await install(["install", "--lockfile-only", "--ignore-scripts", `--registry=${registry.url}`], checkout);

  git(["init", "-q", "-b", "main"], checkout);
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", "base"], checkout);
  const baseSha = git(["rev-parse", "HEAD"], checkout);

  return {
    checkout, baseSha, hostAlias: hostAliasOf(HOST_VERSION), hostVersion: HOST_VERSION,
    hostSpec: `npm:@oh-my-pi/pi-coding-agent@${HOST_VERSION}`,
    registry: registry.url, requests: registry.requests,
  };
}

/** Дельта, которую выдал бы гейт: пин хоста — настоящая запись реестра, разрешаемая реестром-фикстурой. */
function deltaFor(fixtureValue: Fixture) {
  return {
    releaseVersion: RELEASE_VERSION,
    hostPins: [{ alias: fixtureValue.hostAlias, version: fixtureValue.hostVersion, spec: fixtureValue.hostSpec }],
    peers: [{ name: "@oh-my-pi/pi-coding-agent", value: `18.8.7 || ${fixtureValue.hostVersion}` }],
    devPins: [],
  };
}

/** Тот же манифест, но пин хоста — запись реестра: так выглядит настоящий выпуск. */
function registryDelta(version = HOST_VERSION) {
  return {
    releaseVersion: RELEASE_VERSION,
    hostPins: [{ alias: hostAliasOf(version), version, spec: `npm:@oh-my-pi/pi-coding-agent@${version}` }],
    peers: [{ name: "@oh-my-pi/pi-coding-agent", value: `18.8.7 || ${version}` }],
    devPins: [],
  };
}

const ACCEPTED_MANIFEST = JSON.stringify({
  name: "omp-settings-ru", version: "0.5.0",
  devDependencies: {
    "@oh-my-pi/pi-coding-agent": "18.8.7",
    "omp-host-1887": "npm:@oh-my-pi/pi-coding-agent@18.8.7",
  },
  peerDependencies: { "@oh-my-pi/pi-coding-agent": "18.8.7" },
  scripts: { test: "bun test" },
});

function candidate(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "omp-settings-ru", version: RELEASE_VERSION,
    devDependencies: {
      "@oh-my-pi/pi-coding-agent": HOST_VERSION,
      "omp-host-1887": "npm:@oh-my-pi/pi-coding-agent@18.8.7",
      [hostAliasOf(HOST_VERSION)]: `npm:@oh-my-pi/pi-coding-agent@${HOST_VERSION}`,
    },
    peerDependencies: { "@oh-my-pi/pi-coding-agent": `18.8.7 || ${HOST_VERSION}` },
    scripts: { test: "bun test" },
    ...overrides,
  };
}

describe("дельта кандидата к принятому манифесту", () => {
  test("принимается ровно выпуск: версия плагина, пин хоста с точной записью реестра, расширение диапазона peer", () => {
    const verdict = approvedDelta(JSON.parse(ACCEPTED_MANIFEST), candidate(), HOST_VERSION);
    if (!("ok" in verdict)) throw new Error(`неожиданный отказ: ${verdict.failure}`);
    expect(verdict.delta.releaseVersion).toBe(RELEASE_VERSION);
    expect(verdict.delta.hostPins).toEqual([
      { alias: hostAliasOf(HOST_VERSION), version: HOST_VERSION, spec: `npm:@oh-my-pi/pi-coding-agent@${HOST_VERSION}` },
    ]);
    expect(verdict.delta.devPins).toEqual([{ name: "@oh-my-pi/pi-coding-agent", value: HOST_VERSION }]);
  });

  test("спецификация пина проверяется целиком, а не подстрокой", () => {
    // Подстрока «18.9.0» присутствует и в 18.9.01, и в -preview: совпадение подстроки не подтверждает пин.
    for (const spec of ["npm:@oh-my-pi/pi-coding-agent@18.9.01", "npm:@oh-my-pi/pi-coding-agent@18.9.0-preview", "^18.9.0"]) {
      const manifest = JSON.parse(ACCEPTED_MANIFEST) as { devDependencies: Record<string, string> };
      manifest.devDependencies[hostAliasOf(HOST_VERSION)] = spec;
      const verdict = approvedDelta(JSON.parse(ACCEPTED_MANIFEST), { ...(candidate() as object), devDependencies: manifest.devDependencies }, HOST_VERSION);
      expect("ok" in verdict ? "принято" : verdict.failure).toBe(`host-pin-unverified:${hostAliasOf(HOST_VERSION)}`);
    }
  });

  test("имя алиаса обязано соответствовать версии кандидата", () => {
    const manifest = JSON.parse(ACCEPTED_MANIFEST) as { devDependencies: Record<string, string> };
    manifest.devDependencies["omp-host-1891"] = `npm:@oh-my-pi/pi-coding-agent@${HOST_VERSION}`;
    const verdict = approvedDelta(
      JSON.parse(ACCEPTED_MANIFEST),
      { ...(candidate() as object), devDependencies: manifest.devDependencies },
      HOST_VERSION,
    );
    expect("ok" in verdict ? "принято" : verdict.failure).toBe("host-alias-unexpected:omp-host-1891");
  });

  test("произвольная зависимость, чужое поле, удаление и сужение диапазона — отказ", () => {
    const accepted = JSON.parse(ACCEPTED_MANIFEST);
    const dependencies = { ...(candidate() as { devDependencies: Record<string, string> }).devDependencies, "left-pad": "1.0.0" };
    expect(approvedDelta(accepted, candidate({ devDependencies: dependencies }), HOST_VERSION))
      .toEqual({ failure: "package-dependency-changed:left-pad" });
    expect(approvedDelta(accepted, candidate({ omp: { extensions: ["./evil.ts"] } }), HOST_VERSION))
      .toEqual({ failure: "manifest-field-changed:omp" });
    const removed = { ...(candidate() as { devDependencies: Record<string, string> }).devDependencies };
    delete removed["omp-host-1887"];
    expect(approvedDelta(accepted, candidate({ devDependencies: removed }), HOST_VERSION))
      .toEqual({ failure: "manifest-dependency-removed:omp-host-1887" });
    expect(approvedDelta(accepted, candidate({ peerDependencies: { "@oh-my-pi/pi-coding-agent": HOST_VERSION } }), HOST_VERSION))
      .toEqual({ failure: "peer-range-narrowed:@oh-my-pi/pi-coding-agent" });
  });

  test("перевыпуск без смены версии плагина не подтверждает выпуск", () => {
    expect(approvedDelta(JSON.parse(ACCEPTED_MANIFEST), candidate({ version: "0.5.0" }), HOST_VERSION))
      .toEqual({ failure: "manifest-release-version-unverified" });
  });

  test("манифест измерения получается ровно наложением дельты", () => {
    const verdict = approvedDelta(JSON.parse(ACCEPTED_MANIFEST), candidate(), HOST_VERSION);
    if (!("ok" in verdict)) throw new Error("ожидалась принятая дельта");
    const applied = manifestWithDelta(ACCEPTED_MANIFEST, verdict.delta);
    if (applied === undefined) throw new Error("ожидался манифест");
    const manifest = JSON.parse(applied) as { devDependencies: Record<string, string>; peerDependencies: Record<string, string> };
    expect(Object.keys(manifest.devDependencies).sort())
      .toEqual(["@oh-my-pi/pi-coding-agent", "omp-host-1887", hostAliasOf(HOST_VERSION)].sort());
    expect(manifest.devDependencies[hostAliasOf(HOST_VERSION)]).toBe(`npm:@oh-my-pi/pi-coding-agent@${HOST_VERSION}`);
    expect(manifest.peerDependencies["@oh-my-pi/pi-coding-agent"]).toBe(`18.8.7 || ${HOST_VERSION}`);
  });
});

describe("ожидаемый lock-файл и его сверка", () => {
  test("Bun действительно считает lock по дельте, а сверка принимает тот же граф", async () => {
    const fixtureValue = await fixture();
    const acceptedLock = await readFile(join(fixtureValue.checkout, "bun.lock"), "utf8");
    const scratch = join(await tempRoot("lock"), "scratch");
    const expectation = await expectedLock({
      acceptedManifest: await readFile(join(fixtureValue.checkout, "package.json"), "utf8"),
      acceptedLock, delta: deltaFor(fixtureValue), scratch,
      cacheDir: `${scratch}.cache`, deadline: Date.now() + 180_000, registry: fixtureValue.registry,
    });
    if ("failure" in expectation) throw new Error(`ожидался lock: ${expectation.failure}`);
    // Затравка — базовый lock: граф посторонних зависимостей сохранён, а пин кандидата в него добавлен.
    const packages = parseLock(expectation.lock)?.packages as Record<string, unknown>;
    expect(Object.keys(packages)).toContain(fixtureValue.hostAlias);
    expect(Object.keys(packages).some(name => name.includes("left-pad"))).toBe(false);

    expect(lockVerdict(expectation, expectation.lock, expectation.bunVersion)).toEqual({ ok: true });
    // Переформатирование — не изменение графа: сравнение нормализованное, а не побайтовое.
    expect(lockVerdict(expectation, `${expectation.lock}\n`, expectation.bunVersion)).toEqual({ ok: true });
    expect(lockVerdict(expectation, expectation.lock, "0.0.0")).toEqual({ failure: "lock-bun-version-mismatch" });
  });

  test("лишний пакет в lock-файле кандидата отклоняется, отсутствующий пин — тоже", async () => {
    const fixtureValue = await fixture();
    const acceptedLock = await readFile(join(fixtureValue.checkout, "bun.lock"), "utf8");
    const scratch = join(await tempRoot("lockbad"), "scratch");
    const expectation = await expectedLock({
      acceptedManifest: await readFile(join(fixtureValue.checkout, "package.json"), "utf8"),
      acceptedLock, delta: deltaFor(fixtureValue), scratch,
      cacheDir: `${scratch}.cache`, deadline: Date.now() + 180_000, registry: fixtureValue.registry,
    });
    if ("failure" in expectation) throw new Error(`ожидался lock: ${expectation.failure}`);

    const smuggled = parseLock(expectation.lock)!;
    (smuggled.packages as Record<string, unknown>)["left-pad"] = ["left-pad@1.0.0", "", {}, "sha512-AAAA"];
    expect(lockVerdict(expectation, JSON.stringify(smuggled), expectation.bunVersion)).toEqual({ failure: "lock-mismatch:packages" });

    const stripped = parseLock(expectation.lock)!;
    delete (stripped.packages as Record<string, unknown>)[fixtureValue.hostAlias];
    expect(lockVerdict(expectation, JSON.stringify(stripped), expectation.bunVersion)).toEqual({ failure: "lock-mismatch:packages" });
    expect(lockVerdict(expectation, "не json", expectation.bunVersion)).toEqual({ failure: "lock-unreadable" });
  });

  test("площадка генерации убирается и после отказа", async () => {
    const parent = await tempRoot("lockfail");
    const scratch = join(parent, "scratch");
    const verdict = await expectedLock({
      acceptedManifest: "не json", acceptedLock: "", delta: registryDelta(), scratch,
      cacheDir: `${scratch}.cache`, deadline: Date.now() + 60_000,
    });
    expect(verdict).toEqual({ failure: "manifest-invalid" });
    expect(existsSync(scratch)).toBe(false);
  });
});

describe("доверенный корень измерения", () => {
  test("корень собирается из принятого кода, а хост реально устанавливается и выгружается", async () => {
    const fixtureValue = await fixture();
    const root = join(await tempRoot("prep"), "tools");
    const prepared = await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 180_000,
    });
    if ("failure" in prepared) throw new Error(`ожидался корень: ${prepared.failure}`);
    try {
      // Код и конфигурация — из принятого коммита, а не из рабочего дерева кандидата.
      expect(await readFile(join(root, "scripts", "matrix-registry-worker.ts"), "utf8")).toBe(FIXTURE_WORKER);
      // Данные кандидата наложены: файлы каталога и базовые снимки взяты из проверяемого дерева.
      expect(await readFile(join(root,"src/translations/ru-catalog.json"),"utf8")).toBe('{"locale":"ru","settings":{}}\n');
      // Служебные каталоги убраны, корень оставлен вызывающему.
      expect(existsSync(`${root}.lock`)).toBe(false);
      expect(existsSync(`${root}.cache`)).toBe(false);
      // Реестр-фикстура не увидел ни одного запроса вне объявленного набора: наружу не ушло ничего.
      await assertNoUnexpectedRequests(fixtureValue);

      const host = prepared.hosts.find(entry => entry.alias === fixtureValue.hostAlias);
      if (!host) throw new Error("хост не подтверждён в корне");
      expect(host.version).toBe(fixtureValue.hostVersion);
      expect(host.integrity.startsWith("sha512-")).toBe(true);
      expect(host.closureDigest).toMatch(/^[a-f0-9]{64}$/);

      // Настоящая выгрузка: снимок считает установленный пакет, и метка доказывает, чьи байты импортированы.
      const exported = await exportHostSnapshot({
        root, alias: fixtureValue.hostAlias, version: fixtureValue.hostVersion, platform: "win32",
        lock: prepared.lock, deadlineMs: 60_000,
      });
      if ("failure" in exported) throw new Error(`ожидалась выгрузка: ${exported.failure}`);
      const snapshot = exported.snapshot;
      if (typeof snapshot !== "object" || snapshot === null) throw new Error("снимок не объект");
      const fields = snapshot as Record<string, unknown>;
      expect(fields.version).toBe(fixtureValue.hostVersion);
      expect(fields.platform).toBe("win32");
      expect(fields.marker).toBe(HOST_MARKER);
      expect(Object.keys(fields.settings as Record<string, unknown>)).toEqual(["fixture.setting"]);
      // Отпечаток до и после выгрузки совпадает: снимок считается теми же установленными байтами.
      expect(exported.identity.closureDigest).toBe(host.closureDigest);
    } finally {
      await dispose(root);
    }
    expect(existsSync(root)).toBe(false);
  }, 30_000);

  test("node_modules рабочего дерева кандидата в измерение не попадает", async () => {
    const fixtureValue = await fixture();
    // Кандидат кладёт рядом свою копию хоста — с другой версией и другим содержимым.
    const decoy = join(fixtureValue.checkout, "node_modules", ...fixtureValue.hostAlias.split("/"));
    await mkdir(decoy, { recursive: true });
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0", main: "index.js" }));
    await writeFile(join(decoy, "index.js"), "export const host = 'candidate';\n");

    const root = join(await tempRoot("decoy"), "tools");
    const prepared = await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 180_000,
    });
    try {
      if ("failure" in prepared) throw new Error(`ожидался корень: ${prepared.failure}`);
      const installed = JSON.parse(await readFile(join(root, "node_modules", ...fixtureValue.hostAlias.split("/"), "package.json"), "utf8")) as { version: string };
      // Меряется установленный пакет доверенного корня, а не подложенная копия кандидата.
      expect(installed.version).toBe(fixtureValue.hostVersion);
      expect(prepared.hosts.find(entry => entry.alias === fixtureValue.hostAlias)?.version).toBe(fixtureValue.hostVersion);
    } finally {
      await dispose(root);
    }
  }, 30_000);

  test("подмена в установленном хосте видна по отпечатку каталога", async () => {
    const fixtureValue = await fixture();
    const root = join(await tempRoot("tamper"), "tools");
    const prepared = await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 180_000,
    });
    if ("failure" in prepared) throw new Error(`ожидался корень: ${prepared.failure}`);
    try {
      const before = await hostIdentity(root, fixtureValue.hostAlias, prepared.lock.lock);
      if ("failure" in before) throw new Error(before.failure);
      await writeFile(join(root, "node_modules", ...fixtureValue.hostAlias.split("/"), "index.js"), "export const host = 'tampered';\n");
      const after = await hostIdentity(root, fixtureValue.hostAlias, prepared.lock.lock);
      if ("failure" in after) throw new Error(after.failure);
      expect(after.closureDigest).not.toBe(before.closureDigest);
      expect(after.integrity).toBe(before.integrity);
    } finally {
      await dispose(root);
    }
  }, 30_000);

  test("отсутствующий установленный хост — отказ, а не пустая подпись", async () => {
    const fixtureValue = await fixture();
    const root = join(await tempRoot("missing"), "tools");
    const prepared = await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 180_000,
    });
    if ("failure" in prepared) throw new Error(`ожидался корень: ${prepared.failure}`);
    try {
      await rm(join(root, "node_modules", ...fixtureValue.hostAlias.split("/")), { recursive: true, force: true });
      expect(await hostIdentity(root, fixtureValue.hostAlias, prepared.lock.lock))
        .toEqual({ failure: `host-environment-missing:${fixtureValue.hostAlias}` });
    } finally {
      await dispose(root);
    }
  }, 30_000);
});

describe("отказы не оставляют мусора", () => {
  async function leftoversAbsent(root: string): Promise<void> {
    expect(existsSync(root)).toBe(false);
    expect(existsSync(`${root}.lock`)).toBe(false);
    expect(existsSync(`${root}.cache`)).toBe(false);
  }

  test("корень внутри чекаута отклоняется до любых действий", async () => {
    const fixtureValue = await fixture();
    const root = join(fixtureValue.checkout, "tools");
    expect(await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 60_000,
    })).toEqual({ failure: "root-inside-checkout" });
    await leftoversAbsent(root);
  });

  test("недоступная принятая база не оставляет созданного корня", async () => {
    const fixtureValue = await fixture();
    const root = join(await tempRoot("badbase"), "tools");
    expect(await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: "f".repeat(40), root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 60_000,
    })).toEqual({ failure: "accepted-tree-unavailable" });
    await leftoversAbsent(root);
  });

  test("несовпадение установленной версии с разрешённым пином убирает корень целиком", async () => {
    const fixtureValue = await fixture();
    const root = join(await tempRoot("badpin"), "tools");
    const wrong = { ...deltaFor(fixtureValue), hostPins: [{ ...deltaFor(fixtureValue).hostPins[0]!, version: "19.0.0" }] };
    expect(await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root, delta: wrong, registry: fixtureValue.registry, deadlineMs: 180_000,
    })).toEqual({ failure: `host-identity-mismatch:${fixtureValue.hostAlias}` });
    await leftoversAbsent(root);
  }, 30_000);

  test("существующий каталог не удаляется: он не наш", async () => {
    const parent = await tempRoot("existing");
    const root = join(parent, "tools");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "keep.txt"), "чужие данные\n");
    const fixtureValue = await fixture();
    expect(await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 60_000,
    })).toEqual({ failure: "root-exists" });
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("чужие данные\n");
  });

  test("отсутствующие данные кандидата отклоняются, служебные каталоги убраны", async () => {
    const fixtureValue = await fixture();
    await rm(join(fixtureValue.checkout,"src/translations/ru-catalog.json"),{force:true});
    const root = join(await tempRoot("nodata"), "tools");
    expect(await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 180_000,
    })).toEqual({ failure: "candidate-data-missing:src/translations/ru-catalog.json" });
    await leftoversAbsent(root);
  });
});

describe("объявленные хосты", () => {
  test("набор алиасов — это принятые базой плюс разрешённый дельтой, в устойчивом порядке", () => {
    const accepted = JSON.stringify({
      devDependencies: {
        "omp-host-1887": "npm:@oh-my-pi/pi-coding-agent@18.8.7",
        omp_host_bad: "npm:@oh-my-pi/pi-coding-agent@18.8.7",
      },
    });
    expect(declaredHostAliases(accepted, registryDelta())).toEqual([
      { alias: "omp-host-1887", version: "18.8.7" },
      { alias: hostAliasOf(HOST_VERSION), version: HOST_VERSION },
    ]);
  });

  test("имя алиаса выводится из версии", () => {
    expect(hostAliasOf("18.10.1")).toBe("omp-host-18101");
    expect(hostAliasOf(HOST_VERSION)).toBe("omp-host-1890");
  });
});

describe("принятый код не подменяется данными кандидата", () => {
  test("правка кандидатом scripts/ не попадает в корень измерения", async () => {
    const fixtureValue = await fixture();
    await writeFile(join(fixtureValue.checkout, "scripts", "check-coverage.ts"), "// подменённое измерение\n");
    const root = join(await tempRoot("code"), "tools");
    const prepared = await prepareToolRoot({
      checkout: fixtureValue.checkout, baseSha: fixtureValue.baseSha, root,
      delta: deltaFor(fixtureValue), registry: fixtureValue.registry, deadlineMs: 180_000,
    });
    if ("failure" in prepared) throw new Error(`ожидался корень: ${prepared.failure}`);
    try {
      expect(await readFile(join(root, "scripts", "check-coverage.ts"), "utf8")).toBe("// принятый измерительный код\n");
      // Отпечаток измеряемого кода совпадает с принятым коммитом, а не с рабочим деревом.
      const committed = Bun.spawnSync(["git", "show", `${fixtureValue.baseSha}:scripts/check-coverage.ts`], { cwd: fixtureValue.checkout, stdout: "pipe" });
      expect(createHash("sha256").update(await readFile(join(root, "scripts", "check-coverage.ts"))).digest("hex"))
        .toBe(createHash("sha256").update(committed.stdout).digest("hex"));
    } finally {
      await dispose(root);
    }
  }, 30_000);
});
