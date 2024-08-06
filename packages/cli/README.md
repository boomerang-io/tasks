# task-cli

An opinionated CLI for wrapping and running the task logic.

## Usage

### `init`

Use the init command to initialise a new task from template.

The init will copy in the template files and create a new task in the specified directory, set up dependencies, and initialise a git repo.

```sh
npx @boomerang-io/task-cli init
```

> Note: this uses **pnpm** as the package manager.

### <filename> <method>

Run via the package.json script as part of the task execution. Any file placed in the `commands` folder can be referenced and executed.

- `<filename>` is the name of the file in the folder i.e. slack.js would be `slack`
- `<method>` is the exported function inside the file to run.

```sh
pnpm run dev -- <filename> <method>
```
