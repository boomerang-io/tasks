# Boomerang Worker Interface

The following interface provide an opinionated CLI for the the Boomerang Workers, in particular for Boomerang Flow, by providing an easy to leverage CLI with core functionality

- Provides task developers the ease of just having to write a `.js` file to do a specific command.
- Provides a set of utilities to help task developers speed up their development
  - Common methods that can be used by task developers to enhance and speed the ease of their development
  - Logging utilities using chalk to output nice values in the log for the user
  - Collection of utility functions to help plugin authors retrieve, resolve, and set params

## Contributing

We welcome all contributions. Please read the [Contributing Guidelines](./CONTRIBUTING.md).

Do you want to contribute your own worker? Follow our [Contributing a Worker Guidelines](./CONTRIBUTING_WORKER.md) for initializing a project to get started quickly.

## Design

The CLI has a main `cli.js` which imports all the `*.js` files under `./commands` folder. These are then mapped to the task / plugins command that are sent through as arguments on the Task. A command and sub command are required for all runs.

### Handling Failure

When a method fails, we need to set or return (depending on the type of method) by catching the error to log and then return process.exit(1). This allows the container to fail the Kubernetes Pod which will in turn eventually bubble up the failure to the UI.

## Packaging

The following command will use lerna to release new versions of the modules. It determines minor and iteration release numbers and the changelog based on git commit messages.

`pnpm release`

## Local Development

_TBA_

## Troubleshooting

### Cleaning up jobs in Kubernetes

When running against the non production cluster. You will need to clean up your runs using `kubectl delete job -l "app=bmrg-flow"`

### ESLint not working in VSCode

Try adding the following to your VSCode `settings.json` file

```json
"eslint.workingDirectories": [
    {
      "mode": "auto"
    }
  ],
```

## References

- https://medium.com/nmc-techblog/building-a-cli-with-node-js-in-2024-c278802a3ef5
- https://scotch.io/tutorials/build-an-interactive-command-line-application-with-nodejs
