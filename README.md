# Boomerang Worker Interfaces

The following interfaces provide integrations to the Boomerang Workers, in particular for Boomerang Flow, by providing an easy to leverage CLI and also Common Core functions or methods.

### CLI

The CLI is a main execution script that offers task developers the ease of just having to write a `.js` file to do a specific command.

### Core

The core module containers the following main methods

| Method | Purpose                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| common | Collection of common methods that can be used by task developers to enhance and speed the ease of their development |
| log    | Collection of logging utilities using chalk to output nice values in the log for the user                           |
| utils  | Collection of utility functions to help plugin authors retrieve, resolve, and set properties.                       |

In addition the following files are used: config.js and index.js

## Contributing

We welcome all contributions. Please read the [Contributing Guidelines](./CONTRIBUTING.md).

Do you want to contribute your own worker? Follow our [Contributing a Worker Guidelines](./CONTRIBUTING_WORKER.md) for initializing a project to get started quickly.

## Design

The CLI has a main `cli.js` which imports all the `*.js` files under `./commands` folder. These are then mapped to the task / plugins command that are sent through as arguments on the `flow_task_template mongodb` collection. A command and sub command are required for all runs.

### Project Structure

Uses [yarn workspaces](https://classic.yarnpkg.com/en/docs/workspaces/) and [lerna](https://github.com/lerna/lerna) to manage the project as a monorepo.

### Handling Failure

When a method fails, we need to set or return (depending on the type of method) by catching the error to log and then return process.exit(1). This allows the container to fail the Kubernetes Pod which will in turn eventually bubble up the failure to the UI.

## Packaging

The following command will use lerna to release new versions of the modules. It determines minor and iteration release numbers and the changelog based on git commit messages.

`yarn release`

## Clean up

### Cleaning up jobs in Kubernetes

When running against the non production cluster. You will need to clean up your runs using `kubectl delete job -l "app=bmrg-flow"`

## References

- [Node Initial Starter Tutorial](https://scotch.io/tutorials/build-an-interactive-command-line-application-with-nodejs)

## Local Development

Go to CLI package and install it globally for use outside of project. Link for use inside another project that has it as a dependency.

```sh
cd packages/cli
yarn install -g
yarn link
```

Open shell and run command to execute CLI

```sh
boomerang-worker-cli
```

If you want to test changes in another projectd that uses the CLI, in the root of the project run the following command:

```sh
yarn link "@boomerang-worker/cli"
```

## Troubleshooting

**ESLint not working in VSCode**

Try adding the following to your VSCode `settings.json` file

```json
"eslint.workingDirectories": [
    {
      "mode": "auto"
    }
  ],
```
