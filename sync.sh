#!/usr/bin/env bash
# ─── SIP Endpoint Sync & Deploy Script ───────────────────────────────────────
# Syncs local source changes to the remote server and optionally rebuilds.
#
# Usage:
#   ./sync.sh                    # sync + full rebuild + restart
#   ./sync.sh --sync-only        # sync files only, no rebuild
#   ./sync.sh --frontend-only    # push frontend/index.html into running container (fast)
#   ./sync.sh --backend-only     # push backend JS into running container + restart node
#   ./sync.sh --rebuild-only     # full podman rebuild without syncing
#   ./sync.sh --logs             # tail container logs after deploy
#   ./sync.sh --host user@ip     # override remote host

set -e

# ─── Config ───────────────────────────────────────────────────────────────────
REMOTE_HOST="${SIP_REMOTE:-chris@192.168.1.135}"
REMOTE_DIR="${SIP_REMOTE_DIR:-~/Apps/container-sip-endpoint}"
CONTAINER_NAME="sip-endpoint"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Arg parsing ──────────────────────────────────────────────────────────────
SYNC_ONLY=false
REBUILD_ONLY=false
FRONTEND_ONLY=false
BACKEND_ONLY=false
SHOW_LOGS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --sync-only)     SYNC_ONLY=true ;;
    --rebuild-only)  REBUILD_ONLY=true ;;
    --frontend-only) FRONTEND_ONLY=true ;;
    --backend-only)  BACKEND_ONLY=true ;;
    --logs)          SHOW_LOGS=true ;;
    --host)          shift; REMOTE_HOST="$1" ;;
    --help|-h)
      echo "Usage: ./sync.sh [user@host] [options]"
      echo ""
      echo "  user@host          Remote host to deploy to (overrides \$SIP_REMOTE)"
      echo "  (no args)          Sync files + full podman rebuild + restart"
      echo "  --sync-only        Sync files only, skip rebuild"
      echo "  --frontend-only    Hot-push frontend/index.html into running container (fast)"
      echo "  --backend-only     Hot-push backend/*.js into running container + restart node"
      echo "  --rebuild-only     Full podman rebuild on remote without syncing first"
      echo "  --logs             Tail container logs after deploy"
      echo "  --host user@ip     Override remote host (alternative to positional arg)"
      echo ""
      echo "  Env vars:"
      echo "    SIP_REMOTE=user@host    change default remote (current: $REMOTE_HOST)"
      echo "    SIP_REMOTE_DIR=path     change remote path   (current: $REMOTE_DIR)"
      exit 0
      ;;
    *@*)             REMOTE_HOST="$1" ;;
    *)               echo "Unknown argument: $1"; exit 1 ;;
  esac
  shift
done

echo "📡  SIP Endpoint Sync & Deploy"
echo "    Local:     $LOCAL_DIR"
echo "    Remote:    $REMOTE_HOST:$REMOTE_DIR"
echo "    Container: $CONTAINER_NAME"
echo ""

# ─── Fast path: frontend only ─────────────────────────────────────────────────
if [ "$FRONTEND_ONLY" = true ]; then
  echo "🎨  Hot-pushing frontend/index.html..."
  rsync -avz "$LOCAL_DIR/frontend/index.html" "$REMOTE_HOST:$REMOTE_DIR/frontend/index.html"
  ssh "$REMOTE_HOST" "cp $REMOTE_DIR/frontend/index.html /tmp/_sip_idx.html && podman cp /tmp/_sip_idx.html $CONTAINER_NAME:/frontend/index.html"
  echo "✓  Frontend updated — hard refresh browser to apply"
  exit 0
fi

# ─── Fast path: backend only ──────────────────────────────────────────────────
if [ "$BACKEND_ONLY" = true ]; then
  echo "⚙️   Hot-pushing backend JS files..."
  rsync -avz "$LOCAL_DIR/backend/" "$REMOTE_HOST:$REMOTE_DIR/backend/"
  ssh "$REMOTE_HOST" bash << EOF
    set -e
    for f in server.js sipManager.js callHistory.js captureManager.js transcribeManager.js audioDecoder.js; do
      if [ -f "$REMOTE_DIR/backend/\$f" ]; then
        podman cp "$REMOTE_DIR/backend/\$f" $CONTAINER_NAME:/app/\$f
        echo "  ✓ \$f"
      fi
    done
    echo "→ Restarting node process..."
    podman exec $CONTAINER_NAME kill -HUP 1 2>/dev/null || podman restart $CONTAINER_NAME
    sleep 2
    echo "✓  Backend updated"
EOF
  if [ "$SHOW_LOGS" = true ]; then
    echo ""
    echo "📋  Tailing logs (Ctrl+C to stop)..."
    ssh -t "$REMOTE_HOST" "podman logs -f $CONTAINER_NAME"
  fi
  exit 0
fi

# ─── Sync ─────────────────────────────────────────────────────────────────────
if [ "$REBUILD_ONLY" = false ]; then
  echo "📦  Syncing source files..."
  rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '*.log' \
    --exclude 'captures/' \
    --filter=':- .gitignore' \
    "$LOCAL_DIR/" \
    "$REMOTE_HOST:$REMOTE_DIR/"
  echo "✓  Sync complete"
  echo ""
fi

# ─── Full rebuild ─────────────────────────────────────────────────────────────
if [ "$SYNC_ONLY" = false ]; then
  echo "🔨  Full rebuild on $REMOTE_HOST..."
  echo ""

  ssh "$REMOTE_HOST" bash << EOF
    set -e
    cd $REMOTE_DIR

    echo "→ Stopping container..."
    podman-compose down 2>/dev/null || true

    echo "→ Removing old image..."
    podman rmi localhost/container-sip-endpoint_sip-endpoint:latest 2>/dev/null || true

    echo "→ Pruning dangling images and build cache..."
    podman image prune -f 2>/dev/null || true
    podman system prune -f --volumes=false 2>/dev/null || true

    echo "→ Disk space after cleanup:"
    df -h / | awk 'NR==2 {print "   " \$4 " available on " \$6}'

    echo "→ Building new image (this takes a while if Whisper needs compiling)..."
    podman-compose build --no-cache

    echo "→ Starting container..."
    podman-compose up -d

    echo ""
    echo "→ Waiting for startup..."
    sleep 5

    echo ""
    echo "─── Startup logs ────────────────────────────────────────────────"
    podman logs $CONTAINER_NAME 2>&1 | tail -20
    echo "─────────────────────────────────────────────────────────────────"
    echo ""
    echo "✅  Deploy complete"
    echo "    UI:  http://\$(hostname -I | awk '{print \$1}'):3000"
EOF

  echo ""
fi

# ─── Logs ─────────────────────────────────────────────────────────────────────
if [ "$SHOW_LOGS" = true ]; then
  echo "📋  Tailing logs (Ctrl+C to stop)..."
  echo ""
  ssh -t "$REMOTE_HOST" "podman logs -f $CONTAINER_NAME"
fi
