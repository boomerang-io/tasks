# Contribute a Worker

## Prerequisites

Before contributing your own worker, make sure that you have the following tools installed.

- [Node.js](https://nodejs.org/en/download/) v10 or greater
  - If you're on macOS, we recommend using
    [`nvm`](https://github.com/nvm-sh/nvm) to help manage different versions of
    Node.js [nvm](https://github.com/nvm-sh/nvm/blob/master/README.md) as your
    version manager for Node.
- [npm](https://www.npmjs.com/) v5.2 or greater
- [Git](https://git-scm.com/)

### 1. `@boomerang-io` scope

The interface packages are available on npm under the boomerang-io organization and scope. npm has more documentation about [scopes](https://docs.npmjs.com/using-npm/scope.html_) and [.npmrc](https://docs.npmjs.com/configuring-npm/npmrc.html) if you need it manually configured.

### 2. Initialize Project

Open a shell and run the command below.

```sh
npx @boomerang-io/worker-cli init
```

It will prompt you to answer a couple of questions about the worker and attempt to create a new project with all the files and dependencies that you need to get started quickly.

You should have the following

- A new directory
- An initialized git repo in the new directory
- The base dependencies installed with an initial commit performed

If something goes wrong, view the error message or take a look at [Troubleshooting](#Troubleshooting) below.

### 4. Navigate to project

A `README.md` is included in the new project with instructions on getting started and how everything works. It includes information about the file structure.

### 5. Create a new project in GitHub Enterprise

Create a [new project](https://github.ibm.com/organizations/boomerang-io/repositories/new) in our Boomerang GitHub organization

Use the `name` property from the `package.json` in the root of the project to follow the Boomerang Worker naming standard.

Follow the guide for pushing your local project to the newly created repository.

## Troubleshooting

### `npx` failed

- Check that you have the correct versions of node and npm installed
- Can access the `@boomerang-io` scoped packages.

### `init` command failed

- Check that you are not running the command in a .git repository
- Make sure that isn't an existing directory with the same name as what the CLI is trying to create

### Nothing works, how can I be unblocked

- You can manually copy the files from the `packages/cli/template` into a new directory outside a local git repositoryand run `npm install` inside it.
