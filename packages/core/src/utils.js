const log = require("./log");
const properties = require("properties");
const fetch = require("node-fetch");
const fs = require("fs");
const { isLocalEnv } = require("./config");
const { workflowProps, PROPS_FILES_CONFIG } = require("./config");

/**
 * Use IFFE to enscapsulate parameters
 */
module.exports = (function () {
  // Read in parameter property files
  let files = [];
  try {
    files = fs.readdirSync(workflowProps.WF_PROPS_PATH);
  } catch (err) {
    log.warn("Failed to get parameters", err);
    return;
  }

  log.debug("Parameter Files Found:", files);
  log.debug("Environment Variables\n", process.env);

  /**
   * Filter out files that don't match
   * Read in filtered files
   * Reduce to build up one object with all of the parameters
   */

  const { PROPS_FILENAMES, INPUT_PROPS_FILENAME_PATTERN } = PROPS_FILES_CONFIG;
  const props = files
    .filter((file) => PROPS_FILENAMES.includes(file) || INPUT_PROPS_FILENAME_PATTERN.test(file))
    .reduce((accum, file) => {
      const contents = fs.readFileSync(`${workflowProps.WF_PROPS_PATH}/${file}`, "utf8");
      log.debug("  File: " + file + " Original Content: " + contents);
      // Updated strict options for parsing multiline parameters from textarea boxes.
      var options = {
        comments: "#",
        separators: "=",
        strict: true,
        reviver: function (key, value) {
          if (key != null && value == null) {
            return '""';
          } else {
            //Returns all the lines
            return this.assert();
          }
        },
      };
      const parsedProps = properties.parse(contents, options);
      log.debug("  File: " + file + " Parsed Content: ", parsedProps);
      accum[file] = parsedProps;
      return accum;
    }, {});
  return {
    /**
     * Substitute task props that have workflow property notation with corrsponding workflow props
     * @returns Object
     * @deprecated
     */
    substituteTaskInputPropsValuesForWorkflowInputProps() {
      //log.debug("Inside substituteTaskInputPropsValuesForWorkflowInputProps Utility");

      const taskInputProps = props[PROPS_FILES_CONFIG.TASK_INPUT_PROPS_FILENAME];
      const workflowInputProps = props[PROPS_FILES_CONFIG.WORKFLOW_INPUT_PROPS_FILENAME];
      //log.debug(taskInputProps);
      const substitutedTaskInputProps = Object.entries(taskInputProps)
        .filter(
          (taskInputEntry) =>
            log.debug("Value Found:", taskInputEntry[1]) || workflowProps.WF_PROPS_PATTERN.test(taskInputEntry[1])
          //typeof taskInputEntry[1] == "string" && !!taskInputEntry[1].match(workflowProps.WF_PROPS_PATTERN)
        ) //Test the value, and return arrays that match pattern
        .map((filteredProps) => {
          log.debug("Task property found requiring substitutions:", filteredProps);
          const matchedProps = filteredProps[1].match(workflowProps.WF_PROPS_PATTERN_GLOBAL); //Get value from entries array, find match for our property pattern, pull out first matching group
          log.debug("Property references in match:", matchedProps);

          for (var property of matchedProps) {
            /** @todo use original regex for capture group of key*/
            var propertyKey = property.replace("${p:", "").replace("}", "");
            var protectedProperty = false;
            let replacementStr = "";
            /** @todo update this. Workflow System and Input properties might conflict*/
            if (property.includes("workflow/controller.service.url")) {
              /** @todo properly detect a list of protected properties*/
              replacementStr = "";
              protectedProperty = true;
            } else if (property.includes("workflow/")) {
              const prop = propertyKey.split("/")[1];
              replacementStr = props[`workflow.system.properties`][prop];
            } else if (property.includes("task/")) {
              const prop = propertyKey.split("/")[1];
              replacementStr = props[`task.system.properties`][prop];
            } else if (propertyKey.startsWith("cicd/")) {
              const prop = propertyKey.substring(propertyKey.indexOf("/") + 1);
              replacementStr = workflowInputProps[`${prop}`];
            } else if (property.includes("/")) {
              const [key, prop] = propertyKey.split("/");
              replacementStr = props[`${key.replace(/\s+/g, "")}.output.properties`][prop];
            } else {
              replacementStr = workflowInputProps[`${propertyKey}`] ? workflowInputProps[`${propertyKey}`] : "";
            }
            if (!replacementStr) {
              protectedProperty ? log.warn("Protected property:", property) : log.warn("Undefined property:", property);
            } else {
              log.debug("Replacing property:", property, "with:", replacementStr);
              filteredProps[1] = filteredProps[1].replace(property, replacementStr);
            }
          }
          return filteredProps;
        })
        .reduce((accum, [k, v]) => {
          accum[k] = v;
          return accum;
        }, {});

      //Combine both w/ new values overwriting old ones
      const substitutedProps = {
        ...taskInputProps,
        ...substitutedTaskInputProps,
      };
      return substitutedProps;
    },
    resolveInputParameters() {
      log.debug("Resolving input parameters...");
      const taskInputParams = props[PROPS_FILES_CONFIG.TASK_INPUT_PROPS_FILENAME];
      const taskSystemParams = props[PROPS_FILES_CONFIG.TASK_SYSTEM_PROPS_FILENAME];
      const workflowSystemParams = props[PROPS_FILES_CONFIG.WORKFLOW_SYSTEM_PROPS_FILENAME];
      const workflowInputParams = props[PROPS_FILES_CONFIG.WORKFLOW_INPUT_PROPS_FILENAME];

      var allParamsDecoded = {};
      if (taskInputParams && Object.prototype.hasOwnProperty.call(taskInputParams, "allParams")) {
        log.debug("Decoding allParams content...");
        allParamsDecoded = Buffer.from(taskInputParams["allParams"], "base64").toString("utf-8");
        log.debug("All Parameters Decoded:\n", allParamsDecoded);
      }
      // Layered to ensure that system params cannot be overwritten by the user

      log.debug("Returning resolved parameters...");
      const layeredParams = {
        ...workflowInputParams,
        ...allParamsDecoded,
        ...taskInputParams,
        ...workflowSystemParams,
        ...taskSystemParams,
      };
      return layeredParams;
    },
    resolveInputParameter(key) {
      log.debug("Resolving input parameter");
      const params = this.resolveInputParameters();
      return params[key];
    },
    async setOutputParameter(key, value) {
      log.debug("Setting individual task output parameter");

      /**
       * Call internal method
       * To set a object key using a variable it needs to be between [] (computed parameter)
       * this." is necessary in order to call a different function of this module
       */
      await this.setOutputParameters({ [key]: value });
    },
    async setOutputParametersFromFile(fileName) {
      log.debug("Setting task output parameters from file");
      const contents = fs.readFileSync(fileName, "utf8");
      log.debug("  File: " + fileName + " Original Content: " + contents);
      // Updated strict options for parsing multiline parameters from textarea boxes.
      var options = {
        comments: "#",
        separators: "=",
        strict: true,
        reviver: function (key, value) {
          if (key != null && value == null) {
            return '""';
          } else {
            //Returns all the lines
            return this.assert();
          }
        },
      };
      const parsedParams = properties.parse(contents, options);
      log.debug("  File: " + fileName + " Parsed Content: ", parsedParams);
      await this.setOutputParameters(parsedParams);
    },
    async setOutputParameters(parameters) {
      log.debug("Setting task output parameters");
      /**
       * Please note the current limitation that this method can only be called once.
       *
       * The controller endpoint also only accepts Map<String, String> so not full JSON
       */
      //Validation that parameters is in fact an array of key values
      try {
        if (!(Object.keys(parameters) && typeof parameters === "object")) {
          log.warn("Parameters variable isn't a valid object");
          return;
        }
      } catch (error) {
        log.warn(error);
        return;
      }

      log.debug("  parameters: ", JSON.stringify(parameters));

      const { WORKFLOW_SYSTEM_PROPS_FILENAME, TASK_SYSTEM_PROPS_FILENAME } = PROPS_FILES_CONFIG;
      const workflowSystemProps = props[WORKFLOW_SYSTEM_PROPS_FILENAME];
      const taskSystemProps = props[TASK_SYSTEM_PROPS_FILENAME];
      const controllerUrl = workflowSystemProps["controller-service-url"];
      const workflowId = workflowSystemProps["workflow-id"];
      const activityId = workflowSystemProps["workflow-activity-id"];
      const taskId = taskSystemProps["task-id"];
      const taskName = taskSystemProps["task-name"].replace(/\s+/g, "");

      if (isLocalEnv) {
        return Promise.resolve();
      }

      return fetch(
        `http://${controllerUrl}/controller/results/parameters/set?workflowId=${workflowId}&workflowActivityId=${activityId}&taskId=${taskId}&taskName=${taskName}`,
        {
          method: "patch",
          body: JSON.stringify(parameters),
          headers: { "Content-Type": "application/json" },
        }
      )
        .then((res) => log.debug(res))
        .catch((err) => log.err("setOutputParameters", err));
    },
  };
})();
