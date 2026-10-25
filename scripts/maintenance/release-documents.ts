import { git, gitFile, type Candidate } from "./actions-bundle";
import { readCatalog, readCatalogAtCommit, type CoveragePair } from "./semantic";
import { buildReleaseDocuments, type ReleaseDocuments } from "./release-content";
import { snapshotValue } from "./snapshots";
import { SNAPSHOT_PLATFORMS, snapshotPath } from "./paths";
import { asRecord, parseStrictJSON } from "./json";
import type { BaselineSnapshot } from "../../src/report";

/**
 * Сборка пользовательских документов выпуска из проверенных данных.
 *
 * Модуль стоит отдельно от проверки и публикации, потому что оба конца обязаны считать документы одним и тем
 * же кодом: проверка пишет их до коммита, публикация пересчитывает и сверяет байты. Здесь только чтение
 * доверенных объектов (коммит базы, коммит головы или рабочее дерево кандидата) и вызов чистого генератора;
 * ни сети, ни модели, ни права решать, что считать поддержкой.
 */

/** Версия OMP, на которой стояла принятая база: пин devDependency, а не «предыдущая» из манифеста. */
export function pinnedHostVersion(manifest: unknown): string {
  const pinned = asRecord(asRecord(manifest)?.devDependencies)?.["@oh-my-pi/pi-coding-agent"];
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) throw new Error("accepted-pin-invalid");
  return pinned;
}

/** Снимки одной версии из коммита: снимок проходит ту же проверку идентичности, что и данные кандидата. */
export function snapshotsAtCommit(worktree: string, sha: string, version: string): BaselineSnapshot[] {
  return SNAPSHOT_PLATFORMS.map(platform => {
    const path = snapshotPath(version, platform);
    let text: string;
    try { text = gitFile(worktree, sha, path); }
    catch { throw new Error(`release-content-invalid:snapshot-missing:${version}-${platform}`); }
    return snapshotValue(parseStrictJSON(text), version, platform);
  });
}

/** Снимки версии из рабочего дерева кандидата: новые файлы в коммите базы отсутствуют. */
export async function snapshotsInTree(worktree: string, version: string): Promise<BaselineSnapshot[]> {
  const snapshots: BaselineSnapshot[] = [];
  for (const platform of SNAPSHOT_PLATFORMS) {
    const path = `${worktree}/${snapshotPath(version, platform)}`;
    const file = Bun.file(path);
    // Отсутствующий снимок новой версии — отказ генерации с тем же кодом, что и у снимка базы.
    if (!await file.exists()) throw new Error(`release-content-invalid:snapshot-missing:${version}-${platform}`);
    snapshots.push(snapshotValue(parseStrictJSON(await file.text()), version, platform));
  }
  return snapshots;
}

/**
 * Откуда брать итоговые каталог и снимки кандидата.
 *
 * Проверка читает их из рабочего дерева (коммита ещё нет), публикация — из коммита головы. Оба пути дают один
 * и тот же текст на одних данных, поэтому расхождение с байтами коммита — доказательство подмены.
 */
export type ReleaseContentSource =
  | { readonly kind: "worktree"; readonly worktree: string }
  | { readonly kind: "commit"; readonly worktree: string; readonly sha: string };

export interface ReleaseDocumentsInput {
  readonly candidate: Candidate;
  readonly versions: readonly string[];
  readonly coverage: readonly CoveragePair[];
  readonly source: ReleaseContentSource;
}

/**
 * Три пользовательских документа выпуска из уже измеренного доказательства и принятой базы.
 *
 * README и CHANGELOG базы читаются из коммита базы, а не из рабочего дерева: кандидат не имеет права прислать
 * собственные документы и выдать их за принятые. Каталоги, снимки и покрытие — те же измеренные значения, что
 * прошли семантическую проверку; повторного измерения здесь нет.
 */
export async function trustedReleaseDocuments(input: ReleaseDocumentsInput): Promise<ReleaseDocuments> {
  const { candidate, versions, coverage, source } = input;
  const previousHostVersion = pinnedHostVersion(parseStrictJSON(git(source.worktree, ["show", `${candidate.baseSha}:package.json`])));
  return buildReleaseDocuments({
    releaseVersion: candidate.releaseVersion,
    previousHostVersion,
    upstreamVersion: candidate.upstreamVersion,
    versions,
    before: readCatalogAtCommit(source.worktree, candidate.baseSha),
    after: source.kind === "worktree" ? await readCatalog(source.worktree) : readCatalogAtCommit(source.worktree, source.sha),
    previousSnapshots: snapshotsAtCommit(source.worktree, candidate.baseSha, previousHostVersion),
    currentSnapshots: source.kind === "worktree"
      ? await snapshotsInTree(source.worktree, candidate.upstreamVersion)
      : snapshotsAtCommit(source.worktree, source.sha, candidate.upstreamVersion),
    coverage,
  }, {
    readme: gitFile(source.worktree, candidate.baseSha, "README.md"),
    changelog: gitFile(source.worktree, candidate.baseSha, "CHANGELOG.md"),
  });
}

/** Документы выпуска: единственный список, по которому идёт сверка байтов коммита. */
const RELEASE_DOCUMENTS = ["README.md", "CHANGELOG.md", "upgrade-report.md"] as const;

/**
 * Сверка байтов коммита с доверенным пересчётом.
 *
 * Публикация не доверяет присланным документам: три файла пересчитываются тем же генератором из базы и
 * проверенных данных головы, и любое расхождение — отказ. Так расширенный allowlist README не превращается в
 * право переписать установочную инструкцию, ссылки или историю CHANGELOG.
 */
export async function verifyReleaseDocuments(
  checkout: string, candidate: Candidate, versions: readonly string[], coverage: readonly CoveragePair[],
): Promise<ReleaseDocuments> {
  if (!candidate.headSha) throw new Error("candidate-head-missing");
  const documents = await trustedReleaseDocuments({ candidate, versions, coverage, source: { kind: "commit", worktree: checkout, sha: candidate.headSha } });
  const expected: Record<(typeof RELEASE_DOCUMENTS)[number], string> = { "README.md": documents.readme, "CHANGELOG.md": documents.changelog, "upgrade-report.md": documents.report };
  for (const path of RELEASE_DOCUMENTS) {
    if (gitFile(checkout, candidate.headSha, path) !== expected[path]) throw new Error(`candidate-release-content-mismatch:${path}`);
  }
  return documents;
}
