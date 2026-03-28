#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  ProxyHub Security Server Installer
#  Hosts the Node.js dashboard + 3proxy on a hardened Ubuntu/Debian VPS.
#  Run as root: sudo bash install-security-server.sh
#
#  What this does:
#    - Hardens SSH (key-only, custom port)
#    - Sets up UFW firewall
#    - Installs Tailscale (dashboard only reachable via Tailscale)
#    - Installs Node.js 20 + PM2
#    - Installs 3proxy 0.9.5
#    - Deploys your dashboard (git clone or copies files)
#    - Configures nginx as a reverse proxy with basic auth
#    - Sets up fail2ban
#    - Installs unattended-upgrades for auto security patches
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}══ $* ${RESET}"; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash $0"

# ── Config ────────────────────────────────────────────────────────────────────
step "Configuration"

SSH_PORT="${SSH_PORT:-2222}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"      # internal port Node.js listens on
DASHBOARD_USER="${DASHBOARD_USER:-oofbomb}"
DASHBOARD_PASS="${DASHBOARD_PASS:-malaop0989}"
APP_DIR="${APP_DIR:-/opt/proxyhub}"
TS_AUTH_KEY="${TS_AUTH_KEY:-}"
REPO_URL="${REPO_URL:-}"                       # optional: git repo to clone

info "SSH port:        $SSH_PORT"
info "Dashboard port:  $DASHBOARD_PORT (internal)"
info "App directory:   $APP_DIR"

if [[ -z "$TS_AUTH_KEY" ]]; then
    echo -e "${YELLOW}Enter your Tailscale auth key (tskey-auth-...):${RESET}"
    read -r TS_AUTH_KEY
fi

# ── System update ─────────────────────────────────────────────────────────────
step "System Update & Dependencies"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget gnupg2 ufw fail2ban nginx apache2-utils \
    git unzip net-tools jq ca-certificates \
    software-properties-common apt-transport-https \
    unattended-upgrades 2>/dev/null
success "Base packages installed"

# ── Unattended upgrades ───────────────────────────────────────────────────────
step "Auto Security Updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUPGRADE
success "Unattended upgrades configured"

# ── Fail2ban ──────────────────────────────────────────────────────────────────
step "Fail2ban"
cat > /etc/fail2ban/jail.local << FAIL2BAN
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = $SSH_PORT
maxretry = 3
bantime  = 24h

[nginx-http-auth]
enabled  = true
filter   = nginx-http-auth
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 5
FAIL2BAN
systemctl enable fail2ban
systemctl restart fail2ban
success "Fail2ban configured — SSH brute force protection active"

# ── SSH hardening ─────────────────────────────────────────────────────────────
step "SSH Hardening"

# Backup original sshd_config
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak

cat > /etc/ssh/sshd_config.d/99-hardened.conf << SSHCONF
Port $SSH_PORT
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
AllowTcpForwarding no
SSHCONF

# Only reload if config is valid
if sshd -t 2>/dev/null; then
    systemctl reload sshd
    success "SSH hardened — port $SSH_PORT, key-only auth"
    warn "IMPORTANT: Make sure your SSH key is in ~/.ssh/authorized_keys before disconnecting!"
else
    warn "SSH config test failed — skipping reload (using defaults)"
fi

# ── Tailscale ─────────────────────────────────────────────────────────────────
step "Tailscale"
if ! command -v tailscale &>/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up --authkey "$TS_AUTH_KEY" --hostname "proxyhub-hub" --shields-up=false 2>/dev/null || true
sleep 3
TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
if [[ -n "$TS_IP" ]]; then
    success "Tailscale connected: $TS_IP"
else
    warn "Could not get Tailscale IP — check your auth key"
fi

# ── Node.js 20 ────────────────────────────────────────────────────────────────
step "Node.js 20"
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(parseInt(process.version.slice(1)))')" -lt 18 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi
success "Node.js $(node -v)"

# PM2
npm install -g pm2 --quiet
success "PM2 installed"

# ── 3proxy ────────────────────────────────────────────────────────────────────
step "3proxy 0.9.5"
ARCH=$(uname -m)
if [[ "$ARCH" == "x86_64" ]]; then
    DEB_URL="https://github.com/3proxy/3proxy/releases/download/0.9.5/3proxy-0.9.5.x86_64.deb"
    wget -q -O /tmp/3proxy.deb "$DEB_URL"
    dpkg -i /tmp/3proxy.deb || apt-get install -f -y -qq
    rm -f /tmp/3proxy.deb
    success "3proxy installed: $(which 3proxy)"
else
    warn "3proxy .deb only available for x86_64 — skipping (build from source if needed)"
fi

# ── App directory ─────────────────────────────────────────────────────────────
step "Application Setup"
mkdir -p "$APP_DIR"

if [[ -n "$REPO_URL" ]]; then
    info "Cloning from $REPO_URL..."
    git clone "$REPO_URL" "$APP_DIR" 2>/dev/null || (cd "$APP_DIR" && git pull)
    success "Repo cloned"
else
    info "No REPO_URL set — creating placeholder. Copy your files to $APP_DIR manually."
    # Create a minimal package.json so npm install works
    cat > "$APP_DIR/package.json" << PKGJSON
{
  "name": "proxyhub",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2"
  }
}
PKGJSON
fi

# Install node dependencies
cd "$APP_DIR"
[[ -f package.json ]] && npm install --quiet --production
success "npm dependencies installed"

# ── Create default config files if missing ────────────────────────────────────
[[ -f "$APP_DIR/nodes.json"    ]] || echo '{}' > "$APP_DIR/nodes.json"
[[ -f "$APP_DIR/clients.json"  ]] || echo '{}' > "$APP_DIR/clients.json"
[[ -f "$APP_DIR/hotloop.json"  ]] || echo '{"enabled":false,"primaryNode":null,"fallbackNode":null,"primaryWeight":900,"threshold":50,"mode":"weighted"}' > "$APP_DIR/hotloop.json"
[[ -f "$APP_DIR/whitelist.cfg" ]] || touch "$APP_DIR/whitelist.cfg"
[[ -f "$APP_DIR/settings.json" ]] || echo '{"ipAuthEnabled":true,"portRoutes":{}}' > "$APP_DIR/settings.json"

# ── 3proxy hub config ─────────────────────────────────────────────────────────
step "3proxy Hub Config"
HUB_CFG="$APP_DIR/3proxy.cfg"

cat > "$HUB_CFG" << PROXYCFG
# ─── ProxyHub Hub Config ──────────────────────────────────────────────────────
nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536
timeouts 1 5 30 60 180 1800 15 60

log $APP_DIR/3proxy.log D
logformat "STAT %t %C %I %O %D %b %B %R %U %h"
logdump 1048576 1048576

auth iponly
include $APP_DIR/whitelist.cfg
deny *

# ── Load Balancer ────────────────────────────────────────────────────────────
# Hotloop disabled — no chaining, hub is exit

# ── SOCKS5 listener ───────────────────────────────────────────────────────────
socks -p1080 -osTCP_NODELAY -ocTCP_NODELAY -n

# ── HTTP proxy ────────────────────────────────────────────────────────────────
proxy -p3128 -osTCP_NODELAY -ocTCP_NODELAY -n
PROXYCFG

# 3proxy systemd service
cat > /etc/systemd/system/3proxy-hub.service << SVCEOF
[Unit]
Description=3proxy Hub
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/3proxy $HUB_CFG
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable 3proxy-hub
systemctl restart 3proxy-hub || warn "3proxy-hub failed to start — check config"
success "3proxy hub configured"

# ── PM2 app config ────────────────────────────────────────────────────────────
step "PM2 Dashboard Service"
cat > "$APP_DIR/ecosystem.config.js" << PM2CONF
module.exports = {
    apps: [{
        name:    'proxyhub',
        script:  'server.js',
        cwd:     '$APP_DIR',
        env: {
            NODE_ENV: 'production',
            PORT:     '$DASHBOARD_PORT',
        },
        // Ignore JSON/log/cfg file changes — avoids restart loops
        watch:        false,
        max_restarts: 10,
        restart_delay: 3000,
    }]
};
PM2CONF

cd "$APP_DIR"
pm2 start ecosystem.config.js 2>/dev/null || pm2 restart proxyhub 2>/dev/null || true
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash 2>/dev/null || true
success "Dashboard running via PM2"

# ── Nginx reverse proxy ───────────────────────────────────────────────────────
step "Nginx"

# Basic auth for the dashboard
htpasswd -bc /etc/nginx/.htpasswd "$DASHBOARD_USER" "$DASHBOARD_PASS"

# Nginx site config
cat > /etc/nginx/sites-available/proxyhub << NGINXCONF
server {
    listen 80;
    server_name _;

    # Serve on all interfaces but restrict by IP in the location blocks

    # Dashboard — protected by basic auth
    location / {
        # Only allow from Tailscale subnet
        allow 100.0.0.0/8;
        deny all;

        proxy_pass         http://127.0.0.1:$DASHBOARD_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;

        auth_basic           "ProxyHub";
        auth_basic_user_file /etc/nginx/.htpasswd;
    }

    # Extension API — no auth, open CORS (still Tailscale-gated upstream)
    location /ext/ {
        proxy_pass       http://127.0.0.1:$DASHBOARD_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
NGINXCONF

ln -sf /etc/nginx/sites-available/proxyhub /etc/nginx/sites-enabled/proxyhub
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
success "Nginx configured — dashboard behind basic auth + Tailscale IP gate"

# ── Firewall ──────────────────────────────────────────────────────────────────
step "Firewall (UFW)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# SSH on custom port
ufw allow "$SSH_PORT/tcp" comment "SSH"

# HTTP for nginx (dashboard — nginx handles auth)
ufw allow 80/tcp comment "HTTP dashboard"

# SOCKS5 + HTTP proxy — only from Tailscale
ufw allow in on tailscale0 to any port 1080 proto tcp comment "SOCKS5 hub"
ufw allow in on tailscale0 to any port 3128 proto tcp comment "HTTP proxy hub"

# Node.js port — internal only, NOT open to internet
# (nginx proxies to it, so no direct exposure needed)

ufw --force enable
success "Firewall configured"
ufw status verbose

# ── Log rotation ──────────────────────────────────────────────────────────────
step "Log Rotation"
cat > /etc/logrotate.d/proxyhub << LOGROTATE
$APP_DIR/3proxy.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload 3proxy-hub 2>/dev/null || true
    endscript
}
LOGROTATE
success "Log rotation configured"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║  ProxyHub Security Server — Install Complete!                ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Tailscale IP:${RESET}    ${YELLOW}${TS_IP:-not assigned yet}${RESET}"
echo -e "  ${BOLD}SSH port:${RESET}        $SSH_PORT  (key-only)"
echo -e "  ${BOLD}Dashboard:${RESET}       http://${TS_IP:-<tailscale-ip>}/ (Tailscale only)"
echo -e "  ${BOLD}Dashboard auth:${RESET}  $DASHBOARD_USER / $DASHBOARD_PASS"
echo -e "  ${BOLD}App dir:${RESET}         $APP_DIR"
echo -e "  ${BOLD}3proxy config:${RESET}   $HUB_CFG"
echo -e "  ${BOLD}3proxy logs:${RESET}     $APP_DIR/3proxy.log"
echo ""
echo -e "  ${BOLD}Services:${RESET}"
echo -e "    ${CYAN}pm2 status${RESET}                  — dashboard status"
echo -e "    ${CYAN}pm2 logs proxyhub${RESET}            — dashboard logs"
echo -e "    ${CYAN}systemctl status 3proxy-hub${RESET}  — proxy status"
echo -e "    ${CYAN}systemctl status nginx${RESET}       — nginx status"
echo -e "    ${CYAN}systemctl status fail2ban${RESET}    — fail2ban status"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "  1. Copy your server.js + public/ to ${CYAN}$APP_DIR${RESET}"
echo -e "  2. Run ${CYAN}pm2 restart proxyhub${RESET}"
echo -e "  3. Add your SSH public key to ~/.ssh/authorized_keys"
echo -e "  4. Test dashboard at http://${TS_IP:-<tailscale-ip>}/"
echo -e "  5. Set HUB_TS_IP=${TS_IP:-<tailscale-ip>} when installing nodes"
echo ""