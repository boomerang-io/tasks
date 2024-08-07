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
    ? `${process.cwd()}/tests/params`
    : "/params";

export default (function () {
  // Read in parameter property files
  let files = [];
  try {
    files = fs.readdirSync(__path);
  } catch (err) {
    log.warn("Failed to get params - ", err);
    return;
  }

  // log.debug("Param Files:", files);
  //TODO, provide the Environment Variables in the response? Do we need to do this anymore or can developers just pull from ENV
  // log.debug("Environment Variables\n", process.env);

  /**
   * Read in param files
   * - Reduce to build up one object with all of the parameters
   * - No longer need to parse file as a properties file. It will be the entire contents of the file.
   */
  const params = files.reduce((accum, file) => {
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
  return params;
})();
