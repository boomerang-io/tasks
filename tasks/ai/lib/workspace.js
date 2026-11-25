import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { TaskError, asInteger, isSet, workspacePath } from "./params.js";

/**
 * The agent's built-in workspace tools: read, edit, write and bash, each confined to `workdir`, a
 * directory of the run workspace. A node enables them by name in `workspaceTools`; none is on by
 * default, and one the node did not enable is never offered to the model.
 *
 * Confinement: every path is resolved against workdir and refused when its real location (symlinks
 * followed, the nearest existing ancestor for a file not written yet) is outside workdir's. bash
 * runs with workdir as its working directory, in its own process group, with the run's
 * credentials taken out of its environment.
 *
 * A tool's failure (a refused path, an edit that does not match, a command that times out) is
 * handed back to the model as the tool's result, so it can adapt; it does not fail the run.
 */

export const WORKSPACE_TOOLS = ["read", "edit", "write", "bash"];

export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;
const MAX_BASH_TIMEOUT_SECONDS = 3600;
// What one tool result may hand back to the model: beyond it, the head and tail are kept.
export const TOOL_OUTPUT_LIMIT = 32 * 1024;
// read's default page, in lines.
const READ_LINES = 2000;

// The run's credentials and channels, which a command the model writes must not see.
const SCRUBBED_ENV = /^(PARAM_|OPENAI_|OTEL_EXPORTER_OTLP_(TRACES_)?HEADERS$|RESULTS_PATH$|RESULTS_MAX_BYTES$)/;

const DEFINITIONS = {
  read: {
    description:
      "Read a text file in the working directory. Returns its lines; use offset and limit to page through a long file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, relative to the working directory" },
        offset: { type: "integer", description: "The first line to return, from 1. Default 1" },
        limit: { type: "integer", description: `How many lines to return. Default ${READ_LINES}` },
      },
      required: ["path"],
    },
  },
  edit: {
    description:
      "Replace text in a file in the working directory. old must occur in the file exactly once; include enough surrounding text to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, relative to the working directory" },
        old: { type: "string", description: "The exact text to replace" },
        new: { type: "string", description: "The text to put in its place" },
      },
      required: ["path", "old", "new"],
    },
  },
  write: {
    description: "Create or overwrite a file in the working directory with the given content. Parent directories are created.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, relative to the working directory" },
        content: { type: "string", description: "The whole content of the file" },
      },
      required: ["path", "content"],
    },
  },
  bash: {
    description:
      "Run a shell command in the working directory, for example the project's build or tests. Returns the exit code, stdout and stderr (long output keeps its head and tail).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, run with bash -c" },
        timeoutSeconds: { type: "integer", description: "A shorter time limit for this command, in seconds" },
      },
      required: ["command"],
    },
  },
};

/** The workspace params, checked: the enabled tools, workdir's real path, and bash's time limit. */
export function readWorkspaceParams(input) {
  const tools = parseToolList(input.workspaceTools);
  const bashTimeoutSeconds = isSet(input.bashTimeoutSeconds)
    ? asInteger("bashTimeoutSeconds", input.bashTimeoutSeconds)
    : DEFAULT_BASH_TIMEOUT_SECONDS;
  if (bashTimeoutSeconds < 1 || bashTimeoutSeconds > MAX_BASH_TIMEOUT_SECONDS) {
    throw new TaskError("INVALID_PARAM", `bashTimeoutSeconds must be from 1 to ${MAX_BASH_TIMEOUT_SECONDS}, got ${bashTimeoutSeconds}`);
  }
  if (!tools.length) {
    return { tools, workdir: undefined, bashTimeoutSeconds };
  }
  if (!isSet(input.workdir)) {
    throw new TaskError("MISSING_PARAM", `workdir is required when workspaceTools enables ${tools.join(", ")}`);
  }
  const given = workspacePath(input.workdir);
  let workdir;
  try {
    workdir = fs.realpathSync(given);
  } catch {
    throw new TaskError("INVALID_PARAM", `workdir ${given} does not exist`);
  }
  if (!fs.statSync(workdir).isDirectory()) {
    throw new TaskError("INVALID_PARAM", `workdir ${given} is not a directory`);
  }
  return { tools, workdir, bashTimeoutSeconds };
}

/** workspaceTools as a JSON array or a comma-separated list; blank is none. */
function parseToolList(value) {
  if (!isSet(value)) {
    return [];
  }
  const text = String(value).trim();
  let names;
  if (text.startsWith("[")) {
    try {
      names = JSON.parse(text);
    } catch {
      throw new TaskError("INVALID_PARAM", "workspaceTools is not a valid JSON array");
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
      throw new TaskError("INVALID_PARAM", "workspaceTools must be an array of tool names");
    }
  } else {
    names = text.split(",");
  }
  names = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const unknown = names.filter((n) => !WORKSPACE_TOOLS.includes(n));
  if (unknown.length) {
    throw new TaskError("INVALID_PARAM", `workspaceTools names ${unknown.join(", ")}; the workspace tools are ${WORKSPACE_TOOLS.join(", ")}`);
  }
  return names;
}

/** Chat-completions function definitions for the given workspace tools. */
export function workspaceDefinitions(names) {
  return names.map((name) => ({ type: "function", function: { name, ...DEFINITIONS[name] } }));
}

/** A tool failure for the model: its message becomes the tool result. */
class ToolRefusal extends Error {}

function within(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * The real path a tool may act on, or a ToolRefusal. A path that does not exist yet is checked by
 * its nearest existing ancestor, so a write cannot leave workdir through a symlinked directory.
 */
function confine(workdir, given) {
  if (typeof given !== "string" || given.trim() === "") {
    throw new ToolRefusal("path is required");
  }
  const target = path.resolve(workdir, given);
  let existing = target;
  const missing = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const real = path.join(fs.realpathSync(existing), ...missing);
  if (!within(workdir, real)) {
    throw new ToolRefusal(`${given} is outside the working directory`);
  }
  return real;
}

/** Keeps the head and tail of text longer than the limit, saying how much was left out. */
export function clip(text, limit = TOOL_OUTPUT_LIMIT) {
  if (Buffer.byteLength(text) <= limit) {
    return text;
  }
  const half = Math.floor(limit / 2);
  const head = Buffer.from(text).subarray(0, half).toString("utf8");
  const tail = Buffer.from(text).subarray(-half).toString("utf8");
  const omitted = Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return `${head}\n[... ${omitted} bytes omitted ...]\n${tail}`;
}

function readTool(workdir, args) {
  const file = confine(workdir, args.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new ToolRefusal(`${args.path} is not a file`);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const offset = Math.max(1, Number.isInteger(args.offset) ? args.offset : 1);
  const limit = Math.max(1, Number.isInteger(args.limit) ? args.limit : READ_LINES);
  const page = lines.slice(offset - 1, offset - 1 + limit).join("\n");
  const last = Math.min(lines.length, offset - 1 + limit);
  const note = offset > 1 || last < lines.length ? `[lines ${offset}-${last} of ${lines.length}]\n` : "";
  return note + page;
}

function editTool(workdir, args) {
  const file = confine(workdir, args.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new ToolRefusal(`${args.path} is not a file`);
  }
  if (typeof args.old !== "string" || args.old === "" || typeof args.new !== "string") {
    throw new ToolRefusal("old (non-empty) and new must be strings");
  }
  const text = fs.readFileSync(file, "utf8");
  const count = text.split(args.old).length - 1;
  if (count !== 1) {
    throw new ToolRefusal(`old occurs ${count} times in ${args.path}; it must occur exactly once`);
  }
  const index = text.indexOf(args.old);
  fs.writeFileSync(file, text.slice(0, index) + args.new + text.slice(index + args.old.length));
  return `edited ${args.path}`;
}

function writeTool(workdir, args) {
  const file = confine(workdir, args.path);
  if (typeof args.content !== "string") {
    throw new ToolRefusal("content must be a string");
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    throw new ToolRefusal(`${args.path} is a directory`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, args.content);
  return `wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`;
}

/** The environment a command runs with: the container's, without the run's credentials and channels. */
export function commandEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SCRUBBED_ENV.test(key)));
}

function bashTool(workdir, args, limitSeconds) {
  if (typeof args.command !== "string" || args.command.trim() === "") {
    throw new ToolRefusal("command is required");
  }
  const asked = Number.isInteger(args.timeoutSeconds) && args.timeoutSeconds > 0 ? args.timeoutSeconds : limitSeconds;
  const seconds = Math.min(asked, limitSeconds);
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", args.command], { cwd: workdir, env: commandEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Collected up to twice the limit, so clip() still has a head and a tail to keep.
    const take = (sofar, chunk) => (sofar.length < TOOL_OUTPUT_LIMIT * 2 ? sofar + chunk : sofar);
    child.stdout.on("data", (d) => (stdout = take(stdout, d.toString())));
    child.stderr.on("data", (d) => (stderr = take(stderr, d.toString())));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, seconds * 1000);
    const finish = (code, error) => {
      clearTimeout(timer);
      const status = timedOut ? `timed out after ${seconds}s and was killed` : error ? `could not start: ${error.message}` : `exit code ${code}`;
      const text = clip(`${status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      resolve({ text, isError: timedOut || Boolean(error) || code !== 0, timedOut });
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Runs one workspace tool call. Resolves { text, isError, timedOut? }; a refusal is a result the
 * model sees, not a thrown error.
 */
export async function callWorkspaceTool(workspace, name, args, remainingSeconds) {
  try {
    switch (name) {
      case "read":
        return { text: clip(readTool(workspace.workdir, args)), isError: false };
      case "edit":
        return { text: editTool(workspace.workdir, args), isError: false };
      case "write":
        return { text: writeTool(workspace.workdir, args), isError: false };
      case "bash":
        return await bashTool(workspace.workdir, args, Math.max(1, Math.min(workspace.bashTimeoutSeconds, remainingSeconds)));
      default:
        throw new ToolRefusal(`${name} is not a workspace tool`);
    }
  } catch (e) {
    if (e instanceof ToolRefusal || e.code) {
      return { text: `ERROR: ${e.message}`, isError: true };
    }
    throw e;
  }
}
