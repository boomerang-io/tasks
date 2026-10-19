// Loaded with --import by the fixture runner when a case asserts which modules a command loads.
// Registers a resolve hook that appends every resolved module URL to $TASK_AI_MODULE_RECORD.
import { register } from "node:module";

register(new URL("./record-modules-hooks.mjs", import.meta.url));
