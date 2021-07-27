# Boomerang Flow Worker Template

Starter template for creating Boomerang Flow Workers

## Getting Started

1. Add `.js` file to `commands` folder that exports an object with functions
2. Execute new method by running `npm run dev -- <filename> <method>`

```js
// ./commands/greetings.js
module.exports = {
  hello: () => console.log("Hello from Boomerang"),
  goodbye: () => console.log("Goodbye, friend"),
};
```

```sh
npm start -- greetings hello
```

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

`.npmrc` - necessary to install `@boomerang-worker` scoped npm modules  
`Dockerfile` - containerize and execute commands in a kubernetes environments  
`commands` - where all of your modules are located to be registered and executed by `boomerang-worker-cli`

### How it works

The `boomerang-worker-cli` imports all the `*.js` modules in the `./commands` directory. The file name of the exported module becomes the `commmand` and any functions on the exported object are executable methods.

## Available Scripts

### `npm run dev`

Execute `boomerang-worker-cli` in local mode. Used for local development.

### `npm run dev:debug`

Execute `boomerang-worker-cli` in local and debug mode

### `npm run format`

Format your code with [Prettier](https://prettier.io/)

### `npm run lint`

Lint your `.js` files with [ESLint](https://eslint.org/)

### `npm start`

Execute `boomerang-worker-cli`. Used for execution in worker environment. There are assumptions made about files and directories available.

### `npm run test`

Execute unit tests with [Jest](https://jestjs.io/)

### `npm run test:coverage`

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

- [Boomerang Worker CLI and Core](https://github.ibm.com/Boomerang-Workers/boomerang.worker.base)
