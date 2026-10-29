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
| `copy-file`, `list-files`, `list-file-permissions`, `delete-file` | 2 | `googledrive …` | `serviceAccountKey`; `list-files` passes `corpora` and `driveId` through |
| `artifactory-file-download` | 2 | `artifactory downloadFile` | `accessToken`, results, the command runs again |
| `artifactory-file-upload` | 3 | `artifactory uploadFile` | `accessToken`, results, the command runs again |

## Shared credentials

- **GitHub**: `url` and `token` default to `$(workspace.params.github-url)` and
  `$(workspace.params.github-token)`, the read-only workspace params Flow's GitHub integration
  shares (the installation token is a GitHub App token, so no task calls a `/user` endpoint).
  A user can still type a personal access token into the node.
- **Microsoft**: `tenantId`, `clientId` and `clientSecret` have no default. The Graph tasks mint
  their own app-only token with the client-credentials flow, so the names are what a Microsoft
  integration would share as workspace params.
- **Google**: `serviceAccountKey` (the whole JSON key file) has no default; the same name is what a
  Google integration would share. The revised Sheets and Drive tasks keep `clientEmail` and
  `privateKey`, now optional, for a node that already uses them.
