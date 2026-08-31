# Contribute a Worker

## Prerequisites

Before contributing your own worker, make sure that you have the following tools installed.

- [Node.js](https://nodejs.org/en/download/) v10 or greater
  - If you're on macOS, we recommend using
    [`nvm`](https://github.com/nvm-sh/nvm) to help manage different versions of
    Node.js [nvm](https://github.com/nvm-sh/nvm/blob/master/README.md) as your
    version manager for Node.
- [npm](https://www.npmjs.com/) v5.2 or greater
- [Git](https://git-scm.com/)

### 1. `@boomerang-io` scope

The interface packages are available on npm under the boomerang-io organization and scope. npm has more documentation about [scopes](https://docs.npmjs.com/using-npm/scope.html_) and [.npmrc](https://docs.npmjs.com/configuring-npm/npmrc.html) if you need it manually configured.

### 2. Initialize Project

Open a shell and run the command below.

```sh
npx @boomerang-io/worker-cli init
```

It will prompt you to answer a couple of questions about the worker and attempt to create a new project with all the files and dependencies that you need to get started quickly.

You should have the following

- A new directory
- An initialized git repo in the new directory
- The base dependencies installed with an initial commit performed

If something goes wrong, view the error message or take a look at [Troubleshooting](#Troubleshooting) below.

### 4. Navigate to project

A `README.md` is included in the new project with instructions on getting started and how everything works. It includes information about the file structure.

### 5. Create a new project in GitHub Enterprise

Create a [new project](https://github.ibm.com/organizations/boomerang-io/repositories/new) in our Boomerang GitHub organization

Use the `name` property from the `package.json` in the root of the project to follow the Boomerang Worker naming standard.

Follow the guide for pushing your local project to the newly created repository.

## Troubleshooting

### `npx` failed

- Check that you have the correct versions of node and npm installed
- Can access the `@boomerang-io` scoped packages.

### `init` command failed

- Check that you are not running the command in a .git repository
- Make sure that there isn't an existing directory with the same name as what the CLI is trying to create

### Nothing works, how can I be unblocked

- You can manually copy the files from the `packages/cli/template` into a new directory outside a local git repositoryand run `npm install` inside it.

## Task contract

`@boomerang-io/task-core` (`packages/core`) is a convenience library for Node.js tasks — it is
**not** the contract itself. The actual contract between the platform and a task container is
plain environment variables and files, so a task written in any language (Go, Python, a shell
script, ...) can implement it directly without depending on `task-core` at all. This section
documents that contract. `task-core` is published to npm as `@boomerang-io/task-core`
independently of the platform, tagged `task-core@<version>` (see "Release tags" below); the
package's own README documents which contract generations a given release speaks.

### Platform version: `FLOW_VERSION`

`FLOW_VERSION` is set to the running platform's semver string (e.g. `5.0.0`). Use it to branch
on capability when a task needs to behave differently across platform versions — e.g. detecting
whether `RESULTS_PATH` (v5) will be present versus falling back to the v4 `/tekton/results`
default.

### Reading params: `PARAM_NAMES` / `PARAM_<NAME>`

Every resolved param is delivered as an environment variable:

- `PARAM_NAMES` — a comma-separated list of the original param names, e.g. `PARAM_NAMES=path,retryCount`.
- `PARAM_<NAME>` — one variable per param, holding its value, where `<NAME>` is the original
  name folded as described below.

Param names are restricted platform-side to `^[a-zA-Z_][a-zA-Z0-9-_]*$` (letters, digits, `-`,
`_`; must start with a letter or underscore — no dots, since `.` is the reference-path separator
in `$(params.x)` expressions). Given that charset, the fold to an env var name is exactly *upper-case + `-` → `_`*:

- Shell: `echo "$name" | tr 'a-z-' 'A-Z_'`
- JavaScript: `name.toUpperCase().replaceAll('-', '_')`
- Python: `name.upper().replace('-', '_')`

So a param named `retry-Count` is delivered as `PARAM_RETRY_COUNT`. Name matching is
**case-insensitive** platform-side, and case/separator-variant duplicates (e.g. `retryCount` and
`retry_count` on the same task) are **rejected at save time** — you will never see two params
collide onto the same `PARAM_<NAME>` at runtime.

Non-string param values are JSON-encoded into the env var; decode with `JSON.parse` /
`json.loads` / etc. when you expect an object, array, number, or boolean.

**Cap**: all params combined MUST NOT exceed 16KB — enforced platform-side.

### Writing results: `RESULTS_PATH`

`RESULTS_PATH` tells you where to write task results, and its value is **either a directory or a
file** depending on the executor — detect which with `stat`, don't assume:

- **Directory** (Tekton executor, conventionally `/tekton/results`): write **one file per
  result**, file name = result name, file contents = the raw value (this is the Tekton results
  convention).
- **File** (Kubernetes-Jobs executor, `/dev/termination-log`): write **one JSON object**
  containing every result as `{ "name": "value", ... }` — overwriting (or merging with) whatever
  is already there, since the file is written once as your task's termination message.

**Cap**: all results combined MUST NOT exceed 4096 bytes — enforced platform-side (this is also
why the Kubernetes-Jobs executor uses the termination-message file, which carries the same cap
natively).

### Copy-paste snippets

**JavaScript (no library, Node.js built-ins only):**

```js
import fs from "node:fs";

// --- Read params ---
const names = (process.env.PARAM_NAMES ?? "").split(",").filter(Boolean);
const params = Object.fromEntries(
  names.map((name) => {
    const envName = "PARAM_" + name.toUpperCase().replaceAll("-", "_");
    return [name, process.env[envName]];
  })
);

// --- Write results ---
function writeResults(results) {
  const path = process.env.RESULTS_PATH ?? "/tekton/results";
  const isDirectory = fs.statSync(path).isDirectory();

  if (isDirectory) {
    for (const [key, value] of Object.entries(results)) {
      fs.writeFileSync(`${path}/${key}`, String(value));
    }
    return;
  }

  // Single-file target (termination log): merge with anything already written.
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(path, "utf8") || "{}");
  } catch {
    existing = {};
  }
  fs.writeFileSync(path, JSON.stringify({ ...existing, ...results }));
}
```

**Shell:**

```sh
# --- Read params ---
IFS=',' read -ra PARAM_NAME_LIST <<< "$PARAM_NAMES"
for name in "${PARAM_NAME_LIST[@]}"; do
  env_name="PARAM_$(echo "$name" | tr '[:lower:]-' '[:upper:]_')"
  echo "$name = ${!env_name}"
done

# --- Write results ---
write_result() {
  key="$1"; value="$2"
  target="${RESULTS_PATH:-/tekton/results}"
  if [ -d "$target" ]; then
    printf '%s' "$value" > "$target/$key"
  else
    # Single-file target: naive last-writer-wins merge via jq.
    existing="$(cat "$target" 2>/dev/null || echo '{}')"
    echo "$existing" | jq --arg k "$key" --arg v "$value" '. + {($k): $v}' > "$target"
  fi
}
```

**Python:**

```python
import json
import os
import stat

# --- Read params ---
names = [n for n in os.environ.get("PARAM_NAMES", "").split(",") if n]
params = {
    name: os.environ.get("PARAM_" + name.upper().replace("-", "_"))
    for name in names
}

# --- Write results ---
def write_results(results: dict) -> None:
    path = os.environ.get("RESULTS_PATH", "/tekton/results")
    is_directory = stat.S_ISDIR(os.stat(path).st_mode)

    if is_directory:
        for key, value in results.items():
            with open(os.path.join(path, key), "w") as f:
                f.write(str(value))
        return

    # Single-file target (termination log): merge with anything already written.
    try:
        with open(path, "r") as f:
            existing = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        existing = {}
    existing.update(results)
    with open(path, "w") as f:
        json.dump(existing, f)
```

### Release tags

Each publishable artifact in this repo releases off its own tag, `<name>@<version>`, matched by
that artifact's workflow. Tags use the short form `<name>@<version>` (e.g. `task-flow@3.1.0`,
`task-core@3.0.0`); the older `@boomerang-io/<name>@<version>` form is no longer matched.
