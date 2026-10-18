#!/usr/bin/env node
//
// The fixture runner: every tests/fixtures/*.json is one case - params in, scripted provider and
// MCP replies, expectations out. It drives the real command through its environment exactly as the
// platform does (PARAM_NAMES plus PARAM_<NAME>, RESULTS_PATH) and reads what it writes, so the
// fixtures are data another implementation of the same contract can replay. See tests/README.md.
//
//   node tests/run.js [substring...]   # only cases whose file name contains a substring
//
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { startMcpServer, startProvider } from "./mocks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const BIN = { prompt: path.join(HERE, "..", "bin", "prompt.js"), agent: path.join(HERE, "..", "bin", "agent.js") };

const filters = process.argv.slice(2);
// A case that runs this long is hung, not slow: the retry cases take a few seconds at most.
const CASE_TIMEOUT_MS = 60_000;
let passed = 0;
let failed = 0;

/** PARAM_<NAME>: upper-case, `-` to `_`, as CONTRIBUTING_TASKS.md specifies. */
const envName = (name) => `PARAM_${name.toUpperCase().replaceAll("-", "_")}`;

function substitute(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_]+)(?::([^}]+))?\}/g, (whole, key, arg) => {
      if (key === "MCP") return vars.mcp[arg]?.url ?? whole;
      return vars[key] ?? whole;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

/**
 * Partial match: every expected key must match; "$absent" means the key must not exist,
 * "$present" that it must, "$contains:x" that a string contains x; arrays match element by element.
 */
function matches(expected, actual, where, problems) {
  if (expected === "$absent") {
    if (actual !== undefined) problems.push(`${where}: expected absent, got ${JSON.stringify(actual)}`);
    return;
  }
  if (expected === "$present") {
    if (actual === undefined) problems.push(`${where}: expected present`);
    return;
  }
  if (typeof expected === "string" && expected.startsWith("$contains:")) {
    const needle = expected.slice("$contains:".length);
    if (typeof actual !== "string" || !actual.includes(needle)) {
      problems.push(`${where}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(`${where}: expected ${expected.length} item(s), got ${JSON.stringify(actual)}`);
      return;
    }
    expected.forEach((e, i) => matches(e, actual[i], `${where}[${i}]`, problems));
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      problems.push(`${where}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [k, v] of Object.entries(expected)) matches(v, actual[k], `${where}.${k}`, problems);
    return;
  }
  if (expected !== actual) {
    problems.push(`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function readResults(resultsPath, channel) {
  if (channel === "file") {
    const text = fs.readFileSync(resultsPath, "utf8");
    return text ? JSON.parse(text) : {};
  }
  return Object.fromEntries(fs.readdirSync(resultsPath).map((f) => [f, fs.readFileSync(path.join(resultsPath, f), "utf8")]));
}

async function runCase(file) {
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  const name = path.basename(file, ".json");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-ai-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace);
  for (const [rel, contents] of Object.entries(fixture.workspace ?? {})) {
    const target = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  const provider = await startProvider(fixture.provider ?? [{ status: 500, body: { error: "no provider script" } }]);
  const mcp = {};
  for (const [server, spec] of Object.entries(fixture.mcp ?? {})) {
    mcp[server] = await startMcpServer(server, spec);
  }
  const vars = { PROVIDER: provider.baseURL, WORKSPACE: workspace, mcp };

  const channel = fixture.resultsChannel ?? "directory";
  const resultsPath = channel === "file" ? path.join(tmp, "termination-log") : path.join(tmp, "results");
  if (channel === "file") fs.writeFileSync(resultsPath, "");
  else fs.mkdirSync(resultsPath);

  const params = substitute(fixture.params ?? {}, vars);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RESULTS_PATH: resultsPath,
    PARAM_NAMES: Object.keys(params).join(","),
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [envName(k), typeof v === "string" ? v : JSON.stringify(v)])),
    ...substitute(fixture.env ?? {}, vars),
  };

  const command = fixture.command ?? "prompt";
  // Asynchronous on purpose: the mocks live in this process, so a blocking spawn would starve them.
  const proc = await new Promise((resolve) => {
    const child = spawn("node", [BIN[command]], { env, cwd: workspace });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), CASE_TIMEOUT_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

  await provider.close();
  for (const m of Object.values(mcp)) await m.close();

  const problems = [];
  const expect = substitute(fixture.expect ?? {}, vars);
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";

  if (expect.exit === "nonzero") {
    if (proc.status === 0) problems.push(`exit: expected non-zero, got 0`);
  } else if (proc.status !== (expect.exit ?? 0)) {
    problems.push(`exit: expected ${expect.exit ?? 0}, got ${proc.status}`);
  }

  let results = {};
  try {
    results = readResults(resultsPath, channel);
  } catch (e) {
    problems.push(`results: could not read: ${e.message}`);
  }
  if (expect.results) matches(expect.results, results, "results", problems);
  if (expect.resultKeys) {
    const keys = Object.keys(results).sort().join(",");
    if (keys !== [...expect.resultKeys].sort().join(",")) problems.push(`result keys: expected ${expect.resultKeys.sort().join(",")}, got ${keys}`);
  }
  for (const key of expect.noResults ?? []) {
    if (results[key] !== undefined) problems.push(`results.${key}: expected not written, got ${JSON.stringify(results[key])}`);
  }
  for (const s of expect.stdout ?? []) if (!stdout.includes(s)) problems.push(`stdout: expected to contain ${JSON.stringify(s)}`);
  for (const s of expect.stdoutNot ?? []) if (stdout.includes(s)) problems.push(`stdout: expected NOT to contain ${JSON.stringify(s)}`);
  for (const s of expect.stderr ?? []) if (!stderr.includes(s)) problems.push(`stderr: expected to contain ${JSON.stringify(s)}`);
  for (const s of expect.stderrNot ?? []) if (stderr.includes(s)) problems.push(`stderr: expected NOT to contain ${JSON.stringify(s)}`);
  if (expect.requestCount !== undefined && provider.requests.length !== expect.requestCount) {
    problems.push(`requests: expected ${expect.requestCount}, got ${provider.requests.length}`);
  }
  (expect.requests ?? []).forEach((e, i) => {
    const { index = i, ...expected } = e;
    matches(expected, provider.requests[index], `requests[${index}]`, problems);
  });
  const mcpCalls = Object.values(mcp).flatMap((m) => m.calls);
  if (expect.mcpCallCount !== undefined && mcpCalls.length !== expect.mcpCallCount) {
    problems.push(`mcp calls: expected ${expect.mcpCallCount}, got ${JSON.stringify(mcpCalls)}`);
  }
  if (expect.mcpCalls) matches(expect.mcpCalls, mcpCalls, "mcpCalls", problems);
  for (const [rel, contents] of Object.entries(expect.workspace ?? {})) {
    const target = path.join(workspace, rel);
    const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
    if (actual !== contents) problems.push(`workspace/${rel}: expected ${JSON.stringify(contents)}, got ${JSON.stringify(actual)}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  if (problems.length === 0) {
    passed += 1;
    console.log(`  ok   - ${name}: ${fixture.description ?? ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${name}: ${fixture.description ?? ""}`);
    for (const p of problems) console.log(`         ${p}`);
    if (process.env.VERBOSE) {
      console.log("         --- stdout ---\n" + stdout.split("\n").map((l) => "         " + l).join("\n"));
      console.log("         --- stderr ---\n" + stderr.split("\n").map((l) => "         " + l).join("\n"));
    }
  }
}

const files = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort()
  .map((f) => path.join(FIXTURES, f));

console.log(`tasks/ai - ${files.length} fixture(s)`);
for (const file of files) {
  await runCase(file);
}
console.log(`-----\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
