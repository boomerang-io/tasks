// Runs one artifact command in its own process so its process.exit() calls
// terminate the runner rather than the mocha process driving the tests.
import { upload, download } from "../../commands/artifact.js";

const [, , command] = process.argv;

if (command === "upload") {
  await upload();
} else if (command === "download") {
  await download();
} else {
  console.error(`Unknown artifact command: ${command}`);
  process.exit(1);
}
