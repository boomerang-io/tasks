import { shutdownTelemetry, startTelemetry } from "./telemetry.js";

/**
 * The life of one command: telemetry started if configured, the command run, a failure reported on
 * stderr, telemetry flushed, and the exit code set. The exit code depends only on the command.
 */
export async function main(label, run) {
  await startTelemetry();
  let code = 0;
  try {
    await run();
  } catch (e) {
    // A TaskError carries a reason the author can act on; anything else is a bug in the task or the
    // SDK, and its stack is what makes that debuggable.
    console.error(`${label}: ${e.name === "TaskError" ? e.message : (e.stack ?? e.message)}`);
    code = 1;
  }
  await shutdownTelemetry();
  if (code !== 0) {
    process.exit(code);
  }
  process.exitCode = 0;
  // A finished task exits even if an exporter socket is still open after the bounded flush. The
  // timer is unref'd, so it only fires when something else is keeping the process alive.
  setTimeout(() => process.exit(0), 100).unref();
}
