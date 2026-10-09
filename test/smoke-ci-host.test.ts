import { expect, test } from "bun:test";
import { parsePackFilename, selectCheckRun } from "../scripts/smoke-ci-host";

test("parses npm pack listings from array and keyed envelopes", () => {
  expect(parsePackFilename([{filename: "omp-settings-ru-0.2.0.tgz", files: [{path: "package.json"}]}])).toBe("omp-settings-ru-0.2.0.tgz");
  expect(parsePackFilename({"omp-settings-ru": {filename: "omp-settings-ru-0.2.0.tgz"}})).toBe("omp-settings-ru-0.2.0.tgz");
  expect(() => parsePackFilename([])).toThrow("pack-listing-invalid");
  expect(() => parsePackFilename([{files: []}])).toThrow("pack-listing-invalid");
  expect(() => parsePackFilename(null)).toThrow("pack-listing-invalid");
});

test("refuses to produce a receipt without the exact reviewed source head", () => {
  const environment = {...process.env};
  delete environment.OMP_SOURCE_HEAD;
  delete environment.GITHUB_SHA;
  const result = Bun.spawnSync(["bun", "scripts/smoke-ci-host.ts", "18.8.4"], {env: environment, stdout: "pipe", stderr: "pipe", timeout: 60000});
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("source-head-unavailable");
}, 60000);

const expected = {repository: "o/r", commitSha: "a".repeat(40), runId: "123456", jobName: "check (windows-2022, 18.8.4)"};
const row = (id: number, overrides: Record<string, unknown> = {}) => ({id, name: "check (windows-2022, 18.8.4)", head_sha: "a".repeat(40), status: "in_progress", conclusion: null, details_url: `https://github.com/o/r/actions/runs/123456/job/${id}`, ...overrides});

test("selects the running check run that matches this workflow run, head and job", () => {
  const payload = {total_count: 3, check_runs: [
    row(9, {status: "completed", conclusion: "success"}),
    row(41),
    row(42, {name: "check (ubuntu-24.04, 18.8.4)"}),
  ]};
  expect(selectCheckRun(payload, expected)).toBe(41);
});

test("selects by the workflow commit, not the reviewed source head, when they differ", () => {
  const reviewedSourceHead = "b".repeat(40);
  const workflowCommit = "a".repeat(40);
  const payload = {total_count: 1, check_runs: [row(7, {head_sha: workflowCommit})]};
  // On pull_request the job's check run is attached to the synthetic merge commit (workflow commit).
  expect(selectCheckRun(payload, {...expected, commitSha: workflowCommit})).toBe(7);
  expect(() => selectCheckRun(payload, {...expected, commitSha: reviewedSourceHead})).toThrow("check-run-unavailable");
});

test("refuses to guess a check id from unrelated, ambiguous, truncated or foreign listings", () => {
  expect(() => selectCheckRun({total_count: 1, check_runs: [row(1, {status: "completed", conclusion: "success"})]}, expected)).toThrow("check-run-unavailable");
  expect(() => selectCheckRun({total_count: 1, check_runs: [row(1, {head_sha: "b".repeat(40)})]}, expected)).toThrow("check-run-unavailable");
  expect(() => selectCheckRun({total_count: 1, check_runs: [row(1, {name: "check (ubuntu-24.04, 18.8.4)"})]}, expected)).toThrow("check-run-unavailable");
  expect(() => selectCheckRun({total_count: 2, check_runs: [row(1), row(2)]}, expected)).toThrow("check-run-ambiguous");
  expect(() => selectCheckRun({total_count: 2, check_runs: [row(1)]}, expected)).toThrow("check-run-listing-truncated");
  expect(() => selectCheckRun({check_runs: [row(1)]}, expected)).toThrow("check-run-listing-truncated");
  expect(() => selectCheckRun({total_count: "1", check_runs: [row(1)]}, expected)).toThrow("check-run-listing-truncated");
  expect(() => selectCheckRun({total_count: 1, check_runs: [row(1, {details_url: "https://attacker.invalid/actions/runs/123456/job/1"})]}, expected)).toThrow("check-run-unavailable");
  expect(() => selectCheckRun({total_count: 1, check_runs: [row(1, {details_url: "https://github.com/o/r/actions/runs/999/job/1"})]}, expected)).toThrow("check-run-unavailable");
  expect(() => selectCheckRun({total_count: 0, check_runs: []}, expected)).toThrow("check-run-unavailable");
  expect(() => selectCheckRun(null, expected)).toThrow("check-run-payload-invalid");
});
