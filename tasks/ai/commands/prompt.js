import fs from "fs";
import OpenAI from "openai";
import Ajv from "ajv";
import { log, params, results } from "@boomerang-io/task-core";

/**
 * One chat completion against an OpenAI-compatible endpoint.
 *
 * Inputs arrive as PARAM_NAMES/PARAM_<NAME> environment variables and results are written to
 * RESULTS_PATH - a directory on Tekton, a single JSON file on Kubernetes Jobs and Docker. Both are
 * the platform's documented task contract (CONTRIBUTING_TASKS.md) and both are read and written by
 * @boomerang-io/task-core. The token is never logged: it is handed to the SDK and nothing prints
 * it, including the failure paths, which carry the provider's reason but never the request headers.
 *
 * The chat-completions shape is the one the practical field speaks directly - OpenAI, OpenRouter,
 * LiteLLM, Azure AI Foundry, Ollama, vLLM, Groq, Together, and Anthropic through its own
 * OpenAI-compatible endpoint - so a plain `endpoint` param reaches all of them with no gateway and
 * no provider switch.
 */

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_RESPONSE_FORMAT = "text";
const DEFAULT_MAX_CONTEXT_BYTES = 65536;

// Three attempts in total, the SDK retrying 429, 5xx and transport failures on its own backoff.
// Any other 4xx is the request itself being wrong and will be wrong again, so it is not retried.
const MAX_ATTEMPTS = 3;

// How much of a provider's error body to quote. Enough to carry its reason, not enough to fill the
// log with a stack of HTML from a proxy that answered instead of the endpoint.
const ERROR_BODY_CHARS = 512;

// How much of a rejected completion to quote when responseFormat=json and the model did not return
// JSON. Enough to see what it said instead, without printing a whole essay into the pod log.
const INVALID_RESPONSE_CHARS = 200;

// A Markdown code fence around the whole reply, with or without a language tag: "```json\n{...}\n```".
// Some models (gemini-2.5-flash-lite through OpenRouter, for one) wrap their JSON in one now and
// then even under json_object mode and a prompt that forbids it.
const CODE_FENCE = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

// The name the schema is sent under in response_format.json_schema. Providers require one; nothing
// downstream reads it.
const JSON_SCHEMA_NAME = "output";

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

const isNumber = (value) => /^-?([0-9]+|[0-9]*\.[0-9]+)$/.test(value);
const isInteger = (value) => /^-?[0-9]+$/.test(value);

function requireParam(name, value) {
  if (!value) {
    throw new TaskError("MISSING_PARAM", `the '${name}' param is required`);
  }
  return value;
}

function asNumber(name, value) {
  if (!isNumber(value)) {
    throw new TaskError("INVALID_PARAM", `${name} must be a number, got '${value}'`);
  }
  return Number(value);
}

function asInteger(name, value) {
  if (!isInteger(value)) {
    throw new TaskError("INVALID_PARAM", `${name} must be an integer, got '${value}'`);
  }
  return Number(value);
}

/**
 * The `jsonSchema` param: a JSON Schema object as a string. It is compiled here, before any request,
 * so a schema the author got wrong fails as INVALID_PARAM rather than as the provider's 400 - and so
 * the reply can be checked against it on the way out, for providers that accept json_schema but do
 * not actually constrain decoding to it.
 */
function asJsonSchema(value) {
  let schema;
  try {
    schema = JSON.parse(value);
  } catch {
    throw new TaskError("INVALID_PARAM", "jsonSchema must be a JSON Schema object, but it is not valid JSON");
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TaskError("INVALID_PARAM", "jsonSchema must be a JSON Schema object, got a non-object");
  }
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

/**
 * File context: each readable path is appended to the user message as a fenced block under its own
 * heading, until the byte budget is spent. What did not fit is named in the prompt, so the model is
 * told the context is partial rather than silently working from half of it.
 */
function appendFileContext(prompt, files, maxContextBytes) {
  const paths = files
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");

  let content = prompt;
  let used = 0;
  const omitted = [];

  for (const path of paths) {
    let bytes;
    try {
      fs.accessSync(path, fs.constants.R_OK);
      const stat = fs.statSync(path);
      if (!stat.isFile()) {
        throw new Error("not a file");
      }
      bytes = stat.size;
    } catch {
      throw new TaskError(
        "FILE_NOT_READABLE",
        `the 'files' param names '${path}', which is not a readable file on the workspace`,
      );
    }

    if (used + bytes > maxContextBytes) {
      omitted.push(path);
      continue;
    }
    used += bytes;
    content += `\n\n## ${path}\n\n\`\`\`\n${fs.readFileSync(path, "utf8")}\n\`\`\`\n`;
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

/**
 * The provider's reason for refusing, without the request that carried the token.
 */
function errorBody(error) {
  const body = error.error ?? error.message;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return (text ?? "").slice(0, ERROR_BODY_CHARS);
}

/**
 * The reply with a surrounding code fence removed, if it has one; otherwise the reply as it came,
 * trimmed. Only a fence around the whole reply is recognised: JSON buried inside prose is left
 * alone, so the strict check below still fails it rather than guessing at braces.
 */
export function unfence(text) {
  const trimmed = text.trim();
  const fenced = CODE_FENCE.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function failedRequest(url, error) {
  // No status: the endpoint was never reached. The SDK has already used every attempt.
  if (error.status === undefined) {
    return new TaskError("REQUEST_FAILED", `could not reach ${url} after ${MAX_ATTEMPTS} attempts: ${error.message}`);
  }
  if (error.status === 429 || error.status >= 500) {
    return new TaskError(
      "REQUEST_FAILED",
      `${url} returned HTTP ${error.status} on all ${MAX_ATTEMPTS} attempts: ${errorBody(error)}`,
    );
  }
  return new TaskError("REQUEST_REJECTED", `${url} returned HTTP ${error.status}: ${errorBody(error)}`);
}

export async function run() {
  //
  // Inputs
  //
  // task-core returns undefined when neither param channel is present - no PARAM_NAMES and no
  // /params - which is what running outside an executor looks like. A named missing param reads
  // better than a TypeError on the first destructure.
  const input = params ?? {};

  const endpoint = requireParam("endpoint", input.endpoint);
  const token = requireParam("token", input.token);
  const model = requireParam("model", input.model);
  const prompt = requireParam("prompt", input.prompt);
  const systemPrompt = input.systemPrompt ?? "";
  const temperature = asNumber("temperature", input.temperature || DEFAULT_TEMPERATURE);
  const maxTokens = asInteger("maxTokens", input.maxTokens || DEFAULT_MAX_TOKENS);
  const responseFormat = input.responseFormat || DEFAULT_RESPONSE_FORMAT;
  const maxContextBytes = asInteger("maxContextBytes", input.maxContextBytes || DEFAULT_MAX_CONTEXT_BYTES);
  const seed = input.seed ? asInteger("seed", input.seed) : undefined;
  const files = input.files ?? "";

  if (responseFormat !== "text" && responseFormat !== "json") {
    throw new TaskError("INVALID_PARAM", `responseFormat must be 'text' or 'json', got '${responseFormat}'`);
  }
  const jsonSchema = input.jsonSchema ? asJsonSchema(input.jsonSchema) : undefined;
  if (jsonSchema && responseFormat !== "json") {
    throw new TaskError("INVALID_PARAM", `jsonSchema requires responseFormat=json, got '${responseFormat}'`);
  }

  const content = files ? appendFileContext(prompt, files, maxContextBytes) : prompt;

  //
  // Request
  //
  const baseURL = endpoint.replace(/\/+$/, "");
  const url = `${baseURL}/chat/completions`;
  const client = new OpenAI({ apiKey: token, baseURL, maxRetries: MAX_ATTEMPTS - 1 });

  const body = {
    model,
    messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content }],
    temperature,
    // max_tokens rather than max_completion_tokens: it is what the compatible endpoints accept.
    max_tokens: maxTokens,
    // json_schema with strict decoding where a schema is given, so a conforming provider cannot
    // return a fence or a stray key; json_object otherwise.
    ...(jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { name: JSON_SCHEMA_NAME, strict: true, schema: jsonSchema.schema } } }
      : responseFormat === "json"
        ? { response_format: { type: "json_object" } }
        : {}),
    ...(seed !== undefined ? { seed } : {}),
  };

  log.sys(
    `POST ${url} (model=${model}, responseFormat=${responseFormat}${jsonSchema ? "+schema" : ""}, maxTokens=${maxTokens})`,
  );

  let completion;
  try {
    completion = await client.chat.completions.create(body);
  } catch (e) {
    throw failedRequest(url, e);
  }

  //
  // Response
  //
  const choice = completion?.choices?.[0];
  if (choice?.message?.content === undefined || choice.message.content === null) {
    throw new TaskError(
      "NO_COMPLETION",
      `the response carried no choices[0].message.content: ${JSON.stringify(completion).slice(0, ERROR_BODY_CHARS)}`,
    );
  }

  let output = choice.message.content;
  if (responseFormat === "json") {
    // Strip a code fence the model wrapped its JSON in, and hand downstream the bare JSON rather
    // than the fenced text. Anything else that is not JSON still fails the task.
    const candidate = unfence(output);
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      log.warn(
        `responseFormat=json but the model returned content that is not JSON; ` +
          `the first ${INVALID_RESPONSE_CHARS} chars were: ${JSON.stringify(output.slice(0, INVALID_RESPONSE_CHARS))}`,
      );
      throw new TaskError("INVALID_RESPONSE", "responseFormat=json but the model returned content that is not JSON");
    }
    // The schema is checked here too, not only trusted to the provider: a provider that accepts
    // json_schema without constraining decoding to it would otherwise hand downstream a shape it
    // did not promise.
    if (jsonSchema && !jsonSchema.validate(parsed)) {
      const why = jsonSchema.errorsText(jsonSchema.validate.errors);
      log.warn(
        `the model's JSON does not match jsonSchema (${why}); ` +
          `the first ${INVALID_RESPONSE_CHARS} chars were: ${JSON.stringify(output.slice(0, INVALID_RESPONSE_CHARS))}`,
      );
      throw new TaskError("INVALID_RESPONSE", `the model's JSON does not match jsonSchema: ${why}`);
    }
    if (candidate !== output.trim()) {
      log.sys("stripped a code fence from the JSON completion");
    }
    output = candidate;
  }

  const usage = completion.usage ?? {};
  const finishReason = choice.finish_reason ?? "";
  // The model as served, which may be more specific than the one asked for.
  const servedModel = completion.model ?? "";

  await results({
    output,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    finishReason,
    model: servedModel,
  });

  log.good(
    `completed: ${output.length} chars, ${usage.total_tokens ?? 0} tokens, ` +
      `finishReason=${finishReason}, model=${servedModel}`,
  );
}
