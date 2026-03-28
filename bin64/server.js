const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');
const https    = require('https');
const http     = require('http');
const net      = require('net');
const readline = require('readline');
const app      = express();
const PORT     = 80;

// ─── AUTH ────────────────────────────────────────────────────────────────────
const USER  = 'oofbomb';
const PASS  = 'malaop0989';
const TOKEN = Buffer.from(`${USER}:${PASS}`).toString('base64');

app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || /\.(html|js|css|ico|png|woff2?)$/.test(req.path)))
        return next();
    if (req.path.startsWith('/ext/') || req.path === '/speedtest')
        return next();
    const auth  = req.headers.authorization || '';
    const token = auth.replace(/^(Bearer|Basic)\s+/i, '');
    if (token === TOKEN) return next();
    return res.status(401).json({ error: 'Unauthorized' });
});

app.use(express.json());
app.use(express.text({ type: 'text/plain' }));
app.use('/', express.static(path.join(__dirname, 'public')));

// ─── PATHS ───────────────────────────────────────────────────────────────────
const WL_FILE       = path.join(__dirname, 'whitelist.cfg');
const HUB_CFG_FILE  = path.join(__dirname, '3proxy.cfg');
const PROXY_EXE     = path.join(__dirname, '3proxy.exe');
const NODES_FILE    = path.join(__dirname, 'nodes.json');
const CLIENTS_FILE  = path.join(__dirname, 'clients.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const HOTLOOP_FILE  = path.join(__dirname, 'hotloop.json');
const LOG_FILE      = path.join(__dirname, '3proxy.log');
const SERVER_FILE   = __filename;

// ─── TAILSCALE ───────────────────────────────────────────────────────────────
const TS_API_KEY = 'tskey-api-k9GpGN8ma221CNTRL-gYKsstC5M2QhTpXstyj33Qkpeqq5bgT62';
const TS_TAILNET = '-';

// ─── STATE ───────────────────────────────────────────────────────────────────
function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return d; } }
function saveJson(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let activeConnections = new Set();
let nodeRegistry      = loadJson(NODES_FILE, {});
let clientRegistry    = loadJson(CLIENTS_FILE, {});
let settings          = loadJson(SETTINGS_FILE, { ipAuthEnabled: true });
let hotloop           = loadJson(HOTLOOP_FILE, {
    enabled: false,
    primaryNode: null,     // node id
    fallbackNode: null,    // node id
    primaryWeight: 900,    // out of 1000
    threshold: 50,         // connections before spilling to fallback
    mode: 'weighted',      // 'weighted' | 'latency' | 'manual'
});
let tsDevices = [];

// ─── PER-CLIENT LIVE STATS ───────────────────────────────────────────────────
// Parsed from 3proxy log: { ip -> { bytesIn, bytesOut, duration, sendRate, recvRate, remote, lastSeen } }
let clientStats = {};

// ─── LOG TAILER ──────────────────────────────────────────────────────────────
// Parses lines: "STAT <time> <clientIP> <bytesIn> <bytesOut> <durationMs> <sendRate> <recvRate> <remote> <user> <host>"
function startLogTailer() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log('Log file not found yet, will retry:', LOG_FILE);
        setTimeout(startLogTailer, 5000);
        return;
    }

    let size = fs.statSync(LOG_FILE).size;
    const rl = readline.createInterface({ input: fs.createReadStream(LOG_FILE, { start: size }) });

    rl.on('line', parseLine);

    // Watch for new data
    fs.watchFile(LOG_FILE, { interval: 500 }, () => {
        const newSize = fs.statSync(LOG_FILE).size;
        if (newSize > size) {
            const stream = fs.createReadStream(LOG_FILE, { start: size, end: newSize });
            const r2 = readline.createInterface({ input: stream });
            r2.on('line', parseLine);
            size = newSize;
        }
    });

    console.log('Log tailer started:', LOG_FILE);
}

function parseLine(line) {
    if (!line.startsWith('STAT ')) return;
    const parts = line.split(' ');
    // STAT time clientIP bytesIn bytesOut durationMs sendRate recvRate remote user host
    if (parts.length < 8) return;
    const [, time, clientIP, bytesIn, bytesOut, durationMs, sendRate, recvRate, remote] = parts;
    if (!clientIP || clientIP === '-') return;

    clientStats[clientIP] = {
        bytesIn:   parseInt(bytesIn)   || 0,
        bytesOut:  parseInt(bytesOut)  || 0,
        duration:  parseInt(durationMs)|| 0,
        sendRate:  parseFloat(sendRate)|| 0,
        recvRate:  parseFloat(recvRate)|| 0,
        remote:    remote || '-',
        lastSeen:  new Date().toISOString(),
    };

    // Also update active connections set
    activeConnections.add(clientIP);
    // Remove if connection is closed (duration > 0 means it completed)
    if (parseInt(durationMs) > 0) {
        setTimeout(() => activeConnections.delete(clientIP), 30000);
    }
}

startLogTailer();

// ─── TAILSCALE POLLING ───────────────────────────────────────────────────────
function tsRequest(method, endpoint, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            `https://api.tailscale.com/api/v2${endpoint}`,
            { method, headers: { 'Authorization': `Bearer ${TS_API_KEY}`, 'Content-Type': 'application/json' } },
            res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                    catch { resolve({ status: res.statusCode, body: data }); }
                });
            }
        );
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function isOnline(lastSeen) {
    return lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 180000;
}

async function pollTailscale() {
    if (TS_API_KEY === 'YOUR_TAILSCALE_API_KEY') return;
    try {
        const { status, body } = await tsRequest('GET', `/tailnet/${TS_TAILNET}/devices`);
        if (status === 200 && body.devices) {
            tsDevices = body.devices;
            tsDevices.forEach(dev => {
                const node = Object.values(nodeRegistry).find(n => n.tailscaleId === dev.id || n.tailscaleIp === dev.addresses?.[0]);
                if (node) {
                    node.lastSeen    = dev.lastSeen;
                    node.online      = isOnline(dev.lastSeen);
                    node.hostname    = dev.hostname || node.hostname;
                    node.tailscaleIp = dev.addresses?.[0] || node.tailscaleIp;
                }
                const client = Object.values(clientRegistry).find(c => c.tailscaleId === dev.id);
                if (client) {
                    client.lastSeen = dev.lastSeen;
                    client.online   = isOnline(dev.lastSeen);
                    client.hostname = dev.hostname || client.hostname;
                }
            });
            saveJson(NODES_FILE, nodeRegistry);
            saveJson(CLIENTS_FILE, clientRegistry);
        }
    } catch(e) { console.warn('Tailscale poll:', e.message); }
}

setInterval(pollTailscale, 10000);
pollTailscale();

// ─── WHITELIST HELPERS ───────────────────────────────────────────────────────
function getActualWhitelist() {
    if (!fs.existsSync(WL_FILE)) return [];
    return fs.readFileSync(WL_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && l !== 'allow *');
}

function syncWhitelist(ipLines) {
    let out = [];
    if (!settings.ipAuthEnabled) out.push('allow *');
    out.push(...ipLines);
    fs.writeFileSync(WL_FILE, out.join('\n') + '\n');
    softRestartProxy();
}

// ─── HUB CFG REWRITER ────────────────────────────────────────────────────────
// Rewrites the 3proxy-hub.cfg parent lines based on hotloop config
function rewriteHubCfg() {
    if (!fs.existsSync(HUB_CFG_FILE)) return;
    let cfg = fs.readFileSync(HUB_CFG_FILE, 'utf8');

    // Remove existing parent lines
    cfg = cfg.replace(/^allow \*\nparent \d+ socks5 .+\n/gm, '');
    cfg = cfg.replace(/# ── Load Balancer.*?(?=# ──|$)/ms, '');

    const primaryNode  = nodeRegistry[hotloop.primaryNode];
    const fallbackNode = nodeRegistry[hotloop.fallbackNode];

    let lbSection = '# ── Load Balancer ────────────────────────────────────────────────────────────\n';

    if (!hotloop.enabled || !primaryNode) {
        lbSection += '# Hotloop disabled — no chaining, hub is exit\n';
    } else {
        const pw = hotloop.primaryWeight;
        const fw = 1000 - pw;
        lbSection += `allow *\nparent ${pw} socks5 ${primaryNode.tailscaleIp} 1080\n`;
        if (fallbackNode && fw > 0) {
            lbSection += `allow *\nparent ${fw} socks5 ${fallbackNode.tailscaleIp} 1080\n`;
        }
    }

    // Insert before the socks line
    cfg = cfg.replace(/(# ── SOCKS5)/, lbSection + '\n$1');
    fs.writeFileSync(HUB_CFG_FILE, cfg);
}

// ─── SETTINGS & AUTH ─────────────────────────────────────────────────────────
app.get('/settings', (req, res) => res.json({ ...settings, hotloop }));

app.post('/settings/auth', (req, res) => {
    settings.ipAuthEnabled = req.body.enabled;
    saveJson(SETTINGS_FILE, settings);
    syncWhitelist(getActualWhitelist());
    res.json({ ok: true, ipAuthEnabled: settings.ipAuthEnabled });
});

// ─── WHITELIST ───────────────────────────────────────────────────────────────
app.get('/whitelist', (req, res) => res.json({ whitelist: getActualWhitelist(), ipAuthEnabled: settings.ipAuthEnabled }));

app.post('/whitelist', (req, res) => {
    const ip = req.body.ip;
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return res.status(400).send('Invalid IP');
    const lines = getActualWhitelist();
    const entry = `allow * ${ip}`;
    if (!lines.includes(entry)) { lines.push(entry); syncWhitelist(lines); }
    res.send('OK');
});

app.delete('/whitelist', (req, res) => {
    const ip = req.body.ip;
    if (!ip) return res.status(400).send('Missing IP');
    syncWhitelist(getActualWhitelist().filter(l => l !== `allow * ${ip}` && l !== ip));
    res.send('OK');
});

app.get('/whitelist/check', (req, res) => {
    const ip = req.query.ip || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (!settings.ipAuthEnabled) return res.json({ allowed: true, ip });
    res.json({ allowed: getActualWhitelist().some(l => l.includes(ip)), ip });
});

// ─── PROXY CONTROL ───────────────────────────────────────────────────────────
function softRestartProxy(cb) {
    exec('taskkill /IM 3proxy.exe /F', () => {
        setTimeout(() => exec(`start "" "${PROXY_EXE}" "${HUB_CFG_FILE}"`, err => cb && cb(err)), 500);
    });
}

app.post('/restart',     (req, res) => softRestartProxy(e => e ? res.status(500).send('Failed') : res.send('Restarted')));
app.post('/start',       (req, res) => exec(`start "" "${PROXY_EXE}" "${HUB_CFG_FILE}"`, e => e ? res.status(500).send('Failed') : res.send('Started')));
app.post('/stop',        (req, res) => exec('taskkill /IM 3proxy.exe /F', e => e ? res.status(500).send('Not running') : res.send('Stopped')));
app.post('/restart-web', (req, res) => { res.send('Restarting…'); setTimeout(() => process.exit(0), 500); });
app.post('/stop-web',    (req, res) => { res.send('Stopping…'); setTimeout(() => process.exit(0), 300); });
app.post('/status',      (req, res) => exec('tasklist /FI "IMAGENAME eq 3proxy.exe" /NH', (err, out) =>
    res.send(out?.toLowerCase().includes('3proxy.exe') ? 'Running' : 'Not running')));

// ─── CONFIG FILES ─────────────────────────────────────────────────────────────
app.get('/config',  (req, res) => { if (!fs.existsSync(HUB_CFG_FILE)) return res.status(404).send('Not found'); res.setHeader('Content-Type','text/plain'); res.send(fs.readFileSync(HUB_CFG_FILE,'utf8')); });
app.post('/config', (req, res) => { if (typeof req.body!=='string') return res.status(400).send('Expected text'); fs.writeFileSync(HUB_CFG_FILE+'.bak', fs.existsSync(HUB_CFG_FILE)?fs.readFileSync(HUB_CFG_FILE):''); fs.writeFileSync(HUB_CFG_FILE, req.body); res.send('Saved'); });
app.get('/server-source',  (req, res) => { res.setHeader('Content-Type','text/plain'); res.send(fs.readFileSync(SERVER_FILE,'utf8')); });
app.post('/server-source', (req, res) => { if (typeof req.body!=='string'||req.body.trim().length<10) return res.status(400).send('Too short'); fs.writeFileSync(SERVER_FILE+'.bak', fs.readFileSync(SERVER_FILE)); fs.writeFileSync(SERVER_FILE, req.body); res.send('Saved'); setTimeout(()=>process.exit(0),400); });

// ─── CONNECTIONS + STATS ──────────────────────────────────────────────────────
app.get('/connections', (req, res) => {
    res.json({ count: activeConnections.size, ips: Array.from(activeConnections) });
});

// Rich per-client stats from log parser
app.get('/client-stats', (req, res) => {
    res.json({ stats: clientStats, count: Object.keys(clientStats).length });
});

// ─── SPEEDTEST ENDPOINT ───────────────────────────────────────────────────────
// Returns a chunk of random data — client times the response to measure bandwidth
app.get('/speedtest', (req, res) => {
    const size = parseInt(req.query.size) || 1048576; // default 1MB
    const clamped = Math.min(size, 10 * 1048576); // max 10MB
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', clamped);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Stream random-ish data (fast, not crypto random)
    let sent = 0;
    const chunk = Buffer.alloc(65536, 0xAB);
    function sendChunk() {
        while (sent < clamped) {
            const toSend = Math.min(65536, clamped - sent);
            const ok = res.write(chunk.slice(0, toSend));
            sent += toSend;
            if (!ok) { res.once('drain', sendChunk); return; }
        }
        res.end();
    }
    sendChunk();
});

// Upload endpoint — receives data and discards, times it server side
app.post('/speedtest/upload', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    let bytes = 0;
    const start = Date.now();
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
        const elapsed = (Date.now() - start) / 1000;
        res.json({ bytes, elapsed, mbps: ((bytes * 8) / elapsed / 1000000).toFixed(2) });
    });
});

// ─── PING ENDPOINT (for extension latency meter) ──────────────────────────────
app.get('/ext/ping', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ pong: true, ts: Date.now() });
});

// ─── HOTLOOP / LOAD BALANCER ─────────────────────────────────────────────────
app.get('/hotloop', (req, res) => res.json(hotloop));

app.post('/hotloop', (req, res) => {
    const { enabled, primaryNode, fallbackNode, primaryWeight, threshold, mode } = req.body;
    if (enabled !== undefined) hotloop.enabled = enabled;
    if (primaryNode  !== undefined) hotloop.primaryNode  = primaryNode;
    if (fallbackNode !== undefined) hotloop.fallbackNode = fallbackNode;
    if (primaryWeight!== undefined) hotloop.primaryWeight = Math.max(0, Math.min(1000, parseInt(primaryWeight)));
    if (threshold    !== undefined) hotloop.threshold    = parseInt(threshold);
    if (mode         !== undefined) hotloop.mode         = mode;
    saveJson(HOTLOOP_FILE, hotloop);
    rewriteHubCfg();
    // Soft restart to apply
    setTimeout(softRestartProxy, 500);
    res.json({ ok: true, hotloop });
});

// ─── NODE REGISTRY ───────────────────────────────────────────────────────────
// Node ping — TCP connect latency to node's Tailscale IP
function pingNode(ip, port, timeout) {
    return new Promise(resolve => {
        const start = Date.now();
        const sock = new net.Socket();
        sock.setTimeout(timeout || 3000);
        sock.connect(port || 1080, ip, () => {
            const ms = Date.now() - start;
            sock.destroy();
            resolve({ online: true, latencyMs: ms });
        });
        sock.on('error', () => { sock.destroy(); resolve({ online: false, latencyMs: null }); });
        sock.on('timeout', () => { sock.destroy(); resolve({ online: false, latencyMs: null }); });
    });
}

app.get('/nodes', (req, res) => {
    const enriched = Object.entries(nodeRegistry).map(([id, node]) => {
        const tsDev = tsDevices.find(d => d.id === node.tailscaleId || d.addresses?.includes(node.tailscaleIp));
        return { ...node, id, online: tsDev ? isOnline(tsDev.lastSeen) : node.online || false, lastSeen: tsDev?.lastSeen || node.lastSeen || null };
    });
    res.json({ nodes: enriched, hotloop });
});

// Live ping all nodes — called by dashboard and extension
app.get('/nodes/ping', async (req, res) => {
    const results = {};
    await Promise.all(
        Object.entries(nodeRegistry).map(async ([id, node]) => {
            if (!node.tailscaleIp) { results[id] = { online: false, latencyMs: null }; return; }
            results[id] = await pingNode(node.tailscaleIp, 1080, 2000);
        })
    );
    res.json({ results, ts: Date.now() });
});

app.post('/nodes', (req, res) => {
    const { name, region, tailscaleIp, tailscaleId, enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = tailscaleId || `node_${Date.now()}`;
    nodeRegistry[id] = { id, name, region: region||'Unknown', tailscaleIp: tailscaleIp||null, tailscaleId: tailscaleId||null, enabled: enabled!==false, online: false, lastSeen: null, addedAt: new Date().toISOString(), connections: 0 };
    saveJson(NODES_FILE, nodeRegistry);
    res.json({ ok: true, node: nodeRegistry[id] });
});

app.patch('/nodes/:id', (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node) return res.status(404).json({ error: 'Not found' });
    if (req.body.enabled !== undefined) node.enabled = req.body.enabled;
    if (req.body.name)   node.name   = req.body.name;
    if (req.body.region) node.region = req.body.region;
    saveJson(NODES_FILE, nodeRegistry);
    res.json({ ok: true, node });
});

app.delete('/nodes/:id', (req, res) => {
    if (!nodeRegistry[req.params.id]) return res.status(404).json({ error: 'Not found' });
    delete nodeRegistry[req.params.id];
    saveJson(NODES_FILE, nodeRegistry);
    res.json({ ok: true });
}); // h

app.get('/nodes/join-instructions', (req, res) => {
    const authKey = req.query.authKey || TS_API_KEY;
    res.json({
        steps: [
            { label: 'Download & run installer', cmd: `curl -fsSL https://YOUR_HUB/install-node.sh | sudo TS_AUTH_KEY=${authKey} HUB_TS_IP=YOUR_HUB_TAILSCALE_IP bash` },
            { label: 'Or step-by-step — Install Tailscale', cmd: `curl -fsSL https://tailscale.com/install.sh | sh` },
            { label: 'Join your Tailnet', cmd: `sudo tailscale up --authkey ${authKey} --hostname vpn-node-$(hostname)` },
            { label: 'Download 3proxy 0.9.5', cmd: `wget https://github.com/3proxy/3proxy/releases/download/0.9.5/3proxy-0.9.5.x86_64.deb` },
            { label: 'Install 3proxy', cmd: `sudo dpkg -i 3proxy-0.9.5.x86_64.deb` },
            { label: 'Get your Tailscale IP', cmd: `tailscale ip -4` },
            { label: 'Write config', cmd: `TS_IP=$(tailscale ip -4)\nsudo tee /etc/3proxy/conf/3proxy.cfg << EOF\nnserver 1.1.1.1\nnserver 8.8.8.8\nnscache 65536\ntimeouts 1 5 30 60 180 1800 15 60\ndaemon\nlog /logs/3proxy.log D\nlogformat "STAT %t %C %I %O %D %b %B %R %U %h"\nlogdump 1048576 1048576\nauth iponly\nallow * YOUR_HUB_TS_IP\ndeny *\nsocks -p1080 -i$TS_IP -osTCP_NODELAY -ocTCP_NODELAY -n\nEOF` },
            { label: 'Enable & start', cmd: `sudo systemctl enable 3proxy && sudo systemctl restart 3proxy && sudo systemctl status 3proxy` },
        ],
        note: 'Config: /etc/3proxy/conf/3proxy.cfg | Logs: /var/log/3proxy/ | Service: systemctl start|stop|restart|status 3proxy'
    });
});

// ─── CLIENTS ─────────────────────────────────────────────────────────────────
app.get('/clients', (req, res) => {
    const enriched = Object.entries(clientRegistry).map(([id, client]) => {
        const tsDev = tsDevices.find(d => d.id === client.tailscaleId);
        const stats = clientStats[client.tailscaleIp] || clientStats[client.lastKnownIp] || {};
        return { ...client, id, online: tsDev ? isOnline(tsDev.lastSeen) : client.online||false, lastSeen: tsDev?.lastSeen||client.lastSeen||null, liveStats: stats };
    });
    res.json({ clients: enriched });
});

app.post('/clients', (req, res) => {
    const { name, tailscaleId, tailscaleIp, defaultNode } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = tailscaleId || `client_${Date.now()}`;
    clientRegistry[id] = { id, name, tailscaleId: tailscaleId||null, tailscaleIp: tailscaleIp||null, defaultNode: defaultNode||null, online: false, lastSeen: null, addedAt: new Date().toISOString() };
    saveJson(CLIENTS_FILE, clientRegistry);
    res.json({ ok: true, client: clientRegistry[id] });
});

app.patch('/clients/:id', (req, res) => {
    const client = clientRegistry[req.params.id];
    if (!client) return res.status(404).json({ error: 'Not found' });
    if (req.body.defaultNode !== undefined) client.defaultNode = req.body.defaultNode;
    if (req.body.name) client.name = req.body.name;
    saveJson(CLIENTS_FILE, clientRegistry);
    res.json({ ok: true, client });
});

app.delete('/clients/:id', (req, res) => {
    if (!clientRegistry[req.params.id]) return res.status(404).json({ error: 'Not found' });
    delete clientRegistry[req.params.id];
    saveJson(CLIENTS_FILE, clientRegistry);
    res.json({ ok: true });
});

app.post('/clients/:id/kick', async (req, res) => {
    const client = clientRegistry[req.params.id];
    if (!client) return res.status(404).json({ error: 'Not found' });
    if (!client.tailscaleId) return res.status(400).json({ error: 'No Tailscale ID' });
    try {
        const { status } = await tsRequest('DELETE', `/device/${client.tailscaleId}`);
        if (status === 200 || status === 204) { client.online = false; saveJson(CLIENTS_FILE, clientRegistry); res.json({ ok: true, message: `${client.name} kicked` }); }
        else res.status(status).json({ error: 'Tailscale API error' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── AGGREGATE STATS ─────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
    const totalBytesIn  = Object.values(clientStats).reduce((s,c) => s + c.bytesIn, 0);
    const totalBytesOut = Object.values(clientStats).reduce((s,c) => s + c.bytesOut, 0);
    const nodes = Object.entries(nodeRegistry).map(([id, n]) => ({ id, name: n.name, region: n.region, connections: n.connections||0, enabled: n.enabled, online: n.online }));
    res.json({
        totalConnections: activeConnections.size,
        activeClients:    Object.keys(clientStats).length,
        totalBytesIn, totalBytesOut,
        nodes,
        clients: Object.values(clientRegistry).filter(c => c.online).length,
        hotloop,
        timestamp: Date.now(),
    });
});

// ─── EXTENSION API (no auth, CORS open) ──────────────────────────────────────
app.use('/ext', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Returns enabled+online nodes with fresh latency
app.get('/ext/nodes', async (req, res) => {
    const nodes = Object.values(nodeRegistry).filter(n => n.enabled && n.online)
        .map(n => ({ id: n.id, name: n.name, region: n.region, tailscaleIp: n.tailscaleIp }));

    // Live ping each node
    const withPing = await Promise.all(nodes.map(async n => {
        const ping = n.tailscaleIp ? await pingNode(n.tailscaleIp, 1080, 2000) : { latencyMs: null, online: false };
        return { ...n, latencyMs: ping.latencyMs, online: ping.online };
    }));

    res.json({ nodes: withPing, hotloop: { enabled: hotloop.enabled, mode: hotloop.mode } });
});

app.get('/ext/check', (req, res) => {
    // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    const ip = rawIp.replace(/^::ffff:/, '');
    if (!settings.ipAuthEnabled) return res.json({ allowed: true, ip });
    res.json({ allowed: getActualWhitelist().some(l => l.includes(ip)), ip });
});


// ─── PER-NODE SPEED TEST + PING PROXY ────────────────────────────────────────
// Hub proxies these requests through to the node so the dashboard can test
// each node's speed without the client needing direct Tailscale access

app.get('/nodes/:id/ping', async (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node?.tailscaleIp) return res.status(404).json({ error: 'Node not found or no IP' });
    const start = Date.now();
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.connect(3128, node.tailscaleIp, () => {
        const ms = Date.now() - start;
        sock.destroy();
        res.json({ pong: true, latencyMs: ms, node: node.name, ts: Date.now() });
    });
    sock.on('error', () => { sock.destroy(); res.status(503).json({ error: 'Node unreachable', latencyMs: null }); });
    sock.on('timeout', () => { sock.destroy(); res.status(504).json({ error: 'Timeout', latencyMs: null }); });
});

// Proxy speedtest download through to a node's HTTP proxy port
app.get('/nodes/:id/speedtest', (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node?.tailscaleIp) return res.status(404).send('Node not found');
    const size = Math.min(parseInt(req.query.size) || 2097152, 10485760);
    // Fetch from the node's HTTP proxy — it will forward the request
    // We use a direct TCP connection to pull data from the node's proxy
    const options = {
        hostname: node.tailscaleIp,
        port: 3128,
        path: `http://${node.tailscaleIp}:3128/speedtest?size=${size}`,
        method: 'GET',
        timeout: 30000,
    };
    const proxyReq = http.request(options, (proxyRes) => {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
        // Node proxy not reachable — serve from hub as fallback so test still works
        const chunk = Buffer.alloc(65536, 0xAB);
        let sent = 0;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Speedtest-Source', 'hub-fallback');
        function send() {
            while (sent < size) {
                const n = Math.min(65536, size - sent);
                if (!res.write(chunk.slice(0, n))) { res.once('drain', send); return; }
                sent += n;
            }
            res.end();
        }
        send();
    });
    proxyReq.end();
});

// Proxy speedtest upload to node
app.post('/nodes/:id/speedtest/upload', (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node?.tailscaleIp) return res.status(404).send('Node not found');
    let bytes = 0;
    const start = Date.now();
    req.on('data', c => { bytes += c.length; });
    req.on('end', () => {
        const elapsed = (Date.now() - start) / 1000;
        // Forward payload size to node for accurate measurement — or just measure hub receipt
        res.json({
            bytes, elapsed,
            mbps: ((bytes * 8) / elapsed / 1000000).toFixed(2),
            note: elapsed < 0.1 ? 'Too fast to measure accurately — try larger size' : undefined
        });
    });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`3Proxy dashboard → http://localhost:${PORT}`);
    console.log(`IP Auth: ${settings.ipAuthEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Hotloop: ${hotloop.enabled ? 'ENABLED' : 'DISABLED'}`);
});