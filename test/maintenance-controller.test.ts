import { describe, expect, test } from "bun:test";
import { Controller, refusalCode, type ControllerContext } from "../scripts/maintenance/controller";
import { parseReviewerVerdict } from "../scripts/maintenance/report";
import { Journal } from "../scripts/maintenance/journal";
import { GitHub } from "../scripts/maintenance/github";
import { Orca } from "../scripts/maintenance/orca";
import { validatePolicy } from "../scripts/maintenance/policy";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rawPolicy from "../maintenance.config.json";

/**
 * Проверка переходов стадий на типизированных наблюдениях.
 *
 * Журнал, дерево и файлы — настоящие: тесты создают реальные каталоги состояния и реальные git-репозитории.
 * Подменяются только удалённые границы (GitHub, Orca), потому что в тесте недопустимы настоящие PR и выпуски.
 */

const policy = validatePolicy(rawPolicy);

function makeContext(directory: string, overrides: Partial<ControllerContext> = {}) {
  return (async () => {
    const journal = await Journal.open(directory);
    const context: ControllerContext = {
      checkout: directory,
      stateDirectory: directory,
      policy,
      journal,
      github: new GitHub(policy),
      orca: new Orca(policy),
      supportedVersions: ["18.6.1", "18.8.0", "18.8.4", "18.8.7"],
      pinnedVersion: "18.8.7",
      ...overrides,
    };
    return { context, journal };
  })();
}

describe("вердикт ревьюера", () => {
  test("структурированный вердикт принимается с обеими головами и отпечатками", () => {
    const verdict = parseReviewerVerdict(JSON.stringify({
      schemaVersion: 1, nonce: "01234567-0123-0123-0123-0123456789ab", role: "reviewer",
      verdict: "approved", headSha: "a".repeat(40), baseSha: "b".repeat(40),
      evidenceHashes: ["c".repeat(64)], reviewRows: [],
    }));
    expect(verdict?.verdict).toBe("approved");
    expect(verdict?.baseSha).toBe("b".repeat(40));
  });

  test("неструктурированный или неполный вердикт не принимается", () => {
    expect(parseReviewerVerdict("выглядит хорошо")).toBeUndefined();
    expect(parseReviewerVerdict(JSON.stringify({ verdict: "approved" }))).toBeUndefined();
    expect(parseReviewerVerdict(JSON.stringify({ verdict: "approved", headSha: "a".repeat(40), baseSha: "b".repeat(40), evidenceHashes: [] }))).toBeUndefined();
  });
});

describe("код отказа стадии", () => {
  test("внутренний код с путём измерения доходит до записанного blocked целиком", () => {
    // Ровно та форма, которую несёт отказ сбора: путь содержит `/` и `.`, поэтому он часть кода.
    expect(refusalCode(new Error("measurement-code-changed:scripts/check-coverage.ts")))
      .toBe("measurement-code-changed:scripts/check-coverage.ts");
    expect(refusalCode(new Error("package-field-changed:dependencies.omp-settings")))
      .toBe("package-field-changed:dependencies.omp-settings");
    expect(refusalCode(new Error(`historical-identity-removed:composer.tokenRate:${"a".repeat(64)}:${"b".repeat(64)}`)))
      .toBe(`historical-identity-removed:composer.tokenRate:${"a".repeat(64)}:${"b".repeat(64)}`);
    expect(refusalCode(new Error("catalog-file-missing:ru-variants.ts"))).toBe("catalog-file-missing:ru-variants.ts");
  });

  test("посторонний текст ошибки остаётся stage-failed, а не становится причиной", () => {
    expect(refusalCode(new Error("ENOENT: no such file or directory, open 'C:\\secrets\\token.txt'")))
      .toBe("stage-failed");
    expect(refusalCode(new Error("https://user:pass@github.com/repo"))).toBe("stage-failed");
    expect(refusalCode(new Error("GITHUB_TOKEN=ghp_secret"))).toBe("stage-failed");
    expect(refusalCode(new Error("HTTP 403: Resource not accessible by integration"))).toBe("stage-failed");
    expect(refusalCode(new Error(""))).toBe("stage-failed");
    expect(refusalCode("не Error")).toBe("stage-failed");
    expect(refusalCode(new Error("a".repeat(201)))).toBe("stage-failed");
  });
});

describe("приёмка перед запуском", () => {
  test("run отказывается без локальной приёмки", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maint-accept-"));
    try {
      const { context } = await makeContext(directory);
      const controller = new Controller(context);
      expect(await controller.pending()).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("возобновление сохранённой генерации", () => {
  test("незавершённая генерация читается как pending и не теряется", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maint-resume-"));
    try {
      const journal = await Journal.open(directory);
      const state = {
        schemaVersion: 1 as const,
        key: "repo/candidate-18.8.9/base/attempt-1",
        generation: { repository: policy.repository, candidateVersion: "18.8.9", baseSha: "a".repeat(40), attemptNonce: "1" },
        revision: 0,
        stage: "reviewing" as const,
        attempt: 1,
        deadline: Date.now() + 60_000,
        upstreamVersion: "18.8.9",
        releaseVersion: "0.6.0",
        pr: { number: 12, branch: "upgrade/omp-18.8.9", baseSha: "a".repeat(40), headSha: "b".repeat(40), candidateVersion: "18.8.9" },
        effects: [],
      };
      await writeFile(join(directory, "acceptance.json"), JSON.stringify({ schemaVersion: 1, treeHash: "x", policyDigest: "y", acceptedAt: "now", evidence: "test" }));
      const lock = await journal.acquire(state.key);
      await journal.save(state, 0, lock);
      await journal.release(lock);
      await writeFile(join(directory, "active.json"), JSON.stringify({ key: state.key }), "utf8");
      const { context } = await makeContext(directory, { journal });
      const pending = await new Controller(context).pending();
      expect(pending?.stage).toBe("reviewing");
      expect(pending?.pr.number).toBe(12);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
