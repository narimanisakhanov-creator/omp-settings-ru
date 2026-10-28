import { expect, test } from "bun:test";
import { canStartPreparation, classifyOutcomeReason, outcomeArtifactName, outcomeFromJobs, parseOutcome, sanitizeOutcomeReason } from "../scripts/maintenance/outcome";

const baseSha = "a".repeat(40);
const blocked = (retryable = true) => parseOutcome({ schemaVersion: 1, baseSha, candidateVersion: "18.13.4", stage: "discover", outcome: "blocked", reason: retryable ? "registry-http-503" : "candidate-content-invalid", retryable });

test("rejects raw diagnostic text rather than retaining possible secrets", () => {
  expect(sanitizeOutcomeReason("timeout\nTOKEN=secret\u001b[31m")).toBe("maintenance-action-blocked");
  expect(sanitizeOutcomeReason("registry-http-503")).toBe("registry-http-503");
});

test("classifies only confirmed transport or missing discovery prerequisites", () => {
  for (const stage of ["discover", "prepare", "translate", "verify", "publish"] as const) {
    for (const reason of ["registry-http-503", "registry-http-429", "registry-timeout", "github-http-429", "github-http-503", "model-http-503", "model-timeout"]) expect(classifyOutcomeReason(reason, stage)).toBe(true);
    for (const reason of ["trusted-command-failed", "github-command-refused:api", "candidate-content-invalid", "model-http-403", "github-http-401", "github-http-403", "github-http-404"]) expect(classifyOutcomeReason(reason, stage)).toBe(false);
    for (const reason of ["companion-package-unavailable", "native-asset-unavailable"]) expect(classifyOutcomeReason(reason, stage)).toBe(stage === "discover");
  }
});

test("bounds artifacts and refuses unconfirmed retryability", () => {
  expect(outcomeArtifactName("123", "2")).toBe("maintenance-outcome-123-2");
  expect(() => outcomeArtifactName("run-1", "0")).toThrow();
  expect(() => parseOutcome({ ...blocked(), retryable: true, reason: "trusted-command-failed" })).toThrow();
  expect(() => parseOutcome({ ...blocked(), candidateVersion: "unknown" })).toThrow();
  expect(() => parseOutcome({ ...blocked(), reason: "x".repeat(301) })).toThrow();
});

test("enforces durable failure budget and manual reset boundary", () => {
  expect(canStartPreparation([blocked(), blocked()], baseSha, "18.13.4", false)).toBe(false);
  expect(canStartPreparation([blocked(false)], baseSha, "18.13.4", false)).toBe(false);
  expect(canStartPreparation([blocked(false)], baseSha, "18.13.4", true)).toBe(true);
  expect(canStartPreparation([blocked(false), { ...blocked(), retryBlocked: true }], baseSha, "18.13.4", false)).toBe(true);
  expect(canStartPreparation([blocked(false), { ...blocked(), retryBlocked: true }, blocked()], baseSha, "18.13.4", false)).toBe(false);
});

test("writer preserves typed failure and release/retirement distinction", () => {
  const common = { baseSha, candidateVersion: "18.13.4", mode: "prepare", discover: { result: "success" }, prepare: { result: "failure", reason: "registry-http-503", retryable: "true" } };
  expect(outcomeFromJobs(common)).toMatchObject({ stage: "prepare", outcome: "blocked", reason: "registry-http-503", retryable: true });
  expect(outcomeFromJobs({ ...common, prepare: { result: "cancelled" } })).toMatchObject({ stage: "prepare", outcome: "blocked", retryable: false });
  expect(outcomeFromJobs({ ...common, prepare: { result: "success" }, translate: { result: "success" }, verify: { result: "success" }, publish: { result: "success", outcome: "retired" } })).toMatchObject({ stage: "publish", outcome: "retired" });
  expect(outcomeFromJobs({ ...common, candidateVersion: "" })).toBeNull();
  expect(outcomeFromJobs({ ...common, mode: "blocked", discover: { result: "success", reason: "maintenance-paused" } })).toMatchObject({ outcome: "blocked" });
});

test("writer and parser restrict missing prerequisites to discovery", () => {
  for (const reason of ["native-asset-unavailable", "companion-package-unavailable"]) {
    expect(outcomeFromJobs({ baseSha, candidateVersion: "18.13.4", mode: "prepare", discover: { result: "failure", reason, retryable: "true" } })).toMatchObject({ stage: "discover", reason, retryable: true });
    for (const stage of ["prepare", "translate", "verify", "publish"] as const) {
      expect(outcomeFromJobs({ baseSha, candidateVersion: "18.13.4", mode: "prepare", discover: { result: "success" }, [stage]: { result: "failure", reason, retryable: "true" } })).toMatchObject({ stage, reason, retryable: false });
      expect(() => parseOutcome({ ...blocked(), stage, reason })).toThrow("maintenance-outcome-invalid");
    }
  }
  for (const [reason, retryable] of [["github-http-401", false], ["github-http-403", false], ["github-http-404", false], ["github-http-429", true], ["github-http-503", true]] as const) {
    expect(outcomeFromJobs({ baseSha, candidateVersion: "18.13.4", mode: "prepare", discover: { result: "success" }, verify: { result: "failure", reason, retryable: "true" } })).toMatchObject({ stage: "verify", reason, retryable });
  }
});
