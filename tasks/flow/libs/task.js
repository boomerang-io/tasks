import { log } from "@boomerang-io/task-core";
import { HttpsProxyAgent } from "https-proxy-agent";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

/**
 * Shared plumbing for the integration commands (GitHub pipeline, Teams, SharePoint, Google Drive,
 * Artifactory): param checks, the run wrapper, error text that never carries a credential, and
 * the workspace and result-size rules.
 */

/** A failure whose message is written for the user and safe to log as-is. */
export class TaskError extends Error {}

// What one result may hold. Kubernetes caps a termination message at 4096 bytes for all results together.
export const RESULT_BUDGET = 3000;

// A relative path names a workspace under /workspace (workflowrun/..., workflow/...), the parent of every default mount.
const WORKSPACE_ROOT = "/workspace";

/**
 * Runs one command body. The task CLI does not await a command, so a rejection would otherwise end
 * the process with exit code 0: every failure is logged here and exits 1.
 */
export async function run(name, fn) {
  log.debug(`Started ${name}`);
  try {
    await fn();
  } catch (e) {
    log.err(`${name} failed:`, describeError(e));
    process.exit(1);
  }
  log.debug(`Finished ${name}`);
}

/**
 * The text for a failure: the status and the service's own error message. Never the error object
 * itself, since an HTTP client error carries the request config, headers and all.
 */
export function describeError(e) {
  if (e instanceof TaskError) {
    return e.message;
  }
  const status = e?.response?.status ?? e?.status;
  if (status) {
    const detail = serviceMessage(e.response?.data);
    return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  }
  return e?.message ?? String(e);
}

/** The message a service put in its error body, in the shapes GitHub, Graph, Entra, Google and JFrog use. */
export function serviceMessage(data) {
  if (data === undefined || data === null || data === "") {
    return "";
  }
  if (typeof data.pipe === "function") {
    return "";
  }
  if (typeof data === "string") {
    return data.slice(0, 500);
  }
  if (data.error_description) {
    return String(data.error_description).split("\r\n")[0];
  }
  if (data.error && typeof data.error === "object") {
    // Graph and Workflows give a string code; Google a numeric one, with the name in status.
    const code = typeof data.error.code === "string" ? data.error.code : data.error.status;
    return [code, data.error.message].filter(Boolean).join(": ");
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    const details = data.errors.map((err) => (typeof err === "string" ? err : err.message ?? err.code ?? JSON.stringify(err)));
    return [data.message, ...details].filter(Boolean).join("; ");
  }
  if (data.message) {
    return String(data.message);
  }
  return JSON.stringify(data).slice(0, 500);
}

/** Fails with every missing name at once; an empty string counts as missing. */
export function required(values, names) {
  const missing = names.filter((name) => values[name] === undefined || values[name] === null || String(values[name]).trim() === "");
  if (missing.length) {
    throw new TaskError(`Missing required param${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }
}

/** A boolean param, which arrives as a string; blank gives the fallback. */
export function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return String(value).trim().toLowerCase() === "true";
}

/** A whole-number param; blank gives undefined. */
export function asInteger(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const number = Number(String(value).trim());
  if (!Number.isInteger(number)) {
    throw new TaskError(`${name} must be a whole number, got '${value}'`);
  }
  return number;
}

/** A list param: comma- or newline-separated; blank gives undefined. */
export function asList(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const items = String(value)
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** A JSON-object param; blank gives undefined. The parse error is not echoed, since the text may hold a secret. */
export function asJsonObject(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TaskError(`${name} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TaskError(`${name} must be a JSON object`);
  }
  return parsed;
}

/** Absolute paths are used as-is; a relative one resolves against /workspace. */
export function resolvePath(taskPath) {
  return path.isAbsolute(taskPath) ? taskPath : path.resolve(WORKSPACE_ROOT, taskPath);
}

/** The file a download lands in: inside `destination` when it is a directory (or ends with /), else `destination` itself. */
export function destinationFile(destination, fileName) {
  const resolved = resolvePath(destination);
  const isDirectory = /[\\/]$/.test(destination) || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory());
  return isDirectory ? path.join(resolved, fileName) : resolved;
}

/**
 * Streams a download to `target` through a temp file beside it, hashing as it goes, so a failed or
 * corrupt transfer never leaves a partial file in place. Returns { size, sha256 }.
 */
export async function writeStream(stream, target, expectedSha256) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.part`);
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      stream,
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      fs.createWriteStream(temp),
    );
    const sha256 = hash.digest("hex");
    if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
      throw new TaskError(`Checksum mismatch: the server says sha256 ${expectedSha256.toLowerCase()}, the download is ${sha256}`);
    }
    fs.renameSync(temp, target);
    return { size, sha256 };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** The SHA-256 of a local file, read as a stream. */
export async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** An existing, regular file for an upload, or a TaskError naming the param. */
export function sourceFile(taskPath, name) {
  const resolved = resolvePath(taskPath);
  if (!fs.existsSync(resolved)) {
    throw new TaskError(`${name} does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new TaskError(`${name} is not a file: ${resolved}`);
  }
  return resolved;
}

/**
 * The value for a variable-size result: kept when it fits in RESULT_BUDGET, else undefined. Without
 * an output file to fall back on, data too large for a result fails instead of being cut short.
 */
export function fitResult(text, what, outputFile) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= RESULT_BUDGET) {
    return text;
  }
  if (!outputFile) {
    throw new TaskError(`${what} is ${bytes} bytes, more than a task result can carry (${RESULT_BUDGET}); set outputFile to write it to the workspace instead`);
  }
  log.sys(`${what} is ${bytes} bytes, too large for a result: it is in ${resolvePath(outputFile)} only`);
  return undefined;
}

/** Writes data to a workspace file, creating its directory. Returns the absolute path. */
export function writeOutputFile(outputFile, data) {
  const target = resolvePath(outputFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  log.good(`Wrote ${Buffer.byteLength(data)} bytes to ${target}`);
  return target;
}

/** The HTTP_PROXY agent, the way the other commands use it; undefined when no proxy is set. */
export function proxyAgent() {
  if (!process.env.HTTP_PROXY) {
    return undefined;
  }
  log.debug("Using Proxy", process.env.HTTP_PROXY);
  return new HttpsProxyAgent(process.env.HTTP_PROXY);
}

/** axios options for the proxy: the agent when HTTP_PROXY is set, and axios's own env proxy off so it is not applied twice. */
export function proxyOptions() {
  const agent = proxyAgent();
  return agent ? { httpsAgent: agent, proxy: false } : {};
}
