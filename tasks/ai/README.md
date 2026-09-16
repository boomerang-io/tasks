# `task-ai` — the worker image behind Boomerang Flow's `ai` task type

An `ai` task runs one prompt against an OpenAI-compatible endpoint and returns the completion as a
task result. Its author never builds a container and never names an image: Flow's dispatcher
resolves the image from `flow.dispatcher.ai.image` and runs the `prompt` command for every TaskRun
of type `ai` (`TaskImageResolver` in the flow monorepo's `service-dispatcher`).

The image is built and published from this repository, not from the flow monorepo:

```
boomerangio/task-ai:latest
boomerangio/task-ai:<version>
```

`<version>` is whatever follows the `@` in the git tag — pushing `task-ai@1.0.0` publishes
`boomerangio/task-ai:1.0.0` (`.github/workflows/ci-task-ai.yml` →
`.github/workflows/ci-template.yml`). Because the two live in different repositories,
**`flow.dispatcher.ai.image` and the tag published here must be kept in step**: pin the deployed
Flow to an exact tag (`flow.dispatcher.ai.image=boomerangio/task-ai:1.0.0`) rather than trusting
`:latest` to stay compatible with the parameter and result contract below.

Everything else is the ordinary task contract documented in
[`CONTRIBUTING_TASKS.md`](../../CONTRIBUTING_TASKS.md#task-contract): params arrive as
`PARAM_NAMES` plus one `PARAM_<NAME>` per param, and results are written to `RESULTS_PATH`, so the
image runs unchanged on the Tekton, Kubernetes Jobs and Docker executors. Both channels are read
and written by `@boomerang-io/task-core` rather than by this task.

## Implementation

Node, against the official [`openai`](https://www.npmjs.com/package/openai) package, speaking
OpenAI chat-completions.

**Why that protocol.** The chat-completions shape reaches the whole practical field directly, with
no gateway in between: OpenAI, OpenRouter, LiteLLM, Azure AI Foundry, Ollama, vLLM, Groq, Together —
and Anthropic, which publishes its own OpenAI-compatible endpoint (`api.anthropic.com/v1/`, with an
Anthropic key). The only real gaps are Bedrock and Vertex in their native shapes, and both are
normally fronted by a gateway anyway. So a single `endpoint` param covers the field, and the task
needs no `provider` switch.

Anthropic's compatibility layer accepts and then ignores some things — prompt caching controls,
extended thinking, citations and document blocks, and some sampling params (`frequency_penalty`,
`logit_bias`, `n>1`, possibly `seed`). None of them is in this task's param surface, and `usage`
maps cleanly, so the token-count results still populate. Check Anthropic's compatibility page before
adding a param that one of them would touch.

**Why the SDK, and not the alternatives.** The Vercel AI SDK (`ai` + `@ai-sdk/*`) was only buying
provider reach this already has, at the cost of a dependency tree and a `provider` param. Embabel
and IBM's `beeai-framework` are agent and planning frameworks — the wrong layer for one prompt to
one completion, when Flow is already the orchestrator. `@ibm-cloud/watsonx-ai` is a single provider
rather than an abstraction.

**Why Node, and not the bash implementation this replaces.** Consistency rather than capability: it
matches the rest of this repository (`cli`, `core`, `flow`, `resend` are all Node), and the SDK owns
retries, timeouts, structured output and any future tool-calling. The trade being accepted is a
194 MB image and a dependency tree to keep patched, against ~15 MB and no CVE surface for the bash
command that was here before.

Where that 194 MB goes, measured rather than estimated: 15 MB of base, **139 MB of `nodejs`**, and
~40 MB of `node_modules`. Node itself is the floor, so a Node task costs an order of magnitude more
image than a `curl`-and-`jq` one however it is built. What *was* recoverable came to 41 MB: a
single-stage build left npm (15 MB) and its cache (24 MB) in the runtime, so the Dockerfile
installs in a build stage and copies only `node_modules` forward. That also leaves no package
manager in the published image.

## Params in

A param named `maxTokens` reaches the container as `PARAM_MAXTOKENS` — the name upper-cased with
`-` replaced by `_`, so camel case is simply flattened. `PARAM_NAMES` carries the original names,
which is how `task-core` hands back `maxTokens` rather than `MAXTOKENS`.

| Param | Environment variable | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `endpoint` | `PARAM_ENDPOINT` | yes | — | OpenAI-compatible base URL; `/chat/completions` is appended (a trailing `/` is trimmed) |
| `token` | `PARAM_TOKEN` | yes | — | Bearer token. Declare it `password`-typed so Flow filters it out of run reads and log streams |
| `model` | `PARAM_MODEL` | yes | — | Model id to request |
| `prompt` | `PARAM_PROMPT` | yes | — | The user message |
| `systemPrompt` | `PARAM_SYSTEMPROMPT` | no | none | Prepended as a `system` message when non-empty |
| `temperature` | `PARAM_TEMPERATURE` | no | `0.7` | Number |
| `maxTokens` | `PARAM_MAXTOKENS` | no | `1024` | Integer, sent as `max_tokens` |
| `responseFormat` | `PARAM_RESPONSEFORMAT` | no | `text` | `json` sends `response_format: {"type": "json_object"}` and fails the task if the completion is not JSON |
| `seed` | `PARAM_SEED` | no | none | Integer, for reproducible sampling where the provider supports it |
| `files` | `PARAM_FILES` | no | none | Comma-separated paths on the run workspace; each is appended to the user message as a fenced block under a `## <path>` heading |
| `maxContextBytes` | `PARAM_MAXCONTEXTBYTES` | no | `65536` | Byte budget for the file context; files that would exceed it are skipped and named in the prompt so the model knows the context is partial |

An unreadable path in `files` fails the task rather than quietly sending less context.

## Results out

| Result | Source |
| --- | --- |
| `output` | `choices[0].message.content` |
| `promptTokens` | `usage.prompt_tokens` |
| `completionTokens` | `usage.completion_tokens` |
| `totalTokens` | `usage.total_tokens` |
| `finishReason` | `choices[0].finish_reason` |
| `model` | `model` — the model as served, which may be more specific than the one asked for |

Both result channels are handled from the one image:

| `RESULTS_PATH` is | Executor | What is written |
| --- | --- | --- |
| a directory (`/tekton/results`) | Tekton | one file per result, the file name being the result name |
| a file (`/dev/termination-log`) | Kubernetes Jobs | one compact JSON object with the six keys |

`RESULTS_PATH` defaults to `/tekton/results` when the executor does not set it. All results
together must not exceed 4096 bytes — enforced platform-side, and the native cap of the
termination-message file the Kubernetes Jobs executor uses — so a long completion will exceed it.
Nothing truncates the answer to fit. For long output, lower `maxTokens`, or have the model write to
a workspace file and return the path.

## Failure

Any failure exits non-zero with the reason on stderr, and the engine ends the task `failed`. The
reasons are prefixed so they are greppable: `MISSING_PARAM`, `INVALID_PARAM`, `FILE_NOT_READABLE`,
`REQUEST_FAILED`, `REQUEST_REJECTED`, `INVALID_RESPONSE`, `NO_COMPLETION`.

`429`, `5xx` and transport failures are retried, three attempts in total, on the SDK's exponential
backoff with jitter (it also retries `408` and `409`). Any other `4xx` fails at once — a rejected
token or an unknown model will be rejected again. The failure names the status and quotes the first
512 characters of the provider's reason; the token is never printed, on any path, because nothing
logs the request headers.

## Network zone

The endpoint is usually the only thing this container needs to reach. A deployment that wants AI
traffic confined registers a dispatcher for the `ai` type alone (`flow.dispatcher.task-types=ai`)
in a namespace whose egress policy allows the endpoint and nothing else.

## Tests

```bash
bash tasks/ai/tests/run.sh
```

Runs `bin/prompt.js` against `tests/mock_openai.py`, a scripted stand-in for the endpoint, and
asserts the request body, the six results on both results channels, the file-context truncation,
the retry and failure paths, and that the command never puts the token in its own output. 58
assertions, no image build and no network. Needs `node` with this package's dependencies installed
(`pnpm install`), plus `bash`, `curl`, `jq` and `python3`.

The harness delivers `PARAM_NAMES` alongside the `PARAM_<NAME>` variables exactly as the platform
does, so the suite exercises the real param channel through `task-core` rather than a simplified
one.

The suite is black-box — it drives the command through its environment and reads what it writes —
so it carried across from the bash implementation this replaces unchanged apart from the line that
invokes it.

## Build

```bash
docker build -f tasks/ai/Dockerfile -t boomerangio/task-ai:local .
```

**The build context is the repository root**, not `tasks/ai`, so pnpm resolves
`@boomerang-io/task-core` as a workspace dependency instead of fetching it from the npm registry —
the same arrangement as `tasks/resend`. No task-core release has to happen before this image can be
built or tagged.

Two stages: pnpm resolves and deploys the dependency tree in the first and stays behind, so the
published image carries node, the deployed `node_modules` and the command — no pnpm, no npm, no
build toolchain.
