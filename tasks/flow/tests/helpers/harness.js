import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The integration-command test harness: a recording HTTP server standing in for each service, and
 * a runner that executes one command export in its own process the way the dispatcher does, with
 * its params as PARAM_* variables and its results read back from a RESULTS_PATH file.
 */

const runnerPath = fileURLToPath(new URL("./run-command.js", import.meta.url));

/** Turns { name: value } task params into the PARAM_NAMES / PARAM_<NAME> env vars task-core resolves them from. */
export function paramEnv(values) {
  const env = { PARAM_NAMES: Object.keys(values).join(",") };
  for (const [name, value] of Object.entries(values)) {
    env["PARAM_" + name.toUpperCase().replace(/[^A-Za-z0-9_]/g, "_")] = String(value);
  }
  return env;
}

/**
 * Starts a server whose `handler(req)` gets { method, url, path, query, headers, body (Buffer), text, json }
 * and returns { status, headers, body } (an object body is sent as JSON). Every request is kept in `requests`.
 */
export async function mockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://localhost");
      const text = body.toString("utf8");
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const record = { method: req.method, url: req.url, path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), headers: req.headers, body, text, json };
      requests.push(record);
      let reply;
      try {
        reply = (await handler(record, requests.length)) ?? { status: 404, body: { message: "no mock for " + req.method + " " + req.url } };
      } catch (e) {
        reply = { status: 500, body: { message: e.message } };
      }
      const isObject = reply.body !== undefined && !Buffer.isBuffer(reply.body) && typeof reply.body !== "string";
      const payload = isObject ? JSON.stringify(reply.body) : reply.body ?? "";
      res.writeHead(reply.status ?? 200, { ...(isObject ? { "Content-Type": "application/json" } : {}), ...(reply.headers ?? {}) });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Runs `<module> <command>` with the params; resolves { code, stdout, stderr, output, results }.
 * `env` adds environment variables, e.g. MICROSOFT_GRAPH_URL or NODE_OPTIONS for a hook.
 */
export function runCommand(moduleName, command, values, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-flow-results-"));
  const resultsPath = path.join(dir, "termination-log");
  fs.writeFileSync(resultsPath, "");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, moduleName, command], {
      // NODE_ENV=test would send results to tests/results; the file target is what Kubernetes Jobs use.
      env: { ...process.env, NODE_ENV: "", HTTP_PROXY: "", HTTPS_PROXY: "", RESULTS_PATH: resultsPath, ...paramEnv(values), ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      const raw = fs.readFileSync(resultsPath, "utf8");
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, output: stdout + stderr, results: raw ? JSON.parse(raw) : {} });
    });
  });
}

/** A fresh temp directory for one test's workspace files. */
export function tempDir(prefix = "task-flow-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
