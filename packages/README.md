# Boomerang Task Packages

This repository contains the node packages for the Boomerang Flow Tasks.

> Note: the packages were previously @boomerang-io/worker-core and @boomerang-io/worker-cli. These have been deprecated in favor of the new packages.

## Design

The CLI has a main `cli.js` which imports all the `*.js` files under `./commands` folder. These are then mapped to the task / plugins command that are sent through as arguments on the Task. A command and sub command are required for all runs.

### Handling Failure

When a method fails, we need to set or return (depending on the type of method) by catching the error to log and then return process.exit(1). This allows the container to fail the Kubernetes Pod which will in turn eventually bubble up the failure to the UI.

## Packaging

The following command will use lerna to determine minor and iteration release numbers and the
changelog based on git commit messages.

```sh
git tag task-core@x.y.z
git tag task-cli@x.y.z
git push --tags
pnpm release
```

Pushing a `task-core@x.y.z` tag also triggers `.github/workflows/publish-task-core.yml`, which
publishes `@boomerang-io/task-core` to npm automatically — the manual `pnpm release`/lerna flow
above is for cutting the version bump and changelog, not for the npm publish step itself. The
tag version must match `packages/core/package.json`'s `version` or the publish workflow fails.
The older `@boomerang-io/task-core@x.y.z` tag form still works for the image workflows but is no
longer the documented convention — see `CONTRIBUTING_TASKS.md`.

## Local Development

_TBA_

## References

- https://medium.com/nmc-techblog/building-a-cli-with-node-js-in-2024-c278802a3ef5
- https://scotch.io/tutorials/build-an-interactive-command-line-application-with-nodejs
