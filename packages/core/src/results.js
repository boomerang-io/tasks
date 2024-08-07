import * as log from "./log.js";
import fs from "fs";
const { NODE_ENV } = process.env;

/**
 * Param retrieval as a utility for v4
 *
 * - Param resolution is already completed in the Workflow Engine prior to execution
 *   - In difference to prior versions, this utitlity no longer needs to resolve parameters
 * - An alternative to the Tekton params available via ENV variables or content replacement
 * - Especially useful if using an alternate non Tekton handler
 */
const __path =
  NODE_ENV === "local" || NODE_ENV === "test"
    ? `${process.cwd()}/tests/results`
    : "/tekton/results";

export async function set(key, value) {
  await setAll({ [key]: value });
}
export default async function setAll(results) {
  /**
   * Read in param files
   * - Reduce to build up one object with all of the parameters
   * - No longer need to parse file as a properties file. It will be the entire contents of the file.
   */
  log.debug("  parameters: ", JSON.stringify(results));

  //check if folder exists
  if (!fs.existsSync(__path)) {
    log.warn("Unable to set results, path doesn't exist: ", __path);
  } else {
    for (var [key, value] of Object.entries(results)) {
      log.debug("Setting task result: ", key, " = ", value);
      try {
        if (typeof value === "number" || typeof value === "object") {
          value = JSON.stringify(value);
        } else if (typeof value === "boolean") {
          value = String(value);
        }
        fs.writeFileSync(__path + "/" + key, value, (err) => {
          if (err) {
            log.err(err);
            throw err;
          }
          log.debug("Task result successfully saved.");
        });
      } catch (e) {
        log.err(e);
      }
    }
  }
}
