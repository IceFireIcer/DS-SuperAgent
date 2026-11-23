# syntax=docker/dockerfile:1

# Build: installs dsh and packs the one product package, then initializes a
# template DSH_HOME that the entrypoint copies into /data
# on first start. Build context is the repository root:
#   docker build -f docker/Dockerfile -t ds-superagent:local .
FROM node:24-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG DSH_VERSION=0.2.2-rc.1

RUN corepack enable \
    && npm config set registry "$NPM_REGISTRY" --global \
    && COREPACK_NPM_REGISTRY="$NPM_REGISTRY" pnpm config set registry "$NPM_REGISTRY" --global \
    && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
        --allow-scripts=@deepseek-ai/dsh-subprocess-local,node-pty,koffi,@google/genai,protobufjs

COPY superagent/ /src/superagent/

# The client and Office bundles are committed. Build the package, then let
# `dsh plugin add` install its host, client and search provider together.
RUN cd /src/superagent \
    && npm ci --ignore-scripts --no-fund --no-audit \
    && npm run build

# pnpm 11 refuses lifecycle scripts until the exact dependency identities are
# allowed. These are the native runtime dependencies required by the package.
RUN DSH_HOME=/opt/dsh-template dsh plugin --profile web list \
    && printf '\nallowBuilds:\n  "@deepseek-ai/dsh-subprocess-local@%s": true\n  "koffi@3.1.1": true\n  "node-pty@1.2.0-beta.15": true\n' "$DSH_VERSION" \
        >> /opt/dsh-template/profiles/web/pnpm-workspace.yaml
RUN cd /src/superagent \
    && npm pack --pack-destination /tmp \
    && mv /tmp/ds-superagent-*.tgz /tmp/ds-superagent.tgz \
    && DSH_HOME=/opt/dsh-template dsh plugin --profile web add /tmp/ds-superagent.tgz

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash git curl ca-certificates \
        python3 python3-pip python3-venv \
        build-essential jq ripgrep unzip zip ffmpeg less procps gosu \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY --from=build /usr/local/ /usr/local/
COPY --from=build /opt/dsh-template /opt/dsh-template
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/docker.patch.yml /opt/ds-superagent/docker.patch.yml

ENV DSH_HOME=/data \
    DSH_PERMISSION_MODE=danger-full-access \
    DS_SUPERAGENT_WORKSPACE=/workspace

WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

LABEL org.opencontainers.image.title="DS SuperAgent" \
      org.opencontainers.image.description="DS SuperAgent Main, Router and Workers served by dsh web" \
      org.opencontainers.image.source="https://github.com/IceFireIcer/DS-SuperAgent" \
      org.opencontainers.image.licenses="Apache-2.0"
