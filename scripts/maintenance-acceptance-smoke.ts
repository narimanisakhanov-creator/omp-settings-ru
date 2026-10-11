import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ACCEPTANCE_SCENARIOS, controllerTreeHash, type AcceptanceEvidence } from "./maintenance-controller";
import { loadAcceptedPolicy } from "./maintenance/policy";
import { loadReportBinding, loadReportRequest } from "./maintenance/report";
import { homedir } from "node:os";

/**
 * Продюсер доказательства приёмки.
 *
 * Единственный способ получить файл, который `accept` примет: **прогнать** оффлайн-набор сценариев
 * жизненного цикла контроллера и записать факты прогона. `passed` и отпечатки не вводятся пользователем —
 * они выводятся из кода выхода и из неизменности дерева контроллера до и после прогона. Ссылки на dispatch-и
 * исполнителя и независимого ревьюера передаёт вызывающий: их он получил из реальных Run, а верификатор
 * (`accept`) затем опрашивает Orca и GitHub сам.
 *
 * Режим без ссылок — подготовительный: сценарии прогоняются, но доказательство помечается `passed:false` и
 * приёмку не открывает.
 */

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

interface ScenarioRun {
  readonly name: string;
  readonly file: string;
  readonly exitCode: number;
  readonly testsExecuted: number;
  readonly passed: boolean;
}

/** `N pass` + `M fail` из итоговой строки bun test — сколько тестов реально исполнилось в файле. */
function testsExecutedIn(output: string): number {
  const passed = /(\d+)\s+pass/.exec(output);
  const failed = /(\d+)\s+fail/.exec(output);
  return Number(passed?.[1] ?? 0) + Number(failed?.[1] ?? 0);
}

async function runScenario(checkout: string, name: string, file: string): Promise<ScenarioRun> {
  const child = Bun.spawn(["bun", "test", file], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const testsExecuted = testsExecutedIn(`${stdout}\n${stderr}`);
  const passed = exitCode === 0 && testsExecuted > 0;
  return { name, file, exitCode, testsExecuted, passed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkout = resolve(option(args, "--checkout") ?? process.cwd());
  const output = option(args, "--output");
  if (!output) throw new Error("acceptance-producer-output-required");

  // Сокращение набора — только диагностика: `accept` всё равно сверяет состав с обязательным.
  const only = option(args, "--scenarios");
  const requested = only
    ? ACCEPTANCE_SCENARIOS.filter(scenario => only.split(",").map(value => value.trim()).includes(scenario.name))
    : ACCEPTANCE_SCENARIOS;
  if (requested.length === 0) throw new Error("acceptance-producer-scenarios-empty");

  // Отпечаток до прогона: он же будет сверен после. Продюсер не «чинит» дерево и не коммитит.
  const { digest, baseSha } = await loadAcceptedPolicy(checkout);
  const treeBefore = await controllerTreeHash(checkout);

  const scenarios: ScenarioRun[] = [];
  for (const scenario of requested) scenarios.push(await runScenario(checkout, scenario.name, scenario.file));

  const treeAfter = await controllerTreeHash(checkout);
  const dispatchRun = option(args, "--dispatch-run");
  const dispatchId = option(args, "--dispatch");
  const reviewRun = option(args, "--review-run");
  const reviewDispatch = option(args, "--review-dispatch");
  const requestPath = option(args, "--review-request");
  const stateDirectory = resolve(option(args, "--state-dir") ?? join(homedir(), ".omp", "maintenance", "controller"));
  if (requestPath) {
    await loadReportRequest(resolve(requestPath), stateDirectory);
    const binding = await loadReportBinding(resolve(requestPath), stateDirectory);
    if (binding.runId !== reviewRun || binding.dispatchId !== reviewDispatch) throw new Error("worker-report-binding-mismatch");
  }
  const hasDispatches = Boolean(dispatchRun && dispatchId && reviewRun && reviewDispatch && requestPath);

  const passed = treeBefore === treeAfter
    && scenarios.every(scenario => scenario.passed)
    && hasDispatches;
  const evidence: AcceptanceEvidence = {
    schemaVersion: 1,
    kind: "acceptance-evidence",
    passed,
    exitCode: scenarios.every(scenario => scenario.exitCode === 0) ? 0 : 1,
    command: `bun test ${requested.map(scenario => scenario.file).join(" ")}`,
    scenarios: scenarios.map(scenario => ({
      name: scenario.name, file: scenario.file, testsExecuted: scenario.testsExecuted, passed: scenario.passed,
    })),
    treeBefore,
    treeAfter,
    treeHash: treeAfter,
    policyDigest: digest,
    acceptedBaseSha: baseSha,
    dispatch: { runId: dispatchRun ?? "", dispatchId: dispatchId ?? "" },
    review: { runId: reviewRun ?? "", dispatchId: reviewDispatch ?? "", requestPath: requestPath ? resolve(requestPath) : "" },
    producedAt: new Date().toISOString(),
  };

  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: passed,
    output: resolve(output),
    exitCode: evidence.exitCode,
    treeUnchanged: treeBefore === treeAfter,
    dispatches: hasDispatches ? "supplied" : "pending",
    scenarios: evidence.scenarios,
    // Причины отказа видны сразу, без чтения файла: прогон не выдаёт приёмку молча.
    blockers: scenarios.filter(scenario => !scenario.passed)
      .map(scenario => `scenario-failed:${scenario.name}`)
      .concat(hasDispatches ? [] : ["dispatches-pending"])
      .concat(treeBefore === treeAfter ? [] : ["tree-changed-by-run"]),
  }));
  if (!passed) process.exitCode = 11;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "acceptance-producer-failed";
    console.log(JSON.stringify({ ok: false, kind: "blocked", reason }));
    process.exitCode = 11;
  }
}
