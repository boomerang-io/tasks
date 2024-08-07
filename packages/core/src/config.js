// /* eslint-disable no-useless-escape */
// const { NODE_ENV, DEBUG } = process.env;
// import appRoot from "app-root-path";

// const isDebug = DEBUG === "true";
// const isLocalEnv = NODE_ENV === "local";

// const inputOptions = {
//   path: true,
//   namespaces: false,
//   sections: false,
//   variables: false,
//   include: false,
// };
// const workflowProps = {
//   WF_PROPS_PATH: NODE_ENV === "local" || NODE_ENV === "test" ? `${appRoot}/props` : "/props",
//   WF_COMMANDS_PATH: NODE_ENV === "local" || NODE_ENV === "test" ? `${appRoot}/commands` : "/cli/commands",
//   // We have two properties that are the same other than the Global regex flag
//   // This is as regex.test(), if passed global, will not reset the index from word to word of our search
//   // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/test
//   WF_PROPS_PATTERN: /\$\{p:([\w\ \.]*\/){0,2}([\w\.]+)\}/,
//   WF_PROPS_PATTERN_GLOBAL: /\$\{p:([\w\ \.]*\/){0,2}([\w\.]+)\}/g,
// };
// // For the new v4 parameter substitution
// const paramProps = {
//   PATH: NODE_ENV === "local" || NODE_ENV === "test" ? `${appRoot}/params` : "/flow/params",
//   FILENAME: "",
// };

// const outputOptions = {
//   path: `${workflowProps.WF_PROPS_PATH}/output.properties`,
//   unicode: true,
// };

// const WORKFLOW_INPUT_PROPS_FILENAME = "workflow.input.properties";
// const WORKFLOW_SYSTEM_PROPS_FILENAME = "workflow.system.properties";
// const TASK_INPUT_PROPS_FILENAME = NODE_ENV === "test" ? "test.task.input.properties" : "task.input.properties";
// const TASK_SYSTEM_PROPS_FILENAME = "task.system.properties";

// const PROPS_FILES_CONFIG = {
//   WORKFLOW_INPUT_PROPS_FILENAME,
//   WORKFLOW_SYSTEM_PROPS_FILENAME,
//   TASK_INPUT_PROPS_FILENAME,
//   TASK_SYSTEM_PROPS_FILENAME,
//   PROPS_FILENAMES: [
//     WORKFLOW_INPUT_PROPS_FILENAME,
//     WORKFLOW_SYSTEM_PROPS_FILENAME,
//     TASK_INPUT_PROPS_FILENAME,
//     TASK_SYSTEM_PROPS_FILENAME,
//   ],
//   INPUT_PROPS_FILENAME_PATTERN: /^.+\.output\.properties$/,
// };

// export {
//   inputOptions,
//   workflowProps,
//   paramProps,
//   outputOptions,
//   PROPS_FILES_CONFIG,
//   isDebug,
//   isLocalEnv,
// };
