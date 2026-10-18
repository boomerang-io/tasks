# task-ai fixtures

Every file in `fixtures/` is one case of the AI task contract: the params a task run receives, the
replies the model endpoint and any MCP servers give, and what the task must then write, send and
log. `run.js` replays them against this image's commands; another implementation of the same
contract (an in-process handler on the dispatcher SDK, for one) replays the same files against
itself, honouring the same fields.

```bash
node tests/run.js                 # all cases
node tests/run.js agent json      # cases whose file name contains either word
VERBOSE=1 node tests/run.js x     # print the command's stdout and stderr on a failure
```

No network and no image build. Needs `node` with this package's dependencies installed
(`pnpm install` at the repository root).

## A case

```json
{
  "description": "what the case proves",
  "command": "prompt | agent",
  "params": { "endpoint": "${PROVIDER}", "token": "sk-test", "model": "m", "prompt": "..." },
  "env": { "OPENAI_API_KEY": "..." },
  "workspace": { "relative/path.txt": "contents" },
  "resultsChannel": "directory | file",
  "provider": [ { "status": 200, "body": { "...": "a chat-completions response" } } ],
  "mcp": { "serverName": { "token": "optional", "tools": [ { "name": "...", "inputSchema": {}, "result": "text" } ] } },
  "expect": { "...": "see below" }
}
```

- **params**: exactly what reaches the task, every value a string (a JSON param is JSON text). The
  runner delivers them as `PARAM_NAMES` plus `PARAM_<NAME>`, as the platform does. Placeholders:
  `${PROVIDER}` is the mock endpoint's base URL, `${MCP:name}` a mock MCP server's URL,
  `${WORKSPACE}` the case's temporary run workspace.
- **env**: extra environment for the task (the executor-default credentials, for example).
- **workspace**: files to create on the run workspace before the task starts.
- **resultsChannel**: `directory` (Tekton, one file per result; the default) or `file` (Kubernetes
  Jobs, one JSON object).
- **provider**: the scripted replies, in order; the last one repeats once the list is exhausted,
  which is how a persistent failure is modelled.
- **mcp**: MCP servers to serve over streamable HTTP, keyed by the name the case's `mcpServers`
  param uses. A `token` makes the server reject any request without that bearer token. Each tool's
  `result` is a string (returned as text), `{ "text": "...", "isError": true }`, or `"echo"` to
  return the call's arguments as JSON.

## Expectations

| Field | Meaning |
| --- | --- |
| `exit` | `0` (the default) or `"nonzero"` |
| `results` | result name to expected value, as text; a partial match, other results may exist |
| `resultKeys` | the exact set of results written |
| `noResults` | result names that must not have been written |
| `stdout`, `stderr` | substrings that must appear |
| `stdoutNot`, `stderrNot` | substrings that must not appear (a token, for one) |
| `requestCount` | how many requests the endpoint received |
| `requests` | per request (by position, or by `index`): `path`, `authorization`, `contentType` and a partial match on `body` |
| `mcpCallCount`, `mcpCalls` | tool calls the MCP servers received: `{ server, tool, arguments }` |
| `workspace` | files that must exist on the workspace afterwards, with their exact contents |

A partial match checks every key given and ignores the rest; arrays match element by element and
must have the same length. Three markers stand in for values: `"$absent"` (the key must not exist),
`"$present"` (it must), and `"$contains:text"` (a string containing `text`).

## Replaying elsewhere

An implementation that does not run as a container maps the fields the same way: `params` are the
task's params by name, `provider` is what its model client must be shown in order, `mcp` the
servers it must connect to, `results` what it must hand back, and the request expectations what it
must have sent. The cases that assert `stdout` lines (the agent's JSON trace, task-core's log
lines) are this image's; an implementation with its own log format skips those assertions, not the
cases.
