import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const PROJECT = "mame-inout-test-m07";
export const ORIGIN = "http://localhost:8085";
const limits = { api: [750_000_000, 512], db: [750_000_000, 1024], web: [250_000_000, 384], proxy: [250_000_000, 128] };
const fail = (code) => { throw new Error(code); };
const ensure = (condition, code) => { if (!condition) fail(code); };
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));

export function validateArguments(args) {
  ensure(args.length === 4 && args[0] === "--ack" && args[1] === "synthetic-only" && args[2] === "--output" && args[3].endsWith(".json"), "ARGUMENTS_REFUSED");
  return args[3];
}

export function validateContext(value) {
  ensure(Array.isArray(value) && value.length === 1 && value[0]?.Name === "desktop-linux" &&
    value[0]?.Endpoints?.docker?.Host === "npipe:////./pipe/dockerDesktopLinuxEngine", "REMOTE_DOCKER_REFUSED");
}

// 明示した専用project以外には、データ作成・停止・再開を行わない。
// 実データを誤用した場合に消して継続する機能は設けず、空DBからやり直す。
export function validateContainers(items) {
  ensure(Array.isArray(items), "CONTAINERS_REFUSED");
  const core = {};
  for (const item of items) {
    const labels = item.Config?.Labels ?? {};
    const service = labels["com.docker.compose.service"];
    ensure(labels["com.docker.compose.project"] === PROJECT && [...Object.keys(limits), "migrate"].includes(service), "PROJECT_REFUSED");
    if (service === "migrate") { ensure(!item.State?.Running && item.State?.ExitCode === 0, "MIGRATION_REFUSED"); continue; }
    ensure(!core[service] && /^[a-f0-9]{64}$/.test(item.Id), "CONTAINER_ID_REFUSED");
    ensure(item.State?.Running && item.State?.Health?.Status !== "unhealthy", "CONTAINER_NOT_READY");
    ensure(!item.HostConfig?.Privileged && !item.HostConfig?.CapAdd?.length &&
      item.HostConfig?.SecurityOpt?.includes("no-new-privileges:true"), "PRIVILEGES_REFUSED");
    ensure(!(item.Mounts ?? []).some((mount) => /docker\.sock|dockerDesktopLinuxEngine/.test(`${mount.Source} ${mount.Destination}`)), "SOCKET_MOUNT_REFUSED");
    ensure(item.HostConfig?.NanoCpus === limits[service][0] && item.HostConfig?.Memory === limits[service][1] * 1024 ** 2, "RESOURCE_LIMIT_REFUSED");
    if (service !== "proxy") ensure(!Object.keys(item.HostConfig?.PortBindings ?? {}).length, "EXTERNAL_PORT_REFUSED");
    core[service] = item;
  }
  ensure(Object.keys(core).length === 4, "CORE_SERVICES_MISSING");
  const bindings = core.proxy.HostConfig.PortBindings;
  ensure(Object.keys(bindings ?? {}).length === 1 && bindings["8080/tcp"]?.length === 1 &&
    bindings["8080/tcp"][0].HostIp === "127.0.0.1" && bindings["8080/tcp"][0].HostPort === "8085", "PROXY_PORT_REFUSED");
  ensure(core.db.Config.Image === "postgres:18.6-bookworm" && core.db.State.Health?.Status === "healthy", "DATABASE_IMAGE_REFUSED");
  const data = core.db.Mounts.filter((mount) => mount.Destination === "/var/lib/postgresql");
  ensure(data.length === 1 && data[0].Type === "volume" && data[0].Name === `${PROJECT}_db_data`, "DATABASE_VOLUME_REFUSED");
  const environment = Object.fromEntries(core.api.Config.Env.map((entry) => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
  ensure(environment.APP_ORIGIN === ORIGIN && environment.DB_HOST === "db" && environment.DB_NAME === "mame" && environment.DB_USER === "mame_app", "API_ENVIRONMENT_REFUSED");
  ensure(Object.keys(core.api.NetworkSettings.Networks).sort().join(",") === `${PROJECT}_database,${PROJECT}_edge` &&
    Object.keys(core.db.NetworkSettings.Networks).join(",") === `${PROJECT}_database`, "NETWORK_REFUSED");
  return core;
}

export function distribution(samples) {
  const values = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const percentile = (fraction) => values.length ? Math.round(values[Math.ceil(values.length * fraction) - 1] * 100) / 100 : null;
  return { count: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1),
    successes: samples.filter((sample) => sample.status >= 200 && sample.status < 300).length,
    errors: samples.filter((sample) => sample.status < 200 || sample.status >= 300).length };
}

async function command(binary, args, { input, timeout = 30_000 } = {}) {
  // 子プロセス例外のstdout/stderrには一時資格が含まれ得るため、外へ再送しない。
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks = []; let size = 0; let ended = false;
    const stop = () => { if (!ended) { ended = true; clearTimeout(timer); child.kill(); reject(new Error("LOCAL_COMMAND_FAILED")); } };
    const timer = setTimeout(stop, timeout);
    child.on("error", stop);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > 16 * 1024 ** 2) stop(); else chunks.push(chunk); });
    child.on("close", (code) => { if (!ended) { ended = true; clearTimeout(timer); if (code === 0) resolve(Buffer.concat(chunks).toString("utf8")); else reject(new Error("LOCAL_COMMAND_FAILED")); } });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function runBenchmark(args) {
  const output = validateArguments(args);
  // 計測を終えた後に既存ファイルを上書きせず停止する事態を、開始前にも検出する。
  try { await lstat(output); fail("OUTPUT_ALREADY_EXISTS"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const dockerPrefix = process.platform === "win32" ? ["--context", "desktop-linux"] : ["--host", "unix:///var/run/docker.sock"];
  const docker = (args, options) => command("docker", [...dockerPrefix, ...args], options);
  if (process.platform === "win32") validateContext(JSON.parse(await docker(["context", "inspect", "desktop-linux"])));
  else ensure(process.platform === "linux", "OPERATING_SYSTEM_REFUSED");
  const selected = (await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJECT}`])).trim().split(/\s+/).filter(Boolean);
  ensure(selected.length >= 4 && selected.every((id) => /^[a-f0-9]{12,64}$/.test(id)), "PROJECT_NOT_FOUND");
  const core = validateContainers(JSON.parse(await docker(["inspect", ...selected])));
  const host = JSON.parse(await docker(["info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"architecture":{{json .Architecture}},"kernel":{{json .KernelVersion}},"operatingSystem":{{json .OperatingSystem}}}']));
  const identity = (item) => ({ id: item.Id, running: item.State.Running, startedAt: item.State.StartedAt, restarts: item.RestartCount });
  const outside = async () => {
    const ids = (await docker(["ps", "-aq"])).trim().split(/\s+/).filter(Boolean);
    const rows = ids.length ? JSON.parse(await docker(["inspect", ...ids])) : [];
    return rows.filter((row) => row.Config.Labels?.["com.docker.compose.project"] !== PROJECT).map(identity).sort((a, b) => a.id.localeCompare(b.id));
  };
  const outsideBefore = await outside();
  const fixtureSource = await readFile(new URL("../tests/performance/m07-fixture.mjs", import.meta.url), "utf8");
  const fixture = async (mode) => {
    ensure(["seed", "stats", "verify"].includes(mode), "FIXTURE_MODE_REFUSED");
    const script = `${fixtureSource}\ntry { process.stdout.write(JSON.stringify(await runFixture(${JSON.stringify(mode)}))); } catch { process.stderr.write('合成検査処理を完了できません。\\n'); process.exitCode = 1; }\n`;
    const result = await docker(["exec", "-i", "--env", `TEST_PROJECT=${PROJECT}`, "--env", "M07_BENCHMARK_ACK=synthetic-only", core.api.Id, "node", "--input-type=module", "-"], { input: script, timeout: 150_000 });
    try { return JSON.parse(result); } catch { fail("FIXTURE_RESPONSE_INVALID"); }
  };
  const groups = {};
  const call = async (group, path, cookie, body, timeout = 15_000) => {
    ensure(path.startsWith("/api/") && !path.includes("://"), "HTTP_TARGET_REFUSED");
    const started = performance.now();
    let status = 0;
    try {
      const response = await fetch(ORIGIN + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = response.status;
      const text = await response.text();
      let value;
      if (!path.includes(".csv")) { try { value = JSON.parse(text); } catch { fail("HTTP_BODY_INVALID"); } }
      return { status, value, csvRows: path.includes(".csv") ? text.split("\r\n").length - 2 : undefined };
    } catch { status = 0; return { status: 0 }; }
    finally { if (group) (groups[group] ??= []).push({ ms: performance.now() - started, status }); }
  };
  ensure((await call(null, "/api/health")).status === 200 && (await call(null, "/api/admin/me")).status === 401, "HTTP_BASELINE_REFUSED");
  process.stderr.write("専用環境を確認しました。合成データを作成します。\n");
  const credentials = await fixture("seed");
  ensure(credentials.qrs?.length === 500 && credentials.devices?.length === 5 && typeof credentials.adminCookie === "string", "FIXTURE_SHAPE_INVALID");
  const initial = await fixture("verify");
  ensure(initial.people === 500 && initial.visits === 100000 && initial.inside === 100 && initial.devices === 5, "FIXTURE_COUNTS_INVALID");
  const admin = credentials.adminCookie;
  const ticket = async (index, group = null) => {
    const response = await call(group, "/api/reception/requests", credentials.devices[index].cookie, {});
    ensure(response.status === 201 && typeof response.value?.requestId === "string", "TICKET_FAILED");
    return response.value.requestId;
  };
  const record = (index, requestId, personIndex, mode, group = null, timeout) => call(group, "/api/reception/records", credentials.devices[index].cookie,
    { requestId, mode, qr: credentials.qrs[personIndex] }, timeout);
  const expectRecorded = (response) => ensure(response.status === 200 && response.value?.outcome === "RECORDED" && typeof response.value?.recordedAt === "string", "RECORD_FAILED");
  const cleanup = async (personIndex) => expectRecorded(await record(0, await ticket(0), personIndex, "OUT"));
  for (const path of ["/api/admin/presence?limit=100", "/api/admin/dashboard", "/api/admin/attendance?limit=100"]) ensure((await call(null, path, admin)).status === 200, "WARMUP_FAILED");
  const samples = []; let sampling = true;
  const sample = async () => {
    const [raw, database, filesystem] = await Promise.all([
      docker(["stats", "--no-stream", "--format", "{{json .}}", ...Object.values(core).map((item) => item.Id)]),
      fixture("stats"), docker(["exec", core.db.Id, "df", "-Pk", "/var/lib/postgresql"]),
    ]);
    const rows = raw.trim().split(/\r?\n/).map((row) => JSON.parse(row));
    const resources = {};
    for (const [service, item] of Object.entries(core)) {
      const row = rows.find((row) => item.Id.startsWith(row.ID));
      ensure(row && /^[\d.]+%$/.test(row.CPUPerc) && /^[\d.]+%$/.test(row.MemPerc), "RESOURCE_SAMPLE_INVALID");
      resources[service] = { cpuPercent: Number.parseFloat(row.CPUPerc), memoryPercent: Number.parseFloat(row.MemPerc), memoryUsage: row.MemUsage };
    }
    const disk = filesystem.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);
    samples.push({ seconds: Math.round((performance.now() - started) / 100) / 10, resources, database,
      databaseFilesystem: { totalKiB: Number(disk[1]), usedKiB: Number(disk[2]), availableKiB: Number(disk[3]) } });
  };
  const started = performance.now();
  const sampler = (async () => { let index = 0; while (sampling) { await pause(started + index++ * 5000 - performance.now()); if (sampling) await sample(); } })();
  const scheduleLag = [];
  const periodic = async (interval, count, action) => {
    for (let index = 0; index < count; index++) { await pause(started + index * interval - performance.now()); await action(index); }
  };
  process.stderr.write("60秒間の通常受付と管理画面負荷を測定しています。\n");
  let workload;
  try {
    workload = await Promise.allSettled([
      ...credentials.devices.map((_, index) => periodic(5000, 12, async (round) => {
        scheduleLag.push(performance.now() - (started + round * 5000));
        const begin = performance.now();
        expectRecorded(await record(index, await ticket(index, "ticket"), 100 + index, round % 2 ? "OUT" : "IN", "record"));
        (groups.operation ??= []).push({ ms: performance.now() - begin, status: 200 });
      })),
      periodic(2000, 30, async () => { const result = await call("presence", "/api/admin/presence?limit=100", admin); ensure(result.status === 200 && result.value?.items?.length === 100 && result.value.total >= 100 && result.value.total <= 105, "PRESENCE_FAILED"); }),
      periodic(2000, 30, async () => { const result = await call("dashboard", "/api/admin/dashboard", admin); ensure(result.status === 200 && result.value?.counts?.inside >= 100 && result.value.counts.inside <= 105, "DASHBOARD_FAILED"); }),
      periodic(2000, 30, async (round) => {
        const query = ["limit=100", "limit=100&q=%E5%90%88%E6%88%90%E5%88%A9%E7%94%A8%E8%80%8500", "limit=100&from=2025-01-01&to=2025-01-10"][round % 3];
        const result = await call("history", `/api/admin/attendance?${query}`, admin);
        ensure(result.status === 200 && result.value?.items?.length === 100 &&
          (round % 3 !== 0 || result.value.total >= 100000 && result.value.total <= 100030) &&
          (round % 3 !== 1 || result.value.total === 19800) && (round % 3 !== 2 || result.value.total === 5000), "HISTORY_FAILED");
      }),
      periodic(15000, 4, async () => { const result = await call("csv", "/api/admin/attendance.csv?from=2025-01-01&to=2025-01-10", admin); ensure(result.status === 200 && result.csvRows === 5000, "CSV_FAILED"); }),
    ]);
    await pause(started + 60_000 - performance.now());
  } finally { sampling = false; await sampler; }
  ensure(workload.every((result) => result.status === "fulfilled"), "NORMAL_WORKLOAD_FAILED");
  process.stderr.write("同時送信・応答喪失・専用DB停止後の復帰を検査しています。\n");
  const concurrentTickets = await Promise.all(credentials.devices.map((_, index) => ticket(index)));
  const concurrent = await Promise.all(concurrentTickets.map((id, index) => record(index, id, 105, "IN")));
  ensure(concurrent.filter((row) => row.status === 200 && row.value?.outcome === "RECORDED").length === 1 &&
    concurrent.filter((row) => row.status === 409 && row.value?.outcome === "ALREADY_INSIDE").length === 4, "CONCURRENT_RESULT_FAILED");
  await cleanup(105);
  const sameId = await ticket(0);
  const duplicated = await Promise.all(Array.from({ length: 10 }, () => record(0, sameId, 106, "IN")));
  duplicated.forEach(expectRecorded);
  ensure(new Set(duplicated.map((row) => JSON.stringify(row.value))).size === 1, "IDEMPOTENCY_FAILED");
  const mismatch = await record(0, sameId, 106, "OUT");
  ensure(mismatch.status === 409 && mismatch.value?.code === "REQUEST_CONFLICT", "PAYLOAD_CONFLICT_FAILED");
  await cleanup(106);
  const lostId = await ticket(0);
  await new Promise((resolve) => {
    const request = httpRequest(ORIGIN + "/api/reception/records", { method: "POST", headers: { origin: ORIGIN, cookie: credentials.devices[0].cookie, "content-type": "application/json" } });
    const timer = setTimeout(() => request.destroy(), 5000);
    request.on("error", () => {}); request.on("response", (response) => response.destroy());
    request.on("finish", () => setTimeout(() => request.destroy(), 5));
    request.on("close", () => { clearTimeout(timer); resolve(); });
    request.end(JSON.stringify({ requestId: lostId, mode: "IN", qr: credentials.qrs[107] }));
  });
  const lostStatus = await call(null, `/api/reception/requests/${lostId}`, credentials.devices[0].cookie);
  ensure(lostStatus.status === 200 && ["pending", "completed"].includes(lostStatus.value?.state), "LOST_RESPONSE_LOOKUP_FAILED");
  if (lostStatus.value.state === "pending") expectRecorded(await record(0, lostId, 107, "IN"));
  else expectRecorded({ status: 200, value: lostStatus.value.result });
  await cleanup(107);
  const outageId = await ticket(0);
  let outageStatus; let attemptedStop = false; let interrupted = false;
  const handleInterruption = () => { interrupted = true; };
  process.once("SIGINT", handleInterruption); process.once("SIGTERM", handleInterruption);
  try {
    const current = JSON.parse(await docker(["inspect", core.db.Id]))[0];
    ensure(current.Id === core.db.Id && current.Config.Labels["com.docker.compose.project"] === PROJECT &&
      current.Mounts.some((mount) => mount.Type === "volume" && mount.Name === `${PROJECT}_db_data` && mount.Destination === "/var/lib/postgresql"), "DATABASE_STOP_REFUSED");
    attemptedStop = true;
    await docker(["stop", "--time", "3", core.db.Id]);
    ensure(!interrupted, "INTERRUPTED_DURING_DATABASE_STOP");
    const outage = await record(0, outageId, 108, "IN", null, 4000);
    outageStatus = outage.status;
    ensure(outage.status === 0 || outage.status >= 500, "DATABASE_OUTAGE_FALSE_SUCCESS");
  } finally {
    if (attemptedStop) {
      const current = JSON.parse(await docker(["inspect", core.db.Id]))[0];
      ensure(current.Id === core.db.Id && current.Config.Labels["com.docker.compose.project"] === PROJECT && current.Image === core.db.Image, "DATABASE_RESTART_REFUSED");
      await docker(["start", core.db.Id]);
    }
    process.removeListener("SIGINT", handleInterruption); process.removeListener("SIGTERM", handleInterruption);
  }
  let recovered = false;
  for (let retry = 0; retry < 80; retry++) {
    const current = JSON.parse(await docker(["inspect", core.db.Id]))[0];
    if (current.State.Health?.Status === "healthy" && (await call(null, "/api/admin/me", admin, undefined, 2000)).status === 200) { recovered = true; break; }
    await pause(500);
  }
  ensure(recovered, "DATABASE_RECOVERY_FAILED");
  ensure(!interrupted, "INTERRUPTED_AFTER_DATABASE_RESTART");
  expectRecorded(await record(0, outageId, 108, "IN"));
  await cleanup(108);
  const final = await fixture("verify");
  // 60打刻=30区間、各障害シナリオ1区間ずつ。再送を新しい履歴・監査に数えない。
  ensure(final.people === 500 && final.devices === 5 && final.visits === 100034 && final.inside === 100 && final.duplicateOpen === 0 &&
    final.reversedTimes === 0 && final.requests === 72 && final.completedRequests === 72 && final.recordedRequests === 68 && final.recordedAudits === 68, "FINAL_INTEGRITY_FAILED");
  const endItems = JSON.parse(await docker(["inspect", ...Object.values(core).map((item) => item.Id)]));
  for (const item of endItems) {
    const previous = Object.values(core).find((previous) => previous.Id === item.Id);
    ensure(previous && item.State.Running && !item.State.OOMKilled && item.RestartCount === previous.RestartCount, "CONTAINER_FINAL_STATE_FAILED");
    if (item.Id !== core.db.Id) ensure(item.State.StartedAt === previous.State.StartedAt, "OTHER_SERVICE_RESTARTED");
  }
  ensure(JSON.stringify(outsideBefore) === JSON.stringify(await outside()), "OUTSIDE_PROJECT_CHANGED");
  ensure(samples.length >= 10 && samples.every((sample) => Object.values(sample.resources).every((row) => row.memoryPercent <= 100)), "RESOURCE_SAMPLES_FAILED");
  const summary = Object.fromEntries(Object.entries(groups).map(([name, values]) => [name, distribution(values)]));
  const targets = Object.fromEntries(Object.entries(summary).filter(([name]) => name !== "operation").map(([name, value]) => [name, value.errors === 0 && value.p95Ms <= (name === "csv" ? 5000 : 1000)]));
  ensure(summary.ticket.count === 60 && summary.record.count === 60 && summary.presence.count === 30 && summary.dashboard.count === 30 && summary.history.count === 30 && summary.csv.count === 4, "SAMPLE_COUNTS_FAILED");
  const report = { format: 1, measuredAt: new Date().toISOString(), project: PROJECT, origin: ORIGIN,
    sourceCommit: (await command("git", ["rev-parse", "HEAD"])).trim(), sourceWorkingTreeDirty: Boolean((await command("git", ["status", "--porcelain"])).trim()),
    runnerSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    fixtureSha256: createHash("sha256").update(fixtureSource).digest("hex"),
    environment: { engine: JSON.parse(await docker(["version", "--format", "{{json .Server}}"])).Version, operatingSystem: process.platform, node: process.version, host,
      images: Object.fromEntries(Object.entries(core).map(([name, item]) => [name, item.Image])), limits },
    normalDurationSeconds: 60, summary, scheduleLag: distribution(scheduleLag.map((ms) => ({ ms, status: 200 }))),
    targets, performancePassed: Object.values(targets).every(Boolean), integrityPassed: true, initial, final,
    faults: { concurrentIndependentRequests: { attempts: 5, recorded: 1, alreadyInside: 4 }, duplicateSameRequest: { attempts: 10, uniqueResult: 1 },
      payloadConflictStatus: 409, lostResponse: { lookupState: lostStatus.value.state, finalRecorded: true }, databaseOutage: { status: outageStatus, recovered: true } },
    resourceSummary: { samples: samples.length,
      services: Object.fromEntries(Object.keys(core).map((service) => [service, {
        peakCpuPercent: Math.max(...samples.map((sample) => sample.resources[service].cpuPercent)),
        peakMemoryPercent: Math.max(...samples.map((sample) => sample.resources[service].memoryPercent)),
      }])), peakDatabaseConnections: Math.max(...samples.map((sample) => sample.database.connections)),
      databaseBytes: samples.at(-1).database.databaseBytes, minimumDatabaseDiskAvailableKiB: Math.min(...samples.map((sample) => sample.databaseFilesystem.availableKiB)) },
    resources: samples, otherProjectsUnchanged: true,
    limitations: ["合成データのローカルDocker測定。実VPS・実機カメラ・パスキー操作時間の保証ではない。", "管理者セッションと受付資格を合成し、HTTPの認証・Origin検査・試行制限は有効なまま測定した。", "負荷生成・資源採取も同じホストを使用する。"] };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`合成性能・障害検査完了: 整合性=成功、性能目標=${report.performancePassed ? "達成" : "未達"}。\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBenchmark(process.argv.slice(2)).catch((error) => {
    const code = /^[A-Z_]{3,80}$/.test(error?.message ?? "") ? error.message : "UNEXPECTED_FAILURE";
    process.stderr.write(`合成検査を完了できません（${code}）。専用環境・固定条件・出力先を確認してください。資格情報やDBの例外詳細は表示しません。\n`);
    process.exitCode = 1;
  });
}
