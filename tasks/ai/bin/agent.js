#!/usr/bin/env node
//
// The entry point for the `ai-agent` catalogue task. Its revision names the command `agent`, which
// the image puts on PATH as a link to this file.
//
// A failure goes to stderr and exits non-zero, so the engine ends the task `failed` with a reason
// the task author can act on. The task's own logging and trace go to stdout.
import { run } from "../commands/agent.js";

try {
  await run();
} catch (e) {
  // A TaskError carries a reason the author can act on; anything else is a bug in the task or the
  // SDK, and its stack is what makes that debuggable.
  console.error(`ai/agent: ${e.name === "TaskError" ? e.message : (e.stack ?? e.message)}`);
  process.exit(1);
}
