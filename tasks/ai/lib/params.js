import fs from "fs";
import path from "path";
import Ajv from "ajv";
import { log, params as rawParams } from "@boomerang-io/task-core";
import { urlWithoutQuery } from "./telemetry.js";

/**
 * Param reading shared by the prompt and agent commands.
 *
 * Every param reaches the container as a string (PARAM_NAMES / PARAM_<NAME>, read by task-core), so
 * numbers, booleans and JSON are parsed here, and each failure names the param so the author can
 * act on it. Nothing here logs a value: a param may be a credential.
 */

/** Relative workspace paths resolve against the run workspace's conventional mount. */
export const WORKSPACE_ROOT = "/workspace";

/**
 * A failure the task author can act on. The reason is prefixed so it is greppable in a run log.
 */
export class TaskError extends Error {
  constructor(reason, message) {
    super(`${reason} - ${message}`);
    this.name = "TaskError";
    this.reason = reason;
  }
}

/**
 * The params as delivered. task-core returns undefined when neither param channel is present,
 * which is what running outside an executor looks like; a named missing param reads better than a
 * TypeError on the first destructure.
 */
export function readParams() {
  return rawParams ?? {};
}

/** A param counts as given when it is a non-empty string. Flow sends an unset optional as "". */
export function isSet(value) {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
}

export function requireParam(name, value) {
  if (!isSet(value)) {
    throw new TaskError("MISSING_PARAM", `the '${name}' param is required`);
  }
  return value;
}

const NUMBER = /^-?([0-9]+|[0-9]*\.[0-9]+)$/;
const INTEGER = /^-?[0-9]+$/;

export function asNumber(name, value) {
  if (!NUMBER.test(String(value).trim())) {
    throw new TaskError("INVALID_PARAM", `${name} must be a number, got '${value}'`);
  }
  return Number(value);
}

export function asInteger(name, value) {
  if (!INTEGER.test(String(value).trim())) {
    throw new TaskError("INVALID_PARAM", `${name} must be an integer, got '${value}'`);
  }
  return Number(value);
}

export function asBoolean(name, value) {
  const text = String(value).trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new TaskError("INVALID_PARAM", `${name} must be 'true' or 'false', got '${value}'`);
}

/**
 * A JSON-text param. `kind` is "object" or "array"; the error names the param and what it should
 * have been, never its value, so a secret that was wrongly pasted into one is not echoed.
 */
export function asJson(name, value, kind) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TaskError("INVALID_PARAM", `${name} must be a JSON ${kind}, but it is not valid JSON`);
  }
  const isArray = Array.isArray(parsed);
  const isObject = parsed !== null && typeof parsed === "object" && !isArray;
  if ((kind === "array" && !isArray) || (kind === "object" && !isObject)) {
    throw new TaskError("INVALID_PARAM", `${name} must be a JSON ${kind}, got ${describeJson(parsed)}`);
  }
  return parsed;
}

function describeJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * The `jsonSchema` param: a JSON Schema object as a string. It is compiled here, before any request,
 * so a schema the author got wrong fails as INVALID_PARAM rather than as the provider's 400 - and so
 * the reply can be checked against it on the way out, for providers that accept json_schema but do
 * not actually constrain decoding to it.
 */
export function asJsonSchema(value) {
  const schema = asJson("jsonSchema", value, "object");
  // strict: false - a schema written for a provider's structured-output dialect may carry keywords
  // Ajv's strict mode rejects; the provider is the authority on those, the check here is on shape.
  const ajv = new Ajv({ strict: false, allErrors: true });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    throw new TaskError("INVALID_PARAM", `jsonSchema is not a valid JSON Schema: ${e.message}`);
  }
  return { schema, validate, errorsText: (errors) => ajv.errorsText(errors) };
}

/** An absolute path as given; a relative one against the run workspace. */
export function workspacePath(value) {
  const trimmed = String(value).trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(WORKSPACE_ROOT, trimmed);
}

/** The contents of a workspace file named by a param, or FILE_NOT_READABLE naming both. */
export function readWorkspaceFile(name, value) {
  const file = workspacePath(value);
  try {
    if (!fs.statSync(file).isFile()) {
      throw new Error("not a file");
    }
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new TaskError(
      "FILE_NOT_READABLE",
      `the '${name}' param names '${file}', which is not a readable file on the workspace`,
    );
  }
}

/** Writes a workspace file named by a param, creating its directory; FILE_NOT_WRITABLE otherwise. */
export function writeWorkspaceFile(name, value, content) {
  const file = workspacePath(value);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  } catch (e) {
    throw new TaskError("FILE_NOT_WRITABLE", `the '${name}' param names '${file}', which could not be written: ${e.message}`);
  }
  return file;
}

/**
 * File context: each readable path is appended to the text as a fenced block under its own
 * heading, until the byte budget is spent. What did not fit is named, so the model is told the
 * context is partial rather than silently working from half of it.
 */
export function appendFileContext(text, files, maxContextBytes) {
  const paths = files
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(workspacePath);

  let content = text;
  let used = 0;
  const omitted = [];

  for (const file of paths) {
    let bytes;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        throw new Error("not a file");
      }
      fs.accessSync(file, fs.constants.R_OK);
      bytes = stat.size;
    } catch {
      throw new TaskError(
        "FILE_NOT_READABLE",
        `the 'files' param names '${file}', which is not a readable file on the workspace`,
      );
    }

    if (used + bytes > maxContextBytes) {
      omitted.push(file);
      continue;
    }
    used += bytes;
    content += `\n\n## ${file}\n\n\`\`\`\n${fs.readFileSync(file, "utf8")}\n\`\`\`\n`;
  }

  if (omitted.length) {
    content +=
      `\n\nNote: the file context above is truncated at ${maxContextBytes} bytes. ` +
      `These files were omitted: ${omitted.join(", ")}\n`;
    log.warn(`file context truncated at ${maxContextBytes} bytes; omitted: ${omitted.join(", ")}`);
  }
  log.sys(`appended ${used} bytes of file context`);

  return content;
}

const DEFAULT_MAX_CONTEXT_BYTES = 65536;

// A conservative per-image budget across providers; the provider stays the authority and rejects
// what it will not take with its own reason (REQUEST_REJECTED).
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_DETAILS = ["low", "high", "auto"];

// Anything that starts with a URI scheme is treated as a URL rather than a workspace path.
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The image type from the file's first bytes, not its name: PNG, JPEG, GIF or WEBP. */
function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/**
 * The `images` param as chat-completions image_url parts, in the order given. A workspace file is
 * size-checked, type-sniffed and sent inline as a data URL; an https URL is passed through for the
 * provider to fetch. Any other scheme is refused, so an image never travels inside a param.
 */
function imageParts(input) {
  const entries = isSet(input.images)
    ? input.images
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
    : [];
  const detail = isSet(input.imageDetail) ? input.imageDetail.trim() : undefined;
  if (detail !== undefined && !IMAGE_DETAILS.includes(detail)) {
    throw new TaskError("INVALID_PARAM", `imageDetail must be 'low', 'high' or 'auto', got '${input.imageDetail}'`);
  }
  if (entries.length === 0) {
    // Not a failure: an images value fed from an upstream result can legitimately be empty.
    if (detail !== undefined) {
      log.warn("imageDetail is set but images is empty, so imageDetail is ignored");
    }
    return [];
  }
  const maxImageBytes = asInteger("maxImageBytes", isSet(input.maxImageBytes) ? input.maxImageBytes : DEFAULT_MAX_IMAGE_BYTES);
  if (maxImageBytes < 1) {
    throw new TaskError("INVALID_PARAM", `maxImageBytes must be at least 1, got ${maxImageBytes}`);
  }

  return entries.map((entry) => {
    let url;
    if (URI_SCHEME.test(entry)) {
      let parsed;
      try {
        parsed = new URL(entry);
      } catch {
        throw new TaskError("INVALID_PARAM", `images has an entry that is not a valid URL: '${entry.slice(0, 80)}'`);
      }
      if (parsed.protocol !== "https:") {
        // The entry itself is not quoted: a data: URL would be the whole image.
        throw new TaskError(
          "INVALID_PARAM",
          `images entries must be workspace paths or https URLs, got a ${parsed.protocol} URL; put the image on the workspace instead`,
        );
      }
      url = entry;
      log.sys(`attaching image ${urlWithoutQuery(entry)} (URL, fetched by the provider)`);
    } else {
      const file = workspacePath(entry);
      let stat;
      try {
        stat = fs.statSync(file);
        if (!stat.isFile()) {
          throw new Error("not a file");
        }
      } catch {
        throw new TaskError("FILE_NOT_READABLE", `the 'images' param names '${file}', which is not a readable file on the workspace`);
      }
      if (stat.size > maxImageBytes) {
        throw new TaskError(
          "FILE_TOO_LARGE",
          `the 'images' param names '${file}', which is ${stat.size} bytes, over maxImageBytes=${maxImageBytes}`,
        );
      }
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        throw new TaskError("FILE_NOT_READABLE", `the 'images' param names '${file}', which is not a readable file on the workspace`);
      }
      const mime = sniffImage(bytes);
      if (!mime) {
        throw new TaskError("INVALID_PARAM", `the 'images' param names '${file}', which is not a PNG, JPEG, GIF or WEBP image`);
      }
      url = `data:${mime};base64,${bytes.toString("base64")}`;
      log.sys(`attaching image ${file} (${stat.size} bytes, ${mime})`);
    }
    return { type: "image_url", image_url: { url, ...(detail !== undefined ? { detail } : {}) } };
  });
}

function lastUserMessage(messages) {
  return [...messages].reverse().find((m) => m.role === "user");
}

/**
 * The conversation to send, from whichever source the author used:
 *
 * - `messages` or `messagesFile`: an exact [{role, content}] array, replacing systemPrompt and
 *   prompt (both are ignored with a warning if also given). Content may be a string or an array of
 *   chat-completions content parts ([{type: "text"}, {type: "image_url"}]); either goes through
 *   unchanged.
 * - otherwise `prompt` or `promptFile` as the user message, behind `systemPrompt` when non-empty.
 *
 * One source of each kind at most, and at least one of them. `files` are appended to the text of
 * the last user message and `images` are attached to it after that text. Without images, content
 * stays exactly what the source gave.
 */
export function resolveMessages(input) {
  const hasMessages = isSet(input.messages);
  const hasMessagesFile = isSet(input.messagesFile);
  const hasPrompt = isSet(input.prompt);
  const hasPromptFile = isSet(input.promptFile);

  if (hasMessages && hasMessagesFile) {
    throw new TaskError("INVALID_PARAM", "give messages or messagesFile, not both");
  }
  if (hasPrompt && hasPromptFile) {
    throw new TaskError("INVALID_PARAM", "give prompt or promptFile, not both");
  }

  let messages;
  if (hasMessages || hasMessagesFile) {
    const name = hasMessages ? "messages" : "messagesFile";
    const text = hasMessages ? input.messages : readWorkspaceFile("messagesFile", input.messagesFile);
    messages = asJson(name, text, "array").map((m, i) => {
      if (m === null || typeof m !== "object" || typeof m.role !== "string" || m.content === undefined || m.content === null) {
        throw new TaskError("INVALID_PARAM", `${name}[${i}] must be an object with a string role and a content`);
      }
      return m;
    });
    if (messages.length === 0) {
      throw new TaskError("INVALID_PARAM", `${name} must not be empty`);
    }
    if (hasPrompt || hasPromptFile || isSet(input.systemPrompt)) {
      log.warn(`${name} is given, so systemPrompt and prompt are ignored`);
    }
  } else if (hasPrompt || hasPromptFile) {
    const content = hasPrompt ? input.prompt : readWorkspaceFile("promptFile", input.promptFile);
    messages = [
      ...(isSet(input.systemPrompt) ? [{ role: "system", content: input.systemPrompt }] : []),
      { role: "user", content },
    ];
  } else {
    throw new TaskError("MISSING_PARAM", "one of prompt, promptFile, messages or messagesFile is required");
  }

  if (isSet(input.files)) {
    const maxContextBytes = asInteger(
      "maxContextBytes",
      isSet(input.maxContextBytes) ? input.maxContextBytes : DEFAULT_MAX_CONTEXT_BYTES,
    );
    const last = lastUserMessage(messages);
    if (!last) {
      throw new TaskError("INVALID_PARAM", "files needs a user message to append to");
    }
    if (typeof last.content === "string") {
      last.content = appendFileContext(last.content, input.files, maxContextBytes);
    } else if (Array.isArray(last.content)) {
      // Content parts: the files go on the last text part, or on a text part of their own.
      const textPart = [...last.content].reverse().find((part) => part?.type === "text" && typeof part.text === "string");
      if (textPart) {
        textPart.text = appendFileContext(textPart.text, input.files, maxContextBytes);
      } else {
        last.content = [...last.content, { type: "text", text: appendFileContext("", input.files, maxContextBytes).trimStart() }];
      }
    } else {
      throw new TaskError("INVALID_PARAM", "files needs the last user message's content to be text or content parts");
    }
  }

  const images = imageParts(input);
  if (images.length) {
    const last = lastUserMessage(messages);
    if (!last) {
      throw new TaskError("INVALID_PARAM", "images needs a user message to attach to");
    }
    if (typeof last.content === "string") {
      last.content = [{ type: "text", text: last.content }, ...images];
    } else if (Array.isArray(last.content)) {
      last.content = [...last.content, ...images];
    } else {
      throw new TaskError("INVALID_PARAM", "images needs the last user message's content to be text or content parts");
    }
  }

  return messages;
}
