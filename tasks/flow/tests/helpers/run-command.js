// Runs one command export (e.g. `artifact upload`) in its own process so its process.exit() calls
// terminate the runner rather than the mocha process driving the tests.
const [, , moduleName, command] = process.argv;

const commands = await import(`../../commands/${moduleName}.js`);

if (typeof commands[command] !== "function") {
  console.error(`Unknown command: ${moduleName} ${command}`);
  process.exit(1);
}

await commands[command]();
