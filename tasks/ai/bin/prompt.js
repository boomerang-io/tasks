#!/usr/bin/env node
//
// The entry point for the `ai-prompt` catalogue task. Its revision names the command `prompt`,
// which the image puts on PATH as a link to this file.
//
// A failure goes to stderr and exits non-zero, so the engine ends the task `failed` with a reason
// the task author can act on. The task's own logging goes to stdout.
import { run } from "../commands/prompt.js";
import { main } from "../lib/main.js";

await main("ai/prompt", run);
