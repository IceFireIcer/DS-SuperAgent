#!/bin/sh
# Runs dsh web as the node user. The container is the sandbox boundary, so the
# image offers only the danger-full-access preset (see docker.patch.yml).
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

# First start: seed the data volume with the template home built into the image
# (a web profile with the single ds-superagent package installed).
if [ ! -d /data/profiles/web ]; then
  mkdir -p /data
  cp -a /opt/dsh-template/. /data/
fi
PROFILE_PACKAGE=/data/profiles/web/package.json
if [ -f "$PROFILE_PACKAGE" ] && ! node -e '
  const p = require(process.argv[1])
  if (!p.dependencies?.["ds-superagent"]) process.exit(1)
' "$PROFILE_PACKAGE"; then
  echo "entrypoint: this /data profile predates the R5 product and has no ds-superagent." >&2
  echo "entrypoint: archive or choose a new DATA_DIR; the container does not import the old team profile." >&2
  exit 1
fi
# Existing profiles and restored backups can belong to a previous PUID/PGID.
# Do not follow links into workspace shares or descend into other filesystems.
find -P /data -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
  -exec chown -h node:node -- {} +

mkdir -p /workspace
# Only claim an empty /workspace; a populated share keeps its owners.
if [ -z "$(ls -A /workspace)" ]; then
  chown node:node /workspace
fi

# DSH refuses wildcard listens because full-access agents are otherwise exposed
# to the network. Bind the first concrete interface instead; Docker's publish
# rule remains the host-side network boundary.
# DSH_LISTEN_PORT only matters with network_mode: host — published ports
# always map to 3080 inside.
HOST=${DSH_HOST:-auto}
if [ "$HOST" = auto ]; then
  HOST=$(node -e '
    const os = require("node:os")
    const all = Object.values(os.networkInterfaces()).flat()
    const own = os.networkInterfaces().eth0 ?? []
    const selected = [...own, ...all].find(item => item?.family === "IPv4" && !item.internal)
    process.stdout.write(selected?.address ?? "127.0.0.1")
  ')
fi
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
node -e 'process.exit(require("node:net").isIP(process.argv[1]) === 0 ? 1 : 0)' "$HOST" \
  || { echo "entrypoint: DSH_HOST must be a concrete IPv4 or IPv6 address (got '$HOST')" >&2; exit 1; }
case "$HOST" in
  0.0.0.0|::) echo "entrypoint: DSH_HOST cannot be a wildcard address" >&2; exit 1 ;;
esac
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac

# The webserver row's whole config is replaced by a patch, so its bundle values
# (compression on this dsh release) are restated literally.
cat > /tmp/listen.patch.yml <<EOF
- id: webserver
  config:
    host: "$HOST"
    port: $LISTEN_PORT
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF

# --patch is a dsh option and must precede the app's own flags.
set -- dsh --profile web \
  --patch /opt/ds-superagent/docker.patch.yml --patch /tmp/listen.patch.yml \
  --no-open "$@"

if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for trusted in $DSH_TRUSTED_HOST; do
    [ -n "$trusted" ] && set -- "$@" --trusted-host "$trusted"
  done
  IFS=$old_ifs
fi
export HOME=/home/node
cd /workspace
exec gosu node "$@"
