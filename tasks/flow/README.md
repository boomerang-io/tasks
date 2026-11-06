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

#### **Integration commands: shared rules** [libs/task.js](./libs/task.js)

The GitHub pipeline, Teams, SharePoint, Google Drive upload/download/share, Artifactory and HTTP Call commands share these rules:

- **Failure**: every failure is logged and exits 1. The task CLI does not await a command, so a thrown error would otherwise end the pod with exit code 0.
- **No credential in a log**: errors are reported as the status and the service's own error message, never the HTTP client's error object (which carries the request headers). A Teams webhook URL, which carries its signature, is never logged.
- **Paths**: a workspace path is absolute, or relative to `/workspace` (e.g. `workflowrun/reports/out.json`). A download `destinationPath` that is a directory, or ends with `/`, keeps the remote file's name. Downloads stream through a temp file beside the target, so a failed transfer leaves nothing behind.
- **Result size**: Kubernetes caps all of a task's results at 4096 bytes. A result holding variable-size data (`get-github-file-contents`'s `content`, `list-sharepoint-files`'s `files`) carries it only when it is 3000 bytes or less; past that the command needs `outputFile` and writes the data there instead, and fails rather than cut the data short when `outputFile` is blank.
- **Proxy**: `HTTP_PROXY` applies as it does for the other commands.

#### **GitHub pipeline commands** [commands/github.js](./commands/github.js)

Repository-scoped, so a GitHub App installation token (what Flow's GitHub integration shares as `$(workspace.params.github-token)`) works as well as a personal access token: no command calls a `/user` endpoint. Each takes `url` (the API URL, e.g. `https://api.github.com` or `https://github.example.com/api/v3`), `token`, `owner` and `repo`, and returns scalars rather than the response object.

| Command | Calls | Params beyond the four | Results | App permission |
| --- | --- | --- | --- | --- |
| `createIssue` | `POST /repos/{owner}/{repo}/issues` | `title`, `body`, `labels`, `assignees` (comma- or newline-separated), `milestone` | `issueNumber`, `issueUrl`, `issueId` | Issues: write |
| `commentOnIssueOrPullRequest` | `POST /repos/{owner}/{repo}/issues/{number}/comments` | `number`, `body` | `commentId`, `commentUrl` | Issues or Pull requests: write |
| `createPullRequest` | `POST /repos/{owner}/{repo}/pulls` | `title`, `head`, `base`, `body`, `draft` | `pullRequestNumber`, `pullRequestUrl` | Pull requests: write |
| `setCommitStatus` | `POST /repos/{owner}/{repo}/statuses/{sha}` | `sha`, `state` (pending, success, failure, error), `context`, `targetUrl`, `description` (shortened to GitHub's 140 characters) | `statusId` | Commit statuses: write |
| `dispatchWorkflow` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` | `workflow` (file name, path or ID), `ref`, `inputs` (JSON object) | `runId`, `runUrl` | Actions: write |
| `createRelease` | `POST /repos/{owner}/{repo}/releases` | `tagName`, `targetCommitish`, `name`, `body`, `draft`, `prerelease`, `generateReleaseNotes`, `makeLatest` | `releaseId`, `releaseUrl` | Contents: write |
| `getFileContents` | `GET /repos/{owner}/{repo}/contents/{path}` | `path`, `ref`, `outputFile` | `content`, `sha`, `size`, `outputPath` | Contents: read |

`dispatchWorkflow` asks for the run with `return_run_details` (github.com since February 2026). A server that predates it refuses the key as a validation error, before anything is dispatched, so the command dispatches again without it and leaves `runId` and `runUrl` empty. `getFileContents` reads a file over 1 MB through the Git blobs API (to 100 MB), refuses a directory, and needs `outputFile` for content that is not UTF-8 text.

#### **Microsoft Teams commands** [commands/teams.js](./commands/teams.js)

- `sendMessage` posts to a Teams Workflows webhook (the "Post to a channel when a webhook request is received" template); the Office 365 connector webhooks are retired. `webhookUrl` is a password param because the URL carries the webhook's signature. `title` and `message` become an Adaptive Card of two wrapped TextBlocks; `card` sends a whole Adaptive Card (`type: AdaptiveCard`, wrapped as a message attachment) or a whole message (`type: message`, sent as-is) instead.
- `createChannel` (`POST /teams/{teamId}/channels`) makes a `standard` or `private` channel. An app-only call has no signed-in user to own a private channel, so `owner` (a user principal name or object ID) is required for one. Needs the `Channel.Create` application permission.
- `addMember` (`POST /teams/{teamId}/members`) adds `user` as a `member` or `owner`. Needs `TeamMember.ReadWrite.All` (`TeamMember.ReadWriteNonOwnerRole.All` for members only); Graph does not add guests with application permissions.

#### **SharePoint commands** [commands/sharepoint.js](./commands/sharepoint.js)

`site` is the site's URL (any page or library URL under `/sites/<name>` or `/teams/<name>` is cut back to the site) or its Graph site ID; `library` is a document library's name or URL name (`Documents` or `Shared Documents`), blank for the site's default library.

- `uploadFile` puts `filePath` into `folder` (created if missing) as `fileName` (blank keeps the local name), with `conflictBehavior` `replace`, `fail` or `rename`. A file over 4 MB goes through a resumable upload session in 10 MiB chunks; the session URL is pre-authorised, so the token is not sent with the chunks. Results `itemId`, `webUrl`, `name`.
- `downloadFile` fetches `path` through the item's pre-authorised download URL (the token stays with Graph) to `destinationPath`, and checks the byte count against the size SharePoint lists. Results `path`, `size`.
- `listFiles` lists `folder` (blank is the library root) across pages. Results `count`, and `files` as a JSON array of `{name, path, type, size, lastModified, webUrl}`, where `path` is what `downloadFile` takes.

Application permissions: `Sites.ReadWrite.All` or `Files.ReadWrite.All` to upload, the `.Read.All` forms to download and list, or `Sites.Selected` with a grant on the site.

#### **Microsoft Graph credentials** [libs/msgraph.js](./libs/msgraph.js)

The Teams Graph commands and the SharePoint commands take `tenantId`, `clientId` and `clientSecret`, and each run mints its own app-only token with the client-credentials flow, so nothing outside the task refreshes a token. A call Graph throttles (429) or finds briefly unavailable (503) is tried three times in all, waiting as long as `Retry-After` says (capped at 30 seconds). `MICROSOFT_LOGIN_URL` and `MICROSOFT_GRAPH_URL` default to the global cloud and point at a national cloud instead.

#### **Google credentials and Drive commands** [libs/google.js](./libs/google.js), [commands/googledrive.js](./commands/googledrive.js)

Every Google Sheets and Drive command takes `serviceAccountKey`, the service account's whole JSON key file, parsed as JSON. Pasted into a single-line field the key stays valid JSON: the browser drops the newlines between members, and the private key's own line breaks are `\n` escapes inside the string. `clientEmail` and `privateKey` still work for revisions that declare them, and `serviceAccountKey` wins when both are set. A malformed key is reported without echoing any of it.

- `uploadFile` uploads `filePath` into `folderId` as `fileName`, with an optional `mimeType`. A service account has no Drive storage of its own, so the folder belongs in a shared drive it is a member of. Results `fileId`, `fileName`, `webViewLink`.
- `downloadFile` downloads `fileId` to `destinationPath`. A Google Docs, Sheets, Slides or Drawings file is exported, by default to `.docx`, `.xlsx`, `.pptx` or `.png`, or to `exportMimeType` (Drive exports up to 10 MB). Results `path`, `size`, `mimeType`.
- `shareFile` grants `role` (reader, commenter, writer) on `fileId` to a `user` or `group` (`emailAddress`), a `domain` (`domain`) or `anyone` with the link; `sendNotificationEmail` (default true) and `emailMessage` apply to a user or group. Results `permissionId`, `webViewLink`.

`listFiles` passes `corpora` and `driveId` through (with the shared-drive flags), so a shared drive can be listed; it writes its listing under the declared `results` and the `result` name it used before.

#### **HTTP Call command** [commands/http.js](./commands/http.js)

`http execute` serves execute-basic-http-call and execute-advanced-http-call: one request, judged by its status code, with the status as `statusCode` and the body as `response`.

| Param | Meaning |
| --- | --- |
| `url` | http or https. Credentials and the query string are left out of the log. |
| `method` | GET, HEAD, PUT, POST, PATCH, OPTIONS or DELETE; blank is GET. |
| `header` | One `Name: value` per line; one pair of quotes around a name or value is dropped. Only header names are logged. |
| `contentType` | Sets `Content-Type`, replacing one in `header`. |
| `body` | Sent exactly as written. For a JSON type (`application/json`, `+json`) it must parse; it is not reformatted, so large numbers keep their digits. JSON pasted with raw line breaks inside a string is accepted with those breaks removed, as the original command did. |
| `allowUntrustedCerts` | `true` skips verifying the server's certificate (also through a proxy). |
| `outputFilePath` | A workspace file (absolute, or relative to `/workspace`) for the body as received; `response` is then left empty. Needed for a body over 3000 bytes, which otherwise fails the task rather than be cut short. |
| `successcodes`, `errorcodes`, `retrycodes` | Comma-separated status codes or patterns with `x` for a digit (`2xx`, `404`, `50x`). |
| `retrynumber`, `retrydelay` | Retries after the first call (0 to 9, blank 0) and the milliseconds between them (100 to 300000, blank 200). |

A response is judged in order: an error code fails at once; any 2xx or a success code succeeds; a retry code is retried while retries remain; anything else fails. Redirects are not followed, so a 3xx is judged like any other status. A failed call still sets `statusCode`, and `response` when it fits. Failures before any response (`ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`) are retried on their own schedule, 3 times 5 seconds apart (the undeclared `systemretrynumber` and `systemretrydelay` params change it). `HTTP_PROXY` applies unless `NO_PROXY` lists the host or a parent domain of it.

#### **Slack webhook, JSONPath and Execute Shell fixes (3.4.0)**

- **Slack webhooks** (`sendSimpleMessage`, `sendRichMessage`, `sendCustomMessage`, `sendFileMessage`) fail the task on any error: Slack's answer (`HTTP 404: no_service`, `HTTP 400: invalid_payload`), an unreachable webhook, or a JSON param that does not parse. The webhook URL, which is the credential, is never logged. Blank `channel`, `username` and `icon` are left out of the payload, so the webhook's own apply (Slack apps' webhooks ignore all three). `sendFileMessage` decodes `content` when `encoded` is `true`, splits it into blocks of up to 3000 characters at line breaks, and leaves out what does not fit in one message (50 blocks) with a note.
- **JSONPath** (`jsonPathToProperty`, `jsonFilePathToProperty`): a query that matches nothing succeeds with an empty `evaluation` and a warning; an invalid expression fails. The value is logged at debug level only, since the task often picks a token out of a response. `filePath` is absolute or relative to `/workspace`.
- **Execute Shell** (`shell execute`): `path` is absolute or relative to `/workspace`, with or without a trailing slash; blank runs in `/data`, else `/workspace`, else the image's working directory. `failOnError: true` prepends `set -e`, so the first failing command fails the task; without it, as before, only the last command's exit status counts.

#### **Artifactory commands** [commands/artifactory.js](./commands/artifactory.js)

`downloadFile` fetches `url` to `destinationPath`; `uploadFile` PUTs `file` to `url` (the full artifact URL, file name included). The credential is `accessToken` (sent as `Authorization: Bearer`; JFrog no longer issues API keys), else `apiKey` (`X-JFrog-Art-Api`), else `username` and `password` (Basic). A download is checked against the `X-Checksum-Sha256` header Artifactory sends; an upload is checked against the SHA-256 Artifactory reports it stored. Results: download `path`, `size`, `sha256`; upload `downloadUri`, `sha256`, `size`.

### Testing the integration commands

`npm test` runs each command in its own process against a local mock of its service ([tests/helpers/harness.js](./tests/helpers/harness.js)): Octokit's `url` and Artifactory's `url` point at it directly, the Microsoft commands through `MICROSOFT_LOGIN_URL`/`MICROSOFT_GRAPH_URL`, and the Google commands through a test-only `--import` hook ([tests/hooks/google-mock.mjs](./tests/hooks/google-mock.mjs)) that gives the service account a fixed token and refuses any request that is not to the mock.

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
