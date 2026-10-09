import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { InstalledHost, ManagerCapabilities, ReleasePin, UpdateReceipt } from "./contracts.ts";
import { runInstalledSmoke } from "../installed-smoke.ts";

export interface UpdateOptions {
  readonly pin: ReleasePin;
  readonly packagePath: string;
  readonly stateDirectory: string;
  readonly executable: string;
  readonly activate: boolean;
  readonly accepted: boolean;
  readonly targetProfile?: string;
}

async function inspectHost(executable: string): Promise<InstalledHost> {
  const path = Bun.which(executable) ?? resolve(executable);
  const bytes = await readFile(path);
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const version = /^(?:omp(?: v|\/))?(\d+\.\d+\.\d+)\s*$/.exec(output.trim())?.[1];
  if (code !== 0 || !version || !["win32", "linux", "darwin"].includes(process.platform)) throw new Error("host-unverifiable");
  return { version, platform: process.platform as InstalledHost["platform"], executableHash: createHash("sha256").update(bytes).digest("hex") };
}

async function nativeCommand(executable: string, args: string[], cwd?: string) {
  // No inherited credentials, overlays, provider configuration or profile selectors.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const child = Bun.spawn([executable, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output, error, code };
}

function unpackEntries(bytes: Buffer): Map<string, Buffer> {
  const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }) : bytes;
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split("\0")[0]!;
    const prefix = header.subarray(345, 500).toString().split("\0")[0]!;
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeField = header.subarray(124, 136).toString().replace(/\0/g, "").trim();
    const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : NaN;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("package-invalid-archive");
    const type = header[156];
    if (!path.startsWith("package/") || path.includes("\\") || path.includes(":") || path.split("/").some(segment => segment === ".." || segment === ".") || path.startsWith("/") || entries.has(path)) throw new Error("package-unsafe-path");
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("package-unsafe-entry");
    if (type !== 53) {
      if (!/^package\/(?:package\.json|(?:README|CONTRIBUTING|CHANGELOG|THIRD_PARTY_NOTICES|SECURITY|CODE_OF_CONDUCT)\.md|LICENSE|src\/[a-zA-Z0-9_./-]+\.(?:ts|json))$/.test(path)) throw new Error("package-unexpected-file");
      entries.set(path, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function registryPath(profile: string): Promise<string> {
  const env: Record<string, string> = { OMP_PROFILE: profile };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([process.execPath, "-e", 'import {getPluginsLockfile} from "@oh-my-pi/pi-utils/dirs"; console.log(getPluginsLockfile());'], { env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("native-registry-path-unverifiable");
  return output.trim();
}

async function materialize(root: string, entries: Map<string, Buffer>): Promise<string> {
  await mkdir(root, { recursive: true });
  for (const [path, content] of entries) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    try { await writeFile(file, content, { flag: "wx", mode: 0o444 }); await chmod(file, 0o444); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(file)).equals(content)) throw new Error("immutable-package-conflict");
    }
  }
  return join(root, "package");
}

async function immutableFile(path: string, bytes: string | Buffer | Uint8Array): Promise<void> {
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(path)).equals(Buffer.from(bytes))) throw new Error("immutable-package-conflict");
  }
}

async function startupSmoke(options: UpdateOptions, target: string, profile: string, cwd: string): Promise<boolean> {
  try {
    const receipt = await runInstalledSmoke({ executable: options.executable, pluginPath: target, ownedProfile: profile, isolatedCwd: cwd, mode: "post-activation", startupOnly: true });
    await writeFile(join(cwd, `startup-${randomUUID()}.json`), JSON.stringify(receipt), { flag: "wx" });
    return receipt.passed && receipt.startupPassed === true && options.pin.supportedPairs.some(pair => pair.platform === receipt.platform && pair.hostVersion === receipt.hostVersion) && receipt.platform === process.platform && /^[0-9a-f]{64}$/.test(receipt.contentHash) && !receipt.isolation.ambientCredentialInherited && receipt.isolation.homeIsolated && !receipt.isolation.providerRoundTrip;
  } catch (error) {
    const refusal = (error instanceof Error ? error.message : "startup-unverifiable").replaceAll(homedir(), "<user>").replaceAll(cwd, "<owned-state>").replaceAll(target, "<verified-package>");
    await writeFile(join(cwd, `startup-failure-${randomUUID()}.json`), JSON.stringify({ refusal }), { flag: "wx" });
    return false;
  }
}

export async function hasCompletedActivation(options:UpdateOptions):Promise<boolean>{return await Bun.file(join(options.stateDirectory,"activation.json")).exists();}
export async function prepareActivation(options: UpdateOptions): Promise<void> {
  const profile = options.targetProfile;
  if (!profile || profile === "default" || !/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error("activation-target-untrusted");
  await immutableFile(join(options.stateDirectory, "activation-target.json"), JSON.stringify({ profile }));
  if (await Bun.file(join(options.stateDirectory, "installed.json")).exists()) return;
  const host = await inspectHost(options.executable);
  const listed = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"]);
  if (listed.code !== 0) throw new Error("previous-registry-unverifiable");
  const previous = JSON.parse(listed.output).npm?.find((p: { name: string }) => p.name === "omp-settings-ru");
  const registry = await registryPath(profile);
  let snapshot: Buffer;
  try { snapshot = await readFile(registry); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || previous) throw new Error("previous-registry-unverifiable");
    snapshot = Buffer.from("null");
  }
  await immutableFile(join(options.stateDirectory, "previous-registry.json"), snapshot);
  if (!previous) return;
  const root = await realpath(previous.path);
  const files: Record<string, Uint8Array> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("previous-package-unsafe-entry");
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) throw new Error("previous-package-unsafe-entry");
      files[`package/${path}`] = await readFile(join(root, path));
    }
  };
  await visit("src");
  for (const name of ["package.json", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "LICENSE"]) {
    try { files[`package/${name}`] = await readFile(join(root, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || name === "package.json") throw error; }
  }
  const bytes = await new Bun.Archive(files).bytes();
  unpackEntries(Buffer.from(bytes));
  const manifest = JSON.parse(Buffer.from(files["package/package.json"]!).toString());
  if (manifest.name !== "omp-settings-ru" || manifest.version !== previous.version) throw new Error("previous-install-unverifiable");
  const previousPackageHash = createHash("sha256").update(bytes).digest("hex");
  await immutableFile(join(options.stateDirectory, "previous.tgz"), bytes);
  await immutableFile(join(options.stateDirectory, "installed.json"), JSON.stringify({ profile, pluginPath: root, previousPackageHash, hostVersion: host.version, platform: host.platform, timestamp: new Date().toISOString(), enabled: previous.enabled, enabledFeatures: previous.enabledFeatures }));
}

export interface LivenessQuery { readonly exit: number; readonly stdout: string; readonly stderr: string }
export interface LivenessRow { readonly pid: number; readonly line: string }
export type LivenessVerdict = { readonly status: "idle" | "busy" | "failed"; readonly refusal?: string };

const LIVENESS_UNVERIFIABLE = "liveness-query-unverifiable";

function isLivenessRow(row: unknown): row is LivenessRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const candidate = row as { pid?: unknown; line?: unknown };
  return Number.isInteger(candidate.pid) && typeof candidate.line === "string";
}

export function selectLiveOmpRows(livePids: readonly number[], cimRows: readonly LivenessRow[]): LivenessRow[] {
  const argv = new Map(cimRows.map(row => [row.pid, row.line]));
  // Only live pids are sessions: a CIM row for an already-exited process is not.
  // A live pid the CIM snapshot did not cover may have started during sampling,
  // so its argv is unknown (empty) rather than absent.
  return livePids.map(pid => ({ pid, line: argv.get(pid) ?? "" }));
}

export function classifyLiveness(profile: string, rows: readonly LivenessRow[]): LivenessVerdict {
  const literalProfile = profile.replaceAll(".", "\\.");
  const pattern = new RegExp(`--profile[= ]+["']?${literalProfile}(?:["']| |$)`);
  // An unreadable argv on a live process is unknown, not absence, so it stays busy.
  return rows.some(row => row.line === "" || pattern.test(row.line))
    ? { status: "busy", refusal: "active-session-or-liveness-unverifiable" }
    : { status: "idle" };
}

/** Strict: a failed query or any malformed sample is unverifiable, never "idle". */
export function parseLivenessSample(profile: string, query: LivenessQuery): LivenessVerdict {
  const failed = { status: "failed", refusal: LIVENESS_UNVERIFIABLE } as const;
  if (query.exit !== 0) return failed;
  const text = query.stdout.trim();
  if (!text) return failed;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return failed; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failed;
  const { live, cim } = parsed as { live?: unknown; cim?: unknown };
  if (!Array.isArray(live) || !Array.isArray(cim)) return failed;
  // A dropped invalid row could turn a busy snapshot into an idle verdict.
  if (!live.every((pid): pid is number => Number.isInteger(pid))) return failed;
  if (!cim.every(isLivenessRow)) return failed;
  return classifyLiveness(profile, selectLiveOmpRows(live, cim));
}

async function livenessQuery(profile: string): Promise<LivenessQuery> {
  // Accepted launcher contract requires explicit --profile for named targets.
  // The CIM argv snapshot is taken BEFORE the live-pid snapshot, so a process
  // starting during sampling is live-without-argv (unknown, busy) rather than
  // silently dropped. Liveness comes from live processes only, so a process that
  // already exited (still listed by CIM) cannot masquerade as an active session.
  // GetProcessesByName returns an empty array when nothing matches; only a real
  // failure throws, so "no omp process" is a valid empty result, not an error.
  const script = `$ErrorActionPreference = 'Stop'; $cim = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'omp.exe' } | ForEach-Object { $line = $_.CommandLine; if ($null -eq $line) { $line = '' }; '{"pid":' + [int]$_.ProcessId + ',"line":' + (ConvertTo-Json $line -Compress) + '}' }); $live = @([System.Diagnostics.Process]::GetProcessesByName('omp') | ForEach-Object { [int]$_.Id }); Write-Output ('{"live":[' + (($live | ForEach-Object { $_.ToString() }) -join ',') + '],"cim":[' + ($cim -join ',') + ']}')`;
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, stdout, stderr };
}

async function profileLiveness(profile: string): Promise<LivenessVerdict> {
  // Non-Windows and untrusted profile names cannot establish liveness: unknown stays fail-closed.
  if (!/^[A-Za-z0-9._-]+$/.test(profile) || process.platform !== "win32") return { status: "busy", refusal: "active-session-or-liveness-unverifiable" };
  return parseLivenessSample(profile, await livenessQuery(profile));
}

async function completedActivation(options:UpdateOptions,host:InstalledHost,entries:Map<string,Buffer>,profile:string,previousPackageHash:string):Promise<UpdateReceipt|undefined>{
  const receiptPath=join(options.stateDirectory,"activation.json");
  if(!await Bun.file(receiptPath).exists())return undefined;
  const blocked=(refusal:string):UpdateReceipt=>({phase:"blocked",pin:options.pin,previousPackageHash,smokePassed:false,refusal});
  let receipt:{profile?:string;target?:string;version?:string;pin?:ReleasePin;registryHash?:string;enabled?:boolean;enabledFeatures?:unknown};
  try { receipt=JSON.parse(await readFile(receiptPath,"utf8")); } catch { return blocked("activation-receipt-conflict"); }
  if(typeof receipt!=="object"||receipt===null||!receipt.pin||JSON.stringify(receipt.pin)!==JSON.stringify(options.pin)||receipt.profile!==profile||receipt.version!==options.pin.packageVersion||typeof receipt.target!=="string"||!isAbsolute(receipt.target)||typeof receipt.registryHash!=="string"||!/^[a-f0-9]{64}$/.test(receipt.registryHash)||typeof receipt.enabled!=="boolean")return blocked("activation-receipt-conflict");
  try {
    const registry=await registryPath(profile),registryBytes=await readFile(registry);
    if(createHash("sha256").update(registryBytes).digest("hex")!==receipt.registryHash)return blocked("activated-package-conflict");
    const listed=await nativeCommand(options.executable,["--profile",profile,"plugin","list","--json"]);
    if(listed.code!==0)return blocked("activated-package-conflict");
    const plugin=JSON.parse(listed.output).npm?.find((entry:{name:string})=>entry.name==="omp-settings-ru");
    if(plugin?.version!==options.pin.packageVersion||plugin.enabled!==receipt.enabled||JSON.stringify(plugin.enabledFeatures??null)!==JSON.stringify(receipt.enabledFeatures??null)||typeof plugin.path!=="string"||await realpath(plugin.path)!==await realpath(receipt.target))return blocked("activated-package-conflict");
    for(const [path,bytes] of entries)if(!(await readFile(join(plugin.path,relative("package",path)))).equals(bytes))return blocked("activated-package-conflict");
    const currentHost=await inspectHost(options.executable);
    if(JSON.stringify(currentHost)!==JSON.stringify(host))return blocked("activated-host-conflict");
    return {phase:"activated",pin:options.pin,previousPackageHash,smokePassed:true};
  } catch {return blocked("activated-package-conflict");}
}

async function activatePackage(options: UpdateOptions, host: InstalledHost, entries: Map<string, Buffer>, profile: string, previousPackageHash: string): Promise<UpdateReceipt> {
  const pin = options.pin;
  const result = (phase: UpdateReceipt["phase"], refusal?: string): UpdateReceipt => ({ phase, pin: options.pin, previousPackageHash, smokePassed: phase === "activated", ...(refusal ? { refusal } : {}) });
  if (await Bun.file(join(options.stateDirectory, "activation.json")).exists()) {
    const completed = await completedActivation(options, host, entries, profile, previousPackageHash);
    return completed ?? { phase: "blocked", pin: options.pin, previousPackageHash, smokePassed: false, refusal: "activation-receipt-conflict" };
  }
  const registry = await registryPath(profile);
  const lock = join(dirname(registry), "updater-activation.lock");
  await mkdir(dirname(lock), { recursive: true });
  try { await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" }); } catch { return result("safe-pending", "activation-lock-held"); }
  let snapshot: Buffer | undefined;
  let previousTarget: string | undefined;
  let switched = false;
  const lease = join(options.stateDirectory, "before-session.lease");
  try { await writeFile(lease, JSON.stringify({ pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, profile }), { flag: "wx" }); }
  catch { await rm(lock, { force: true }); return result("safe-pending", "before-session-lease-held"); }
  let previousEntries: Map<string, Buffer> | undefined;
  let previousVersion: string | undefined;
  try {
    const liveness = await profileLiveness(profile);
    if (liveness.status !== "idle") return result("safe-pending", liveness.refusal!);
    const currentHost = await inspectHost(options.executable);
    if (JSON.stringify(currentHost) !== JSON.stringify(host)) return result("safe-pending", "host-changed-before-activation");
    const listed = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"]);
    if (listed.code !== 0) return result("safe-pending", "previous-registry-unverifiable");
    const before = JSON.parse(listed.output);
    const previous = before.npm.find((p: { name: string }) => p.name === "omp-settings-ru");
    try { snapshot = await readFile(registry); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (await Bun.file(join(options.stateDirectory, "previous-registry.json")).exists()) {
      const expected = await readFile(join(options.stateDirectory, "previous-registry.json"));
      if (!expected.equals(snapshot ?? Buffer.from("null"))) return result("safe-pending", "previous-registry-changed");
    }
    const config = snapshot ? JSON.parse(snapshot.toString()) : { plugins: {}, settings: {} };
    if (previous) {
      const oldBytes = await readFile(join(options.stateDirectory, "previous.tgz"));
      const oldEntries = unpackEntries(oldBytes);
      if (createHash("sha256").update(oldBytes).digest("hex") !== previousPackageHash || !(await Promise.all([...oldEntries].map(async ([p, content]) => (await readFile(join(previous.path, relative("package", p)))).equals(content)))).every(Boolean)) return result("safe-pending", "local-install-modified");
      previousEntries = oldEntries;
      previousVersion = previous.version;
      const durablePrevious = await materialize(join(homedir(), ".omp", "maintenance", "packages", `${previous.version}-${previousPackageHash}`), oldEntries);
      previousTarget = (await lstat(previous.path)).isSymbolicLink() ? await realpath(previous.path) : durablePrevious;
      await immutableFile(join(options.stateDirectory, "backup", "registry.json"), snapshot!);
    }
    const durable = join(homedir(), ".omp", "maintenance", "packages", `${pin.packageVersion}-${pin.sha256}`);
    if (!relative(resolve(tmpdir()), resolve(durable)).startsWith("..")) return result("blocked", "durable-package-under-temp");
    const target = await materialize(durable, entries);
    await immutableFile(join(options.stateDirectory, "activation-intent.json"), JSON.stringify({ profile, pin, target, previousTarget }));
    switched = true;
    const linked = await nativeCommand(options.executable, ["--profile", profile, "plugin", "link", target, "--json"]);
    if (linked.code !== 0) throw new Error("native-activation-failed");
    const changed = { ...config, plugins: { ...config.plugins, "omp-settings-ru": { ...(config.plugins["omp-settings-ru"] ?? { enabled: true, enabledFeatures: null }), version: pin.packageVersion } } };
    await writeFile(`${registry}.new`, JSON.stringify(changed, null, 2), { flag: "wx" });
    await rename(`${registry}.new`, registry);
    const after = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"]);
    const installed = JSON.parse(after.output).npm.find((p: { name: string }) => p.name === "omp-settings-ru");
    const health = await nativeCommand(options.executable, ["--profile", profile, "plugin", "doctor", "--json"]);
    if (after.code !== 0 || installed?.version !== pin.packageVersion || JSON.stringify(JSON.parse(await readFile(registry, "utf8"))) !== JSON.stringify(changed) || health.code !== 0 || JSON.parse(health.output).some((c: { status: string }) => c.status === "error")) throw new Error("activation-registry-verification-failed");
    if (!await startupSmoke(options, target, `omp-settings-ru-proof-${randomUUID()}`, options.stateDirectory)) throw new Error("activation-startup-failed");
    await writeFile(join(options.stateDirectory, "activation.json"), JSON.stringify({ profile, target, pin, registryHash:createHash("sha256").update(await readFile(registry)).digest("hex"),version: installed.version, enabled: installed.enabled, enabledFeatures: installed.enabledFeatures, registryPreserved: true }), { flag: "wx" });
    return result("activated");
  } catch (error) {
    if (!switched) return result("safe-pending", error instanceof Error ? error.message : "activation-state-unverifiable");
    const rollback = await nativeCommand(options.executable, ["--profile", profile, "plugin", previousTarget ? "link" : "uninstall", previousTarget ?? "omp-settings-ru", "--json"]);
    if (snapshot) await writeFile(registry, snapshot); else await rm(registry, { force: true });
    const restored = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"]);
    const bytesRestored = !snapshot || (await readFile(registry)).equals(snapshot);
    const old = JSON.parse(restored.output || "{}").npm?.find((p: { name: string }) => p.name === "omp-settings-ru");
    const packageRestored = previousEntries && old ? (await Promise.all([...previousEntries].map(async ([p, content]) => (await readFile(join(old.path, relative("package", p)))).equals(content)))).every(Boolean) : !old;
    const rollbackSmoke = previousTarget ? await startupSmoke(options, previousTarget, `omp-settings-ru-proof-${randomUUID()}`, options.stateDirectory) : true;
    const restoredOk = rollback.code === 0 && restored.code === 0 && bytesRestored && packageRestored && rollbackSmoke && (previousTarget ? old?.version === previousVersion : !old);
    await writeFile(join(options.stateDirectory, "activation-rollback.json"), JSON.stringify({ registryRestored: bytesRestored, packageRestored, restoredVersion: old?.version, rollbackSmoke, restoredOk }), { flag: "wx" });
    return result(restoredOk ? "rolled-back" : "blocked", restoredOk ? (error instanceof Error ? error.message : "activation-failed") : "activation-rollback-failed");
  } finally { await rm(lock, { force: true }); await rm(lease, { force: true }); }
}

export async function runUpdate(options: UpdateOptions): Promise<UpdateReceipt> {
  let previousPackageHash = "";
  const pending = (refusal: string): UpdateReceipt => ({ phase: "safe-pending", pin: options.pin, previousPackageHash, smokePassed: false, refusal });
  let host: InstalledHost;
  try { host = await inspectHost(options.executable); } catch { return pending("host-unavailable-or-unverifiable"); }
  if (!options.pin.supportedPairs.some(pair => pair.hostVersion === host.version && pair.platform === host.platform)) return pending("host-pair-unsupported");
  const blocked = (refusal: string): UpdateReceipt => ({ phase: "blocked", pin: options.pin, previousPackageHash, smokePassed: false, refusal });
  const pin = options.pin;
  if (!/^\d+\.\d+\.\d+$/.test(pin.packageVersion) || pin.tag !== `v${pin.packageVersion}` || !/^[0-9a-f]{40}$/.test(pin.commitSha) || !Number.isSafeInteger(pin.assetId) || pin.assetId <= 0 || !/^[0-9a-f]{64}$/.test(pin.sha256)) return blocked("release-pin-invalid");
  let fixed: ReleasePin;
  try { fixed = JSON.parse(await readFile(join(options.stateDirectory, "release-pin.json"), "utf8")); }
  catch { return blocked("release-pin-unavailable"); }
  if (fixed.tag !== pin.tag || fixed.commitSha !== pin.commitSha || fixed.assetId !== pin.assetId || fixed.sha256 !== pin.sha256 || fixed.packageVersion !== pin.packageVersion || JSON.stringify(fixed.supportedPairs) !== JSON.stringify(pin.supportedPairs)) return blocked("release-pin-mismatch");
  let bytes: Buffer;
  try { bytes = await readFile(options.packagePath); } catch { return blocked("package-unavailable"); }
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) return blocked("package-hash-mismatch");
  let entries: Map<string, Buffer>;
  try { entries = unpackEntries(bytes); } catch (error) { return blocked(error instanceof Error ? error.message : "package-invalid-archive"); }
  let manifest: { name?: string; version?: string; scripts?: unknown; dependencies?: unknown; omp?: { extensions?: string[] } };
  try { manifest = JSON.parse(entries.get("package/package.json")!.toString()); } catch { return blocked("package-unsafe-manifest"); }
  const lifecycleNames = /^(?:preinstall|install|postinstall|prepare|prepublish|prepublishOnly|prepack|postpack)$/;
  if (manifest.name !== "omp-settings-ru" || manifest.version !== pin.packageVersion || manifest.scripts && Object.keys(manifest.scripts).some(name => lifecycleNames.test(name)) || manifest.dependencies || !manifest.omp?.extensions?.length || manifest.omp.extensions.some(path => !path.startsWith("./src/") || !entries.has(`package/${path.slice(2)}`))) return blocked("package-unsafe-manifest");
  const help = await nativeCommand(options.executable, ["--help"]);
  const managerHelp = await nativeCommand(options.executable, ["plugin", "install", "--help"]);
  if (help.code !== 0 || !help.output.includes("--profile") || !help.output.includes("isolated profile")) return pending("profile-isolation-unverified");
  if (managerHelp.code !== 0 || !managerHelp.output.includes("--dry-run") || !managerHelp.output.includes("Paths") && !managerHelp.output.includes("paths")) return pending("native-manager-unverifiable");
  let previousBytes: Buffer | undefined;
  let previousMetadata: Buffer | undefined;
  let previousEntries: Map<string, Buffer> | undefined;
  let previousVersion = "";
  let activationProfile: string | undefined;
  if (options.activate && options.accepted) {
    let authority: { profile?: unknown };
    try { authority = JSON.parse(await readFile(join(options.stateDirectory, "activation-target.json"), "utf8")); } catch { return blocked("activation-target-unavailable"); }
    if (!options.targetProfile || !/^[A-Za-z0-9._-]+$/.test(options.targetProfile) || authority.profile !== options.targetProfile) return blocked("activation-target-untrusted");
    activationProfile = options.targetProfile;
  }
  try {
    previousMetadata = await readFile(join(options.stateDirectory, "installed.json"));
    const metadata = JSON.parse(previousMetadata.toString());
    previousBytes = await readFile(join(options.stateDirectory, "previous.tgz"));
    previousPackageHash = createHash("sha256").update(previousBytes).digest("hex");
    if (metadata.previousPackageHash !== previousPackageHash || metadata.hostVersion !== host.version || metadata.platform !== host.platform || typeof metadata.pluginPath !== "string" || !Number.isFinite(Date.parse(metadata.timestamp)) || typeof metadata.enabled !== "boolean") return blocked("previous-install-unverifiable");
    if (options.activate && options.accepted && metadata.profile !== activationProfile) return blocked("previous-profile-target-mismatch");
    previousEntries = unpackEntries(previousBytes);
    const oldManifest = JSON.parse(previousEntries.get("package/package.json")!.toString());
    if (oldManifest.name !== manifest.name || oldManifest.scripts && Object.keys(oldManifest.scripts).some(name => lifecycleNames.test(name)) || oldManifest.dependencies) return blocked("previous-install-unverifiable");
    previousVersion = oldManifest.version;
    const backup = join(options.stateDirectory, "backup");
    await mkdir(backup, { recursive: true });
    await immutableFile(join(backup, "previous.tgz"), previousBytes);
    await immutableFile(join(backup, "installed.json"), previousMetadata);
    await immutableFile(join(backup, "receipt.json"), JSON.stringify({ pin, previousPackageHash }));
  } catch (error) {
    if (previousMetadata || (error as NodeJS.ErrnoException).code !== "ENOENT") return blocked("previous-install-unverifiable");
  }
  const stage = join(options.stateDirectory, "stage");
  try {
    await mkdir(stage, { recursive: true });
    await immutableFile(join(stage, "receipt.json"), JSON.stringify({ pin, host, previousPackageHash }));
    await materialize(stage, entries);
    await immutableFile(join(stage, "package.tgz"), bytes);
  } catch (error) { return blocked(error instanceof Error ? error.message : "stage-unwritable"); }
  try {
    const verified = JSON.parse(await readFile(join(options.stateDirectory, "verification-complete.json"), "utf8"));
    if (JSON.stringify(verified.pin) !== JSON.stringify(pin) || JSON.stringify(verified.host) !== JSON.stringify(host) || verified.previousPackageHash !== previousPackageHash || verified.smokePassed !== true) return blocked("verification-receipt-conflict");
    if (options.activate !== options.accepted) return { phase: "staged", pin, previousPackageHash, smokePassed: true, refusal: "activation-not-accepted" };
    if (options.activate) return activatePackage(options, host, entries, activationProfile!, previousPackageHash);
    return { phase: "staged", pin, previousPackageHash, smokePassed: true };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return blocked("verification-receipt-conflict"); }
  const profile = `omp-updater-${randomUUID()}`;
  const target = join(stage, "package");
  try {
  const before = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"], stage);
  if (before.code !== 0 || JSON.parse(before.output).npm?.length !== 0 || JSON.parse(before.output).marketplace?.length !== 0) return pending("profile-isolation-unverified");
  if (previousEntries) {
    const initial = join(stage, "rollback-initial");
    await materialize(initial, previousEntries);
    const oldInstall = await nativeCommand(options.executable, ["--profile", profile, "plugin", "install", join(initial, "package"), "--json"], stage);
    if (oldInstall.code !== 0) return blocked("rollback-initial-install-failed");
  }
  const preview = await nativeCommand(options.executable, ["--profile", profile, "plugin", "install", target, "--dry-run", "--json"], stage);
  if (preview.code !== 0) return pending("native-install-preview-failed");
  const install = await nativeCommand(options.executable, ["--profile", profile, "plugin", "install", target, "--json"], stage);
  const listed = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"], stage);
  const doctor = await nativeCommand(options.executable, ["--profile", profile, "plugin", "doctor", "--json"], stage);
  const plugin = JSON.parse(listed.output || "{}").npm?.find((entry: { name: string; version: string }) => entry.name === manifest.name && entry.version === pin.packageVersion);
  const capabilities: ManagerCapabilities = {
    installVerifiedPath: install.code === 0 && !!plugin,
    // A local path is a source link, not a permanent pinned tarball replacement.
    replaceVerifiedPath: false, pinnedUpgradeTarget: false, isolatedProfile: true, userScope: false,
  };
  const checks: { name: string; status: string }[] = JSON.parse(doctor.output || "[]");
  const health = doctor.code === 0 && checks.some(check => check.name === "plugin:omp-settings-ru" && check.status === "ok") && checks.every(check => check.status !== "error");
  const smokePassed = await startupSmoke(options, target, `omp-settings-ru-proof-${randomUUID()}`, stage);
  await writeFile(join(options.stateDirectory, "verification.json"), JSON.stringify({ host, pin, profile, capabilities, managerHealthy: health, managerChecks: checks, sessionSmoke: smokePassed ? "observed-interactive-settings" : "unverified" }));
  if (!capabilities.installVerifiedPath || !health) return pending("isolated-manager-verification-failed");
  if (previousBytes && previousMetadata && previousEntries) {
    const restored = join(stage, "rollback-restored");
    const backedBytes = await readFile(join(options.stateDirectory, "backup", "previous.tgz"));
    const restoredEntries = unpackEntries(backedBytes);
    await materialize(restored, restoredEntries);
    const rollback = await nativeCommand(options.executable, ["--profile", profile, "plugin", "install", join(restored, "package"), "--json"], stage);
    const rollbackList = await nativeCommand(options.executable, ["--profile", profile, "plugin", "list", "--json"], stage);
    const old = JSON.parse(rollbackList.output || "{}").npm?.find((entry: { name: string; version: string }) => entry.name === manifest.name && entry.version === previousVersion);
    const bytesRestored = backedBytes.equals(previousBytes) && (await Promise.all([...restoredEntries].map(async ([path, content]) => (await readFile(join(restored, path))).equals(content)))).every(Boolean);
    const metadataRestored = (await readFile(join(options.stateDirectory, "backup", "installed.json"))).equals(previousMetadata) && !!old;
    await immutableFile(join(options.stateDirectory, "rollback-proof.json"), JSON.stringify({ previousPackageHash, restoredVersion: old?.version, bytesRestored, metadataRestored, nativeLinkRollbackOnly: true, sessionSmoke: "unverified" }));
    if (rollback.code !== 0 || !bytesRestored || !metadataRestored) return blocked("rollback-verification-failed");
  }
  if (smokePassed) await immutableFile(join(options.stateDirectory, "verification-complete.json"), JSON.stringify({ pin, host, previousPackageHash, smokePassed: true }));
  if (options.activate !== options.accepted) return { phase: "staged", pin, previousPackageHash, smokePassed, refusal: "activation-not-accepted" };
  if (options.activate && options.accepted) {
    if (!smokePassed) return pending("isolated-startup-verification-failed");
    return activatePackage(options, host, entries, activationProfile!, previousPackageHash);
  }
  return { phase: "staged", pin, previousPackageHash, smokePassed, ...(!smokePassed ? { refusal: "isolated-startup-verification-failed" } : {}) };
  } finally {
    await nativeCommand(options.executable, ["--profile", profile, "plugin", "uninstall", "omp-settings-ru", "--json"], stage);
  }
}
