# Boomerang Flow Worker Template

Starter template for creating worker templates

## Folder Structure

    |-- .npmrc
    |-- .gitignore
    |-- .github
        |-- PULL_REQUEST_TEMPLATE.md
    |-- README.md
    |-- package.json
    |-- Dockerfile
    |-- command.js
    |-- command.spec.js
    |-- commands
        |-- index.js

## Design

## Local Development

## Testing

## Learn More

## Troubleshooting

The CLI has a main cli.js which imports all the `*.js` files under `./commands` folder. These are then mapped to the task / plugins command that are sent through as arguments on the flow_task_template mongodb collection. A command and sub command are required for all runs.

### CLI

The CLI is a main execution script that offers task developers the ease of just having to write a js file to do a specific command.

### Core

The core module containers the following main methods

| Method | Purpose                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| common | Collection of common methods that can be used by task developers to enhance and speed the ease of their development |
| log    | Collection of logging utilities using chalk to output nice values in the log for the user                           |
| utils  | Collection of utility functions to help plugin authors retrieve, resolve, and set properties.                       |

In addition the following files are used: config.js and index.js

### Handling Failure

When a method fails, we need to set or return (depending on the type of method) by catching the error to log and then return process.exit(1). This allows the container to fail the Kubernetes Pod which will in turn eventually bubble up the failure to the UI.

## Packaging

The following command will use lerna to release new versions of the modules. It determines minor and iteration release numbers and the changelog based on git commit messages.

`npm run-script release`

## Clean up

### Cleaning up jobs in Kubernetes

When running against the non production cluster. You will need to clean up your runs using `kubectl delete job -l "app=bmrg-flow"`

## References

- [Node Initial Starter Tutorial](https://scotch.io/tutorials/build-an-interactive-command-line-application-with-nodejs)
