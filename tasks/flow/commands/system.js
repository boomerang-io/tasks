import { log, params, result } from "@boomerang-io/task-core";
import fs from "fs";
import jp from "jsonpath";
import { checkParameters, isValidJson } from "../libs/utilities.js";
import { resolvePath } from "../libs/task.js";

/**
 * Evaluates the query and sets `evaluation`. A query that matches nothing still succeeds, with an
 * empty evaluation and a warning, so a later task can branch on it. The value is logged at debug
 * level only: this task often picks a token out of an HTTP response.
 */
async function evaluate(json, query) {
  log.sys("Commencing json parsing of", query, "query.");
  let propertyValue;
  try {
    propertyValue = jp.value(json, query);
  } catch (e) {
    log.err(`Invalid JSON path expression '${query}': ${e.message}`);
    process.exit(1);
  }
  if (propertyValue === undefined) {
    log.warn(`The query '${query}' matched nothing; 'evaluation' is empty`);
    propertyValue = "";
  } else {
    log.sys(`Finished parsing: the query matched a ${Array.isArray(propertyValue) ? "array" : propertyValue === null ? "null" : typeof propertyValue}`);
    log.debug("Value from query:", JSON.stringify(propertyValue));
  }
  await result("evaluation", propertyValue);
  log.good("Parameter 'evaluation' set");
}

export async function jsonPathToProperty() {
  log.debug("Inside Json Path To Property Plugin");

  //Destructure and get properties ready.
  const { json, query } = params;

  // Validate mandatory parameters
  if (checkParameters({ json, query })) {
    log.err(`Invalid mandatory parameters. Check log for details`);
    process.exit(1);
  }
  let newJSON = isValidJson(json);
  if (!newJSON) {
    log.err("Invalid JSON string passed to task");
    process.exit(1);
  }

  log.debug("Json Query:", query);
  await evaluate(newJSON, query);

  log.debug("Finished Json Path To Property Plugin");
}

export async function jsonFilePathToProperty() {
  log.debug("Inside Json File Path To Property Plugin");

  //Destructure and get properties ready.
  const { filePath, query } = params;

  // Validate mandatory parameters
  if (checkParameters({ filePath, query })) {
    log.err(`Invalid mandatory parameters. Check log for details`);
    process.exit(1);
  }

  try {
    // A relative path names a workspace under /workspace, as the other file commands take it.
    const file = resolvePath(filePath);
    const fileContent = fs.readFileSync(file, "utf8");
    log.good("The file was succesfully read!");
    let newJSON = isValidJson(fileContent);
    if (!newJSON) {
      log.err("Invalid JSON content in the file passed to task");
      return process.exit(1);
    }
    log.good("Valid JSON content in the file!");

    log.debug("Json Query:", query);
    await evaluate(newJSON, query);
  } catch (e) {
    log.err(e.message ?? e);
    process.exit(1);
  }

  log.debug("Finished Json File Path To Property Plugin");
}
