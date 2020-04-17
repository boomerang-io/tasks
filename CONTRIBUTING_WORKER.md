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
- Access to IBM network

### 1. Add `@boomerang-worker` scope

You need to tell npm to look for the `@boomerang-worker` scoped packages in our Boomerang Artifactory instance. To do this, add the value below to your local `.npmrc` file. npm has more documentation about [scopes](https://docs.npmjs.com/using-npm/scope.html_) and the [.npmrc](https://docs.npmjs.com/configuring-npm/npmrc.html).

```sh
# .npmrc
"@boomerang-worker:registry=https://tools.boomerangplatform.net/artifactory/api/npm/"
```

You can easily set this at the global and user level with the following command:

```sh
npm config set @boomerang-worker:registry https://tools.boomerangplatform.net/artifactory/api/npm/boomeranglib-npm/
```

### 2. Initialize Project

Open a shell and run the command below.

```sh
npx @boomerang-worker/cli init
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

Create a [new project](https://github.ibm.com/organizations/Boomerang-Workers/repositories/new) in our Boomerang Worker GitHub Enterprise organization

Use the `name` property from the `package.json` in the root of the project to following the Boomerang Worker naming standard.

Following guidance for pushing your local project to the newly created one.

## Troubleshooting

### `npx` failed

- Check that you have the correct versions of node and npm installed
- Make sure that you are connected to the IBM network. Our `@boomerang-worker` packages are hosted on an internal Artifactory instance.

### `init` command failed

- Check that you are not running the command in a .git repository
- Make sure that isn't an existing directory with the same name as what the CLI is trying to create

### Nothing works, how can I be unblocked

- You can manually copy the files from the `packages/cli/template` into a new directory outside a local git repositoryand run `npm install` inside it.
