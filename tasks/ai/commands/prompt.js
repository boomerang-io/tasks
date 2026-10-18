import { log, results } from "@boomerang-io/task-core";
import { TaskError, isSet, readParams, requireParam, resolveMessages, writeWorkspaceFile } from "../lib/params.js";
import {
  buildRequestBody,
  createCompletion,
  describeRequest,
  finalizeOutput,
  firstChoice,
  readSampling,
  resolveConnection,
  usageResults,
} from "../lib/completion.js";

export { TaskError };
export { unfence } from "../lib/completion.js";

/**
 * `ai-prompt`: one chat completion against an OpenAI-compatible endpoint.
 *
 * Inputs arrive as PARAM_NAMES/PARAM_<NAME> environment variables and results are written to
 * RESULTS_PATH - a directory on Tekton, a single JSON file on Kubernetes Jobs and Docker. Both are
 * the platform's documented task contract (CONTRIBUTING_TASKS.md) and both are read and written by
 * @boomerang-io/task-core. The token is never logged: it is handed to the SDK and nothing prints
 * it, including the failure paths, which carry the provider's reason but never the request headers.
 */
export async function run() {
  const input = readParams();

  const model = requireParam("model", input.model);
  const connection = resolveConnection(input);
  const sampling = readSampling(input);
  const messages = resolveMessages(input);

  const body = buildRequestBody({ model, messages, sampling });
  log.sys(describeRequest(connection.url, body, sampling));

  const completion = await createCompletion(connection, body);
  const choice = firstChoice(completion);
  if (typeof choice.message.content !== "string") {
    throw new TaskError(
      "NO_COMPLETION",
      `the response carried no choices[0].message.content: ${JSON.stringify(completion).slice(0, 512)}`,
    );
  }

  const output = finalizeOutput(choice.message.content, sampling);
  if (isSet(input.outputFile)) {
    const file = writeWorkspaceFile("outputFile", input.outputFile, output);
    log.sys(`wrote ${output.length} chars to ${file}`);
  }

  const usage = usageResults(completion);
  const finishReason = choice.finish_reason ?? "";
  // The model as served, which may be more specific than the one asked for.
  const servedModel = completion.model ?? "";

  await results({ output, finishReason, model: servedModel, ...usage });

  log.good(
    `completed: ${output.length} chars, ${usage.totalTokens} tokens, finishReason=${finishReason}, model=${servedModel}`,
  );
}
