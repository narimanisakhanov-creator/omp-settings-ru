import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ControllerPolicy } from "./contracts";
import { GitHub } from "./github";
import { asRecord, parseStrictJSON } from "./json";
import { outcomeArtifactName, parseOutcome, type MaintenanceOutcome } from "./outcome";
import { parseCandidate, validateBundle, type Candidate } from "./actions-bundle";
export interface MaintenanceIdentity {
  readonly schemaVersion: 1; readonly repository: string; readonly upstreamVersion: string; readonly releaseVersion: string;
  readonly baseSha: string; readonly headSha: string; readonly runId: string; readonly runAttempt: string;
  readonly artifactId: string; readonly manifestSha256: string;
}
const begin = "<!-- omp-maintenance:v1 -->";
const end = "<!-- /omp-maintenance -->";
export function maintenanceBody(identity: MaintenanceIdentity): string {
  const { schemaVersion, repository, upstreamVersion, releaseVersion, baseSha, headSha, runId, runAttempt, artifactId, manifestSha256 } = identity;
  return `Автоматически проверенная поддержка OMP ${upstreamVersion}.\n\n${begin}\n${JSON.stringify({ schemaVersion, repository, upstreamVersion, releaseVersion, baseSha, headSha, runId, runAttempt, artifactId, manifestSha256 })}\n${end}`;
}
export function parseMaintenanceBlock(body: string): MaintenanceIdentity {
  if (body.split(begin).length !== 2 || body.split(end).length !== 2) throw new Error("maintenance-block-ambiguous");
  const raw = asRecord(parseStrictJSON(body.split(begin)[1]!.split(end)[0]!.trim()));
  if (!raw || Object.keys(raw).sort().join(",") !== "artifactId,baseSha,headSha,manifestSha256,releaseVersion,repository,runAttempt,runId,schemaVersion,upstreamVersion") throw new Error("maintenance-block-invalid");
  const { artifactId, manifestSha256, ...candidate } = raw;
  parseCandidate({ ...candidate, semanticReview: "disabled", files: [] });
  if (typeof raw.headSha !== "string" || typeof artifactId !== "string" || !/^[1-9]\d*$/.test(artifactId) || typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("maintenance-block-invalid");
  return raw as unknown as MaintenanceIdentity;
}
export function validateOrigin(candidate: Candidate, runValue: unknown, artifactValue: unknown, artifactId: string): void {
  const run = asRecord(runValue); const artifact = asRecord(artifactValue);
  const repo = asRecord(run?.repository); const origin = asRecord(artifact?.workflow_run);
  if (!run || !artifact || String(run.id) !== candidate.runId || String(run.run_attempt) !== candidate.runAttempt || run.path !== ".github/workflows/upstream-watch.yml" || !["schedule", "workflow_dispatch"].includes(String(run.event)) || run.head_branch !== "main" || run.head_sha !== candidate.baseSha || repo?.full_name !== candidate.repository || String(artifact.id) !== artifactId || artifact.expired !== false || artifact.name !== `maintenance-${candidate.upstreamVersion}-${candidate.runId}-${candidate.runAttempt}` || String(origin?.id) !== candidate.runId || origin?.head_sha !== candidate.baseSha) throw new Error("artifact-origin-invalid");
}
export function secretFreeEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL/i.test(key) || key.startsWith("GIT_CONFIG_")) delete env[key];
  delete env.GIT_ASKPASS; delete env.SSH_ASKPASS;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
export class HostedGitHub {
  readonly checks: GitHub;
  constructor(readonly policy: ControllerPolicy, private readonly token: string) { this.checks = new GitHub(policy, token); }
  async command(args: readonly string[], write = false): Promise<string> {
    if (write) await this.checks.assertIdentity();
    const child = Bun.spawn(["gh", ...args], { env: { ...secretFreeEnvironment(), GH_TOKEN: this.token }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), this.policy.deadlinesMs.command);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) {
        const status = args[0] === "api" ? /\(HTTP (\d{3})\)/.exec(stderr)?.[1] : undefined;
        throw new Error(status ? `github-http-${status}` : `github-command-refused:${args[0]}`);
      }
      if (stdout.length > 16 * 1024 * 1024) throw new Error("github-response-too-large");
      return stdout;
    } finally { clearTimeout(timer); }
  }
  async api(path: string, fields?: Readonly<Record<string, string | boolean>>, method = "POST"): Promise<unknown> {
    const args = ["api", path];
    if (fields) { args.push("--method", method); for (const [key, value] of Object.entries(fields)) args.push(typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`); }
    return parseStrictJSON(await this.command(args, fields !== undefined));
  }
  async list(path: string, key?: string): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const values = key ? asRecord(raw)?.[key] : raw;
      if (!Array.isArray(values) || values.some(row => !asRecord(row))) throw new Error("github-list-invalid");
      rows.push(...values as Record<string, unknown>[]);
      if (values.length < 100) return rows;
    }
    throw new Error("github-pagination-exhausted");
  }
  async ownedPulls(): Promise<readonly { pr: Record<string, unknown>; identity: MaintenanceIdentity }[]> {
    const prs = await this.list(`repos/${this.policy.repository}/pulls?state=all&sort=updated&direction=desc`);
    const result: { pr: Record<string, unknown>; identity: MaintenanceIdentity }[] = [];
    for (const pr of prs) {
      const head = asRecord(pr.head); const user = asRecord(pr.user); const base = asRecord(pr.base);
      if (!String(head?.ref).startsWith("upgrade/omp-")) continue;
      if (pr.state === "closed" && !pr.merged_at) continue;
      if (user?.login !== this.policy.controllerLogin || user.type !== this.policy.controllerType || base?.ref !== "main" || asRecord(base.repo)?.full_name !== this.policy.repository || asRecord(head?.repo)?.full_name !== this.policy.repository) throw new Error("maintenance-pr-ownership-conflict");
      const identity = parseMaintenanceBlock(String(pr.body ?? ""));
      if (identity.repository !== this.policy.repository || head?.ref !== `upgrade/omp-${identity.upstreamVersion}` || head?.sha !== identity.headSha) throw new Error("maintenance-pr-identity-conflict");
      result.push({ pr, identity });
    }
    return result;
  }
  async origin(candidate: Candidate, artifactId: string): Promise<void> {
    const root = `repos/${this.policy.repository}`;
    const [run, artifact] = await Promise.all([this.api(`${root}/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}`), this.api(`${root}/actions/artifacts/${artifactId}`)]);
    validateOrigin(candidate, run, artifact, artifactId);
    const jobs = await this.list(`${root}/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}/jobs?filter=all`, "jobs");
    const verified = jobs.filter(job => job.name === "verify" && String(job.run_id) === candidate.runId && job.head_sha === candidate.baseSha);
    if (verified.length !== 1 || verified[0]?.status !== "completed" || verified[0]?.conclusion !== "success") throw new Error("artifact-verification-job-not-successful");
  }
  async readOutcomes(baseSha: string, candidateVersion: string): Promise<readonly MaintenanceOutcome[]> {
    const root = `repos/${this.policy.repository}`;
    const runs = await this.list(`${root}/actions/workflows/upstream-watch.yml/runs?branch=main&head_sha=${baseSha}`, "workflow_runs");
    const outcomes: MaintenanceOutcome[] = [];
    const validRun = (run: Record<string, unknown>, id: string, attempt: string) => String(run.id) === id && String(run.run_attempt) === attempt && run.path === ".github/workflows/upstream-watch.yml" && run.head_branch === "main" && run.head_sha === baseSha && asRecord(run.repository)?.full_name === this.policy.repository && ["schedule", "workflow_dispatch"].includes(String(run.event));
    const ordered = [...runs].sort((a, b) => Number(b.id) - Number(a.id));
    for (const latest of ordered) {
      const id = String(latest.id); const attempts = Number(latest.run_attempt);
      if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 1000 || !validRun(latest, id, String(attempts))) throw new Error("maintenance-outcome-origin-invalid");
      const artifacts = await this.list(`${root}/actions/runs/${id}/artifacts`, "artifacts");
      for (let number = attempts; number >= 1; number--) {
        const attempt = String(number);
        if (id === process.env.GITHUB_RUN_ID && attempt === process.env.GITHUB_RUN_ATTEMPT) continue;
        const run = asRecord(await this.api(`${root}/actions/runs/${id}/attempts/${attempt}`));
        if (!run || !validRun(run, id, attempt)) throw new Error("maintenance-outcome-origin-invalid");
        if (run.status !== "completed") continue;
        const selectedName = `maintenance-selection-${candidateVersion}-${id}-${attempt}`;
        const selected = artifacts.some(artifact => artifact.name === selectedName);
        const matches = artifacts.filter(artifact => artifact.name === outcomeArtifactName(id, attempt));
        const otherSelection = artifacts.some(artifact => typeof artifact.name === "string" && artifact.name.startsWith("maintenance-selection-") && artifact.name.endsWith(`-${id}-${attempt}`) && artifact.name !== selectedName);
        if (!selected && otherSelection) continue;
        if (!matches.length && !selected) {
          const jobs = await this.list(`${root}/actions/runs/${id}/attempts/${attempt}/jobs?filter=all`, "jobs");
          // Failed discovery before selection must remain harmless, but a started prepare cannot disappear.
          const matchingSelectionStep = jobs.some(job => Array.isArray(job.steps) && job.steps.some(step => asRecord(step)?.name === `Record selected candidate ${candidateVersion}` && asRecord(step)?.conclusion !== "skipped"));
          if (matchingSelectionStep || jobs.some(job => job.name === "prepare" && job.conclusion !== "skipped")) throw new Error("maintenance-outcome-unavailable");
          continue;
        }
        if (matches.length !== 1) throw new Error("maintenance-outcome-unavailable");
        const artifact = matches[0]!; const origin = asRecord(artifact.workflow_run);
        if (artifact.expired !== false || typeof artifact.expires_at !== "string" || Date.parse(artifact.expires_at) <= Date.now() || !Number.isFinite(Date.parse(artifact.expires_at)) || typeof artifact.size_in_bytes !== "number" || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 128 * 1024) throw new Error("maintenance-outcome-unavailable");
        if (!/^[1-9]\d*$/.test(String(artifact.id)) || String(origin?.id) !== id || origin?.head_sha !== baseSha || origin?.head_branch !== "main" || origin?.repository_id !== asRecord(run.repository)?.id || origin?.head_repository_id !== asRecord(run.repository)?.id) throw new Error("maintenance-outcome-origin-invalid");
        const directory = await mkdtemp(join(tmpdir(), "omp-outcome-"));
        try {
          const zip = join(directory, "artifact.zip");
          const child = Bun.spawn(["gh", "api", `${root}/actions/artifacts/${artifact.id}/zip`], { env: { ...secretFreeEnvironment(), GH_TOKEN: this.token }, stdout: "pipe", stderr: "ignore" });
          const timer = setTimeout(() => child.kill(), this.policy.deadlinesMs.command);
          const chunks: Uint8Array[] = []; let size = 0;
          try {
            for await (const chunk of child.stdout) { size += chunk.length; if (size > 128 * 1024) { child.kill(); throw new Error("maintenance-outcome-invalid"); } chunks.push(chunk); }
            if (await child.exited !== 0) throw new Error("maintenance-outcome-unavailable");
          } finally { clearTimeout(timer); }
          await writeFile(zip, Buffer.concat(chunks, size));
          const listing = Bun.spawnSync(["unzip", "-Z1", zip], { env: secretFreeEnvironment(), stdout: "pipe", stderr: "ignore", timeout: this.policy.deadlinesMs.command });
          if (listing.exitCode !== 0 || listing.stdout.toString().trim() !== "maintenance-outcome.json") throw new Error("maintenance-outcome-invalid");
          const entry = Bun.spawn(["unzip", "-p", zip, "maintenance-outcome.json"], { env: secretFreeEnvironment(), stdout: "pipe", stderr: "ignore" });
          const entryTimer = setTimeout(() => entry.kill(), this.policy.deadlinesMs.command);
          const bytes: Uint8Array[] = []; let length = 0;
          try {
            for await (const chunk of entry.stdout) { length += chunk.length; if (length > 64 * 1024) { entry.kill(); throw new Error("maintenance-outcome-invalid"); } bytes.push(chunk); }
            if (await entry.exited !== 0) throw new Error("maintenance-outcome-invalid");
          } finally { clearTimeout(entryTimer); }
          const outcome = parseOutcome(parseStrictJSON(Buffer.concat(bytes, length).toString("utf8")));
          if (outcome.baseSha !== baseSha || (selected && outcome.candidateVersion !== candidateVersion)) throw new Error("maintenance-outcome-origin-invalid");
          if (outcome.retryBlocked && run.event !== "workflow_dispatch") throw new Error("maintenance-outcome-origin-invalid");
          if (outcome.candidateVersion === candidateVersion) {
            outcomes.push(outcome);
            if (outcome.retryBlocked) return outcomes.reverse();
          }
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
    return outcomes.reverse();
  }
  async download(identity: MaintenanceIdentity): Promise<string> {
    const extract = async (zip: string, path: string, limit: number): Promise<Uint8Array> => {
      const child = Bun.spawn(["unzip", "-p", zip, path], { env: secretFreeEnvironment(), stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), this.policy.deadlinesMs.command);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for await (const chunk of child.stdout) {
          size += chunk.length;
          if (size > limit) { child.kill(); throw new Error("artifact-entry-too-large"); }
          chunks.push(chunk);
        }
        if (await child.exited !== 0) throw new Error("artifact-entry-invalid");
        return Buffer.concat(chunks, size);
      } finally { clearTimeout(timer); }
    };
    const root = await mkdtemp(join(tmpdir(), "omp-hosted-proof-"));
    try {
      const metadata = asRecord(await this.api(`repos/${this.policy.repository}/actions/artifacts/${identity.artifactId}`));
      if (!metadata || metadata.expired !== false || typeof metadata.size_in_bytes !== "number" || metadata.size_in_bytes > 256 * 1024 * 1024) throw new Error("artifact-expired-or-too-large");
      const zip = join(root, "artifact.zip");
      const proc = Bun.spawn(["gh", "api", `repos/${this.policy.repository}/actions/artifacts/${identity.artifactId}/zip`], { env: { ...secretFreeEnvironment(), GH_TOKEN: this.token }, stdout: Bun.file(zip), stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), this.policy.deadlinesMs.command);
      try { if (await proc.exited !== 0) throw new Error("artifact-download-refused"); } finally { clearTimeout(timer); }
      const listing = Bun.spawnSync(["unzip", "-Z1", zip], { env: secretFreeEnvironment(), stdout: "pipe", stderr: "pipe" });
      if (listing.exitCode) throw new Error("artifact-zip-invalid");
      const paths = listing.stdout.toString().trim().split("\n").filter(path => !path.endsWith("/"));
      if (paths.length > 2001 || new Set(paths).size !== paths.length || !paths.includes("candidate.json")) throw new Error("artifact-zip-invalid");
      const manifest = await extract(zip, "candidate.json", 1024 * 1024);
      if (createHash("sha256").update(manifest).digest("hex") !== identity.manifestSha256) throw new Error("artifact-manifest-mismatch");
      const candidate = parseCandidate(parseStrictJSON(new TextDecoder().decode(manifest)));
      await this.origin(candidate, identity.artifactId);
      if (paths.sort().join("\0") !== ["candidate.json", ...candidate.files.map(file => file.path)].sort().join("\0")) throw new Error("artifact-zip-unlisted");
      const output = join(root, "bundle"); await mkdir(output);
      for (const path of paths) {
        const entry = path === "candidate.json" ? manifest : await extract(zip, path, 64 * 1024 * 1024);
        await mkdir(dirname(join(output, path)), { recursive: true }); await writeFile(join(output, path), entry);
      }
      await validateBundle(output); return output;
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }
  async push(checkout: string, head: string, branch: string): Promise<void> {
    await this.checks.assertIdentity();
    const directory = await mkdtemp(join(tmpdir(), "omp-hosted-askpass-"));
    try {
      const askpass = join(directory, "askpass.sh");
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *Password*) printf "%s\\n" "$MAINTENANCE_GIT_TOKEN";; *) exit 1;; esac\n', { mode: 0o700 });
      const proc = Bun.spawn(["git", "-c", "credential.helper=", "push", `https://github.com/${this.policy.repository}.git`, `${head}:refs/heads/${branch}`], { cwd: checkout, env: { ...secretFreeEnvironment(), GIT_ASKPASS: askpass, MAINTENANCE_GIT_TOKEN: this.token }, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), this.policy.deadlinesMs.command);
      try { if (await proc.exited !== 0) throw new Error("candidate-push-refused"); } finally { clearTimeout(timer); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
