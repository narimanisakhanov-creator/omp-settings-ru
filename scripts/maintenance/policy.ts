import { createHash } from "node:crypto";
import type { ControllerPolicy, SourcePlatform } from "./contracts";

/**
 * Доверенная политика контроллера.
 *
 * Читается из принятого коммита `origin/main`, а не из рабочего дерева кандидата: политику нельзя изменить
 * тем же изменением, которое она сопровождает. Отпечаток политики — единственный вход, по которому запуск
 * можно сверить с доверенным значением.
 */

const PLATFORMS: readonly SourcePlatform[] = ["win32", "darwin", "linux"];

export async function runGit(args: readonly string[], cwd?: string): Promise<{code: number; stdout: string; stderr: string}> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL/i.test(key) || key.startsWith("GIT_CONFIG_")) delete env[key];
  delete env.GIT_ASKPASS; delete env.SSH_ASKPASS;
  const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function invalid(reason: string): never {
  throw new Error(`policy-invalid:${reason}`);
}

/** Валидация полей политики. Возвращает нормализованную политику или бросает `policy-invalid`. */
export function validatePolicy(raw: unknown): ControllerPolicy {
  if (typeof raw !== "object" || raw === null) invalid("not-object");
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1) invalid("schema-version");
  if (typeof root.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(root.repository)) invalid("repository");
  const controller = root.controller;
  if (typeof controller !== "object" || controller === null) invalid("controller-missing");
  const c = controller as Record<string, unknown>;
  const controllerKeys = ["baseBranch", "controllerLogin", "controllerType", "branchPattern", "executorPaths", "requiredCheckTemplate", "additionalRequiredChecks", "deadlinesMs"];
  if (Object.keys(c).some(key => !controllerKeys.includes(key))) invalid("controller-field");

  if (c.baseBranch !== "main") invalid("base-branch");
  if (typeof c.controllerLogin !== "string" || !c.controllerLogin) invalid("controller-login");
  if (c.controllerType !== "User") invalid("controller-type");
  if (typeof c.branchPattern !== "string" || !c.branchPattern) invalid("branch-pattern");
  for (const key of ["requiredCheckTemplate"] as const) {
    if (typeof c[key] !== "string" || !c[key]) invalid(key);
  }
  for (const key of ["executorPaths", "additionalRequiredChecks"] as const) {
    if (!Array.isArray(c[key]) || (c[key] as unknown[]).some(value => typeof value !== "string")) invalid(key);
  }
  if (!Array.isArray(root.requiredCheckPlatforms) || root.requiredCheckPlatforms.length === 0) invalid("check-platforms");
  for (const pair of root.requiredCheckPlatforms as unknown[]) {
    const entry = pair as Record<string, unknown>;
    if (typeof entry.os !== "string" || !PLATFORMS.includes(entry.platform as SourcePlatform)) invalid("check-platform");
  }
  const deadlines = c.deadlinesMs as Record<string, unknown> | undefined;
  if (!deadlines) invalid("deadlines");
  if (Object.keys(deadlines).some(key => !["precheck", "command", "verification", "release", "checks"].includes(key))) invalid("deadline-field");
  for (const key of ["precheck", "command", "verification", "release", "checks"] as const) {
    if (!Number.isSafeInteger(deadlines[key]) || (deadlines[key] as number) <= 0) invalid(`deadline-${key}`);
  }
  if ((deadlines.precheck as number) > 30000) invalid("precheck-deadline");

  return {
    schemaVersion: 1,
    repository: root.repository,
    baseBranch: "main",
    controllerLogin: c.controllerLogin as string,
    controllerType: "User",
    branchPattern: c.branchPattern as string,
    executorPaths: c.executorPaths as string[],
    requiredCheckTemplate: c.requiredCheckTemplate as string,
    requiredCheckPlatforms: (root.requiredCheckPlatforms as {os: string; platform: SourcePlatform}[])
      .map(pair => ({ os: pair.os, platform: pair.platform })),
    additionalRequiredChecks: c.additionalRequiredChecks as string[],
    deadlinesMs: {
      precheck: deadlines.precheck as number,
      command: deadlines.command as number,
      verification: deadlines.verification as number,
      release: deadlines.release as number,
      checks: deadlines.checks as number,
    },
  };
}

/** Stable normalized policy and repository identity; no machine-local commands enter the digest. */
export function policyDigest(policy: ControllerPolicy, repoSelector: string): string {
  return createHash("sha256").update(JSON.stringify({ policy, repoSelector })).digest("hex");
}

/**
 * Загрузка политики из принятого коммита постоянной ветви.
 *
 * `origin/main` разрешается локально; содержимое `maintenance.config.json` берётся из этого коммита, поэтому
 * правка политики в рабочем дереве или в ветви кандидата на результат не влияет.
 */
export async function loadAcceptedPolicy(checkout: string): Promise<{policy: ControllerPolicy; digest: string; baseSha: string}> {
  const head = await runGit(["rev-parse", "--verify", "origin/main^{commit}"], checkout);
  const baseSha = head.stdout.trim();
  if (head.code !== 0 || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("accepted-base-unavailable");
  const shown = await runGit(["show", `${baseSha}:maintenance.config.json`], checkout);
  if (shown.code !== 0) throw new Error("policy-unavailable");
  const policy = validatePolicy(JSON.parse(shown.stdout));
  return { policy, digest: policyDigest(policy, `github:${policy.repository}`), baseSha };
}

/** Stable versions compare numerically, not lexically (18.10 follows 18.9). */
export function compareVersions(left: string, right: string): number {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stable.test(left) || !stable.test(right)) throw new Error("stable-version-required");
  const a = left.split(".").map(BigInt); const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1;
  return 0;
}
