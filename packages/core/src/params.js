import * as log  from "./log.js";
// import properties from "properties";
import appRoot from "app-root-path";
const { NODE_ENV } = process.env;
import fs from "fs";

/**
 * Param retrieval as a utility
 * 
 * - Param resolution is already completed in the Workflow Engine prior to execution
 *   - In difference to prior versions, this utitlity no longer needs to resolve parameters
 * - An alternative to the Tekton params available via ENV variables or content replacement
 * - Especially useful if using an alternate non Tekton handler
 */
// For the new v4 parameter substitution
const paramProps = {
  PATH: NODE_ENV === "local" || NODE_ENV === "test" ? `${appRoot}/tests/params` : "/flow/params",
  FILENAME: "",
};

export default (function () {
  // Read in parameter property files
  let files = [];
  try {
    files = fs.readdirSync(paramProps.PATH);
  } catch (err) {
    log.warn("Failed to get parameters - ", err);
    return;
  }

  log.debug("Parameter Files Found:", files);
  //TODO, provide the Environment Variables in the response? Do we need to do this anymore or can developers just pull from ENV
  // log.debug("Environment Variables\n", process.env);

  /**
   * Read in param files
   * - Reduce to build up one object with all of the parameters
   * - No longer need to parse file as a properties file. It will be the entire contents of the file.
   */
  const params = files
    .reduce((accum, file) => {
      const contents = fs.readFileSync(`${paramProps.PATH}/${file}`, "utf8");
      log.debug("  Param: " + file + " Content: " + contents.toString());
      accum[file] = contents.toString();
      return accum;
    }, {});
  return params;
})();
