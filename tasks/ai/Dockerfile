# syntax=docker/dockerfile:1
#
# task-ai - the worker image behind Boomerang Flow's `ai` task type.
#
# An `ai` task author never builds a container: Flow's dispatcher resolves this image and the
# `prompt` command for every TaskRun of type `ai` (the `flow.dispatcher.ai.image` property, read by
# `TaskImageResolver` in the flow monorepo's service-dispatcher). The image is built and published
# from this repository as `boomerangio/task-ai:latest` and `boomerangio/task-ai:<version>` by
# `.github/workflows/ci-task-ai.yml`, so Flow's `flow.dispatcher.ai.image` and this repository's
# tags have to be kept in step.
#
# Build context is the REPO ROOT (not tasks/ai) so pnpm can resolve @boomerang-io/task-core as an
# internal pnpm-workspace dependency instead of fetching it from the npm registry. See
# CONTRIBUTING_TASKS.md.

# ---- deps: resolve/install this task's workspace deps with pnpm ----
FROM alpine:3.20.2 AS deps

RUN apk add --no-cache bash coreutils nodejs npm

WORKDIR /workspace

# pnpm itself, pinned to the version declared in the root package.json's
# "packageManager" field (matches the pnpm-lock.yaml lockfileVersion).
# Alpine's `nodejs`/`npm` packages don't ship corepack, so install pnpm
# directly at the pinned version instead of relying on `corepack enable`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")

# Only the workspace members this task actually needs: task-core (the
# internal dependency being resolved) and the task's own directory.
COPY packages/core ./packages/core
COPY tasks/ai ./tasks/ai

# --filter <pkg>... resolves @boomerang-io/task-ai plus its workspace
# dependencies (task-core); --prod skips devDependencies.
RUN pnpm install --prod --frozen-lockfile --filter @boomerang-io/task-ai...

# pnpm deploy produces a flat, self-contained, npm-compatible install for
# just this task (pruned of devDependencies and unrelated workspace
# packages) so the runtime stage doesn't need pnpm/corepack at all.
RUN pnpm --filter @boomerang-io/task-ai deploy --prod /out

# ---- runtime: no pnpm, no npm, no build toolchain ----
#
# wolfi-base: Chainguard's hardened, glibc, near-zero-CVE base. The free tier publishes `:latest`
# only - there is no digest to pin that stays pullable - and the image is rebuilt on every task
# tag anyway, so the floating tag is the intended usage rather than a shortcut.
FROM cgr.dev/chainguard/wolfi-base:latest

# nodejs to run the command and ca-certificates-bundle so an HTTPS endpoint verifies - nothing
# else. `apk upgrade` first: the base tag can lag the package repository.
RUN apk upgrade --no-cache \
    && apk add --no-cache nodejs ca-certificates-bundle

WORKDIR /opt/boomerang
COPY --from=deps /out ./

# The dispatcher sets the container command to the bare name `prompt`, so it has to be on PATH.
# wolfi-base ships no /usr/local/bin, hence /usr/bin. Node resolves the link to its real path, so
# the command still finds /opt/boomerang/node_modules.
RUN chmod +x /opt/boomerang/bin/prompt.js \
    && ln -s /opt/boomerang/bin/prompt.js /usr/bin/prompt

# Non-root. 2000 matches the numeric user the Flow service images run as; OpenShift requires a
# numeric USER rather than a name.
RUN addgroup -g 2000 flow \
    && adduser -D -u 2000 -G flow flow
USER 2000

# No ENTRYPOINT: the dispatcher sets the container command (`prompt`), and leaving the entrypoint
# empty keeps a future second command (`embed`, `classify`) a one-line change.
CMD ["prompt"]
