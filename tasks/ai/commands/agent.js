import { log, results } from "@boomerang-io/task-core";
import {
  TaskError,
  asBoolean,
  asInteger,
  asJson,
  isSet,
  readParams,
  requireParam,
  resolveMessages,
  writeWorkspaceFile,
} from "../lib/params.js";
import {
  EMPTY_USAGE,
  addUsage,
  buildRequestBody,
  createCompletion,
  describeRequest,
  finalizeOutput,
  firstChoice,
  readSampling,
  resolveConnection,
  usageResults,
} from "../lib/completion.js";
import { connectMcpServers, validateMcpServers, validateMcpTokens } from "../lib/mcp.js";

/**
 * `ai-agent`: a tool-calling loop against an OpenAI-compatible endpoint.
 *
 * The model is called with the tools the MCP servers serve; each tool call it makes is executed and
 * its result appended as a tool message; the loop ends when the model answers without calling a
 * tool, and that answer is the output, shaped exactly as ai-prompt shapes its reply. Every turn and
 * every tool call is traced to the task log as one JSON line, while the results stay a summary.
 *
 * `tools` declares tools an executor implements natively. A container has no native tools, so each
 * declared name must be served by an MCP server here, or the task fails UNKNOWN_TOOL before the
 * first call rather than when the model first reaches for it.
 */

const DEFAULT_MAX_TURNS = 10;

// How much of a tool call's arguments to put in the trace. They are model-written, not secrets,
// but a whole document pasted into one would otherwise fill the log.
const TRACE_ARGUMENT_CHARS = 500;

function trace(event) {
  process.stdout.write(`${JSON.stringify({ trace: "ai-agent", ...event })}\n`);
}

function readAgentParams(input) {
  const tools = isSet(input.tools) ? asJson("tools", input.tools, "array") : [];
  tools.forEach((tool, i) => {
    if (tool === null || typeof tool !== "object" || typeof tool.name !== "string" || tool.name.trim() === "") {
      throw new TaskError("INVALID_PARAM", `tools[${i}] must be an object with a name`);
    }
  });
  const servers = validateMcpServers(isSet(input.mcpServers) ? asJson("mcpServers", input.mcpServers, "array") : []);
  const tokens = validateMcpTokens(isSet(input.mcpTokens) ? asJson("mcpTokens", input.mcpTokens, "object") : {}, servers);
  const allowedTools = isSet(input.allowedTools) ? asJson("allowedTools", input.allowedTools, "array") : undefined;
  allowedTools?.forEach((name, i) => {
    if (typeof name !== "string") {
      throw new TaskError("INVALID_PARAM", `allowedTools[${i}] must be a tool name`);
    }
  });
  // Opaque values for natively implemented tools. A container has none, so the shape is checked
  // and the values go nowhere; they are never shown to the model.
  const toolContext = isSet(input.toolContext) ? asJson("toolContext", input.toolContext, "object") : undefined;
  const maxTurns = asInteger("maxTurns", isSet(input.maxTurns) ? input.maxTurns : DEFAULT_MAX_TURNS);
  if (maxTurns < 1) {
    throw new TaskError("INVALID_PARAM", `maxTurns must be at least 1, got ${maxTurns}`);
  }
  const maxToolCalls = isSet(input.maxToolCalls) ? asInteger("maxToolCalls", input.maxToolCalls) : undefined;
  const parallelToolCalls = isSet(input.parallelToolCalls) ? asBoolean("parallelToolCalls", input.parallelToolCalls) : true;
  const reinforcement = isSet(input.toolResultReinforcement) ? input.toolResultReinforcement : undefined;
  return { tools, servers, tokens, allowedTools, toolContext, maxTurns, maxToolCalls, parallelToolCalls, reinforcement };
}

/** The tool names the model may call: served by MCP, declared names resolved, allowedTools applied. */
function selectTools(registry, agent) {
  const served = [...registry.tools.keys()];
  const unserved = agent.tools.map((t) => t.name).filter((name) => !registry.tools.has(name));
  if (unserved.length) {
    throw new TaskError(
      "UNKNOWN_TOOL",
      `tools declares ${unserved.map((n) => `'${n}'`).join(", ")}, which no MCP server serves; ` +
        "a container run has no natively implemented tools",
    );
  }
  if (!agent.allowedTools) {
    return served;
  }
  const unknown = agent.allowedTools.filter((name) => !registry.tools.has(name));
  if (unknown.length) {
    throw new TaskError("UNKNOWN_TOOL", `allowedTools names ${unknown.map((n) => `'${n}'`).join(", ")}, which no MCP server serves`);
  }
  return served.filter((name) => agent.allowedTools.includes(name));
}

/** Executes one of the model's tool calls and returns its tool message. */
async function executeToolCall(registry, selected, call, turn) {
  const name = call.function?.name ?? "";
  if (!selected.includes(name)) {
    throw new TaskError("UNKNOWN_TOOL", `the model called '${name}', which is not an available tool`);
  }
  let args;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    // The model's mistake, handed back to it rather than failing the run.
    trace({ event: "tool", turn, tool: name, ok: false, error: "arguments were not valid JSON" });
    return { role: "tool", tool_call_id: call.id, content: "ERROR: the tool call arguments were not valid JSON" };
  }
  const started = Date.now();
  let outcome;
  try {
    outcome = await registry.call(name, args);
  } catch (e) {
    outcome = { server: registry.tools.get(name).server.name, text: `ERROR: ${e.message}`, isError: true };
  }
  trace({
    event: "tool",
    turn,
    tool: name,
    server: outcome.server,
    arguments: (call.function.arguments ?? "").slice(0, TRACE_ARGUMENT_CHARS),
    ok: !outcome.isError,
    resultChars: outcome.text.length,
    ms: Date.now() - started,
  });
  const content = outcome.isError && !outcome.text.startsWith("ERROR") ? `ERROR: ${outcome.text}` : outcome.text;
  return { role: "tool", tool_call_id: call.id, content };
}

export async function run() {
  const input = readParams();

  const model = requireParam("model", input.model);
  const connection = resolveConnection(input);
  const sampling = readSampling(input);
  const agent = readAgentParams(input);
  const messages = resolveMessages(input);

  const registry = await connectMcpServers(agent.servers, agent.tokens);
  try {
    const selected = selectTools(registry, agent);
    const tools = registry.definitions(selected);
    log.sys(`agent: ${selected.length} tool(s) available${selected.length ? `: ${selected.join(", ")}` : ""}, maxTurns=${agent.maxTurns}`);

    let usage = EMPTY_USAGE;
    let turns = 0;
    let toolCalls = 0;
    let completion;
    let choice;
    let finalContent;

    while (turns < agent.maxTurns) {
      const body = buildRequestBody({ model, messages, sampling, tools, parallelToolCalls: agent.parallelToolCalls });
      if (turns === 0) {
        log.sys(describeRequest(connection.url, body, sampling));
      }
      completion = await createCompletion(connection, body);
      turns += 1;
      choice = firstChoice(completion);
      usage = addUsage(usage, usageResults(completion));

      const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
      trace({
        event: "turn",
        turn: turns,
        finishReason: choice.finish_reason ?? "",
        toolCalls: calls.map((c) => c.function?.name ?? ""),
        usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens },
      });

      if (calls.length === 0) {
        if (typeof choice.message.content !== "string") {
          throw new TaskError(
            "NO_COMPLETION",
            `the response carried neither tool calls nor choices[0].message.content: ${JSON.stringify(completion).slice(0, 512)}`,
          );
        }
        finalContent = choice.message.content;
        break;
      }

      toolCalls += calls.length;
      if (agent.maxToolCalls !== undefined && toolCalls > agent.maxToolCalls) {
        throw new TaskError(
          "MAX_TURNS_EXCEEDED",
          `the model asked for ${toolCalls} tool calls, over maxToolCalls=${agent.maxToolCalls}, after ${turns} turn(s)`,
        );
      }

      // The assistant turn goes back exactly as it came, tool_calls included, then one tool
      // message per call, in the order the model made them.
      messages.push(choice.message);
      const toolMessages = agent.parallelToolCalls
        ? await Promise.all(calls.map((call) => executeToolCall(registry, selected, call, turns)))
        : await calls.reduce(
            (chain, call) => chain.then(async (done) => [...done, await executeToolCall(registry, selected, call, turns)]),
            Promise.resolve([]),
          );
      messages.push(...toolMessages);
      if (agent.reinforcement) {
        messages.push({ role: "user", content: agent.reinforcement });
      }
    }

    if (finalContent === undefined) {
      throw new TaskError(
        "MAX_TURNS_EXCEEDED",
        `the model was still calling tools after maxTurns=${agent.maxTurns} (${toolCalls} tool call(s))`,
      );
    }

    const output = finalizeOutput(finalContent, sampling);
    if (isSet(input.outputFile)) {
      const file = writeWorkspaceFile("outputFile", input.outputFile, output);
      log.sys(`wrote ${output.length} chars to ${file}`);
    }

    const finishReason = choice.finish_reason ?? "";
    const servedModel = completion.model ?? "";
    await results({ output, finishReason, model: servedModel, ...usage, turns, toolCalls });

    log.good(
      `completed: ${output.length} chars, ${turns} turn(s), ${toolCalls} tool call(s), ${usage.totalTokens} tokens, ` +
        `finishReason=${finishReason}, model=${servedModel}`,
    );
  } finally {
    await registry.close();
  }
}
