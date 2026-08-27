# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT (not tasks/flow) so pnpm can resolve
# @boomerang-io/task-core as an internal pnpm-workspace dependency instead of
# fetching it from the npm registry. See CONTRIBUTING_TASKS.md.

# ---- deps: resolve/install this task's workspace deps with pnpm ----
FROM alpine:3.20.2 AS deps

RUN apk add --no-cache bash coreutils nodejs npm python3 make g++

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
COPY tasks/flow ./tasks/flow

# --filter <pkg>... resolves @boomerang-io/task-flow plus its workspace
# dependencies (task-core); --prod skips devDependencies.
RUN pnpm install --prod --frozen-lockfile --filter @boomerang-io/task-flow...

# pnpm deploy produces a flat, self-contained, npm-compatible install for
# just this task (pruned of devDependencies and unrelated workspace
# packages) so the runtime stage doesn't need pnpm/corepack at all.
RUN pnpm --filter @boomerang-io/task-flow deploy --prod /out

# ---- runtime: small alpine image, no pnpm/corepack, no build toolchain ----
FROM alpine:3.20.2

WORKDIR /opt/bin

#Add Packages
RUN apk add --no-cache bash sed grep curl coreutils nodejs npm

WORKDIR /cli
COPY --from=deps /out ./

ENTRYPOINT [ "npm", "start" ]
