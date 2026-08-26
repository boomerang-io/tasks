import * as log from "./log.js";
import fs from "fs";
const { NODE_ENV, PARAM_NAMES } = process.env;

/**
 * Param retrieval as a utility for v4/v5
 *
 * - Param resolution is already completed in the Workflow Engine prior to execution
 * - v5 agents deliver every param as an environment variable PARAM_<NAME> (name upper-cased,
 *   any character outside [A-Za-z0-9_] replaced by "_"; non-string values JSON-encoded) and
 *   list the original names in PARAM_NAMES so they can be mapped back exactly.
 * - The /params file-per-param directory is the v4 (Tekton projected ConfigMap) channel and
 *   stays as the fallback so one task-core works against both agents.
 */
const __path =
  NODE_ENV === "local" || NODE_ENV === "test"
    ? `${process.cwd()}/tests/params`
    : "/params";

function envName(name) {
  return "PARAM_" + name.toUpperCase().replace(/[^A-Za-z0-9_]/g, "_");
}

function fromEnv() {
  if (PARAM_NAMES === undefined) {
    return undefined;
  }
  const names = PARAM_NAMES === "" ? [] : PARAM_NAMES.split(",");
  const params = names.reduce((accum, name) => {
    const value = process.env[envName(name)];
    if (value !== undefined) {
      log.sys("Retrieving param: " + name + ", value: " + value);
      accum[name] = value;
    }
    return accum;
  }, {});
  log.debug("Retrieved params from PARAM_* environment variables");
  return params;
}

function fromFiles() {
  let files = [];
  try {
    files = fs.readdirSync(__path);
  } catch (err) {
    log.warn("Failed to get params - ", err);
    return;
  }

  /**
   * Read in param files
   * - Reduce to build up one object with all of the parameters
   * - The entire contents of the file is the value.
   */
  return files.reduce((accum, file) => {
    const __filepath = `${__path}/${file}`;
    log.debug("Inspecting potential param file: " + file);
    const stat = fs.statSync(__filepath);
    if (stat.isFile()) {
      const contents = fs.readFileSync(__filepath, "utf8");
      log.sys("Retrieving param: " + file + ", value: " + contents.toString());
      accum[file] = contents.toString();
    }
    return accum;
  }, {});
}

export default (function () {
  return fromEnv() ?? fromFiles();
})();
