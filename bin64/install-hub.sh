#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════════
#  ProxyHub - Hub Installation Script
# ═════════════════════════════════════════════════════════════════════════════
#  Installs 3proxy on the hub and configures it for parent chaining
# ═════════════════════════════════════════════════════════════════════════════

set -e

# ─── COLORS ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ─── ARCHITECTURE DETECTION ──────────────────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        DEB_URL="https://github.com/3proxy/3proxy/releases/download/0.9.6/3proxy-0.9.6.x86_64.deb"
        ;;
    aarch64|arm64)
        DEB_URL="https://github.com/3proxy/3proxy/releases/download/0.9.6/3proxy-0.9.6.arm64.deb"
        ;;
    *)
        error "Unsupported architecture: $ARCH"
        ;;
esac

info "Detected architecture: $ARCH"

# ─── INSTALL 3PROXY ──────────────────────────────────────────────────────────
if command -v 3proxy &>/dev/null; then
    ok "3proxy already installed"
else
    info "Downloading 3proxy from $DEB_URL"
    wget -q -O /tmp/3proxy.deb "$DEB_URL" || error "Failed to download 3proxy"
    
    info "Installing 3proxy"
    dpkg -i /tmp/3proxy.deb 2>/dev/null || apt-get install -f -y &>/dev/null
    rm -f /tmp/3proxy.deb
    
    ok "3proxy installed to $(which 3proxy)"
fi

# ─── DIRECTORIES ─────────────────────────────────────────────────────────────
INSTALL_DIR="/etc/3proxy/hub"
LOG_DIR="/var/log/3proxy/hub"

info "Creating directories"
mkdir -p "$INSTALL_DIR"
mkdir -p "$LOG_DIR"

# ─── HUB CONFIG ──────────────────────────────────────────────────────────────
info "Generating hub configuration"

cat > "$INSTALL_DIR/3proxy.cfg" <<'EOF'
# ═════════════════════════════════════════════════════════════════════════════
#  ProxyHub - Hub Configuration
# ═════════════════════════════════════════════════════════════════════════════
#  This hub accepts browser connections and chains to remote nodes
# ═════════════════════════════════════════════════════════════════════════════

nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60

# Logging
log /var/log/3proxy/hub/3proxy.log D
logformat "- %U %C:%c %R:%r %O %I %h %T"
rotate 30

# Authentication: allow all (controlled by Node.js dashboard)
auth none

# ─── MAIN SOCKS5 PROXY (Port 1080) ──────────────────────────────────────────
# This is the default load-balanced entry point
# Parent chains will be added here by the Node.js server

socks -p1080

# ─── HTTP PROXY (Port 3128) ──────────────────────────────────────────────────
# For health checks and HTTP clients

proxy -p3128

# ─── PORT ROUTES ─────────────────────────────────────────────────────────────
# Additional port mappings are managed dynamically by the Node.js server
# See: /port-routes API endpoints
# Configs are written to /etc/3proxy/hub/port-*.cfg
EOF

ok "Hub config written to $INSTALL_DIR/3proxy.cfg"

# ─── SYSTEMD SERVICE ─────────────────────────────────────────────────────────
info "Creating systemd service"

cat > /etc/systemd/system/3proxy-hub.service <<EOF
[Unit]
Description=3proxy Hub
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/3proxy $INSTALL_DIR/3proxy.cfg
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable 3proxy-hub
ok "Systemd service created and enabled"

# ─── START SERVICE ───────────────────────────────────────────────────────────
info "Starting 3proxy hub"
systemctl restart 3proxy-hub
sleep 2

if systemctl is-active --quiet 3proxy-hub; then
    ok "3proxy hub is running"
else
    error "Failed to start 3proxy hub. Check: journalctl -u 3proxy-hub -n 50"
fi

# ─── VERIFY PORTS ────────────────────────────────────────────────────────────
info "Verifying ports..."
sleep 1

if ss -tlnp | grep -q ':1080'; then
    ok "Port 1080 (SOCKS5) is listening"
else
    warn "Port 1080 not listening yet"
fi

if ss -tlnp | grep -q ':3128'; then
    ok "Port 3128 (HTTP) is listening"
else
    warn "Port 3128 not listening yet"
fi

# ─── FIREWALL ────────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
    info "Configuring firewall"
    ufw allow 1080/tcp comment "3proxy SOCKS5" &>/dev/null || true
    ufw allow 3128/tcp comment "3proxy HTTP" &>/dev/null || true
    ok "Firewall rules added"
fi

# ─── SUMMARY ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           ProxyHub Hub Installation Complete              ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}Config:${NC}     $INSTALL_DIR/3proxy.cfg"
echo -e "  ${BLUE}Logs:${NC}       $LOG_DIR/3proxy.log"
echo -e "  ${BLUE}Service:${NC}    systemctl status 3proxy-hub"
echo ""
echo -e "  ${BLUE}SOCKS5:${NC}     0.0.0.0:1080"
echo -e "  ${BLUE}HTTP:${NC}       0.0.0.0:3128"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "  1. Your Node.js dashboard should auto-detect these ports"
echo -e "  2. Port health checks will show green within 30 seconds"
echo -e "  3. Configure port routes via the dashboard or API"
echo ""