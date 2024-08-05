# Boomerang Task Packages

## Design

The CLI has a main `cli.js` which imports all the `*.js` files under `./commands` folder. These are then mapped to the task / plugins command that are sent through as arguments on the Task. A command and sub command are required for all runs.

### Handling Failure

When a method fails, we need to set or return (depending on the type of method) by catching the error to log and then return process.exit(1). This allows the container to fail the Kubernetes Pod which will in turn eventually bubble up the failure to the UI.

## Packaging

The following command will use lerna to release new versions of the modules. It determines minor and iteration release numbers and the changelog based on git commit messages.

`pnpm release`

## Local Development

_TBA_

## References

- https://medium.com/nmc-techblog/building-a-cli-with-node-js-in-2024-c278802a3ef5
- https://scotch.io/tutorials/build-an-interactive-command-line-application-with-nodejs
