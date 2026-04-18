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
#    HUB_TOKEN     - Shared secret from hub        (curl http://hub/agent/token -u user:pass)
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

if [[ -z "${HUB_TOKEN:-}" ]]; then
    echo -e "${YELLOW}Enter the hub shared token (from hub:/agent/token):${RESET}"
    echo -e "${CYAN}  On your hub run: curl -u oofbomb:malaop0989 http://localhost:8080/agent/token${RESET}"
    read -r HUB_TOKEN
fi
[[ ${#HUB_TOKEN} -lt 16 ]] && error "HUB_TOKEN too short (min 16 chars). Get it from your hub's /agent/token endpoint."

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
pkill -f 3proxy 2>/dev/null || true
sleep 1

apt-get purge -y -qq 3proxy 2>/dev/null || true
dpkg --purge 3proxy 2>/dev/null || true
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

PROXY_BIN=$(command -v 3proxy || echo "/usr/bin/3proxy")
[[ ! -f "$PROXY_BIN" ]] && PROXY_BIN="/usr/bin/3proxy"
[[ ! -f "$PROXY_BIN" ]] && error "3proxy binary not found after install"
success "3proxy installed: $PROXY_BIN"

# ── Create directory structure ────────────────────────────────────────────────
step "Creating Directory Structure"

CFG_DIR="/etc/3proxy/conf"
LOG_DIR="/var/log/3proxy"

mkdir -p "$CFG_DIR" "$LOG_DIR"
mkdir -p /usr/local/3proxy/conf /usr/local/3proxy/logs

# Ensure log dir is writable by 3proxy
chmod 755 "$LOG_DIR"
chown root:root "$LOG_DIR"

# Symlinks
[[ -L "$CFG_DIR" ]] || { rm -rf "$CFG_DIR"; ln -sfn /usr/local/3proxy/conf "$CFG_DIR"; }
[[ -L "$LOG_DIR" ]] || { rm -rf "$LOG_DIR"; ln -sfn /usr/local/3proxy/logs "$LOG_DIR"; }

# Whitelist file
WHITELIST_CFG="$CFG_DIR/whitelist.cfg"
echo "allow * $HUB_TS_IP" > "$WHITELIST_CFG"

success "Directories ready"
info "  Config: $CFG_DIR/3proxy.cfg"
info "  Logs:   $LOG_DIR/"
info "  Whitelist: $WHITELIST_CFG"

# ── Write 3proxy config ───────────────────────────────────────────────────────
step "Writing 3proxy Config"

# FIX: log path uses the real resolved path, not /logs which doesn't exist
LOG_FILE="$LOG_DIR/3proxy.log"

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

# Full stats logging — parsed by hub's Node.js server
log $LOG_FILE D
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

# FIX: Type=simple — we removed 'daemon' from the config so 3proxy stays in
# the foreground. Type=forking requires a PID file which 3proxy only writes
# when running as a daemon. Using simple avoids the protocol/PIDFile error.
cat > /etc/systemd/system/3proxy.service << SVCEOF
[Unit]
Description=3proxy ProxyHub Node ($NODE_NAME)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PROXY_BIN $CFG_DIR/3proxy.cfg
ExecReload=/bin/kill -HUP \$MAINPID
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
    journalctl -u 3proxy -n 20 --no-pager || true
fi

# ── Firewall ──────────────────────────────────────────────────────────────────
step "Configuring Firewall"

ufw --force reset 2>/dev/null || true
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0 from "$HUB_TS_IP" to any port 1080 proto tcp comment "3proxy SOCKS5 from hub"
ufw allow in on tailscale0 from "$HUB_TS_IP" to any port 3128 proto tcp comment "3proxy HTTP from hub"
ufw allow in on tailscale0 from "$HUB_TS_IP" to any port 9999 proto tcp comment "node-agent from hub"
ufw allow 22/tcp comment "SSH"
ufw --force enable
success "Firewall configured — only hub can reach proxy ports"

# ── Node Agent (control daemon for hub) ──────────────────────────────────────
step "Installing Node.js Control Agent"

# Install Node.js if missing
if ! command -v node &>/dev/null; then
    info "Installing Node.js 20…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
fi
info "Node: $(node -v)"

AGENT_DIR="/opt/proxyhub-agent"
CONF_DIR_AGENT="/etc/proxyhub"
mkdir -p "$AGENT_DIR" "$CONF_DIR_AGENT"

# Write the hub token (shared secret)
umask 077
printf '%s' "$HUB_TOKEN" > "$CONF_DIR_AGENT/hub-token"
chmod 600 "$CONF_DIR_AGENT/hub-token"

# Create a system user to run the agent
if ! id -u proxyhub >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin proxyhub
fi

# Grant the proxyhub user permission to manage the 3proxy service + shutdown
cat > /etc/sudoers.d/proxyhub-agent <<SUDO
# Managed by install-node.sh — do not edit
proxyhub ALL=(ALL) NOPASSWD: /bin/systemctl start 3proxy
proxyhub ALL=(ALL) NOPASSWD: /bin/systemctl stop 3proxy
proxyhub ALL=(ALL) NOPASSWD: /bin/systemctl restart 3proxy
proxyhub ALL=(ALL) NOPASSWD: /bin/systemctl reload 3proxy
proxyhub ALL=(ALL) NOPASSWD: /bin/systemctl is-active 3proxy
proxyhub ALL=(ALL) NOPASSWD: /usr/bin/systemctl start 3proxy
proxyhub ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop 3proxy
proxyhub ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart 3proxy
proxyhub ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload 3proxy
proxyhub ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-active 3proxy
proxyhub ALL=(ALL) NOPASSWD: /usr/sbin/shutdown
proxyhub ALL=(ALL) NOPASSWD: /sbin/shutdown
SUDO
chmod 440 /etc/sudoers.d/proxyhub-agent
visudo -cf /etc/sudoers.d/proxyhub-agent >/dev/null

# Write the agent source (inline — no external copy needed)
cat > "$AGENT_DIR/agent.js" << 'AGENTJS'
#!/usr/bin/env node
// ProxyHub Node Agent — binds to Tailscale IP only, controls 3proxy.
const express = require('express');
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

const VERSION      = '1.0.0';
const PORT         = parseInt(process.env.AGENT_PORT || '9999', 10);
const SERVICE_NAME = process.env.SERVICE_NAME || '3proxy';
const TOKEN_FILE   = process.env.TOKEN_FILE   || '/etc/proxyhub/hub-token';
const HUB_TS_IP    = (process.env.HUB_TS_IP || '').trim();

let HUB_TOKEN = (process.env.HUB_TOKEN || '').trim();
if (!HUB_TOKEN) {
    try { HUB_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
    catch { console.error('[agent] no token'); process.exit(1); }
}
if (HUB_TOKEN.length < 16) { console.error('[agent] token too short'); process.exit(1); }

function getTailscaleIp() {
    try {
        const out = execSync('tailscale ip -4', { timeout: 2000, stdio: ['ignore','pipe','ignore'] })
            .toString().trim().split('\n')[0].trim();
        if (out.startsWith('100.')) return out;
    } catch {}
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            if (a.family === 'IPv4' && a.address.startsWith('100.')) return a.address;
        }
    }
    return null;
}

const TS_IP = getTailscaleIp();
if (!TS_IP) { console.error('[agent] no tailscale ip'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ip.startsWith('100.') && ip !== '127.0.0.1' && ip !== '::1') return res.status(403).json({ error: 'tailnet only' });
    if (HUB_TS_IP && ip !== HUB_TS_IP && ip !== '127.0.0.1' && ip !== '::1') return res.status(403).json({ error: 'not hub' });
    if ((req.headers['x-hub-token'] || '') !== HUB_TOKEN) return res.status(401).json({ error: 'bad token' });
    next();
});

function run(cmd, timeout = 10000) {
    return new Promise(resolve => {
        exec(cmd, { timeout }, (err, stdout, stderr) =>
            resolve({ ok: !err, code: err?.code ?? 0, stdout: (stdout||'').toString(), stderr: (stderr||'').toString() }));
    });
}

function systemctl(action) {
    const cmd = (process.getuid && process.getuid() === 0)
        ? `systemctl ${action} ${SERVICE_NAME}`
        : `sudo -n systemctl ${action} ${SERVICE_NAME}`;
    return run(cmd);
}

app.get('/status', async (req, res) => {
    const r = await systemctl('is-active');
    res.json({
        active:       r.stdout.trim() === 'active',
        service:      SERVICE_NAME,
        hostname:     os.hostname(),
        uptime:       Math.floor(os.uptime()),
        loadavg:      os.loadavg(),
        mem:          { free: os.freemem(), total: os.totalmem() },
        platform:     os.platform(),
        tailscaleIp:  TS_IP,
        agentVersion: VERSION,
        ts:           Date.now(),
    });
});

app.post('/start',   async (_q, r) => { const x = await systemctl('start');   r.status(x.ok ? 200 : 500).json(x); });
app.post('/stop',    async (_q, r) => { const x = await systemctl('stop');    r.status(x.ok ? 200 : 500).json(x); });
app.post('/restart', async (_q, r) => { const x = await systemctl('restart'); r.status(x.ok ? 200 : 500).json(x); });
app.post('/reload',  async (_q, r) => {
    const rr = await systemctl('reload');
    if (rr.ok) return r.json({ ...rr, method: 'reload' });
    const rs = await systemctl('restart');
    r.status(rs.ok ? 200 : 500).json({ ...rs, method: 'restart' });
});

app.get('/logs', async (req, res) => {
    const n = Math.min(parseInt(req.query.n, 10) || 200, 2000);
    const r = await run(`journalctl -u ${SERVICE_NAME} -n ${n} --no-pager`, 8000);
    res.type('text/plain').send(r.stdout + (r.stderr ? '\n[stderr]\n' + r.stderr : ''));
});

app.post('/reboot', (_q, res) => {
    res.json({ ok: true, scheduled: true, eta: 'T+1 minute' });
    const cmd = (process.getuid && process.getuid() === 0) ? 'shutdown -r +1' : 'sudo -n shutdown -r +1';
    setTimeout(() => exec(cmd), 300);
});

app.get('/ip', (_q, res) => {
    const req = http.get('http://api.ipify.org/', { timeout: 5000 }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => res.json({ ip: d.trim(), ts: Date.now() }));
    });
    req.on('error',   () => res.status(500).json({ error: 'lookup failed' }));
    req.on('timeout', () => { req.destroy(); res.status(504).json({ error: 'timeout' }); });
});

app.listen(PORT, TS_IP, () => {
    console.log(`[agent] v${VERSION} on ${TS_IP}:${PORT} (tailnet only)`);
    console.log(`[agent] service=${SERVICE_NAME}  hub_pin=${HUB_TS_IP || '(none)'}`);
});
app.listen(PORT, '127.0.0.1', () => console.log(`[agent] also on 127.0.0.1:${PORT}`));
AGENTJS

# Write package.json + install express
cat > "$AGENT_DIR/package.json" << 'PKGJSON'
{
  "name": "proxyhub-node-agent",
  "version": "1.0.0",
  "private": true,
  "main": "agent.js",
  "dependencies": { "express": "^4.18.2" }
}
PKGJSON

cd "$AGENT_DIR"
npm install --omit=dev --silent 2>&1 | tail -3

chown -R proxyhub:proxyhub "$AGENT_DIR"
chown root:proxyhub "$CONF_DIR_AGENT/hub-token"
chmod 640 "$CONF_DIR_AGENT/hub-token"

# Systemd unit
cat > /etc/systemd/system/proxyhub-agent.service << UNIT
[Unit]
Description=ProxyHub Node Agent
After=network-online.target tailscaled.service
Wants=network-online.target tailscaled.service

[Service]
Type=simple
User=proxyhub
Group=proxyhub
Environment=AGENT_PORT=9999
Environment=SERVICE_NAME=3proxy
Environment=TOKEN_FILE=$CONF_DIR_AGENT/hub-token
Environment=HUB_TS_IP=$HUB_TS_IP
ExecStartPre=/bin/bash -c 'for i in {1..20}; do tailscale ip -4 2>/dev/null | grep -q "^100\\." && exit 0; sleep 1; done; exit 1'
ExecStart=/usr/bin/node $AGENT_DIR/agent.js
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable proxyhub-agent >/dev/null
systemctl restart proxyhub-agent
sleep 2

if systemctl is-active --quiet proxyhub-agent; then
    success "proxyhub-agent running on $NODE_TS_IP:9999"
else
    warn "proxyhub-agent not running — check: journalctl -u proxyhub-agent -n 30"
    journalctl -u proxyhub-agent -n 10 --no-pager || true
fi

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
echo -e "  ${BOLD}Agent port:${RESET}     $NODE_TS_IP:9999  (hub control via Tailscale)"
echo -e "  ${BOLD}Config:${RESET}         $CFG_DIR/3proxy.cfg"
echo -e "  ${BOLD}Logs:${RESET}           $LOG_FILE"
echo ""
echo -e "  ${BOLD}Manage 3proxy:${RESET}"
echo -e "    ${CYAN}systemctl start 3proxy${RESET}    — start"
echo -e "    ${CYAN}systemctl stop 3proxy${RESET}     — stop"
echo -e "    ${CYAN}systemctl restart 3proxy${RESET}  — restart"
echo -e "    ${CYAN}systemctl status 3proxy${RESET}   — check status"
echo -e "    ${CYAN}journalctl -u 3proxy -f${RESET}   — live logs"
echo -e "    ${CYAN}tail -f $LOG_FILE${RESET}"
echo ""
echo -e "  ${BOLD}Manage node-agent:${RESET}"
echo -e "    ${CYAN}systemctl status proxyhub-agent${RESET}"
echo -e "    ${CYAN}journalctl -u proxyhub-agent -f${RESET}"
echo ""
echo -e "  ${BOLD}Add this node to your dashboard:${RESET}"
echo -e "    Name:         $NODE_NAME"
echo -e "    Tailscale IP: ${YELLOW}$NODE_TS_IP${RESET}"
echo -e "    Region:       (enter your city)"
echo ""
echo -e "  ${BOLD}Add hub to whitelist:${RESET}  ${CYAN}echo 'allow * $HUB_TS_IP' >> $WHITELIST_CFG${RESET}"
echo ""