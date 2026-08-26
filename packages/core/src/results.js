import * as log from "./log.js";
import fs from "fs";
const { NODE_ENV, RESULTS_PATH } = process.env;

/**
 * Result emission for v4/v5
 *
 * - RESULTS_PATH is set by the v5 agents. A directory (Tekton: /tekton/results) takes one
 *   file per result; a file (Kubernetes Jobs: /dev/termination-log) takes the whole
 *   {name: value} map as one JSON object.
 * - Without RESULTS_PATH this falls back to the v4 Tekton directory.
 * - Either way the 4096-byte Kubernetes termination-message cap applies to the total.
 */
const __path =
  NODE_ENV === "local" || NODE_ENV === "test"
    ? `${process.cwd()}/tests/results`
    : RESULTS_PATH || "/tekton/results";

function stringify(value) {
  if (typeof value === "number" || typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return value;
}

export default async function set(results) {
  log.debug("  results: ", JSON.stringify(results));

  let stat;
  try {
    stat = fs.statSync(__path);
  } catch (err) {
    log.warn("Unable to set results, path doesn't exist: ", __path);
    return;
  }

  if (stat.isDirectory()) {
    for (const [key, value] of Object.entries(results)) {
      log.debug("Setting task result: ", key, " = ", value);
      try {
        fs.writeFileSync(__path + "/" + key, stringify(value));
      } catch (e) {
        log.err(e);
      }
    }
    return;
  }

  // Single-file target: merge with anything already written so repeated calls accumulate.
  let existing = {};
  try {
    const current = fs.readFileSync(__path, "utf8");
    existing = current ? JSON.parse(current) : {};
  } catch (e) {
    existing = {};
  }
  const merged = { ...existing };
  for (const [key, value] of Object.entries(results)) {
    merged[key] = stringify(value);
  }
  try {
    fs.writeFileSync(__path, JSON.stringify(merged));
  } catch (e) {
    log.err(e);
  }
}
