# Catalogue definitions

The catalogue tasks this image serves that were added or revised from `task-flow@3.3.0` on, one
file per task, in exactly the shape of Flow's seed (`service-core/src/main/resources/seed/tasks.json`
and `task-revisions.json`): `task` is the tasks.json head and `revisions[]` are task-revisions.json
documents, joined by `parentRef`.

Flow's seed is a copy of these files. For a task Flow seeded before 3.3.0, `task` is the existing
head unchanged and `revisions[]` holds only the revisions added here; the earlier ones stay as
Flow has them. A seeded revision is never edited: a change to a contract is a new revision.

Every revision here pins `spec.image` to the `boomerangio/task-flow` tag it was written against,
since a revision with a blank image runs whatever default image the Flow install is configured
with, which may predate the command. `spec.arguments` is `[<command module>, <method>]`, the
`boomerang-task-cli` arguments the image's entrypoint takes.

## task-flow 3.3.0

Sheets revision 4 and Drive revision 3 came after the image, without a new one: each is its
3.3.0 revision (Sheets 3, Drive 2) with only `serviceAccountKey`'s default, `version` and
`changelog` changed, still pinned to `boomerangio/task-flow:3.3.0` (Flow PR #764).

| Task | Revision | Arguments | What it is |
| --- | --- | --- | --- |
| `create-github-issue` | 1 | `github createIssue` | new |
| `comment-on-github-issue` | 1 | `github commentOnIssueOrPullRequest` | new |
| `create-github-pull-request` | 1 | `github createPullRequest` | new |
| `set-github-commit-status` | 1 | `github setCommitStatus` | new |
| `dispatch-github-workflow` | 1 | `github dispatchWorkflow` | new |
| `create-github-release` | 1 | `github createRelease` | new |
| `get-github-file-contents` | 1 | `github getFileContents` | new |
| `send-teams-message` | 1 | `teams sendMessage` | new |
| `create-teams-channel` | 1 | `teams createChannel` | new |
| `add-teams-member` | 1 | `teams addMember` | new |
| `upload-sharepoint-file` | 1 | `sharepoint uploadFile` | new |
| `download-sharepoint-file` | 1 | `sharepoint downloadFile` | new |
| `list-sharepoint-files` | 1 | `sharepoint listFiles` | new |
| `upload-google-drive-file` | 1 | `googledrive uploadFile` | new |
| `download-google-drive-file` | 1 | `googledrive downloadFile` | new |
| `share-google-drive-file` | 1 | `googledrive shareFile` | new |
| `create-spreadsheet`, `add-sheet`, `delete-sheet`, `copy-sheet-to-another-spreadsheet`, `get-data`, `clear-data`, `append-data`, `update-data` | 3 | `googlesheets …` | `serviceAccountKey` |
| the same eight Sheets tasks | 4 | `googlesheets …` | `serviceAccountKey` defaults to the Google integration's workspace param |
| `copy-file`, `list-files`, `list-file-permissions`, `delete-file` | 2 | `googledrive …` | `serviceAccountKey`; `list-files` passes `corpora` and `driveId` through |
| the same four Drive tasks | 3 | `googledrive …` | `serviceAccountKey` defaults to the Google integration's workspace param |
| `artifactory-file-download` | 2 | `artifactory downloadFile` | `accessToken`, results, the command runs again |
| `artifactory-file-upload` | 3 | `artifactory uploadFile` | `accessToken`, results, the command runs again |

## task-flow 3.4.0

| Task | Revision | Arguments | What it is |
| --- | --- | --- | --- |
| `execute-basic-http-call` | 2 | `http execute` | the command runs again; helper text describes the behaviour |
| `execute-advanced-http-call` | 5 | `http execute` | the command runs again; helper text describes the behaviour |

`commands/http.js` was commented out from 2025-03 to 3.4.0, so every earlier revision of both
tasks logged "Could not find method execute for command http" and exited 0, doing nothing. The
params of these revisions are the same as the previous ones (basic 1, advanced 4); an earlier
revision runs the restored command too on an image of 3.4.0 or later (unpinned, or once Flow's
default image is 3.4.0), except advanced revision 2, which is pinned to 3.1.0.

## Shared credentials

- **GitHub**: `url` and `token` default to `$(workspace.params.github-url)` and
  `$(workspace.params.github-token)`, the read-only workspace params Flow's GitHub integration
  shares (the installation token is a GitHub App token, so no task calls a `/user` endpoint).
  A user can still type a personal access token into the node.
- **Microsoft**: on the five Graph tasks (create-teams-channel, add-teams-member and the three
  SharePoint tasks), `tenantId`, `clientId` and `clientSecret` default to
  `$(workspace.params.microsoft-tenant-id)`, `$(workspace.params.microsoft-client-id)` and
  `$(workspace.params.microsoft-client-secret)`. Each run mints its own app-only token from them
  with the client-credentials flow, so nothing refreshes a token. send-teams-message's
  `webhookUrl` has no default: a webhook belongs to one channel.
- **Google**: `serviceAccountKey` (the whole JSON key file) defaults to
  `$(workspace.params.google-service-account-key)` on the three new Drive tasks, on Sheets
  revision 4 and on Drive revision 3. Sheets revision 3 and Drive revision 2 give it no default.
  A default reference resolves when the run is admitted. So on Sheets 4 and Drive 3, a node that
  still uses the now-optional `clientEmail` and `privateKey`, in a workspace without the Google
  integration, fails at admission unless the key is typed into the node. Typing the key in
  replaces the reference. A node pinned to an earlier revision is unaffected.
- Each GitHub task's description names the App permission it needs (Issues, Pull requests,
  Contents, Commit statuses or Actions), since an installation token carries only what the App
  was granted.
