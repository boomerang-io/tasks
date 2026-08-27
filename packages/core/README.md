# @boomerang-io/task-core

Boomerang Task Core — a Node.js convenience library for reading task params and writing task
results inside a Boomerang task container.

## Maintenance mode

This package is **maintenance mode, not the contract**. The documented task contract in
[`CONTRIBUTING_TASKS.md`](../../CONTRIBUTING_TASKS.md#task-contract) — plain environment
variables and files — is the supported integration surface for a task written in any language
(Go, Python, a shell script, ...). `task-core` is an optional convenience wrapper for Node.js
tasks; it is kept working and published, but new capability lands in the contract doc first.

`3.0.0` speaks both contract generations:

- **v5**: `PARAM_NAMES` / `PARAM_<NAME>` env vars, `RESULTS_PATH` (directory or file, detected
  with `stat`).
- **v4**: falls back to the `/params` directory and `/tekton/results` when the v5 env vars
  aren't present, so existing v4 tasks built against this package keep working unchanged.

## Install

```sh
npm install @boomerang-io/task-core
```

## Usage

```js
import { params, results, log, result, common, CICDError } from "@boomerang-io/task-core";
```

See `src/index.js` for the full export surface.
