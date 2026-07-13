#!/bin/bash
# Restart all Winston services
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM=$(id -u)
LOGS_DIR="$HOME/Library/Logs"

echo "Rebuilding Go router..."
cd "$PROJECT_DIR"
go build -o bin/winston ./cmd/winston

echo "Rebuilding Next.js frontend..."
cd "$PROJECT_DIR/web"
npm run build --silent

echo "Restarting services..."
launchctl bootout "gui/$UID_NUM/com.winston.router" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.winston.frontend" 2>/dev/null || true

# Kill any stragglers (note: 57710 = router, 57711 = frontend; 3000/3100/8080/49710/49711 = legacy)
lsof -ti :3000 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :3100 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :8080 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :49710 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :49711 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :57710 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :57711 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/com.winston.frontend.plist"
launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/com.winston.router.plist"
sleep 3

echo "Checking services..."
launchctl list | grep winston
echo ""

echo "Recent router logs:"
tail -5 "$LOGS_DIR/winston-router.out.log" 2>/dev/null || echo "(no router logs yet)"
echo ""

curl -s http://127.0.0.1:57710/health
echo ""
echo "Done."
