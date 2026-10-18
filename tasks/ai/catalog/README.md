# Catalogue definitions

One file per catalogue task that this image serves, in exactly the shape of Flow's seed
(`service-core/src/main/resources/seed/tasks.json` and `task-revisions.json`): `task` is the
tasks.json head and `revisions[]` are the task-revisions.json documents, joined by `parentRef`.

These files are the source of truth for the param and result contract; Flow's seed is a copy of
them. A contract change is one PR here (image, definition, README, fixtures together) and a seed
sync in Flow. `spec.image` pins the exact `boomerangio/task-ai:<version>` tag the revision was
written against and `spec.command` names the command in that image.

| File | Command | What it runs | First tag that serves it |
| --- | --- | --- | --- |
| `ai-prompt.json` | `prompt` | one completion | `task-ai@2.0.0` |
| `ai-agent.json` | `agent` | a tool-calling loop to a final answer | `task-ai@2.0.0` |

These two replace the original seeded `ai` task. `task-ai@2.0.0` is a major release because the
`prompt` command drops the 1.x contract rather than extending it: `endpoint` and `token` are
optional, `temperature` and `maxTokens` have no default and are sent only when set, and the
results carry three extra usage fields. A workflow node on the old `ai` task moves to `ai-prompt`;
the param names it already uses are unchanged.

## How Flow dispatches these

Flow's Kubernetes dispatcher runs an `ai` revision's declared `spec.image` and `spec.command` as
given (flow PR #558), but only when the image starts with an allowed prefix, by default
`boomerangio/task-ai`. A revision declaring any other image is refused at dispatch with the
never-started reason `ImageNotAllowed`; an operator who runs a different ai image adds its prefix
to `flow.dispatcher.ai.image-prefixes`. The original `ai` task, which relied on the
`flow.dispatcher.ai.image` fallback, is removed from the seed with this release.

When `endpoint` or `token` is left blank, the dispatcher's `flow.dispatcher.ai.endpoint` and
`flow.dispatcher.ai.token` reach the pod as `OPENAI_BASE_URL` and `OPENAI_API_KEY`, which the
image's SDK reads when no explicit value is given. An embedding product running these tasks
in-process supplies its own gateway settings instead.
