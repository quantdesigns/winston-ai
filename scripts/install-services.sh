#!/bin/bash
# Install Winston background services (macOS launchd or Linux systemd)
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
NPM_BIN="$(which npm 2>/dev/null || echo "/usr/local/bin/npm")"
NODE_BIN="$(which node 2>/dev/null || echo "/usr/local/bin/node")"
OS="$(uname -s)"

echo "Project directory: $PROJECT_DIR"
echo "OS detected: $OS"
echo "npm: $NPM_BIN"
echo "node: $NODE_BIN"

# Parse .env file into env vars
# Handles comments, empty lines, and quoted values
parse_env_file() {
    if [ ! -f "$ENV_FILE" ]; then
        echo "Warning: .env file not found at $ENV_FILE"
        return
    fi
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        # Extract key=value
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            # Strip surrounding quotes (single or double)
            value="${value#\"}"
            value="${value%\"}"
            value="${value#\'}"
            value="${value%\'}"
            echo "$key=$value"
        fi
    done < "$ENV_FILE"
}

# XML-escape a string for plist
xml_escape() {
    local s="$1"
    s="${s//&/&amp;}"
    s="${s//</&lt;}"
    s="${s//>/&gt;}"
    s="${s//\"/&quot;}"
    echo "$s"
}

install_macos() {
    local AGENTS_DIR="$HOME/Library/LaunchAgents"
    local LOGS_DIR="$HOME/Library/Logs"
    local UID_NUM
    UID_NUM=$(id -u)

    mkdir -p "$AGENTS_DIR" "$LOGS_DIR"

    # Build environment variables XML block from .env
    local ENV_BLOCK=""
    while IFS='=' read -r key value; do
        [ -z "$key" ] && continue
        ENV_BLOCK="${ENV_BLOCK}        <key>$(xml_escape "$key")</key>
        <string>$(xml_escape "$value")</string>
"
    done < <(parse_env_file)

    # Also add PATH so binaries are found
    ENV_BLOCK="${ENV_BLOCK}        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$(dirname "$NPM_BIN"):$(dirname "$NODE_BIN")</string>
"

    echo "Generating com.winston.router.plist..."
    cat > "$AGENTS_DIR/com.winston.router.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.winston.router</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PROJECT_DIR/bin/winston</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
$ENV_BLOCK    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOGS_DIR/winston-router.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOGS_DIR/winston-router.err.log</string>
</dict>
</plist>
PLIST

    echo "Generating com.winston.frontend.plist..."
    cat > "$AGENTS_DIR/com.winston.frontend.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.winston.frontend</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(dirname "$NODE_BIN")/node</string>
        <string>node_modules/next/dist/bin/next</string>
        <string>start</string>
        <string>-H</string>
        <string>127.0.0.1</string>
        <string>-p</string>
        <string>57711</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR/web</string>
    <key>EnvironmentVariables</key>
    <dict>
$ENV_BLOCK        <key>PORT</key>
        <string>57711</string>
        <key>HOSTNAME</key>
        <string>127.0.0.1</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOGS_DIR/winston-frontend.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOGS_DIR/winston-frontend.err.log</string>
</dict>
</plist>
PLIST

    echo "Loading services..."
    # Unload first if already loaded
    launchctl bootout "gui/$UID_NUM/com.winston.router" 2>/dev/null || true
    launchctl bootout "gui/$UID_NUM/com.winston.frontend" 2>/dev/null || true
    sleep 1

    launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/com.winston.router.plist"
    launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/com.winston.frontend.plist"

    echo ""
    echo "Service status:"
    launchctl list | grep winston || echo "(no winston services found)"
    echo ""
    echo "Services installed successfully."
    echo "Logs: $LOGS_DIR/winston-*.log"
}

install_linux() {
    echo "Generating winston-router.service..."
    sudo tee /etc/systemd/system/winston-router.service > /dev/null <<SERVICE
[Unit]
Description=Winston Router (Go backend)
After=network.target

[Service]
Type=simple
ExecStart=$PROJECT_DIR/bin/winston
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

    echo "Generating winston-frontend.service..."
    sudo tee /etc/systemd/system/winston-frontend.service > /dev/null <<SERVICE
[Unit]
Description=Winston Frontend (Next.js)
After=network.target

[Service]
Type=simple
ExecStart=$NPM_BIN start
WorkingDirectory=$PROJECT_DIR/web
EnvironmentFile=$PROJECT_DIR/.env
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$(dirname "$NPM_BIN"):$(dirname "$NODE_BIN")

[Install]
WantedBy=multi-user.target
SERVICE

    echo "Enabling and starting services..."
    sudo systemctl daemon-reload
    sudo systemctl enable winston-router winston-frontend
    sudo systemctl restart winston-router winston-frontend

    echo ""
    echo "Service status:"
    sudo systemctl status winston-router winston-frontend --no-pager || true
    echo ""
    echo "Services installed successfully."
}

case "$OS" in
    Darwin)
        install_macos
        ;;
    Linux)
        install_linux
        ;;
    *)
        echo "Unsupported OS: $OS"
        exit 1
        ;;
esac
