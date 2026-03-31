#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  ProxyHub Config Generator
#  Generates 3proxy.cfg, adds port routes via API, restarts
# ─────────────────────────────────────────────────────────────

APP_DIR="/home/oofbomb/3proxy-modified3/bin64"
API="http://localhost:8080"
AUTH="oofbomb:malaop0989"
CFG="$APP_DIR/3proxy.cfg"
LOG="$APP_DIR/3proxy.log"
PROXY_BIN="$APP_DIR/3proxy.exe"

# ── COLOURS ───────────────────────────────────────────────────
G="\033[0;32m" Y="\033[0;33m" R="\033[0;31m" B="\033[0;34m" NC="\033[0m" BOLD="\033[1m"
ok()   { echo -e "${G}✓${NC} $1"; }
info() { echo -e "${B}→${NC} $1"; }
warn() { echo -e "${Y}⚠${NC} $1"; }
err()  { echo -e "${R}✗${NC} $1"; }

echo -e "\n${BOLD}ProxyHub Config Generator${NC}\n"

# ── STEP 1: WRITE MAIN 3proxy.cfg ─────────────────────────────
info "Writing hub 3proxy.cfg..."

cat > "$CFG" << PROXYCFG
# ═══════════════════════════════════════════════════════════════
#  ProxyHub — Hub 3proxy Config
#  Port 1080 = default exit (hotloop or direct)
#  Port routes (1081, 1082 etc) = spawned separately by server.js
# ═══════════════════════════════════════════════════════════════

nserver 1.1.1.1
nserver 8.8.8.8
nscache 65536

timeouts 1 5 30 60 180 1800 15 60

log $LOG D
logformat "STAT %t %C %I %O %D %b %B %R %U %h"

# ── Load Balancer ──────────────────────────────────────────────
# Hotloop disabled — no chaining, hub is exit

# ── SOCKS5 on port 1080 (default) ─────────────────────────────
auth none
allow *
socks -p1080 -osTCP_NODELAY -ocTCP_NODELAY -n
PROXYCFG

ok "Hub config written → $CFG"

# ── STEP 2: FETCH NODES FROM API ──────────────────────────────
info "Fetching nodes from server-linux.js..."
NODES_JSON=$(curl -s -u "$AUTH" "$API/nodes")
if [ -z "$NODES_JSON" ]; then
    err "Could not reach API at $API — is server-linux.js running?"
    exit 1
fi

# Parse node list (using python for clean JSON parsing)
NODE_LIST=$(python3 - << PYEOF
import json, sys
data = json.loads('''$NODES_JSON''')
nodes = data.get('nodes', [])
for n in nodes:
    if n.get('tailscaleIp') and n.get('enabled', True):
        print(f"{n['id']}|{n['name']}|{n['tailscaleIp']}")
PYEOF
)

if [ -z "$NODE_LIST" ]; then
    warn "No enabled nodes found — skipping port route setup"
else
    echo ""
    echo -e "${BOLD}Available nodes:${NC}"
    i=1
    declare -A NODE_IDS
    declare -A NODE_NAMES
    declare -A NODE_IPS
    while IFS='|' read -r nid nname nip; do
        echo -e "  ${B}$i)${NC} $nname — $nip"
        NODE_IDS[$i]=$nid
        NODE_NAMES[$i]=$nname
        NODE_IPS[$i]=$nip
        ((i++))
    done <<< "$NODE_LIST"
    TOTAL=$((i-1))

    # ── STEP 3: PORT ROUTE SETUP ─────────────────────────────
    echo ""
    echo -e "${BOLD}Port Route Setup${NC}"
    echo -e "${Y}Port 1080 = hub default (always on)${NC}"
    echo ""

    # Auto-assign ports starting at 1081
    PORT=1081
    while IFS='|' read -r nid nname nip; do
        read -rp "  Assign port $PORT → $nname? [Y/n]: " CONFIRM
        CONFIRM=${CONFIRM:-Y}
        if [[ "$CONFIRM" =~ ^[Yy] ]]; then
            info "Adding port route $PORT → $nname ($nip)..."
            RESULT=$(curl -s -u "$AUTH" -X POST "$API/port-routes" \
                -H "Content-Type: application/json" \
                -d "{\"port\":$PORT,\"nodeId\":\"$nid\"}")
            if echo "$RESULT" | grep -q '"ok":true'; then
                ok "Port $PORT → $nname active"
            else
                ERR=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)
                warn "Port $PORT failed: $ERR"
            fi
        else
            info "Skipped port $PORT"
        fi
        ((PORT++))
    done <<< "$NODE_LIST"
fi

# ── STEP 4: HOTLOOP SETUP ────────────────────────────────────
echo ""
echo -e "${BOLD}Hotloop / Load Balancer${NC}"
read -rp "  Enable hotloop? [y/N]: " HL
HL=${HL:-N}

if [[ "$HL" =~ ^[Yy] ]]; then
    echo ""
    echo "  Pick primary node:"
    i=1
    while IFS='|' read -r nid nname nip; do
        echo -e "    ${B}$i)${NC} $nname"
        ((i++))
    done <<< "$NODE_LIST"
    read -rp "  Primary [1]: " PIDX; PIDX=${PIDX:-1}
    read -rp "  Fallback [2]: " FIDX; FIDX=${FIDX:-2}
    read -rp "  Primary weight 0-100% [80]: " WEIGHT; WEIGHT=${WEIGHT:-80}

    PRIMARY_ID=${NODE_IDS[$PIDX]}
    FALLBACK_ID=${NODE_IDS[$FIDX]}
    PW=$((WEIGHT * 10))

    RESULT=$(curl -s -u "$AUTH" -X POST "$API/hotloop" \
        -H "Content-Type: application/json" \
        -d "{\"enabled\":true,\"primaryNode\":\"$PRIMARY_ID\",\"fallbackNode\":\"$FALLBACK_ID\",\"primaryWeight\":$PW,\"mode\":\"weighted\"}")

    if echo "$RESULT" | grep -q '"ok":true'; then
        ok "Hotloop enabled — ${NODE_NAMES[$PIDX]} ($WEIGHT%) ↔ ${NODE_NAMES[$FIDX]} ($((100-WEIGHT))%)"
    else
        warn "Hotloop save failed — check dashboard"
    fi
else
    info "Hotloop disabled"
    curl -s -u "$AUTH" -X POST "$API/hotloop" \
        -H "Content-Type: application/json" \
        -d '{"enabled":false}' > /dev/null
fi

# ── STEP 5: DISABLE IP AUTH ───────────────────────────────────
echo ""
info "Disabling IP auth (allow all)..."
echo "allow *" > "$APP_DIR/whitelist.cfg"
curl -s -u "$AUTH" -X POST "$API/settings/auth" \
    -H "Content-Type: application/json" \
    -d '{"enabled":false}' > /dev/null
ok "IP auth disabled — whitelist.cfg set to allow *"

# ── STEP 6: RESTART HUB PROXY ─────────────────────────────────
echo ""
info "Restarting hub proxy..."
RESULT=$(curl -s -u "$AUTH" -X POST "$API/restart")
if echo "$RESULT" | grep -q '"ok":true\|Restarted'; then
    ok "Hub proxy restarted"
else
    warn "Restart response: $RESULT"
fi

# ── STEP 7: CHECK PORT ROUTES ─────────────────────────────────
echo ""
info "Checking port route status..."
ROUTES=$(curl -s -u "$AUTH" "$API/port-routes")
python3 - << PYEOF
import json
data = json.loads('''$ROUTES''')
routes = data.get('portRoutes', [])
if not routes:
    print("  No port routes configured")
else:
    for r in routes:
        status = "✓ Active" if r.get('active') else "✗ Stopped"
        print(f"  Port {r['port']} → {r['nodeName']} — {status}")
PYEOF

# ── DONE ──────────────────────────────────────────────────────
echo ""
echo -e "${G}${BOLD}Done!${NC} Dashboard: http://vpn.oofbomb.xyz"
echo -e "  Port 1080 = hub default"
PORT=1081
while IFS='|' read -r nid nname nip; do
    echo -e "  Port $PORT = $nname ($nip)"
    ((PORT++))
done <<< "$NODE_LIST" 2>/dev/null
echo ""