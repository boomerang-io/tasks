import OpenAI from "openai";
import { log } from "@boomerang-io/task-core";
import { TaskError, asInteger, asJson, asJsonSchema, asNumber, isSet } from "./params.js";
import { KIND, captureContent, redactMessages } from "./telemetry.js";

/**
 * The chat-completions request and reply, shared by the prompt and agent commands.
 *
 * The chat-completions shape is the one the practical field speaks directly - OpenAI, OpenRouter,
 * LiteLLM, Azure AI Foundry, Ollama, vLLM, Groq, Together, and Anthropic through its own
 * OpenAI-compatible endpoint - so a plain `endpoint` reaches all of them with no gateway and no
 * provider switch.
 */

// Three attempts in total, the SDK retrying 429, 5xx and transport failures on its own backoff.
// Any other 4xx is the request itself being wrong and will be wrong again, so it is not retried.
export const MAX_ATTEMPTS = 3;

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

// A reasoning model's thinking, when the endpoint leaves it inline ahead of the answer.
const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/i;

// The name the schema is sent under in response_format.json_schema. Providers require one; nothing
// downstream reads it.
const JSON_SCHEMA_NAME = "output";

// The environment the executor may hand a container when the task's own endpoint and token params
// are blank. The openai SDK reads the same two names on its own; they are resolved here so that an
// explicit param always wins and a missing one is named.
const ENV_BASE_URL = "OPENAI_BASE_URL";
const ENV_API_KEY = "OPENAI_API_KEY";

/**
 * Where to send the request and with what credential: the task's params first, the executor's
 * environment when they are blank.
 */
export function resolveConnection(input, env = process.env) {
  const endpoint = isSet(input.endpoint) ? input.endpoint : env[ENV_BASE_URL];
  const token = isSet(input.token) ? input.token : env[ENV_API_KEY];
  if (!isSet(endpoint)) {
    throw new TaskError("MISSING_PARAM", `the 'endpoint' param is required when the executor sets no ${ENV_BASE_URL}`);
  }
  if (!isSet(token)) {
    throw new TaskError("MISSING_PARAM", `the 'token' param is required when the executor sets no ${ENV_API_KEY}`);
  }
  const baseURL = endpoint.trim().replace(/\/+$/, "");
  return {
    baseURL,
    url: `${baseURL}/chat/completions`,
    client: new OpenAI({ apiKey: token, baseURL, maxRetries: MAX_ATTEMPTS - 1 }),
  };
}

/**
 * The sampling and output-shape params. Each convenience param is sent only when set, so a blank
 * one leaves the provider's default in place (newer reasoning models reject any other temperature,
 * and max_tokens altogether). `parameters` is an open map merged last, so its keys win.
 */
export function readSampling(input) {
  const responseFormat = isSet(input.responseFormat) ? input.responseFormat.trim() : "text";
  if (responseFormat !== "text" && responseFormat !== "json") {
    throw new TaskError("INVALID_PARAM", `responseFormat must be 'text' or 'json', got '${input.responseFormat}'`);
  }
  const jsonSchema = isSet(input.jsonSchema) ? asJsonSchema(input.jsonSchema) : undefined;
  if (jsonSchema && responseFormat !== "json") {
    throw new TaskError("INVALID_PARAM", `jsonSchema requires responseFormat=json, got '${responseFormat}'`);
  }
  return {
    temperature: isSet(input.temperature) ? asNumber("temperature", input.temperature) : undefined,
    maxTokens: isSet(input.maxTokens) ? asInteger("maxTokens", input.maxTokens) : undefined,
    seed: isSet(input.seed) ? asInteger("seed", input.seed) : undefined,
    parameters: isSet(input.parameters) ? asJson("parameters", input.parameters, "object") : {},
    responseFormat,
    jsonSchema,
  };
}

/**
 * The request body. Order matters only for what `parameters` overrides: it is merged last, and a
 * max_completion_tokens in it suppresses max_tokens rather than sending both.
 */
export function buildRequestBody({ model, messages, sampling, tools, parallelToolCalls }) {
  const { temperature, maxTokens, seed, parameters, responseFormat, jsonSchema } = sampling;
  const body = {
    model,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
    // max_tokens rather than max_completion_tokens: it is what the compatible endpoints accept.
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(seed !== undefined ? { seed } : {}),
    // json_schema with strict decoding where a schema is given, so a conforming provider cannot
    // return a fence or a stray key; json_object otherwise.
    ...(jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { name: JSON_SCHEMA_NAME, strict: true, schema: jsonSchema.schema } } }
      : responseFormat === "json"
        ? { response_format: { type: "json_object" } }
        : {}),
    ...(tools && tools.length ? { tools } : {}),
    // Sent only as false and only with tools: OpenAI rejects the key on a request with no tools,
    // and some compatible servers reject it outright, so true is the provider's default, unsent.
    ...(tools && tools.length && parallelToolCalls === false ? { parallel_tool_calls: false } : {}),
    ...parameters,
  };
  if ("max_completion_tokens" in parameters) {
    delete body.max_tokens;
  }
  return body;
}

/** A one-line description of the request for the log; nothing in it is a credential. */
export function describeRequest(url, body, sampling) {
  const extras = Object.keys(sampling.parameters);
  return (
    `POST ${url} (model=${body.model}, responseFormat=${sampling.responseFormat}${sampling.jsonSchema ? "+schema" : ""}` +
    `${body.max_tokens !== undefined ? `, maxTokens=${body.max_tokens}` : ""}` +
    `${body.tools ? `, tools=${body.tools.length}` : ""}` +
    `${extras.length ? `, parameters=${extras.join("/")}` : ""})`
  );
}

/**
 * The provider's reason for refusing, without the request that carried the token.
 */
function errorBody(error) {
  const body = error.error ?? error.message;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return (text ?? "").slice(0, ERROR_BODY_CHARS);
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

/** One chat completion, with the SDK's retries, or a TaskError naming what went wrong. */
export async function createCompletion(connection, body) {
  try {
    return await connection.client.chat.completions.create(body);
  } catch (e) {
    throw failedRequest(connection.url, e);
  }
}

/** choices[0], or NO_COMPLETION quoting what came back instead. */
export function firstChoice(completion) {
  const choice = completion?.choices?.[0];
  if (!choice?.message) {
    throw new TaskError(
      "NO_COMPLETION",
      `the response carried no choices[0].message: ${JSON.stringify(completion).slice(0, ERROR_BODY_CHARS)}`,
    );
  }
  return choice;
}

/**
 * The usage block as results. The three optional counters are empty strings when the endpoint does
 * not report them, so every declared result is always written.
 */
export function usageResults(completion) {
  const usage = completion?.usage ?? {};
  const optional = (value) => (typeof value === "number" ? value : "");
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    reasoningTokens: optional(usage.completion_tokens_details?.reasoning_tokens),
    cachedPromptTokens: optional(usage.prompt_tokens_details?.cached_tokens),
    cost: optional(usage.cost),
  };
}

/** Usage summed across turns: counters add, an optional counter stays empty until one is reported. */
export function addUsage(total, next) {
  const add = (a, b) => (a === "" && b === "" ? "" : (a === "" ? 0 : a) + (b === "" ? 0 : b));
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    reasoningTokens: add(total.reasoningTokens, next.reasoningTokens),
    cachedPromptTokens: add(total.cachedPromptTokens, next.cachedPromptTokens),
    cost: add(total.cost, next.cost),
  };
}

export const EMPTY_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: "", cachedPromptTokens: "", cost: "" };

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

/** The reply without a leading <think>...</think> block. */
export function stripThink(text) {
  return text.replace(THINK_BLOCK, "");
}

/**
 * The output result from the model's final content. Under responseFormat=json a think block and a
 * code fence are stripped, the rest must parse as JSON and, with jsonSchema, match it; the bare
 * JSON is what goes downstream. Under text the content goes through as it came.
 */
export function finalizeOutput(content, sampling) {
  if (sampling.responseFormat !== "json") {
    return content;
  }
  const candidate = unfence(stripThink(content));
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    log.warn(
      `responseFormat=json but the model returned content that is not JSON; ` +
        `the first ${INVALID_RESPONSE_CHARS} chars were: ${JSON.stringify(content.slice(0, INVALID_RESPONSE_CHARS))}`,
    );
    throw new TaskError("INVALID_RESPONSE", "responseFormat=json but the model returned content that is not JSON");
  }
  // The schema is checked here too, not only trusted to the provider: a provider that accepts
  // json_schema without constraining decoding to it would otherwise hand downstream a shape it
  // did not promise.
  const { jsonSchema } = sampling;
  if (jsonSchema && !jsonSchema.validate(parsed)) {
    const why = jsonSchema.errorsText(jsonSchema.validate.errors);
    log.warn(
      `the model's JSON does not match jsonSchema (${why}); ` +
        `the first ${INVALID_RESPONSE_CHARS} chars were: ${JSON.stringify(content.slice(0, INVALID_RESPONSE_CHARS))}`,
    );
    throw new TaskError("INVALID_RESPONSE", `the model's JSON does not match jsonSchema: ${why}`);
  }
  if (candidate !== content.trim()) {
    log.sys("stripped a code fence or think block from the JSON completion");
  }
  return candidate;
}

//
// Spans. A chat span covers one model call, its retries included; the attributes follow the
// OpenTelemetry GenAI conventions, with Flow-specific extras under flow.ai.*.
//

// Request keys with a GenAI convention name; anything else that was sent goes under flow.ai.request.*.
const REQUEST_ATTRIBUTES = {
  temperature: "gen_ai.request.temperature",
  top_p: "gen_ai.request.top_p",
  top_k: "gen_ai.request.top_k",
  seed: "gen_ai.request.seed",
  max_tokens: "gen_ai.request.max_tokens",
  max_completion_tokens: "gen_ai.request.max_tokens",
  frequency_penalty: "gen_ai.request.frequency_penalty",
  presence_penalty: "gen_ai.request.presence_penalty",
  stop: "gen_ai.request.stop_sequences",
  n: "gen_ai.request.choice.count",
};
// Keys that are the conversation or its shape rather than sampling parameters.
const NOT_REQUEST_PARAMETERS = new Set(["model", "messages", "tools", "response_format", "parallel_tool_calls", "stream"]);

/** The name and options of a chat span for this request; the caller starts it under its parent. */
export function chatSpan(connection, body, sampling, extra = {}) {
  const url = new URL(connection.baseURL);
  const attributes = {
    "gen_ai.operation.name": "chat",
    // The wire protocol; server.address names the real host (OpenRouter, Azure, Ollama...).
    "gen_ai.provider.name": "openai",
    "gen_ai.request.model": body.model,
    "gen_ai.output.type": sampling.responseFormat === "json" ? "json" : "text",
    "server.address": url.hostname,
    "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    ...extra,
  };
  for (const [key, value] of Object.entries(body)) {
    if (NOT_REQUEST_PARAMETERS.has(key)) continue;
    attributes[REQUEST_ATTRIBUTES[key] ?? `flow.ai.request.${key}`] = key === "stop" && !Array.isArray(value) ? [value] : value;
  }
  if (captureContent()) {
    const messages = JSON.stringify(redactMessages(body.messages));
    // The current convention's name, and the older one Langfuse maps to a generation's input.
    attributes["gen_ai.input.messages"] = messages;
    attributes["gen_ai.prompt"] = messages;
  }
  return [`chat ${body.model}`, { kind: KIND.CLIENT, attributes }];
}

/** What the response says about itself, onto its chat span. */
export function recordCompletion(span, completion) {
  const choice = completion?.choices?.[0];
  const usage = completion?.usage ?? {};
  span.set({
    "gen_ai.response.model": completion?.model,
    "gen_ai.response.id": completion?.id,
    "gen_ai.response.finish_reasons": choice?.finish_reason ? [choice.finish_reason] : undefined,
    "gen_ai.usage.input_tokens": usage.prompt_tokens,
    "gen_ai.usage.output_tokens": usage.completion_tokens,
    "gen_ai.usage.cache_read.input_tokens": usage.prompt_tokens_details?.cached_tokens,
    "flow.ai.usage.reasoning_tokens": usage.completion_tokens_details?.reasoning_tokens,
    // The name Langfuse reads as a generation's total cost.
    "gen_ai.usage.cost": typeof usage.cost === "number" ? usage.cost : undefined,
  });
  if (captureContent() && choice?.message) {
    const output = JSON.stringify(
      redactMessages([
        {
          role: "assistant",
          content: choice.message.content ?? null,
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        },
      ]),
    );
    span.set({ "gen_ai.output.messages": output, "gen_ai.completion": output });
  }
}

/** Marks a span failed with the TaskError's reason, or the error's own name. */
export function failSpan(span, error) {
  span.fail(error?.reason ?? error?.name, error?.message);
}
