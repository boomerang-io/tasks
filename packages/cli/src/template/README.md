# Boomerang Flow Task Template

Starter template for creating Boomerang Flow Tasks

## Understanding the template

### Basic Hello

```sh
npm start -- greetings hello
```

### With ENV input

```sh
export FLOW_FRIEND=Joe
npm start -- greetings helloFriend
```

This will return with

```
01/01/21 10:11:12 🤖  Boomerang Task CLI 2.0.0
01/01/21 10:11:12 🤖  Executing command helloFriend
01/01/21 10:11:12 🤖  Hello Joe, welcome to Boomerang Flow!
```

## Getting Started

1. Add a `.js` file to `commands` folder that exports an object with functions
2. Execute new method by running `pnpm run dev -- <filename> <method>`

### How it works

The `boomerang-task-cli` imports all the `*.js` modules in the `./commands` directory. The file name of the exported module becomes the `commmand` and any functions on the exported object are executable methods.

## Folder Structure

    |-- .gitignore
    |-- Dockerfile
    |-- package.json
    |-- README.md
    |-- .github
        |-- PULL_REQUEST_TEMPLATE.md
        |-- ISSUE_TEMPLATE.md
    |-- commands
        |-- command.js
    |-- tests
        |-- command.spec.js

### Key Files and Directories

`.npmrc` - necessary to install `@boomerang-io` scoped npm modules  
`Dockerfile` - containerize and execute commands in a kubernetes environments  
`commands` - where all of your modules are located to be registered and executed by `boomerang-task-cli`

## Available Scripts

### `npm run dev`

Execute `boomerang-task-cli` in local mode. Used for local development.

### `pnpm run dev:debug`

Execute `boomerang-task-cli` in local and debug mode

### `pnpm run format`

Format your code with [Prettier](https://prettier.io/)

### `pnpm run lint`

Lint your `.js` files with [ESLint](https://eslint.org/)

### `pnpm start`

Execute `boomerang-task-cli`. Used for execution in worker environment. There are assumptions made about files and directories available.

### `pnpm run test`

Execute unit tests with [Jest](https://jestjs.io/)

### `pnpm run test:coverage`

Execute unit tests with [Jest](https://jestjs.io/) and generate coverage report

## Testing

[Jest](https://jestjs.io/) is included as a test runner with scripts to execute unit tests and generate code coverage reports.

## Project Configuration

The template includes configuration for the following:

- Code Formatting via [Prettier](https://prettier.io/)
- Linting via [ESLint](https://eslint.org/)
- Precommit hooks via [Husky](https://github.com/typicode/husky)
- Commit standards via [Commitlint](https://github.com/conventional-changelog/commitlint) (not configured by default, but recommended)

Enable commit standards via [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0-beta.4/) by adding the following to your `package.json`.

```js
"husky": {
    "hooks": {
      "commit-msg": "commitlint -e $HUSKY_GIT_PARAMS",
    }
  }
```

## Troubleshooting

- Make sure that your `commands` directory only includes `.js` files that export modules. The CLI will try to register every matching file in it.

## Further Reading

- [Boomerang Tasks](https://github.com/boomerang-io/tasks)
