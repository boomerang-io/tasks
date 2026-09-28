# Boomerang Flow Default Task

This is the Boomerang Flow Tasks that runs the out of the box tasks and map to the tasks in Flow.

Depends on:

- [Boomerang Task CLI](../../packages/README.md)
- [Boomerang Task Core](../../packages/README.md)

## Design

TBA

### Failure

When a method fails, we need to set or return (depending on the type of method) by catching the error to log and then return process.exit(1). This allows the container to fail the Kubernetes Pod which will in turn eventually bubble up the failure to the UI.

## Developing and Testing

When developing commands you can run `npm run-script dev` which will run the CLI with DEBUG enabled. This means that it will look for a `/props` folder locally which allows you to feed in the property model as required.

### How to Test locally with Docker

1. Build with the Dockerfile-test by passing in `-f Dockerfile.test` to the docker build command
2. Run and pass in required commander parameters `docker run -i -t bmrg-worker-flow:test -- slack sendWebhook`

Example: `docker build -t bmrg-worker-flow:test -v /props:/props . && docker run -i -t bmrg-worker-flow:test -- slack sendWebhook`

> This requires developers to have kept this dockerfile up to date
> The test Dockerfile will try to immitate the peices that Kubernetes Controller takes care of such as mounting a `/data` directory and `/props/*.properties`

### How to Test locally with Node.js

1. Ensure that you have the package cross-env installed
2. Run the `run-script dev` script and pass in arguments

```
npm run-script dev -- slack sendWebhook
```

### Setting input Variables for Testing

Under the `props` folder, you can set input variables:
`task.input.properties` -> set variables that will be the input for a task plugin
`workflow.input.properties` -> these variables will be available across tasks

These files are designed to replicate the properties that would be mounted in confimaps by the controller service.

### Development guide

#### **Utilities file / functions** [libs/utilities.js](./libs/utilities.js)

**_Descriptions_**: This file contains utility functions that are to be used/reused in other tasks to offer the developer a faster way to check for missing parameters, display missing parameters, unset parameters, removal of specific properties from objects, etc.
**_Functions_**

- _checkIfEmpty_: Check if param is set or not, in case of mandatory inputs;
- _unsetField_: Removes every property from object, with the name 'fieldName';
- _checkParameters_: Validates all attributes of the supplied object. Returns true if all parameters are valid;
- _checkForJson_: Try to check if valid JSON and convert it to JS Object.

#### **Artifact commands** [commands/artifact.js](./commands/artifact.js)

**_Descriptions_**: `artifact upload` and `artifact download` move a file or folder between the run workspace and object storage through a presigned URL. The file bytes never pass through Flow — the engine fills the link fields on the task run when it hands the task to the dispatcher, so these commands talk directly to the object store using ordinary task params.

**_Task params_**

| Param            | Used by  | Meaning                                                                                                                                                |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`           | both     | The artifact's name.                                                                                                                                   |
| `path`           | both     | Upload: a file or directory. Download: the destination. Absolute, or relative to `/workspace` (e.g. `workflowrun/reports/sbom.json`). |
| `url`            | both     | A presigned URL (PUT for upload, GET for download), valid ~15 minutes, for exactly one object.                                                         |
| `headers`        | both     | A JSON object string of headers the request must send, possibly empty or missing (`{}` if so); e.g. Azure Blob needs `{"x-ms-blob-type":"BlockBlob"}`. |
| `retention-days` | upload   | Applied by Flow, not read by this worker.                                                                                                              |
| `sha256`         | download | Lowercase hex SHA-256 of the file as stored, checked after download.                                                                                   |
| `contentType`    | download | The stored object's content type; drives whether the download is unpacked as a folder.                                                                 |

A relative `path` resolves against `/workspace`, the parent of every default workspace mount, so it names its workspace: `workflowrun/...` or `workflow/...`. An absolute path (e.g. `/data/...` or a custom `mountPath`) is used as-is.

Like every task param, these arrive as `PARAM_<NAME>` environment variables resolved by `@boomerang-io/task-core`'s `params` (see `packages/core/src/params.js`): the name is upper-cased and every character outside `[A-Za-z0-9_]` becomes `_`. For this task that resolves to `PARAM_NAME`, `PARAM_PATH`, `PARAM_URL`, `PARAM_HEADERS`, `PARAM_RETENTION_DAYS`, `PARAM_SHA256`, and `PARAM_CONTENTTYPE` (no separator — `contentType` upper-cases to `CONTENTTYPE`), alongside `PARAM_NAMES` listing which of them are set.

**_Folder handling_**: uploading a directory packs its _contents_ (not the directory itself) into a gzipped tarball with `Content-Type: application/vnd.boomerang.artifact.tar+gzip`, using the platform `tar` binary, so it unpacks flat into whatever destination directory the download side picks. Downloading an artifact stored with that content type creates the destination directory and extracts the tarball into it; any other content type is written as a single file, placed under `path` if it names a directory (or ends with `/`), or at `path` directly otherwise.

**_Verification_**: uploads stream the file straight from disk with `Content-Length` set to its size (files can be gigabytes, so nothing is buffered in memory); downloads stream to a temp file while hashing it, and a SHA-256 mismatch against `sha256` deletes the temp file and fails the task rather than leaving a corrupt file in place.

## Packaging

### Automatic

1. Create Git Tag
2. Push Git Tag
3. Check Boomerang CICD

### Manual

`VERSION=<tag> && docker build -t boomerangio/task-flow:$VERSION . && docker push boomerangio/task-flow:$VERSION`

## Clean up

### Cleaning up jobs in Kubernetes

When running against the non production cluster. You will need to clean up your runs using `kubectl delete job -l "app=bmrg-flow"`

## Handling new versions of Tasks

Within the Flow UI, you are able to go in and create a new version of a task, you also have the option to overwrite the current version of the task. How do you go about making this decision when creating updates to tasks in the boomerang.flow.worker?

### When to create a new version?

Basically if this update to a task could potentially break a user's flow, then this needs to be a new version. Examples of this type of behavior include:

- Adding a field to a task
- Removing a field from a task
- Changing the functionality drastically in such a way where a previously configured flow may break or no longer function in the same way due to the changes.

### When to overwrite the previous version?

If you are not introducing any breaking changes as listed above, then you do not want to create a new version. Instances where you would want to overwrite a task version may include:

- Updating the task template to add more specific or helpful text in the config for a task
- Your new release of the task fixes a bug or handles some type of edge case that was previously uncovered.

As long as the release of the worker does not introduce anything that could break an existing flow, a new task version is not needed.

### How to go about rolling out a new version

If a new version is created for a task, this change needs to be captured within the loader, so that we can keep the loader as the source of truth and not have version discrepancies between environments.

If you are looking to make an update to a task's version. You can make this update in QA and then coordinate with the service team so that they can capture the task templates from stage and update within the loader. They will then run the loader against dev and test, continuing this process of promotion and testing until out in live.

### Specifying the worker version

We specify a version of the worker in the controller that is the default for out of the box tasks. You can change which version of the worker that a specific task points to by updating the `image` in the Flow UI for that task. Set it to tools.boomerangplatform.net:8500/ise/bmrg-worker-flow:2.x.x (substitute for your desired version) and save in order to overwrite the default worker.

## References

- [Docker](https://github.com/docker-library/docker/blob/master/Dockerfile.template)
