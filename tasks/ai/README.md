# `task-ai` — the image behind Boomerang Flow's `ai-prompt` and `ai-agent` tasks

One image, two commands:

| Catalogue task | Command | What it does |
| --- | --- | --- |
| `ai-prompt` | `prompt` | one chat completion against an OpenAI-compatible endpoint, optionally held to a JSON Schema |
| `ai-agent` | `agent` | a tool-calling loop against the same kind of endpoint, with tools served over MCP, to a final answer shaped the same way |

The task author never builds a container and never names an image. Each catalogue revision in
[`catalog/`](catalog/) pins this image by exact tag and names its command; Flow's dispatcher runs
that pair for every run of the task, and an embedding product that runs the family in-process
honours the same param and result contract. The definition files in `catalog/` are the source of
truth for that contract; Flow's seed is a copy.

The image is built and published from this repository, not from the flow monorepo:

```
boomerangio/task-ai:latest
boomerangio/task-ai:<version>
```

`<version>` is whatever follows the `@` in the git tag — pushing `task-ai@2.0.0` publishes
`boomerangio/task-ai:2.0.0` for linux/amd64 and linux/arm64 (`.github/workflows/ci-task-ai.yml` →
`ci-template.yml`). A revision's `spec.image` and the tag it was written against move together, in
the same PR as the image change.

`2.1.0` adds image input (revision 2 of both tasks) and optional OpenTelemetry spans; it is
additive, and revision 1 of each task stays pinned to `2.0.0`. `2.0.0` was a major release: the `prompt` command implements the `ai-prompt` contract and drops the
contract of the original `ai` task (endpoint and token were required, temperature and maxTokens had
defaults, six results). A deployment on the `ai` task stays on its pinned 1.x tag until its nodes
move to `ai-prompt`; the param names they already use are unchanged.

Everything else is the ordinary task contract documented in
[`CONTRIBUTING_TASKS.md`](../../CONTRIBUTING_TASKS.md#task-contract): params arrive as
`PARAM_NAMES` plus one `PARAM_<NAME>` per param, and results are written to `RESULTS_PATH`, so the
image runs unchanged on the Tekton, Kubernetes Jobs and Docker executors. Both channels are read
and written by `@boomerang-io/task-core` rather than by this task.

## Implementation

Node, against the official [`openai`](https://www.npmjs.com/package/openai) package for
chat-completions and [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
for the agent's tools.

```
bin/prompt.js  bin/agent.js      the two entry points, linked onto PATH as `prompt` and `agent`
commands/prompt.js               ai-prompt
commands/agent.js                ai-agent: the loop, the trace, the limits
lib/params.js                    param parsing, prompt sources, workspace files, file context
lib/completion.js                connection, request body, retries, usage, JSON and schema handling
lib/mcp.js                       MCP servers: connect, list tools, call tools
lib/telemetry.js                 optional OpenTelemetry spans, loaded only when an endpoint is set
lib/main.js                      the life of a command: telemetry, run, failure, flush, exit code
catalog/                         the catalogue definitions (Flow's seed shape)
tests/                           the fixture runner, the mocks, and the fixtures
```

**Why that protocol.** The chat-completions shape reaches the whole practical field directly, with
no gateway in between: OpenAI, OpenRouter, LiteLLM, Azure AI Foundry, Ollama, vLLM, Groq, Together —
and Anthropic, which publishes its own OpenAI-compatible endpoint. Tool calling and structured
output ride on the same shape (`tools`, `tool_calls`, `response_format`). So a single `endpoint`
param covers the field, and the task needs no `provider` switch. The only real gaps are Bedrock and
Vertex in their native shapes, and both are normally fronted by a gateway anyway.

**Why nothing is sent unless set.** A catalogue default is copied onto every run's params when Flow
materialises a task, so a handler cannot tell "set" from "defaulted". Newer reasoning models reject
any non-default `temperature` and reject `max_tokens` in favour of `max_completion_tokens`. So
`temperature`, `maxTokens` and `seed` have no default and are sent only when the param is
non-empty; the open `parameters` map carries anything else and wins on conflict.

**Why the SDKs, and not the alternatives.** The Vercel AI SDK was only buying provider reach this
already has, at the cost of a dependency tree and a `provider` param. Agent frameworks (Embabel,
beeai) are the wrong layer when Flow is already the orchestrator: the loop here is forty lines and
the tools are MCP's. The MCP SDK is carried for the transport (streamable HTTP, sessions, SSE
responses) rather than hand-rolled; it is the largest dependency in the image, which measures about
214 MB: 139 MB of node, 90 MB of `node_modules`, the rest base.

## Params in

A param named `maxTokens` reaches the container as `PARAM_MAXTOKENS` — the name upper-cased with
`-` replaced by `_`. `PARAM_NAMES` carries the original names, which is how `task-core` hands back
`maxTokens` rather than `MAXTOKENS`. Every value is a string; a JSON param is JSON text, parsed here
and failed with `INVALID_PARAM` naming the param when it does not parse (its value is never echoed).

A path param is used as given when absolute and resolved against `/workspace` when relative.

### Shared by `ai-prompt` and `ai-agent`

| Param | Required | Meaning |
| --- | --- | --- |
| `model` | yes | Model id to request |
| `prompt` | one source | The user message |
| `promptFile` | one source | A workspace file whose contents are the user message, for a prompt too large for a param (the engine caps params at 16 KB and a single environment string at 128 KB) |
| `systemPrompt` | no | Prepended as a `system` message when non-empty |
| `messages` | one source | A JSON array of `{role, content}` sent as the exact message array, replacing `systemPrompt` and `prompt` (which are then ignored, with a warning). For replays and evals. `content` may be a string or an array of chat-completions content parts (`[{"type": "text", ...}, {"type": "image_url", ...}]`); either goes to the endpoint unchanged |
| `messagesFile` | one source | The same array, read from a workspace file |
| `endpoint` | no | OpenAI-compatible base URL; `/chat/completions` is appended (a trailing `/` is trimmed). Blank means the executor's default, `OPENAI_BASE_URL` |
| `token` | no | Bearer token. Declared `password`-typed so Flow filters it out of run reads and log streams. Blank means the executor's default, `OPENAI_API_KEY` |
| `temperature` | no | Number; sent only when set |
| `maxTokens` | no | Integer, sent as `max_tokens` only when set; a `max_completion_tokens` in `parameters` suppresses it |
| `seed` | no | Integer; sent only when set |
| `parameters` | no | A JSON object merged into the request last: `top_p`, `reasoning_effort`, `verbosity`, `max_completion_tokens`, `frequency_penalty`, `presence_penalty`, anything the endpoint accepts. Its keys win over the convenience params |
| `responseFormat` | no | `text` (default, no `response_format` key) or `json` (`response_format: {"type": "json_object"}`, and the reply must parse as JSON) |
| `jsonSchema` | no | A JSON Schema object. Requires `responseFormat=json`. Sends `response_format: {"type": "json_schema", "json_schema": {"name": "output", "strict": true, "schema": ...}}` and validates the reply here as well: a schema that does not compile fails with `INVALID_PARAM` before any request, JSON that does not match fails with `INVALID_RESPONSE` naming the failing keyword |
| `files` | no | Comma-separated workspace paths; each is appended to the last user message as a fenced block under a `## <path>` heading: to its text, or to its last text part when it has content parts (a text part is added if it has none) |
| `maxContextBytes` | no | Byte budget for the file context (default 65536); files that would exceed it are skipped and named in the prompt |
| `images` | no | Comma-separated images attached to the last user message after its text, in order. A workspace path is checked against `maxImageBytes`, typed from its first bytes (PNG, JPEG, GIF, WEBP; the file name is not trusted) and sent as a `data:` URL; an `https` URL is passed through for the provider to fetch. Any other scheme (`http:`, `data:`, `file:`) is `INVALID_PARAM`, so an image never travels inside a param. Needs a vision-capable model. A URL containing a comma encodes it as `%2C` |
| `imageDetail` | no | `low`, `high` or `auto`, sent as `image_url.detail` on each image from `images` only when set. Set with no images, it is a warning and is ignored |
| `maxImageBytes` | no | Largest workspace image, in bytes (default 5242880). A larger file is `FILE_TOO_LARGE`, never resized or skipped. Not sent; URLs are not checked, since the image never fetches them |
| `outputFile` | no | A workspace path to write the full `output` to, for a following `uploadartifact` node; `output` still carries it up to the results cap |

Exactly one of `prompt`, `promptFile`, `messages`, `messagesFile` must be given per kind: none is
`MISSING_PARAM`, `prompt` with `promptFile` or `messages` with `messagesFile` is `INVALID_PARAM`.
An explicit `endpoint` or `token` always wins over the environment; neither anywhere is
`MISSING_PARAM` naming the variable.

Without `images`, a message's content is exactly what its source gave: a prompt stays a plain
string. With them, string content becomes `[{"type": "text"}, ...images]` and a content-parts array
has the images appended. Each image is logged as its path, size and type, or as a URL's origin and
path: the query string is dropped, so a presigned URL's signature never reaches the pod log.
`images` is a text param, though, so Flow stores and shows a presigned URL with the run; private
images belong on the workspace. The agent resends the images on every turn, since they stay in the
conversation.

Under `responseFormat=json`, a leading `<think>…</think>` block and a Markdown code fence around
the whole reply are stripped before parsing, and `output` carries the bare JSON. JSON buried inside
prose is not hunted for; it fails `INVALID_RESPONSE`.

### `ai-agent` only

| Param | Default | Meaning |
| --- | --- | --- |
| `tools` | none | A JSON array of `{name, description, inputSchema}` tools an executor implements natively. A container has none, so every declared name must be served by an MCP server below, or the task fails `UNKNOWN_TOOL` before the first request |
| `mcpServers` | none | A JSON array of `{name, url}` MCP servers (streamable HTTP). Only those two keys: a credential inside this param is `INVALID_PARAM`, because Flow filters secrets by param type and this is a text param |
| `mcpTokens` | none | A `password`-typed JSON object `{serverName: bearerToken}` for the servers above |
| `allowedTools` | all | A JSON array of tool names the model may call |
| `toolContext` | none | A JSON object of opaque values for natively implemented tools, never shown to the model. Validated and otherwise unused on a container run |
| `maxTurns` | `10` | Model calls before the loop fails `MAX_TURNS_EXCEEDED` |
| `maxToolCalls` | none | Tool calls in total before the loop fails `MAX_TURNS_EXCEEDED`, checked before the turn that would exceed it is executed |
| `parallelToolCalls` | `true` | Sent as `parallel_tool_calls: false` only when false and only when tools are present; `true` is the provider's default and is not sent, since OpenAI rejects the key without tools and some servers reject it outright |
| `toolResultReinforcement` | none | Appended as a user message after each turn's tool messages |

The loop: the model is called with the MCP tools as chat-completions functions; each tool call it
makes is executed (together when `parallelToolCalls`, in order otherwise) and answered with a tool
message; the loop ends when the model answers without calling a tool, and that answer is the
output, shaped exactly as `ai-prompt` shapes its reply (`responseFormat`, `jsonSchema`,
`outputFile` all apply, and `response_format` is sent on every turn). A tool that returns
`isError`, or arguments the model did not write as valid JSON, go back to the model as `ERROR: …`
and the loop continues; a tool the model names that is not available fails `UNKNOWN_TOOL`. A tool
name served by two servers is `INVALID_PARAM`.

Every turn and every tool call is traced to the task log as one JSON line, `{"trace":"ai-agent",
"event":"turn"|"tool", …}`, with the running token totals, the tool name and server, the first 500
characters of the arguments and the result size — not the result itself. The results stay a summary.

## Results out

| Result | Source | Empty when |
| --- | --- | --- |
| `output` | the reply text, or the bare JSON string under `responseFormat=json` | never |
| `finishReason` | `choices[0].finish_reason` of the final turn | not reported |
| `model` | `model` as served, which may be more specific than the one asked for | not reported |
| `promptTokens` | `usage.prompt_tokens`, summed over turns | — (`0`) |
| `completionTokens` | `usage.completion_tokens`, summed | — (`0`) |
| `totalTokens` | `usage.total_tokens`, summed | — (`0`) |
| `reasoningTokens` | `usage.completion_tokens_details.reasoning_tokens`, summed | not reported |
| `cachedPromptTokens` | `usage.prompt_tokens_details.cached_tokens`, summed | not reported |
| `cost` | `usage.cost` (OpenRouter), summed | not reported |
| `turns` | `ai-agent` only: model calls made | — |
| `toolCalls` | `ai-agent` only: tool calls made | — |

Every declared result is always written, the optional counters as an empty string when the endpoint
does not report them, so a results parser that filters by declared name always finds them.

Both result channels are handled from the one image:

| `RESULTS_PATH` is | Executor | What is written |
| --- | --- | --- |
| a directory (`/tekton/results`) | Tekton | one file per result, the file name being the result name |
| a file (`/dev/termination-log`) | Kubernetes Jobs | one compact JSON object |

`RESULTS_PATH` defaults to `/tekton/results` when the executor does not set it. All results
together must not exceed 4096 bytes on Kubernetes — the native cap of the termination-message file
— so a long completion will exceed it. Nothing truncates the answer to fit. For long output, use
`outputFile` and hand the file to a following `uploadartifact` node, or lower `maxTokens`.

## Failure

Any failure exits non-zero with the reason on stderr, and the engine ends the task `failed`. The
reasons are prefixed so they are greppable: `MISSING_PARAM`, `INVALID_PARAM`, `FILE_NOT_READABLE`,
`FILE_NOT_WRITABLE`, `FILE_TOO_LARGE`, `REQUEST_FAILED`, `REQUEST_REJECTED`, `INVALID_RESPONSE`, `NO_COMPLETION`,
and for the agent `UNKNOWN_TOOL` and `MAX_TURNS_EXCEEDED`.

`429`, `5xx` and transport failures are retried, three attempts in total, on the SDK's exponential
backoff with jitter. Any other `4xx` fails at once — a rejected token or an unknown model will be
rejected again. The failure names the status and quotes the first 512 characters of the provider's
reason. An MCP server that cannot be connected or listed is `REQUEST_FAILED` naming the server.

No credential is printed on any path: nothing logs request headers, a JSON param that fails to
parse is not echoed, and `task-core` logs the names of the params it reads but not their values.

## Tracing (OpenTelemetry)

Off unless the executor sets `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`).
Off, nothing from `@opentelemetry` is even imported. On, the SDK is imported at startup and every
model call, tool call and MCP call becomes a span, exported over OTLP/HTTP. Nothing about the task
changes either way: results, exit codes and the JSON-lines trace in the task log are the same.

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | where spans go; `/v1/traces` is appended |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json`. `grpc` is not supported by this image: one warning, nothing exported |
| `OTEL_EXPORTER_OTLP_HEADERS` | sent with each export (a Langfuse basic-auth header, for one); never logged |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | the resource every span carries; `service.name` defaults to `task-ai` |
| `TRACEPARENT`, `TRACESTATE` | the W3C context the spans join; Flow derives it from the run so every task of a run shares one trace. Invalid, it is a warning and the spans start their own trace |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` | adds prompts, replies, tool arguments and tool results to the spans. Off by default, because prompts carry customer data |
| `OTEL_SDK_DISABLED=true`, `OTEL_TRACES_EXPORTER=none` | off, even with an endpoint |

The spans follow the OpenTelemetry GenAI and MCP semantic conventions:

```
ai-prompt   chat <model>                         CLIENT, child of TRACEPARENT

ai-agent    invoke_agent ai-agent                INTERNAL, child of TRACEPARENT
            ├── initialize                       CLIENT, per MCP server
            ├── tools/list                       CLIENT, per MCP server
            ├── chat <model>                     CLIENT, per turn (flow.agent.turn)
            └── execute_tool <tool>              INTERNAL, per tool call (flow.agent.turn)
                └── tools/call <tool>            CLIENT
```

A chat span carries `gen_ai.operation.name`, `gen_ai.provider.name` (`openai`, the wire protocol;
`server.address` names the real host), `gen_ai.request.model`, `gen_ai.output.type`, a
`gen_ai.request.*` attribute for each sampling parameter actually sent (`flow.ai.request.*` for
one with no convention name, `reasoning_effort` for example), `gen_ai.response.model`,
`gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens` and
`flow.ai.usage.reasoning_tokens` when reported, and `gen_ai.usage.cost` when the endpoint reports a
cost, which is the attribute Langfuse reads as a generation's total cost. A failure sets the span's
status to error and `error.type` to the reason prefix.

With content capture on, a chat span adds `gen_ai.input.messages` and `gen_ai.output.messages`
(the current convention) and `gen_ai.prompt` and `gen_ai.completion` (the names Langfuse maps to a
generation's input and output), all as the chat-completions JSON; an `execute_tool` span adds
`gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Even then, image data is replaced by
`[image data omitted]`, URL query strings are dropped, and no credential appears.

An export failure is one warning line. The flush before exit is bounded at 5 s, so an unreachable
endpoint delays the end of a task by at most that, and never changes its outcome.

## Network zone

The endpoint, the MCP servers and, when tracing is on, the OTLP endpoint are the only things this
container needs to reach. Image URLs are fetched by the provider, not by this container. A deployment
that wants AI traffic confined registers a dispatcher for the `ai` type alone
(`flow.dispatcher.task-types=ai`) in a namespace whose egress policy allows those and nothing else.

## Tests

```bash
node tasks/ai/tests/run.js        # or: pnpm --filter @boomerang-io/task-ai test
```

98 cases in [`tests/fixtures/`](tests/), each a JSON file of params in, scripted endpoint and MCP
replies, and the results, requests, log lines, workspace files and exported spans expected out. The runner drives
the real commands through their environment exactly as the platform does and stands in for the
endpoint, the MCP servers and an OTLP receiver in-process, so there is no network and no image build. The fixtures
are the contract as data: an in-process implementation of `ai-prompt` and `ai-agent` replays the
same files against itself. [`tests/README.md`](tests/README.md) describes the format.

## Build

```bash
docker build -f tasks/ai/Dockerfile -t boomerangio/task-ai:local .
```

**The build context is the repository root**, not `tasks/ai`, so pnpm resolves
`@boomerang-io/task-core` as a workspace dependency instead of fetching it from the npm registry.
No task-core release has to happen before this image can be built or tagged.

Two stages: pnpm resolves and deploys the dependency tree in the first and stays behind, so the
published image carries node, the deployed `node_modules` and the two commands — no pnpm, no npm,
no build toolchain. Non-root (uid 2000), no entrypoint: the dispatcher sets the command.
