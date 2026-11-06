import { log, params } from "@boomerang-io/task-core";
import shelljs from "shelljs";
import fs from "fs";
import { asBoolean, resolvePath } from "../libs/task.js";

// Where a script runs when no path is given: the v3 data mount, else the v5 workspace root.
const DEFAULT_DIRECTORIES = ["/data", "/workspace"];

/** The directory to run in: the path given (absolute, or relative to /workspace), else the first default that exists. */
function workingDirectory(path) {
  if (path && path.trim() && path !== '""') {
    return resolvePath(path.trim());
  }
  const fallback = DEFAULT_DIRECTORIES.find((dir) => fs.existsSync(dir)) ?? process.cwd();
  log.debug(`No directory specified. Defaulting to ${fallback}...`);
  return fallback;
}

export function execute() {
  log.debug("Inside Shell Plugin");
  const { path, shell, script, failOnError } = params;

  const dir = workingDirectory(path);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    log.err("No such directory:", dir);
    return process.exit(1);
  }
  shelljs.cd(dir);

  let config = {
    verbose: false,
  };
  if (!shell || shell === '""') {
    log.debug("No shell interpreter specified. Defaulting...");
  } else {
    config.shell = shell;
  }
  // Without it a shell's exit status is its last command's, so an earlier failure goes unnoticed.
  let toRun = script ?? "";
  if (asBoolean(failOnError)) {
    log.debug("failOnError is set: the script runs under set -e");
    toRun = `set -e\n${toRun}`;
  }
  log.debug("Script to execute:", toRun);
  shelljs.exec(toRun, config, function (code, stdout, stderr) {
    if (code != 0) {
      log.err("  Exit code:", code);
      log.err("  Program stderr:", stderr);
      return process.exit(code);
    }
  });

  log.debug("End Shell Plugin");
}
