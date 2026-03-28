#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  ProxyHub Node Auto-Installer
#  Run as root on any Ubuntu/Debian Linux machine.
#  Installs: Tailscale, 3proxy 0.9.5, Node.js agent, configures everything.
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/install.sh | sudo bash
#  Or copy this file and run:
#    sudo bash install-node.sh
#
#  Required env vars (or you'll be prompted):
#    TS_AUTH_KEY   - Tailscale reusable auth key  (tskey-auth-...)
#    HUB_TS_IP     - Your hub's Tailscale IP       (100.x.x.x)
#    NODE_NAME     - Display name for this node    (e.g. "NYC Node")
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}══ $* ${RESET}"; }

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Run as root: sudo bash $0"

# ── Detect arch ───────────────────────────────────────────────────────────────
ARCH=$(uname -m)
[[ "$ARCH" != "x86_64" ]] && error "Only x86_64 supported by the .deb package. Got: $ARCH"

# ── Gather config ─────────────────────────────────────────────────────────────
step "Configuration"

if [[ -z "${TS_AUTH_KEY:-}" ]]; then
    echo -e "${YELLOW}Enter your Tailscale reusable auth key (tskey-auth-...):${RESET}"
    read -r TS_AUTH_KEY
fi

if [[ -z "${HUB_TS_IP:-}" ]]; then
    echo -e "${YELLOW}Enter your hub's Tailscale IP (100.x.x.x):${RESET}"
    read -r HUB_TS_IP
fi

if [[ -z "${NODE_NAME:-}" ]]; then
    echo -e "${YELLOW}Enter a display name for this node (e.g. 'NYC Node'):${RESET}"
    read -r NODE_NAME
fi

# Sanitize node name for hostname
NODE_SLUG=$(echo "$NODE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g')

info "Node name:   $NODE_NAME"
info "Node slug:   $NODE_SLUG"
info "Hub TS IP:   $HUB_TS_IP"
info "TS key:      ${TS_AUTH_KEY:0:20}..."

# ── System update ─────────────────────────────────────────────────────────────
step "System Update"
apt-get update -qq
apt-get install -y -qq curl wget gnupg2 lsb-release apt-transport-https ca-certificates \
    software-properties-common net-tools ufw jq 2>/dev/null || true
success "Dependencies installed"

# ── Tailscale ─────────────────────────────────────────────────────────────────
step "Installing Tailscale"

if command -v tailscale &>/dev/null; then
    warn "Tailscale already installed — upgrading"
    apt-get install -y -qq tailscale 2>/dev/null || true
else
    curl -fsSL https://tailscale.com/install.sh | sh
fi

# Bring up Tailscale with the auth key
info "Joining Tailnet as vpn-node-$NODE_SLUG..."
tailscale up \
    --authkey "$TS_AUTH_KEY" \
    --hostname "vpn-node-$NODE_SLUG" \
    --accept-routes \
    --shields-up=false \
    2>&1 | tail -3 || warn "tailscale up had warnings — checking status"

# Wait for Tailscale IP
info "Waiting for Tailscale IP assignment..."
for i in $(seq 1 30); do
    NODE_TS_IP=$(tailscale ip -4 2>/dev/null || true)
    [[ -n "$NODE_TS_IP" ]] && break
    sleep 2
    echo -n "."
done
echo

[[ -z "$NODE_TS_IP" ]] && error "Failed to get Tailscale IP after 60s. Check your auth key."
success "Tailscale IP: $NODE_TS_IP"

# ── Remove any existing 3proxy ─────────────────────────────────────────────────
step "Removing Existing 3proxy (if any)"

systemctl stop 3proxy 2>/dev/null || true
systemctl disable 3proxy 2>/dev/null || true

# Kill any running instances
pkill -f 3proxy 2>/dev/null || true
sleep 1

# Remove old packages and files
apt-get purge -y -qq 3proxy 2>/dev/null || true
dpkg --purge 3proxy 2>/dev/null || true

# Nuke old config and log dirs (we'll recreate)
rm -rf /usr/local/3proxy /etc/3proxy /var/log/3proxy 2>/dev/null || true
success "Old 3proxy removed"

# ── Install 3proxy 0.9.5 ──────────────────────────────────────────────────────
step "Installing 3proxy 0.9.5"

DEB_URL="https://github.com/3proxy/3proxy/releases/download/0.9.5/3proxy-0.9.5.x86_64.deb"
DEB_FILE="/tmp/3proxy-0.9.5.x86_64.deb"

info "Downloading $DEB_URL"
wget -q --show-progress -O "$DEB_FILE" "$DEB_URL" || \
    curl -fsSL -o "$DEB_FILE" "$DEB_URL"

info "Installing package..."
dpkg -i "$DEB_FILE" || apt-get install -f -y -qq
rm -f "$DEB_FILE"

# Verify install
PROXY_BIN=$(command -v 3proxy || echo "/usr/local/3proxy/bin/3proxy")
[[ ! -f "$PROXY_BIN" ]] && PROXY_BIN="/usr/bin/3proxy"
[[ ! -f "$PROXY_BIN" ]] && error "3proxy binary not found after install"
success "3proxy installed: $PROXY_BIN"
$PROXY_BIN --version 2>&1 | head -1 || true

# ── Create directory structure ────────────────────────────────────────────────
step "Creating Directory Structure"

# The .deb puts config at /usr/local/3proxy/conf/ symlinked from /etc/3proxy/conf/
# Logs at /usr/local/3proxy/logs/ symlinked from /var/log/3proxy
# We work with the canonical symlink paths

CFG_DIR="/etc/3proxy/conf"
LOG_DIR="/var/log/3proxy"

mkdir -p "$CFG_DIR" "$LOG_DIR"
mkdir -p /usr/local/3proxy/logs
chmod 777 /usr/local/3proxy/logs

# If symlinks don't exist, make them point to /usr/local/3proxy equivalents
[[ -d /usr/local/3proxy/conf ]] || mkdir -p /usr/local/3proxy/conf
[[ -d /usr/local/3proxy/logs ]] || mkdir -p /usr/local/3proxy/logs

# Ensure symlinks
[[ -L "$CFG_DIR" ]] || { rm -rf "$CFG_DIR"; ln -sfn /usr/local/3proxy/conf "$CFG_DIR"; }
[[ -L "$LOG_DIR" ]] || { rm -rf "$LOG_DIR"; ln -sfn /usr/local/3proxy/logs "$LOG_DIR"; }

# Whitelist file — hub's Tailscale IP is always allowed
WHITELIST_CFG="$CFG_DIR/whitelist.cfg"
echo "allow * $HUB_TS_IP" > "$WHITELIST_CFG"

success "Directories ready"
info "  Config: $CFG_DIR/3proxy.cfg"
info "  Logs:   $LOG_DIR/"
info "  Whitelist: $WHITELIST_CFG"

# ── Write 3proxy config ───────────────────────────────────────────────────────
step "Writing 3proxy Config"

cat > "$CFG_DIR/3proxy.cfg" << PROXYCFG
# ─── ProxyHub Node Config ─────────────────────────────────────────────────────
# Node: $NODE_NAME
# Tailscale IP: $NODE_TS_IP
# Hub IP: $HUB_TS_IP
# Generated by install-node.sh on $(date)

nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60

# daemon — removed, systemd handles this

# Full stats logging — parsed by hub's Node.js server
log /logs/3proxy.log D
logformat "STAT %t %C %I %O %D %b %B %R %U %h"
logdump 1048576 1048576

# Only accept connections from hub's Tailscale IP
auth iponly
include $WHITELIST_CFG
deny *

# SOCKS5 — only on Tailscale interface, never public internet
socks -p1080 -i$NODE_TS_IP -osTCP_NODELAY -ocTCP_NODELAY -n

# HTTP proxy for ping/health checks
proxy -p3128 -i$NODE_TS_IP -osTCP_NODELAY -ocTCP_NODELAY -n
PROXYCFG

chown -R root:root "$CFG_DIR"
chmod 600 "$CFG_DIR/3proxy.cfg"
success "Config written to $CFG_DIR/3proxy.cfg"

# ── Write systemd service ─────────────────────────────────────────────────────
step "Setting Up systemd Service"

# The .deb usually drops a service file — we overwrite it to be safe
cat > /etc/systemd/system/3proxy.service << SVCEOF
[Unit]
Description=3proxy ProxyHub Node ($NODE_NAME)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=forking
ExecStart=$PROXY_BIN $CFG_DIR/3proxy.cfg
ExecReload=/bin/kill -HUP \$MAINPID
ExecStop=/bin/kill -TERM \$MAINPID
PIDFile=/run/3proxy.pid
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable 3proxy
systemctl restart 3proxy
sleep 2

if systemctl is-active --quiet 3proxy; then
    success "3proxy is running"
else
    warn "3proxy may not have started — check: journalctl -u 3proxy -n 50"
fi

# ── Firewall ──────────────────────────────────────────────────────────────────
step "Configuring Firewall"

# Only allow 1080/3128 FROM the hub's Tailscale IP — nothing public
ufw --force reset 2>/dev/null || true
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 from "$HUB_TS_IP" to any port 1080 proto tcp comment "3proxy SOCKS5 from hub"
ufw allow in on tailscale0 from "$HUB_TS_IP" to any port 3128 proto tcp comment "3proxy HTTP from hub"
ufw allow 22/tcp comment "SSH"
ufw --force enable
success "Firewall configured — only hub can reach proxy ports"

# ── Verify ────────────────────────────────────────────────────────────────────
step "Verification"

echo ""
info "3proxy status:"
systemctl status 3proxy --no-pager -l | head -20 || true

echo ""
info "Listening on Tailscale interface:"
ss -tlnp | grep -E '1080|3128' || netstat -tlnp 2>/dev/null | grep -E '1080|3128' || true

echo ""
info "Tailscale status:"
tailscale status 2>/dev/null | head -10 || true

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║  Node Install Complete!                                  ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Node Name:${RESET}      $NODE_NAME"
echo -e "  ${BOLD}Tailscale IP:${RESET}   $NODE_TS_IP"
echo -e "  ${BOLD}SOCKS5 port:${RESET}    $NODE_TS_IP:1080"
echo -e "  ${BOLD}HTTP port:${RESET}      $NODE_TS_IP:3128"
echo -e "  ${BOLD}Config:${RESET}         $CFG_DIR/3proxy.cfg"
echo -e "  ${BOLD}Logs:${RESET}           $LOG_DIR/3proxy.log"
echo ""
echo -e "  ${BOLD}Manage 3proxy:${RESET}"
echo -e "    ${CYAN}systemctl start 3proxy${RESET}    — start"
echo -e "    ${CYAN}systemctl stop 3proxy${RESET}     — stop"
echo -e "    ${CYAN}systemctl restart 3proxy${RESET}  — restart"
echo -e "    ${CYAN}systemctl status 3proxy${RESET}   — check status"
echo -e "    ${CYAN}journalctl -u 3proxy -f${RESET}   — live logs"
echo -e "    ${CYAN}tail -f $LOG_DIR/3proxy.log${RESET}"
echo ""
echo -e "  ${BOLD}Add this node to your dashboard:${RESET}"
echo -e "    Name:        $NODE_NAME"
echo -e "    Tailscale IP: ${YELLOW}$NODE_TS_IP${RESET}"
echo -e "    Region:      (enter your city)"
echo ""
echo -e "  ${BOLD}Add hub to whitelist.cfg:${RESET}  ${CYAN}echo 'allow * $HUB_TS_IP' >> $WHITELIST_CFG${RESET}"
echo ""