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
  chatSpan,
  createCompletion,
  describeRequest,
  failSpan,
  finalizeOutput,
  fitOutput,
  firstChoice,
  readSampling,
  recordCompletion,
  resolveConnection,
  usageResults,
} from "../lib/completion.js";
import { connectMcpServers, validateMcpServers, validateMcpTokens } from "../lib/mcp.js";
import { KIND, captureContent, rootSpan } from "../lib/telemetry.js";
import { callWorkspaceTool, readWorkspaceParams, workspaceDefinitions } from "../lib/workspace.js";

/**
 * `ai-agent`: a tool-calling loop against an OpenAI-compatible endpoint.
 *
 * The model is called with the tools the MCP servers serve; each tool call it makes is executed and
 * its result appended as a tool message; the loop ends when the model answers without calling a
 * tool, and that answer is the output, shaped exactly as ai-prompt shapes its reply. Every turn and
 * every tool call is traced to the task log as one JSON line, while the results stay a summary.
 *
 * `tools` declares tools an executor implements natively. Here each declared name must be an
 * enabled workspace tool or served by an MCP server, or the task fails UNKNOWN_TOOL before the
 * first call rather than when the model first reaches for it.
 *
 * `workspaceTools` enables the built-in read, edit, write and bash tools (lib/workspace.js), each
 * confined to `workdir`. None is enabled by default. They sit beside the MCP tools: allowedTools,
 * maxTurns and maxToolCalls apply to both, and `timeoutSeconds` bounds the whole loop.
 *
 * With an OTLP endpoint configured, the run is an `invoke_agent` span under the run's TRACEPARENT,
 * holding the MCP `initialize` and `tools/list` spans, a `chat` span per turn, and an
 * `execute_tool` span per tool call with its MCP `tools/call` span beneath it.
 */

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const MAX_TIMEOUT_SECONDS = 86400;

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
  const timeoutSeconds = isSet(input.timeoutSeconds) ? asInteger("timeoutSeconds", input.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS;
  if (timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new TaskError("INVALID_PARAM", `timeoutSeconds must be from 1 to ${MAX_TIMEOUT_SECONDS}, got ${timeoutSeconds}`);
  }
  const workspace = readWorkspaceParams(input);
  return { tools, servers, tokens, allowedTools, toolContext, maxTurns, maxToolCalls, parallelToolCalls, reinforcement, timeoutSeconds, workspace };
}

/**
 * The tool names the model may call: the enabled workspace tools and the MCP-served ones, declared
 * names resolved, allowedTools applied to both.
 */
function selectTools(registry, agent) {
  const builtIn = agent.workspace.tools;
  const clash = builtIn.filter((name) => registry.tools.has(name));
  if (clash.length) {
    throw new TaskError(
      "INVALID_PARAM",
      `${clash.map((n) => `'${n}'`).join(", ")} is both an enabled workspace tool and served by MCP server '${registry.tools.get(clash[0]).server.name}'`,
    );
  }
  const available = [...builtIn, ...registry.tools.keys()];
  const unserved = agent.tools.map((t) => t.name).filter((name) => !available.includes(name));
  if (unserved.length) {
    throw new TaskError(
      "UNKNOWN_TOOL",
      `tools declares ${unserved.map((n) => `'${n}'`).join(", ")}, which is neither an enabled workspace tool nor served by an MCP server`,
    );
  }
  if (!agent.allowedTools) {
    return available;
  }
  const unknown = agent.allowedTools.filter((name) => !available.includes(name));
  if (unknown.length) {
    throw new TaskError(
      "UNKNOWN_TOOL",
      `allowedTools names ${unknown.map((n) => `'${n}'`).join(", ")}, which is neither an enabled workspace tool nor served by an MCP server`,
    );
  }
  return available.filter((name) => agent.allowedTools.includes(name));
}

/** The definitions the model is offered: workspace tools first, then the MCP ones. */
function toolDefinitions(registry, agent, selected) {
  const builtIn = selected.filter((name) => agent.workspace.tools.includes(name));
  const served = selected.filter((name) => !agent.workspace.tools.includes(name));
  return [...workspaceDefinitions(builtIn), ...registry.definitions(served)];
}

/** Executes one of the model's tool calls under an execute_tool span and returns its tool message. */
async function executeToolCall(registry, agent, selected, call, turn, parent, deadline) {
  const name = call.function?.name ?? "";
  const span = parent.child(`execute_tool ${name}`, {
    kind: KIND.INTERNAL,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.id": call.id,
      "gen_ai.tool.type": "function",
      "flow.agent.turn": turn,
      ...(captureContent() ? { "gen_ai.tool.call.arguments": call.function?.arguments ?? "" } : {}),
    },
  });
  try {
    if (!selected.includes(name)) {
      throw new TaskError("UNKNOWN_TOOL", `the model called '${name}', which is not an available tool`);
    }
    const message = await runToolCall(registry, agent, call, name, turn, span, deadline);
    if (captureContent()) {
      span.set({ "gen_ai.tool.call.result": message.content });
    }
    return message;
  } catch (e) {
    failSpan(span, e);
    throw e;
  } finally {
    span.end();
  }
}

async function runToolCall(registry, agent, call, name, turn, span, deadline) {
  let args;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    // The model's mistake, handed back to it rather than failing the run.
    trace({ event: "tool", turn, tool: name, ok: false, error: "arguments were not valid JSON" });
    span.fail("invalid_arguments", "the tool call arguments were not valid JSON");
    return { role: "tool", tool_call_id: call.id, content: "ERROR: the tool call arguments were not valid JSON" };
  }
  const started = Date.now();
  let outcome;
  if (agent.workspace.tools.includes(name)) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    outcome = { server: "workspace", ...(await callWorkspaceTool(agent.workspace, name, args, remaining)) };
  } else {
    try {
      outcome = await registry.call(name, args, span);
    } catch (e) {
      outcome = { server: registry.tools.get(name).server.name, text: `ERROR: ${e.message}`, isError: true };
    }
  }
  if (outcome.isError) {
    span.fail("tool_error", "the tool reported an error");
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

function timeoutError(agent, turns) {
  return new TaskError("TIMEOUT_EXCEEDED", `the agent was still working after timeoutSeconds=${agent.timeoutSeconds} (${turns} turn(s))`);
}

function overDeadline(deadline, agent, turns) {
  if (Date.now() >= deadline) {
    throw timeoutError(agent, turns);
  }
}

/** The model call, or TIMEOUT_EXCEEDED when the loop's wall-clock limit falls first. */
function beforeDeadline(promise, deadline, agent, turns) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(agent, turns)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export async function run() {
  const input = readParams();

  const model = requireParam("model", input.model);
  const connection = resolveConnection(input);
  const sampling = readSampling(input);
  const agent = readAgentParams(input);
  const messages = resolveMessages(input);

  const agentSpan = rootSpan("invoke_agent ai-agent", {
    kind: KIND.INTERNAL,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "ai-agent",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": model,
    },
  });
  try {
    await runAgent({ input, model, connection, sampling, agent, messages, agentSpan });
  } catch (e) {
    failSpan(agentSpan, e);
    throw e;
  } finally {
    agentSpan.end();
  }
}

async function runAgent({ input, model, connection, sampling, agent, messages, agentSpan }) {
  const started = Date.now();
  const registry = await connectMcpServers(agent.servers, agent.tokens, agentSpan);
  try {
    const selected = selectTools(registry, agent);
    const tools = toolDefinitions(registry, agent, selected);
    log.sys(`agent: ${selected.length} tool(s) available${selected.length ? `: ${selected.join(", ")}` : ""}, maxTurns=${agent.maxTurns}`);
    // First on the trace, so a reviewer sees at once whether this step can change files or run commands.
    const workspaceEnabled = agent.workspace.tools.filter((name) => selected.includes(name));
    trace({
      event: "start",
      workspaceTools: workspaceEnabled,
      ...(workspaceEnabled.length ? { workdir: agent.workspace.workdir } : {}),
      tools: selected,
      maxTurns: agent.maxTurns,
      timeoutSeconds: agent.timeoutSeconds,
    });
    if (workspaceEnabled.includes("bash")) {
      log.warn(`agent: bash is enabled: the model can run commands in ${agent.workspace.workdir}`);
    }
    const deadline = started + agent.timeoutSeconds * 1000;

    let usage = EMPTY_USAGE;
    let turns = 0;
    let toolCalls = 0;
    let completion;
    let choice;
    let finalContent;

    while (turns < agent.maxTurns) {
      overDeadline(deadline, agent, turns);
      const body = buildRequestBody({ model, messages, sampling, tools, parallelToolCalls: agent.parallelToolCalls });
      if (turns === 0) {
        log.sys(describeRequest(connection.url, body, sampling));
      }
      turns += 1;
      const turnSpan = agentSpan.child(...chatSpan(connection, body, sampling, { "flow.agent.turn": turns }));
      try {
        completion = await beforeDeadline(createCompletion(connection, body), deadline, agent, turns);
        recordCompletion(turnSpan, completion);
        choice = firstChoice(completion);
      } catch (e) {
        failSpan(turnSpan, e);
        throw e;
      } finally {
        turnSpan.end();
      }
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
        ? await Promise.all(calls.map((call) => executeToolCall(registry, agent, selected, call, turns, agentSpan, deadline)))
        : await calls.reduce(
            (chain, call) => chain.then(async (done) => [...done, await executeToolCall(registry, agent, selected, call, turns, agentSpan, deadline)]),
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
    agentSpan.set({ "gen_ai.response.model": servedModel, "flow.agent.turns": turns, "flow.agent.tool_calls": toolCalls });
    const others = { finishReason, model: servedModel, ...usage, turns, toolCalls };
    await results({ output: fitOutput(output, others), ...others });

    log.good(
      `completed: ${output.length} chars, ${turns} turn(s), ${toolCalls} tool call(s), ${usage.totalTokens} tokens, ` +
        `finishReason=${finishReason}, model=${servedModel}`,
    );
  } finally {
    await registry.close();
  }
}
