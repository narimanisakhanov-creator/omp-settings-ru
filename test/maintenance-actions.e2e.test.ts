import { afterEach, describe, expect, test, spyOn, mock } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { candidatePaths, gitFile, parseCandidate, validateBundle, validateCandidateTree, writeBundleManifest, type Candidate } from "../scripts/maintenance/actions-bundle";
import { HostedGitHub, parseMaintenanceBlock, maintenanceBody, validateOrigin } from "../scripts/maintenance/actions-github";
import { compareVersions, validatePolicy } from "../scripts/maintenance/policy";
import { parseStrictJSON } from "../scripts/maintenance/json";
import rawPolicy from "../maintenance.config.json";
import { finalizeCandidate } from "../scripts/maintenance/actions-publish";
import { snapshotValue } from "../scripts/maintenance/snapshots";
import { validatePublishedCandidate, verifyCommittedArtifacts } from "../scripts/maintenance/actions-candidate";
import { verifyCandidate } from "../scripts/maintenance/actions-verify";
import { trustedReleaseDocuments, verifyReleaseDocuments } from "../scripts/maintenance/release-documents";
import { SUPPORTED_HOSTS } from "../scripts/maintenance/paths";
import { identitiesOf, markerPairsOf, catalogDelta, readCatalogAtCommit, translationIdentitiesOf } from "../scripts/maintenance/semantic";
import type { BaselineSnapshot } from "../src/report";
import { computeSourceHash } from "../src/source";
import { ensureCheckRun } from "../scripts/maintenance/check-recovery";
import { recoveryFixture } from "./maintenance-actions-fixture";
import { FIXTURE_PLATFORMS, fixtureGit, semanticRuntimeFixture } from "./maintenance-runtime-fixture";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "hosted-actions-")); temporary.push(root); return root; }
function git(cwd: string, ...args: string[]) { const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }); if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout.toString().trim(); }
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function manifest(baseSha = "a".repeat(40), headSha?: string) { return { schemaVersion: 1 as const, repository: "narimanisakhanov-creator/omp-settings-ru", runId: "123", runAttempt: "2", baseSha, upstreamVersion: "18.9.0", releaseVersion: "0.6.0", semanticReview: "disabled" as const, ...(headSha ? { headSha } : {}), files: [] }; }

describe("hosted artifact boundary", () => {
  test("rejects duplicate keys, traversal, unexpected fields and prereleases", () => {
    expect(() => parseStrictJSON('{"a":1,"a":2}')).toThrow();
    expect(() => parseCandidate({ ...manifest(), files: [{ path: "../secret", sha256: sha("x") }] })).toThrow();
    expect(() => parseCandidate({ ...manifest(), command: "execute" })).toThrow();
    expect(() => parseCandidate({ ...manifest(), upstreamVersion: "18.9.0-rc.1" })).toThrow();
    expect(compareVersions("18.10.0", "18.9.9")).toBeGreaterThan(0);
    expect(compareVersions("18.9.0", "18.9.0")).toBe(0);
  });
  test("validates actual artifact bytes and refuses unlisted files and symlinks", async () => {
    const root = await directory();
    await writeFile(join(root, "candidate.patch"), "patch");
    await writeBundleManifest(root, manifest());
    expect((await validateBundle(root)).files).toEqual([{ path: "candidate.patch", sha256: sha("patch") }]);
    await writeFile(join(root, "candidate.patch"), "tampered");
    await expect(validateBundle(root)).rejects.toThrow("artifact-hash-mismatch");
    await writeFile(join(root, "candidate.patch"), "patch");
    await writeFile(join(root, "unlisted"), "secret");
    await expect(validateBundle(root)).rejects.toThrow("artifact-unlisted");
  });
  test("accepts only one exact-parent candidate ref and byte-identical patch in a bare-git bundle", async () => {
    const root = await directory(); const repo = join(root, "repo"); const artifact = join(root, "artifact");
    await mkdir(repo); await mkdir(artifact); git(repo, "init", "-b", "main");
    await writeFile(join(repo, "CHANGELOG.md"), "base\n"); git(repo, "add", "CHANGELOG.md"); git(repo, "commit", "-m", "base"); const base = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "CHANGELOG.md"), "base\ncandidate\n"); git(repo, "add", "CHANGELOG.md"); git(repo, "commit", "-m", "chore: support OMP 18.9.0"); const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/heads/maintenance-candidate", head);
    git(repo, "bundle", "create", join(artifact, "candidate.bundle"), "refs/heads/maintenance-candidate", `^${base}`);
    const patch = Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-renames", base, head], { cwd: repo, stdout: "pipe" }).stdout;
    await writeFile(join(artifact, "candidate.patch"), patch);
    const candidate = manifest(base, head);
    expect(validateCandidateTree(repo, artifact, candidate, ["CHANGELOG.md"])).toEqual(["CHANGELOG.md"]);
    await writeFile(join(artifact, "candidate.patch"), "not the candidate patch");
    expect(() => validateCandidateTree(repo, artifact, candidate, ["CHANGELOG.md"])).toThrow("candidate-patch-mismatch");
    await writeFile(join(artifact, "candidate.patch"), patch);
    expect(() => validateCandidateTree(repo, artifact, candidate, ["package.json"])).toThrow("candidate-path-forbidden");
  });
});

describe("origin and durable PR identity", () => {
  test("machine body is data with one unambiguous block", () => {
    const identity = { ...manifest("a".repeat(40), "b".repeat(40)), headSha: "b".repeat(40), artifactId: "42", manifestSha256: "c".repeat(64) };
    const body = maintenanceBody(identity);
    expect(parseMaintenanceBlock(body)).toMatchObject({ runId: "123", artifactId: "42", releaseVersion: "0.6.0" });
    expect(() => parseMaintenanceBlock(body + body)).toThrow();
    expect(() => parseMaintenanceBlock("human text")).toThrow();
  });
  test("hashes alone cannot authorize a foreign workflow, ref, run attempt or expired artifact", () => {
    const candidate = manifest();
    const run = { id: 123, run_attempt: 2, event: "workflow_dispatch", path: ".github/workflows/upstream-watch.yml", head_branch: "main", head_sha: candidate.baseSha, repository: { full_name: candidate.repository } };
    const artifact = { id: 42, name: "maintenance-18.9.0-123-2", expired: false, workflow_run: { id: 123, head_sha: candidate.baseSha } };
    expect(() => validateOrigin(candidate, run, artifact, "42")).not.toThrow();
    for (const changed of [{ ...run, head_branch: "other" }, { ...run, run_attempt: 1 }, { ...run, path: ".github/workflows/check.yml" }, { ...run, repository: { full_name: "foreign/repo" } }]) expect(() => validateOrigin(candidate, changed, artifact, "42")).toThrow();
    expect(() => validateOrigin(candidate, run, { ...artifact, expired: true }, "42")).toThrow();
  });
});

test("snapshot input validates full normalized source and rejects hash tampering", () => {
  const source = { tab: "General", group: null, label: "Label", description: "Description", warning: null, options: null };
  const snapshot = { version: "18.9.0", platform: "linux", settings: { fixture: { sourceHash: computeSourceHash(source), ...source } } };
  expect(snapshotValue(snapshot).settings.fixture?.label).toBe("Label");
  expect(() => snapshotValue({ ...snapshot, settings: { fixture: { ...snapshot.settings.fixture, label: "Changed" } } })).toThrow("snapshot-source-hash-mismatch");
});

describe("release documents travel through the candidate commit", () => {
  const PREVIOUS = "18.8.7";
  const UPSTREAM = "18.9.0";
  const VERSIONS = [PREVIOUS, UPSTREAM] as const;
  const PLATFORMS = ["win32", "linux", "darwin"] as const;
  const README_BASE = [
    "# omp-settings-ru", "", "## установка", "", "```text", "omp plugin install omp-settings-ru@omp-settings-ru", "```", "",
    "<!-- omp-supported:start -->", "## устаревшая таблица", "", "| OMP | настройки |", "| --- | ---: |", "| 18.8.4 | 404/404 |",
    "<!-- omp-supported:end -->", "", "## подробнее", "", "[FAQ](docs/faq.md).", "",
  ].join("\n");
  const CHANGELOG_BASE = "# изменения\n\n## [0.5.0](https://example.invalid/v0.5.0) — 2026-10-10\n\n- прошлый выпуск\n";
  const source = (label: string) => ({ tab: "General", group: null, label, description: `${label} description`, warning: null, options: null });
  const settings = (version: string) => version === UPSTREAM
    ? { "theme.dark": source("Dark theme"), "composer.predictions": source("Predictions") }
    : { "theme.dark": source("Dark theme") };
  const snapshotOf = (version: string, platform: string) => ({
    version, platform,
    settings: Object.fromEntries(Object.entries(settings(version)).map(([path, value]) => [path, { sourceHash: computeSourceHash(value), ...value }])),
  });
  const catalog = (includeCandidate: boolean) => JSON.stringify({ locale: "ru", settings: {
    "theme.dark": { variants: [{ sourceHash: computeSourceHash(source("Dark theme")), label: "Тёмная тема", description: "Тёмный фон", platforms: [...PLATFORMS], observedIn: [PREVIOUS] }] },
    ...(includeCandidate ? { "composer.predictions": { variants: [{ sourceHash: computeSourceHash(source("Predictions")), label: "Предсказания", description: "Подсказки ввода", platforms: [...PLATFORMS], observedIn: [UPSTREAM] }] } } : {}),
  } }, null, 2) + "\n";
  const coverage = VERSIONS.flatMap(version => PLATFORMS.map(platform => ({
    version, platform, complete: version === UPSTREAM ? 2 : 1, total: version === UPSTREAM ? 2 : 1,
  })));
  const candidateFor = (baseSha: string, headSha?: string) => ({ ...manifest(baseSha, headSha), upstreamVersion: UPSTREAM, releaseVersion: "0.6.0" });

  /** База поддержки 18.8.7 и рабочие данные кандидата 18.9.0; README базы уже содержит управляемый блок. */
  async function fixture() {
    const root = await directory(); const repo = join(root, "repo"); await mkdir(join(repo, "test/fixtures/host-snapshots"), { recursive: true });
    git(repo, "init", "-b", "main");
    const write = async (path: string, text: string) => { await mkdir(join(repo, path, ".."), { recursive: true }); await writeFile(join(repo, path), text); };
    const base = {
      "README.md": README_BASE,
      "CHANGELOG.md": CHANGELOG_BASE,
      "package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.5.0", devDependencies: { "@oh-my-pi/pi-coding-agent": PREVIOUS } }, null, 2) + "\n",
      "src/translations/ru-catalog.json": catalog(false),
    };
    for (const [path, text] of Object.entries(base)) await write(path, text);
    for (const platform of PLATFORMS) await write(`test/fixtures/host-snapshots/${PREVIOUS}-${platform}.json`, JSON.stringify(snapshotOf(PREVIOUS, platform), null, 2) + "\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const head = {
      "src/translations/ru-catalog.json": catalog(true),
      "package.json": JSON.stringify({ name: "omp-settings-ru", version: "0.6.0", devDependencies: { "@oh-my-pi/pi-coding-agent": UPSTREAM } }, null, 2) + "\n",
    };
    for (const [path, text] of Object.entries(head)) await write(path, text);
    for (const platform of PLATFORMS) await write(`test/fixtures/host-snapshots/${UPSTREAM}-${platform}.json`, JSON.stringify(snapshotOf(UPSTREAM, platform), null, 2) + "\n");
    return { repo, baseSha, write };
  }

  test("generated README, CHANGELOG and report match the commit bytes and keep the install instruction", async () => {
    const { repo, baseSha, write } = await fixture();
    const documents = await trustedReleaseDocuments({
      candidate: candidateFor(baseSha), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo },
    });
    // Установочная инструкция и всё вне управляемого блока сохранены байт в байт.
    expect(documents.readme).toContain("omp plugin install omp-settings-ru@omp-settings-ru");
    expect(documents.readme).toContain("[FAQ](docs/faq.md).");
    expect(documents.readme).not.toContain("устаревшая таблица");
    expect(documents.changelog.startsWith("## 0.6.0\n")).toBe(true);
    expect(documents.changelog).toContain(CHANGELOG_BASE.trimEnd());
    expect(documents.report).toContain("Предсказания");
    for (const [path, text] of [["README.md", documents.readme], ["CHANGELOG.md", documents.changelog], ["upgrade-report.md", documents.report]] as const) await write(path, text);
    git(repo, "add", "."); git(repo, "commit", "-m", `chore: support OMP ${UPSTREAM}`);
    const headSha = git(repo, "rev-parse", "HEAD");
    expect(await verifyReleaseDocuments(repo, candidateFor(baseSha, headSha), [...VERSIONS], coverage)).toEqual(documents);
    // Окончательный набор путей доказательства — ровно diff коммита, включая три пользовательских документа.
    const committed = git(repo, "diff", "--name-only", baseSha, headSha).split("\n").filter(Boolean).sort();
    expect(committed).toEqual([
      "CHANGELOG.md", "README.md", "package.json", "src/translations/ru-catalog.json",
      "test/fixtures/host-snapshots/18.9.0-darwin.json", "test/fixtures/host-snapshots/18.9.0-linux.json",
      "test/fixtures/host-snapshots/18.9.0-win32.json", "upgrade-report.md",
    ]);
    // Повторная генерация на том же входе даёт те же байты.
    expect(await trustedReleaseDocuments({ candidate: candidateFor(baseSha), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo } })).toEqual(documents);
  }, 30000);

  test("README text substituted outside the managed block is refused even after the commit is rebuilt", async () => {
    const { repo, baseSha, write } = await fixture();
    const documents = await trustedReleaseDocuments({ candidate: candidateFor(baseSha), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo } });
    for (const [path, text] of [["README.md", documents.readme], ["CHANGELOG.md", documents.changelog], ["upgrade-report.md", documents.report]] as const) await write(path, text);
    git(repo, "add", "."); git(repo, "commit", "-m", `chore: support OMP ${UPSTREAM}`);
    // Подмена установочной инструкции вне управляемого блока: байты README пересчитаны вместе с новым коммитом.
    await write("README.md", documents.readme.replace("omp plugin install omp-settings-ru@omp-settings-ru", "omp plugin install attacker/marketplace"));
    git(repo, "add", "."); git(repo, "commit", "-m", `chore: support OMP ${UPSTREAM}`);
    const tampered = git(repo, "rev-parse", "HEAD");
    await expect(verifyReleaseDocuments(repo, candidateFor(baseSha, tampered), [...VERSIONS], coverage))
      .rejects.toThrow("candidate-release-content-mismatch:README.md");
    // Управляемый блок вне доверенного пересчёта тоже не принимается: правка таблицы руками — не документ выпуска.
    await write("README.md", documents.readme.replace("| 18.9.0 | 2/2 | 2/2 | 2/2 |", "| 18.9.0 | 999/999 | 999/999 | 999/999 |"));
    git(repo, "add", "."); git(repo, "commit", "-m", `chore: support OMP ${UPSTREAM}`);
    await expect(verifyReleaseDocuments(repo, candidateFor(baseSha, git(repo, "rev-parse", "HEAD")), [...VERSIONS], coverage))
      .rejects.toThrow("candidate-release-content-mismatch:README.md");
  }, 30000);

  test("a release section already present in the accepted CHANGELOG blocks generation instead of rewriting history", async () => {
    const { repo, baseSha, write } = await fixture();
    // CHANGELOG в рабочем дереве не участвует: документы базы читаются из коммита, поэтому присланная
    // кандидатом секция не может ни попасть в выпуск, ни выдать себя за принятую.
    await write("CHANGELOG.md", `## 0.6.0\n\n- секция, написанная кандидатом\n\n${CHANGELOG_BASE}`);
    const documents = await trustedReleaseDocuments({ candidate: candidateFor(baseSha), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo } });
    expect(documents.changelog).not.toContain("написанная кандидатом");
    // Принятая база с уже существующим заголовком версии — отказ: история не переписывается и не дублируется.
    git(repo, "add", "."); git(repo, "commit", "-m", "human changelog");
    const conflicting = git(repo, "rev-parse", "HEAD");
    await expect(trustedReleaseDocuments({ candidate: candidateFor(conflicting), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo } }))
      .rejects.toThrow("release-changelog-version-conflict");
  }, 30000);
  test("recomputed artifact hashes cannot authorize a README edit outside the managed block", async () => {
    const root = await directory(); const { repo, baseSha, write } = await fixture();
    const documents = await trustedReleaseDocuments({ candidate: candidateFor(baseSha), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo } });
    for (const [path, text] of [["README.md", documents.readme], ["CHANGELOG.md", documents.changelog], ["upgrade-report.md", documents.report]] as const) await write(path, text);
    git(repo, "add", "."); git(repo, "commit", "-m", `chore: support OMP ${UPSTREAM}`);
    const headSha = git(repo, "rev-parse", "HEAD");
    const bundle = join(root, "artifact"); await mkdir(join(bundle, "data"), { recursive: true });
    const stage = async (readme: string) => {
      await mkdir(join(bundle, "data/src/translations"), { recursive: true });
      await writeFile(join(bundle, "data/README.md"), readme);
      await writeFile(join(bundle, "data/CHANGELOG.md"), documents.changelog);
      await writeFile(join(bundle, "data/upgrade-report.md"), documents.report);
      await writeFile(join(bundle, "data/src/translations/ru-catalog.json"), catalog(true));
      await writeBundleManifest(bundle, candidateFor(baseSha, headSha));
    };
    // Честные байты проходят и по манифесту артефакта, и по сверке с коммитом.
    await stage(documents.readme);
    expect((await validateBundle(bundle)).headSha).toBe(headSha);
    expect((await verifyReleaseDocuments(repo, await validateBundle(bundle), [...VERSIONS], coverage)).readme).toBe(documents.readme);
    // Подмена вне блока с пересчитанным манифестом артефакта: хэши артефакта сходятся, а с коммитом — нет.
    await stage(documents.readme.replace("omp plugin install omp-settings-ru@omp-settings-ru", "omp plugin install attacker/marketplace"));
    const tampered = await validateBundle(bundle);
    expect(tampered.files.some(file => file.path === "data/README.md")).toBe(true);
    await expect(verifyCommittedArtifacts(repo, bundle, tampered, ["README.md", "CHANGELOG.md", "upgrade-report.md"]))
      .rejects.toThrow("candidate-data-commit-mismatch:README.md");
    // Доверенная сверка читает коммит, поэтому подмена в артефакте до неё не доходит и коммит остаётся валидным.
    expect((await verifyReleaseDocuments(repo, tampered, [...VERSIONS], coverage)).readme).toBe(documents.readme);
  }, 30000);

  test("a missing snapshot of the new version blocks document generation", async () => {
    const { repo, baseSha } = await fixture();
    // Снимок удалён из рабочего дерева: неполная платформенная сетка — отказ генерации, а не пустая ячейка.
    await rm(join(repo, `test/fixtures/host-snapshots/${UPSTREAM}-win32.json`));
    await expect(trustedReleaseDocuments({ candidate: candidateFor(baseSha), versions: [...VERSIONS], coverage, source: { kind: "worktree", worktree: repo } }))
      .rejects.toThrow("release-content-invalid:snapshot-missing:18.9.0-win32");
  }, 30000);

  test("README is the only user document added to the candidate allowlist", async () => {
    const paths = candidatePaths(UPSTREAM);
    expect(paths).toContain("README.md");
    expect(paths.filter(path => path.endsWith(".md"))).toEqual(["upgrade-report.md", "CHANGELOG.md", "README.md"]);
    const root = await directory(); await mkdir(join(root, "data/docs"), { recursive: true });
    await writeFile(join(root, "data/docs/faq.md"), "manual\n");
    await writeBundleManifest(root, manifest("a".repeat(40)));
    await expect(validateBundle(root)).rejects.toThrow("artifact-path-forbidden:data/docs/faq.md");
  });
});

for (const fault of ["dependency", "history"] as const) test(`production verify rejects invalid ${fault} before any dependency subprocess`, async () => {
  const fixture = await semanticRuntimeFixture(["18.8.1", "18.8.2", "18.8.3", "18.8.4"], "18.8.7");
  const artifact = join(await directory(), "artifact"); await mkdir(artifact);
  try {
    fixture.applyCandidate(fixture.checkout);
    // Prepared artifacts carry the accepted support rows; completeSupport alone performs rotation.
    await writeFile(join(fixture.checkout, SUPPORTED_HOSTS), fixtureGit(fixture.checkout, ["show", `${fixture.base}:${SUPPORTED_HOSTS}`]));
    if (fault === "dependency") {
      const pkg = await Bun.file(join(fixture.checkout, "package.json")).json(); pkg.devDependencies["unapproved-package"] = "1.0.0";
      await writeFile(join(fixture.checkout, "package.json"), JSON.stringify(pkg));
    } else {
      const support = await Bun.file(join(fixture.checkout, SUPPORTED_HOSTS)).json(); support.historical[0].baselines.linux = "a".repeat(64);
      await writeFile(join(fixture.checkout, SUPPORTED_HOSTS), JSON.stringify(support));
    }
    const candidate = { ...manifest(fixture.base), upstreamVersion: fixture.candidate };
    for (const path of candidatePaths(fixture.candidate)) {
      const file = Bun.file(join(fixture.checkout, path)); if (!await file.exists()) continue;
      await mkdir(join(artifact, "data", path, ".."), { recursive: true }); await writeFile(join(artifact, "data", path), await file.bytes());
    }
    await writeBundleManifest(artifact, candidate);
    const spawn = Bun.spawn; const spawnSync = Bun.spawnSync; const dependencyCommands: string[][] = [];
    const guard = (command: string[]) => { if (command.includes("install")) { dependencyCommands.push(command); throw new Error("unexpected-dependency-subprocess"); } };
    spyOn(Bun, "spawn").mockImplementation(((command: string[], options: object) => { guard(command); return spawn(command, options); }) as typeof Bun.spawn);
    spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: object) => { guard(command); return spawnSync(command, options); }) as typeof Bun.spawnSync);
    try {
      await expect(verifyCandidate(fixture.checkout, artifact, validatePolicy(rawPolicy))).rejects.toThrow(fault === "dependency" ? "package-dependency-changed:unapproved-package" : "supported-history-transition-invalid");
      expect(dependencyCommands).toEqual([]);
    } finally { mock.restore(); }
  } finally { await fixture.close(); }
}, 120000);

/**
 * Полный кандидат в форме, которую принимает публикация: bundle, patch, артефакт и proof.json.
 *
 * Проверяется именно то, что нельзя увидеть в одном документе: окончательный `proof.semantic.changedPaths`
 * обязан совпасть с diff коммита, включая README/CHANGELOG/upgrade-report, а сами документы — с доверенным
 * пересчётом. Используется настоящий изолированный npm registry; публичной сети и native smoke нет.
 */

test("candidate proof carries README, CHANGELOG and report as the exact commit diff", async () => {
  const fixture = await semanticRuntimeFixture(["18.8.4"], "18.8.7");
  try {
  const root = await directory(); const repo = fixture.checkout; const artifact = join(root, "artifact"); await mkdir(artifact);
  const policy = validatePolicy(rawPolicy); const BASE = fixture.versions[0]!; const UPSTREAM = fixture.candidate; const VERSIONS = [BASE, UPSTREAM] as const;
  const README = "# omp-settings-ru\n\n## установка\n\n```text\nomp plugin install omp-settings-ru@omp-settings-ru\n```\n\n<!-- omp-supported:start -->\n## старая таблица\n<!-- omp-supported:end -->\n\n## подробнее\n\n[FAQ](docs/faq.md).\n";
  const CHANGELOG = "# изменения\n\n## [0.5.0](https://example.invalid/v0.5.0) — 2026-10-10\n\n- прошлый выпуск\n";
  const write = async (path: string, text: string) => { await mkdir(join(repo, path, ".."), { recursive: true }); await writeFile(join(repo, path), text); };
  await write("README.md", README); await write("CHANGELOG.md", CHANGELOG);
  fixtureGit(repo, ["add", "README.md", "CHANGELOG.md"]); fixtureGit(repo, ["commit", "-m", "accepted documents"]);
  const baseSha = fixtureGit(repo, ["rev-parse", "HEAD"]);
  const candidate: Candidate = { schemaVersion: 1, repository: policy.repository, runId: "123", runAttempt: "2", baseSha, upstreamVersion: UPSTREAM, releaseVersion: "0.6.0", semanticReview: "disabled", files: [] };
  fixture.applyCandidate(repo);
  const coverage = VERSIONS.flatMap(version => FIXTURE_PLATFORMS.map(async platform => {
    const snapshot = await Bun.file(join(repo, "test/fixtures/host-snapshots", `${version}-${platform}.json`)).json() as BaselineSnapshot;
    const total = Object.keys(snapshot.settings).length;
    return { version, platform, complete: total, total };
  }));
  const resolvedCoverage = await Promise.all(coverage);
  const documents = await trustedReleaseDocuments({ candidate, versions: [...VERSIONS], coverage: resolvedCoverage, source: { kind: "worktree", worktree: repo } });
  await write("README.md", documents.readme); await write("CHANGELOG.md", documents.changelog); await write("upgrade-report.md", documents.report);
  fixtureGit(repo, ["add", "-A"]); fixtureGit(repo, ["commit", "-m", `chore: support OMP ${UPSTREAM}`]);
  const headSha = fixtureGit(repo, ["rev-parse", "HEAD"]);
  const committed = fixtureGit(repo, ["diff", "--name-only", baseSha, headSha]).split("\n").filter(Boolean).sort();
  const before = readCatalogAtCommit(repo, baseSha); const after = readCatalogAtCommit(repo, headSha);
  const snapshots = VERSIONS.flatMap(version => FIXTURE_PLATFORMS.map(platform => JSON.parse(fixtureGit(repo, ["show", `${headSha}:test/fixtures/host-snapshots/${version}-${platform}.json`])) as BaselineSnapshot));
  const baseSnapshots = ["win32", "linux", "darwin"].map(platform => JSON.parse(fixtureGit(repo, ["show", `${baseSha}:test/fixtures/host-snapshots/${BASE}-${platform}.json`])) as BaselineSnapshot);
  const delta = catalogDelta(after, before, snapshots, baseSnapshots); if ("failure" in delta) throw new Error(delta.failure);
  const evidence = {
    candidateVersion: UPSTREAM, supportedVersions: [...VERSIONS], coverage: resolvedCoverage,
    drift: VERSIONS.flatMap(version => FIXTURE_PLATFORMS.map(platform => ({ version, platform, added: 0, removed: 0, changed: 0 }))),
    reviewRows: [], reviewRequired: false, changedPaths: committed, changedCatalogVariants: delta.variants,
    identities: identitiesOf(after), identitiesBefore: identitiesOf(before), translationIdentities: translationIdentitiesOf(after), translationIdentitiesBefore: translationIdentitiesOf(before), markerPairs: markerPairsOf(after, snapshots),
  };
  expect(committed).toEqual(expect.arrayContaining(["README.md", "CHANGELOG.md", "upgrade-report.md", "bun.lock"]));
  fixtureGit(repo, ["update-ref", "refs/heads/maintenance-candidate", headSha]); fixtureGit(repo, ["bundle", "create", join(artifact, "candidate.bundle"), "refs/heads/maintenance-candidate", `^${baseSha}`]);
  await writeFile(join(artifact, "candidate.patch"), Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-renames", baseSha, headSha], { cwd: repo, stdout: "pipe" }).stdout);
  for (const path of committed) { await mkdir(join(artifact, "data", path, ".."), { recursive: true }); await writeFile(join(artifact, "data", path), Bun.spawnSync(["git", "show", `${headSha}:${path}`], { cwd: repo, stdout: "pipe" }).stdout); }
  const digest = (path: string) => createHash("sha256").update(fixtureGit(repo, ["show", `${headSha}:${path}`]) + "\n").digest("hex");
  await writeFile(join(artifact, "proof.json"), JSON.stringify({ baseSha, upstreamVersion: UPSTREAM, releaseVersion: "0.6.0", semanticReview: "disabled", nativeSmoke: "passed", catalogSha256: digest("src/translations/ru-catalog.json"), manifestSha256: digest("src/translations/variant-review.json"), semantic: evidence }, null, 2) + "\n");
  await writeBundleManifest(artifact, { ...candidate, headSha });
  const published = await validatePublishedCandidate(repo, artifact, policy, fixture.registry); expect(published.headSha).toBe(headSha);
  const proof = await Bun.file(join(artifact, "proof.json")).json(); expect(proof.semantic.changedPaths).toEqual(committed);
  await writeFile(join(artifact, "proof.json"), JSON.stringify({ ...proof, semantic: { ...proof.semantic, changedPaths: committed.filter(path => path !== "README.md") } }, null, 2) + "\n"); await writeBundleManifest(artifact, { ...candidate, headSha });
  await expect(validatePublishedCandidate(repo, artifact, policy, fixture.registry)).rejects.toThrow("candidate-verification-paths-mismatch");
  await writeFile(join(artifact, "proof.json"), JSON.stringify(proof, null, 2) + "\n"); await writeBundleManifest(artifact, { ...candidate, headSha });
  const originalLock = await Bun.file(join(repo, "bun.lock")).text();
  const changedLock = originalLock.replace(/sha512-[A-Za-z0-9+/=]+/, `sha512-${"A".repeat(86)}==`);
  expect(changedLock).not.toBe(originalLock);
  await write("bun.lock", changedLock); fixtureGit(repo, ["add", "bun.lock"]); fixtureGit(repo, ["commit", "--amend", "--no-edit"]);
  const lockHead = fixtureGit(repo, ["rev-parse", "HEAD"]);
  fixtureGit(repo, ["update-ref", "refs/heads/maintenance-candidate", lockHead]);
  await rm(join(artifact, "candidate.bundle"));
  fixtureGit(repo, ["bundle", "create", join(artifact, "candidate.bundle"), "refs/heads/maintenance-candidate", `^${baseSha}`]);
  await writeFile(join(artifact, "candidate.patch"), Bun.spawnSync(["git", "diff", "--binary", "--full-index", "--no-renames", baseSha, lockHead], { cwd: repo, stdout: "pipe" }).stdout);
  await writeFile(join(artifact, "data/bun.lock"), changedLock); await writeBundleManifest(artifact, { ...candidate, headSha: lockHead });
  await expect(validatePublishedCandidate(repo, artifact, policy, fixture.registry)).rejects.toThrow("lock-mismatch:packages");
  await write("README.md", documents.readme.replace("omp plugin install omp-settings-ru@omp-settings-ru", "omp plugin install attacker/marketplace")); fixtureGit(repo, ["add", "README.md"]); fixtureGit(repo, ["commit", "-m", `chore: support OMP ${UPSTREAM}`]);
  const tampered = fixtureGit(repo, ["rev-parse", "HEAD"]); await expect(verifyReleaseDocuments(repo, { ...published, headSha: tampered }, VERSIONS, resolvedCoverage)).rejects.toThrow("candidate-release-content-mismatch:README.md");
  } finally { await fixture.close(); }
}, 120000);
test("expired owned candidate is closed and exact bare remote branch retired without mutating main", async () => {
  const root = await directory(); const repo = join(root, "repo"); const bare = join(root, "origin.git"); await mkdir(repo);
  git(repo, "init", "-b", "main"); await writeFile(join(repo, "CHANGELOG.md"), "base\n"); git(repo, "add", "CHANGELOG.md"); git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD"); git(root, "init", "--bare", bare); git(repo, "remote", "add", "origin", bare); git(repo, "push", "origin", "main");
  await writeFile(join(repo, "CHANGELOG.md"), "candidate\n"); git(repo, "commit", "-am", "candidate"); const head = git(repo, "rev-parse", "HEAD"); git(repo, "push", "origin", `${head}:refs/heads/upgrade/omp-18.9.0`);
  const policy = validatePolicy(rawPolicy); const repository = policy.repository;
  const identity = { ...manifest(base, head), headSha: head, artifactId: "42", manifestSha256: "c".repeat(64) };
  let closed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    const main = git(bare, "rev-parse", "refs/heads/main");
    if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response("unauthorized", { status: 401 });
    if (path === `/repos/${repository}/pulls` && request.method === "GET") return Response.json(closed ? [] : [{ number: 1, state: "open", merged_at: null, draft: false, body: maintenanceBody(identity), user: { login: policy.controllerLogin, type: "User" }, base: { ref: "main", sha: base, repo: { full_name: repository } }, head: { ref: "upgrade/omp-18.9.0", sha: head, repo: { full_name: repository } } }]);
    if (path.endsWith("/actions/artifacts/42")) return Response.json({ expired: true });
    if (path.endsWith("/actions/runs/123/attempts/2")) return Response.json({ id: 123, run_attempt: 2, path: ".github/workflows/upstream-watch.yml", event: "schedule", head_branch: "main", head_sha: base, repository: { full_name: repository } });
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: main } });
    if (path.endsWith("/git/ref/heads/upgrade/omp-18.9.0")) return Response.json({ object: { sha: git(bare, "rev-parse", "refs/heads/upgrade/omp-18.9.0") } });
    if (path === "/user") return Response.json({ login: policy.controllerLogin, type: "User" });
    if (path.endsWith("/pulls/1") && request.method === "PATCH") { const value = await request.json() as { state: string }; if (value.state !== "closed") return new Response("bad", { status: 400 }); closed = true; return Response.json({ state: "closed" }); }
    if (path.endsWith("/git/refs/heads/upgrade/omp-18.9.0") && request.method === "DELETE" && closed) { git(bare, "update-ref", "-d", "refs/heads/upgrade/omp-18.9.0", head); return new Response(null, { status: 204 }); }
    return new Response("unexpected fixture route", { status: 404 });
  } });
  const transport = join(root, "gh.ts");
  await writeFile(transport, `const args=process.argv.slice(2); if(args[0]!=="api")throw new Error("refused"); let method="GET";let endpoint="";const body={};for(let i=1;i<args.length;i++){if(args[i]==="--method")method=args[++i];else if(args[i]==="-f"||args[i]==="-F"){const value=args[++i];const at=value.indexOf("=");body[value.slice(0,at)]=value.slice(at+1);}else endpoint=args[i];}const response=await fetch(${JSON.stringify(server.url.href)}+endpoint,{method,headers:{authorization:"Bearer "+process.env.GH_TOKEN,"content-type":"application/json"},...(method==="GET"||method==="DELETE"?{}:{body:JSON.stringify(body)})});if(!response.ok){console.error("HTTP "+response.status);process.exit(1)}process.stdout.write(await response.text());`);
  const spawn = Bun.spawn;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Bun.SpawnOptions.OptionsObject<"pipe", "pipe", "pipe">) => command[0] === "gh" ? spawn([process.execPath, transport, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  try {
    expect(await finalizeCandidate(repo, "18.9.0", new HostedGitHub(policy, "fixture-token"))).toBe("retired");
    expect(closed).toBe(true);
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(base);
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/upgrade/")).toBe("");
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/tags/")).toBe("");
  } finally { mock.restore(); server.stop(true); }
}, 30000);

test("fresh translation CLI writes strict catalog without invoking a semantic reviewer", async () => {
  const root = await directory(); const bundle = join(root, "artifact"); await mkdir(bundle); await mkdir(join(bundle, "data/src/translations"), { recursive: true });
  await writeFile(join(root, "maintenance.config.json"), JSON.stringify(rawPolicy));
  const base = "a".repeat(40); const source = { tab: "General", group: null, label: "Mode", description: "Select mode", warning: null, options: null };
  const hash = computeSourceHash(source);
  const snapshots = ["win32", "darwin", "linux"].map(platform => ({ version: "18.9.0", platform, settings: { fixture: { sourceHash: hash, ...source } } }));
  const original = JSON.stringify({ locale: "ru", settings: {} });
  await writeFile(join(bundle, "data/src/translations/ru-catalog.json"), original);
  await writeFile(join(bundle, "data/src/translations/variant-review.json"), JSON.stringify({ schemaVersion: 1, variants: [] }));
  await writeFile(join(bundle, "input.json"), JSON.stringify({ snapshots }));
  await writeBundleManifest(bundle, manifest(base));
  let count = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions" || request.headers.get("authorization") !== "Bearer model-fixture") return new Response("refused", { status: 403 });
    const body = await request.json() as { messages: { role: string; content: string }[] };
    if (body.messages.length !== 2) return new Response("history", { status: 400 });
    count++;
    return Response.json({ choices: [{ message: { content: '{"label":"Режим","description":"Выберите режим"}' } }] });
  } });
  const cli = join(import.meta.dir, "../scripts/maintenance-actions.ts");
  const environment = { ...process.env, GITHUB_ACTIONS: "false", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", MAINTENANCE_BASE_SHA: base, MAINTENANCE_API_KEY: "model-fixture", MAINTENANCE_BASE_URL: server.url.href + "v1", MAINTENANCE_MODEL: "fixture", GH_TOKEN: undefined, GITHUB_TOKEN: undefined, MAINTENANCE_GH_TOKEN: undefined };
  try {
    const child = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text(); expect(await child.exited, stderr).toBe(0);
    const catalog = await Bun.file(join(bundle, "data/src/translations/ru-catalog.json")).json();
    expect(catalog.settings.fixture.variants[0].label).toBe("Режим");
    expect(catalog.settings.fixture.variants[0].platforms).toEqual(["darwin", "linux", "win32"]);
    const candidate = await validateBundle(bundle); expect(candidate.semanticReview).toBe("disabled"); expect("reviewResponses" in candidate).toBe(false);
    const rows = await Bun.file(join(bundle, "data/src/translations/variant-review.json")).json();
    expect(rows).toEqual({ schemaVersion: 1, variants: [], semanticReview: "disabled" });
    expect(count).toBe(1);
    expect(await Bun.file(join(root, ".git")).exists()).toBe(false);
    await writeFile(join(bundle, "input.json"), "{model-fixture"); await writeBundleManifest(bundle, manifest(base));
    const broken = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    const brokenStderr = await new Response(broken.stderr).text(); expect(await broken.exited).not.toBe(0);
    expect(brokenStderr).toBe("translate-failed:input:SyntaxError\n");
    expect(brokenStderr.length).toBeLessThanOrEqual(120);
    expect(brokenStderr).not.toContain("maintenance-action-blocked"); expect(brokenStderr).not.toContain("model-fixture");
    expect(count).toBe(1);
    await rm(join(bundle, "input.json")); await writeBundleManifest(bundle, manifest(base));
    const missing = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(missing.stderr).text()).toBe("translate-failed:input:ENOENT\n"); expect(await missing.exited).not.toBe(0);
    expect(count).toBe(1);
    let httpFailure = false;
    await writeFile(join(bundle, "data/src/translations/ru-catalog.json"), original);
    await writeFile(join(bundle, "input.json"), JSON.stringify({ snapshots })); await writeBundleManifest(bundle, manifest(base));
    server.stop(true);
    const failingServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { httpFailure = true; return new Response("refused", { status: 503 }); } });
    try {
      const failedRequest = Bun.spawn([process.execPath, cli, "translate", "--bundle", bundle], { cwd: root, env: { ...environment, MAINTENANCE_BASE_URL: failingServer.url.href + "v1" }, stdout: "pipe", stderr: "pipe" });
      expect(await new Response(failedRequest.stderr).text()).toBe("model-http-503\n"); expect(await failedRequest.exited).not.toBe(0);
      expect(httpFailure).toBe(true);
    } finally { failingServer.stop(true); }
  } finally { server.stop(true); }
}, 30000);

for (const mode of ["merge-without-tag", "draft", "manual-draft", "manual-advanced", "published"] as const) test(`recovery ${mode} preserves exact bare refs and confirms catalog without duplicate effects`, async () => {
  const fixture = await recoveryFixture(mode);
  const spawn = Bun.spawn; const spawnSync = Bun.spawnSync; const actualFetch = globalThis.fetch; const sleep = Bun.sleep;
  spyOn(Bun, "spawn").mockImplementation(((command: string[], options: object) => command[0] === "gh" ? spawn([process.execPath, fixture.transport, ...command.slice(1)], options) : spawn(command, options)) as typeof Bun.spawn);
  spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: object) => command[0] === "gh" ? spawnSync([process.execPath, fixture.transport, ...command.slice(1)], options) : spawnSync(command, options)) as typeof Bun.spawnSync);
  spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "github.com") throw new Error("fixture-refuses-live-fetch");
    return actualFetch(fixture.origin + url.pathname + url.search, init);
  }) as typeof fetch);
  spyOn(Bun, "sleep").mockImplementation((() => sleep(1)) as typeof Bun.sleep);
  try {
    expect(await finalizeCandidate(fixture.repo, "18.9.0", new HostedGitHub(fixture.policy, "fixture-token"))).toBe("released");
    expect(fixture.git("rev-parse", "refs/heads/main")).toBe(fixture.merge);
    expect(fixture.git("rev-parse", "refs/tags/v0.6.0")).toBe(fixture.merge);
    expect(fixture.git("for-each-ref", "--format=%(refname)", "refs/heads/upgrade/")).toBe("");
    const before = await readFile(join(fixture.root, "requests.jsonl"), "utf8");
    expect(await finalizeCandidate(fixture.repo, "18.9.0", new HostedGitHub(fixture.policy, "fixture-token"))).toBe("released");
    const after = (await readFile(join(fixture.root, "requests.jsonl"), "utf8")).slice(before.length).trim().split("\n").map(line => JSON.parse(line) as { method: string });
    expect(after.every(row => row.method === "GET")).toBe(true);
    const state = await Bun.file(join(fixture.root, "state.json")).json();
    expect(state).toMatchObject({ published: true, draft: false, reruns: mode === "draft" || mode === "manual-draft" || mode === "manual-advanced" ? 1 : 0 });
  } finally { mock.restore(); await fixture.cleanup(); }
}, 30000);

function recoveryTestGithub(runs: readonly Record<string, unknown>[], options: { rerun?: (id: number) => void; attempts?: Record<number, Record<string, unknown>> } = {}): HostedGitHub {
  const policy = validatePolicy(rawPolicy);
  let runIndex = 0;
  const attempts = options.attempts ?? {};
  const github = Object.create(HostedGitHub.prototype) as HostedGitHub & { policy: typeof policy };
  Object.defineProperty(github, "policy", { value: policy });
  github.list = async (path: string) => path.includes("/jobs") ? [{ id: 9001, run_id: 501, run_attempt: 1, name: "check (ubuntu-latest, 18.9.0)", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }] : [runs[Math.min(runIndex++, runs.length - 1)]!];
  github.api = async (path: string) => {
    const match = path.match(/actions\/runs\/(\d+)\/attempts\/(\d+)/);
    return match ? attempts[Number(match[2])] : undefined;
  };
  github.command = async () => { options.rerun?.(501); return ""; };
  const checks = new HostedGitHub(policy, "fixture").checks;
  checks.checksFor = async () => {
    const run = runs[Math.min(Math.max(0, runIndex - 1), runs.length - 1)]!;
    const names = [...policy.requiredCheckPlatforms.map(pair => policy.requiredCheckTemplate.replaceAll("{os}", pair.os).replaceAll("{version}", "18.9.0")), ...policy.additionalRequiredChecks];
    return names.map((name, id) => ({id, name, headSha: String(run.head_sha), status: "completed", conclusion: "success", workflowPath: ".github/workflows/check.yml", event: "push", workflowRunId: Number(run.id), workflowAttempt: Number(run.run_attempt), headBranch: String(run.head_branch)}));
  };
  Object.defineProperty(github, "checks", { value: checks });
  return github;
}

test("check recovery reruns failed workflow and accepts the new successful attempt", async () => {
  let reruns = 0;
  const repository = validatePolicy(rawPolicy).repository;
  const run = (attempt: number, conclusion: string, status = "completed") => ({ id: 501, run_attempt: attempt, path: ".github/workflows/check.yml", event: "push", head_sha: "a".repeat(40), head_branch: "main", status, conclusion, repository: { full_name: repository } });
  const github = recoveryTestGithub([run(1, "failure"), run(2, "success")], { rerun: () => { reruns++; }, attempts: { 2: run(2, "success") } });
  const sleep = Bun.sleep; spyOn(Bun, "sleep").mockImplementation((() => sleep(1)) as typeof Bun.sleep);
  await ensureCheckRun(github, "a".repeat(40), ["18.9.0"], "main");
  expect(reruns).toBe(1);
});

test("check recovery accepts cancelled attempt only after failed-job rerun", async () => {
  let reruns = 0;
  const repository = validatePolicy(rawPolicy).repository;
  const run = (attempt: number, conclusion: string) => ({ id: 501, run_attempt: attempt, path: ".github/workflows/check.yml", event: "push", head_sha: "b".repeat(40), head_branch: "main", status: "completed", conclusion, repository: { full_name: repository } });
  const github = recoveryTestGithub([run(1, "cancelled"), run(2, "success")], { rerun: () => { reruns++; }, attempts: { 2: run(2, "success") } });
  await ensureCheckRun(github, "b".repeat(40), ["18.9.0"], "main");
  expect(reruns).toBe(1);
});

test("check recovery refuses to reset an exhausted attempt budget after restart", async () => {
  let reruns = 0;
  const repository = validatePolicy(rawPolicy).repository;
  const run = { id: 501, run_attempt: 3, path: ".github/workflows/check.yml", event: "push", head_sha: "c".repeat(40), head_branch: "main", status: "completed", conclusion: "failure", repository: { full_name: repository } };
  const github = recoveryTestGithub([run], { rerun: () => { reruns++; } });
  await expect(ensureCheckRun(github, "c".repeat(40), ["18.9.0"], "main")).rejects.toThrow("candidate-checks-retries-exhausted:501");
  expect(reruns).toBe(0);
});

test("check recovery refuses a rerun when no new attempt starts", async () => {
  let clock = 0;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const sleep = spyOn(Bun, "sleep").mockImplementation((ms: number | Date) => { clock += typeof ms === "number" ? ms : ms.getTime(); return Promise.resolve(); });
  try {
    const repository = validatePolicy(rawPolicy).repository;
    const run = { id: 501, run_attempt: 1, path: ".github/workflows/check.yml", event: "push", head_sha: "d".repeat(40), head_branch: "main", status: "completed", conclusion: "failure", repository: { full_name: repository } };
    const github = recoveryTestGithub([run], { attempts: {} });
    let posts = 0;
    github.command = async () => { posts++; throw new Error("This workflow is already running"); };
    await expect(ensureCheckRun(github, "d".repeat(40), ["18.9.0"], "main")).rejects.toThrow("check-rerun-not-started:501");
    expect(clock).toBe(60_000);
    expect(posts).toBe(1);
  } finally {
    sleep.mockRestore();
    now.mockRestore();
  }
});
