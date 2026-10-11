import { describe, expect, test } from "bun:test";
import { compareVersions, decidePrecheck, exitCode, matchesOwnedPr, type OpenPullRequest } from "../scripts/maintenance/precheck";
import { validatePolicy, policyDigest } from "../scripts/maintenance/policy";
import type { ControllerPolicy } from "../scripts/maintenance/contracts";
import rawPolicy from "../maintenance.config.json";

const policy: ControllerPolicy = validatePolicy(rawPolicy);
const base = {
  registryLatest: "18.8.9",
  pinned: "18.8.7",
  supported: ["18.6.1", "18.8.0", "18.8.4", "18.8.7"],
  policy,
  openPrs: [] as OpenPullRequest[],
  lock: { kind: "free" } as const,
  now: 1_000,
  deadline: 60_000,
};
const resolved = { candidate: "18.8.9", branch: "upgrade/omp-18.8.9" };

describe("сравнение версий", () => {
  test("сравнивает числовые компоненты, а не строки", () => {
    expect(compareVersions("18.8.9", "18.8.10")).toBe(-1);
    expect(compareVersions("18.10.0", "18.9.9")).toBe(1);
    expect(compareVersions("18.8.9", "18.8.9")).toBe(0);
    expect(() => compareVersions("18.8", "18.8.9")).toThrow("invalid-version");
  });
});

describe("решение предварительной проверки", () => {
  test("более новая версия реестра даёт свежий пригодный кандидат", () => {
    expect(decidePrecheck(base)).toEqual({ ...resolved, kind: "eligible", resume: false });
    expect(exitCode({ kind: "eligible", candidate: "18.8.9", branch: "upgrade/omp-18.8.9", resume: false })).toBe(0);
  });

  test("совпадающая или более старая версия реестра не даёт работы", () => {
    expect(decidePrecheck({ ...base, registryLatest: "18.8.7" })).toEqual({ kind: "skip", reason: "no-work" });
    expect(decidePrecheck({ ...base, registryLatest: "18.8.0" })).toEqual({ kind: "skip", reason: "no-work" });
    expect(exitCode({ kind: "skip", reason: "no-work" })).toBe(10);
  });

  test("уже поддержанная версия не запускает новый цикл", () => {
    expect(decidePrecheck({ ...base, registryLatest: "18.8.4", pinned: "18.8.0" }))
      .toEqual({ kind: "skip", reason: "already-supported" });
  });

  test("нечитаемая версия реестра блокирует запуск", () => {
    expect(decidePrecheck({ ...base, registryLatest: "latest" })).toEqual({ kind: "blocked", reason: "registry-version-invalid" });
    expect(exitCode({ kind: "blocked", reason: "registry-version-invalid" })).toBe(12);
  });

  test("истёкший срок и занятая блокировка блокируют запуск", () => {
    expect(decidePrecheck({ ...base, now: 60_000 })).toEqual({ kind: "blocked", reason: "deadline-expired" });
    expect(decidePrecheck({ ...base, lock: { kind: "held" } }))
      .toEqual({ kind: "blocked", reason: "repo-locked-owner-liveness-unknown" });
    expect(exitCode({ kind: "blocked", reason: "repo-locked-owner-liveness-unknown" })).toBe(13);
  });
});

describe("принадлежность запроса на слияние", () => {
  const owned = { number: 7, branch: "upgrade/omp-18.8.9", baseSha: "a".repeat(40), headSha: "b".repeat(40) };

  test("свой незавершённый запрос возобновляется, а не дублируется", () => {
    const observed: OpenPullRequest = { ...owned, author: policy.controllerLogin };
    const decision = decidePrecheck({ ...base, openPrs: [observed], ownedPr: owned });
    expect(decision).toEqual({ ...resolved, kind: "eligible", resume: true });
  });

  test("свой запрос с изменившейся головой не принимается за свой", () => {
    const moved: OpenPullRequest = { ...owned, headSha: "c".repeat(40), author: policy.controllerLogin };
    expect(decidePrecheck({ ...base, openPrs: [moved], ownedPr: owned }))
      .toEqual({ kind: "skip", reason: "foreign-pr" });
  });

  test("чужой запрос по тому же кандидату безопасно пропускается", () => {
    const foreign: OpenPullRequest = { ...owned, author: "someone-else" };
    expect(decidePrecheck({ ...base, openPrs: [foreign] })).toEqual({ kind: "skip", reason: "foreign-pr" });
    expect(matchesOwnedPr({ ...foreign, headSha: "d".repeat(40) }, owned)).toBe(false);
  });

  test("совпадение наблюдения и записи журнала требует всех полей", () => {
    expect(matchesOwnedPr({ ...owned, author: policy.controllerLogin }, owned)).toBe(true);
    expect(matchesOwnedPr({ ...owned, baseSha: "e".repeat(40), author: policy.controllerLogin }, owned)).toBe(false);
    expect(matchesOwnedPr({ ...owned, branch: "upgrade/omp-18.8.8", author: policy.controllerLogin }, owned)).toBe(false);
  });
});

describe("политика", () => {
  test("закрепляет фактического локального автора, а не бота", () => {
    expect(policy.controllerLogin).toBe("narimanisakhanov-creator");
    expect(policy.controllerType).toBe("User");
    expect(policy.baseBranch).toBe("main");
  });

  test("отклоняет политику неизвестной схемы и отсутствующую секцию контроллера", () => {
    expect(() => validatePolicy({ ...rawPolicy, schemaVersion: 2 })).toThrow("policy-invalid:schema-version");
    expect(() => validatePolicy({ ...rawPolicy, controller: undefined })).toThrow("policy-invalid:controller-missing");
    expect(() => validatePolicy({
      ...rawPolicy,
      controller: { ...rawPolicy.controller, controllerType: "Bot" },
    })).toThrow("policy-invalid:controller-type");
  });

  test("отпечаток зависит от политики, селектора и команды precheck", () => {
    const digest = policyDigest(policy, "github:x/y", "bun precheck");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(policyDigest(policy, "github:x/y", "bun precheck")).toBe(digest);
    expect(policyDigest(policy, "github:x/z", "bun precheck")).not.toBe(digest);
    expect(policyDigest(policy, "github:x/y", "bun --precheck")).not.toBe(digest);
  });
});
