# Welcome to the Boomerang Tasks

This repository is the monorepo for anything to do with the Boomerang Tasks, in particular for Boomerang Flow.

For documentation about Boomerang Flow and its Tasks, please visit our [website](https://usebooemrang.io).

Also, please join our community on [Slack](https://join.slack.com/t/boomerang-io/shared_invite/zt-pxo2yw2o-c3~6YvWkKNrKIwhIBAKhaw).

## Node Packages

Provide an opinionated set of core methods as well as an opinionated CLI for the the Boomerang Task containers.

To learn more about the packages, please refer to the [packages README](./packages/README.md).

### CLI

Main execution script providing task developers the ease of just having to write a `.js` file to do a specific command.

### Core

Provides a set of utilities to help task developers speed up their development

| Method | Purpose                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| common | Collection of common methods that can be used by task developers to enhance and speed the ease of their development |
| log    | Collection of logging utilities using chalk to output nice values in the log for the user                           |
| utils  | Collection of utility functions to help plugin authors retrieve, resolve, and set properties.                       |

## Tasks

There are a number of tasks that are used by Boomerang Flow, including SendGrid, Slack, Artifactory, Box, etc.

Generally the tasks will run using the Task CLI, however they can be any container that can run as a Kubernetes Job or Tekton Task, i.e.  short lived and single execution focus.

These are all located in the [`./tasks` folder](./tasks). To learn more about Tasks, please refer to the [README](./tasks/README.md).

## Contributing

We welcome all contributions. Please read the [Contributing Guidelines](./CONTRIBUTING.md).

Do you want to contribute your own Task? Follow our [Contributing a Task Guidelines](./CONTRIBUTING_TASKS.md) for initializing a project to get started quickly.

### Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) to ensure that the commit messages are easy to read and follow a standard format that can then be used in automated changelog generation.