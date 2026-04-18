const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { exec } = require('child_process');
const https    = require('https');
const http     = require('http');
const net      = require('net');
const readline = require('readline');
const app      = express();
const PORT     = 8080;

// ─── AUTH ────────────────────────────────────────────────────────────────────
const USER  = 'oofbomb';
const PASS  = 'malaop0989';
const TOKEN = Buffer.from(`${USER}:${PASS}`).toString('base64');

app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || /\.(html|js|css|ico|png|woff2?)$/.test(req.path)))
        return next();
    if (req.path.startsWith('/ext/') || req.path === '/speedtest')
        return next();
    // /terminal accepts an auth token in the query string (popup window can't send headers)
    if (req.path === '/terminal' && req.method === 'GET') {
        const qt = (req.query.token || '').replace(/^(Bearer|Basic)\s+/i, '');
        // Accept either the base64 token or raw "user:pass"
        if (qt === TOKEN || qt === `${USER}:${PASS}` || Buffer.from(qt).toString('base64') === TOKEN) return next();
    }
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
const HUB_TOKEN_FILE = path.join(__dirname, 'hub-token');  // shared secret w/ node agents
const NOTIFS_FILE    = path.join(__dirname, 'notifications.json');
const AGENT_PORT     = 9999;

// ─── TAILSCALE ───────────────────────────────────────────────────────────────
const TS_API_KEY = 'tskey-api-k9GpGN8ma221CNTRL-gYKsstC5M2QhTpXstyj33Qkpeqq5bgT62';
const TS_TAILNET = '-';

// ─── STATE ───────────────────────────────────────────────────────────────────
function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return d; } }
function saveJson(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

let activeConnections = new Set();
let nodeRegistry      = loadJson(NODES_FILE, {});
let clientRegistry    = loadJson(CLIENTS_FILE, {});
let settings          = loadJson(SETTINGS_FILE, { ipAuthEnabled: true, dashAuthEnabled: true });
if (settings.dashAuthEnabled === undefined) settings.dashAuthEnabled = true;
let hotloop           = loadJson(HOTLOOP_FILE, {
    enabled: false, primaryNode: null, fallbackNode: null,
    primaryWeight: 900, threshold: 50, mode: 'weighted',
});
let tsDevices = [];
let clientStats = {};
let notifications = loadJson(NOTIFS_FILE, []);   // [{ level, msg, ts }]

// ─── HUB TOKEN (shared secret for node agents) ───────────────────────────────
let HUB_TOKEN_VALUE = '';
try { HUB_TOKEN_VALUE = fs.readFileSync(HUB_TOKEN_FILE, 'utf8').trim(); } catch {}
if (!HUB_TOKEN_VALUE || HUB_TOKEN_VALUE.length < 32) {
    HUB_TOKEN_VALUE = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(HUB_TOKEN_FILE, HUB_TOKEN_VALUE, { mode: 0o600 }); }
    catch (e) { console.warn('[hub-token] could not write token file:', e.message); }
    console.log(`[hub-token] generated new token → ${HUB_TOKEN_FILE}`);
}

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
function addNotif(level, msg) {
    notifications.unshift({ level, msg, ts: Date.now() });
    if (notifications.length > 200) notifications.length = 200;
    try { saveJson(NOTIFS_FILE, notifications); } catch {}
}

// ─── NODE AGENT CLIENT ───────────────────────────────────────────────────────
// Talks to each node's proxyhub-agent over Tailscale. No public ports used.
function callNodeAgent(ip, apiPath, { method = 'GET', body = null, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            host: ip, port: AGENT_PORT, path: apiPath, method,
            headers: {
                'X-Hub-Token':  HUB_TOKEN_VALUE,
                'Content-Type': 'application/json',
                ...(data != null ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
            timeout,
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                const ct = (res.headers['content-type'] || '').toLowerCase();
                let parsed = buf;
                if (ct.includes('application/json')) { try { parsed = JSON.parse(buf); } catch {} }
                resolve({ status: res.statusCode, body: parsed, raw: buf });
            });
        });
        req.on('error',   err => reject(err));
        req.on('timeout', ()  => { req.destroy(new Error('agent timeout')); });
        if (data != null) req.write(data);
        req.end();
    });
}

// ─── PORT → NODE ROUTING ─────────────────────────────────────────────────────
// Maps a SOCKS5 listen port to a specific node ID.
// When a client connects to hub:PORT, their traffic is routed to that node only.
// Edit this via dashboard or directly in settings.json under portRoutes.
// Example: { "1081": "node_chicago", "1082": "node_nyc" }
// Port 1080 = default hub routing (hotloop / no chain)
let portRoutes = loadJson(SETTINGS_FILE, {}).portRoutes || {};

// Active per-port 3proxy listener processes: { port: childProcess }
const portProxyProcesses = {};

function buildPortRouteCfg(port, node) {
const logPath = path.join(__dirname, 'logs', `3proxy-port${port}.log`);
    return [
        'nserver 1.1.1.1',
        'nserver 8.8.8.8',
        'nscache 65536',
        'timeouts 1 5 30 60 180 1800 15 60',
        `log ${logPath} D`,
        'logformat "STAT %t %C %I %O %D %b %B %R %U %h"',
        'auth iponly',
        'allow *',
        `parent 1000 socks5 ${node.tailscaleIp} 1080`,
        'deny *',
        `socks -p${port} -osTCP_NODELAY -ocTCP_NODELAY -n`,
    ].join('\n');
}

function startPortProxy(port, node) {
    if (portProxyProcesses[port]) {
        portProxyProcesses[port].kill();
        delete portProxyProcesses[port];
    }
    const cfgPath = path.join(__dirname, `3proxy-port${port}.cfg`);
    fs.writeFileSync(cfgPath, buildPortRouteCfg(port, node));
    const proc = require('child_process').spawn(PROXY_EXE, [cfgPath], { detached: false });
    portProxyProcesses[port] = proc;
    proc.on('exit', () => delete portProxyProcesses[port]);
    console.log(`[PortRoute] Started port ${port} → ${node.name} (${node.tailscaleIp})`);
}

function stopPortProxy(port) {
    if (portProxyProcesses[port]) {
        portProxyProcesses[port].kill();
        delete portProxyProcesses[port];
    }
    const cfgPath = path.join(__dirname, `3proxy-port${port}.cfg`);
    if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
}

function syncPortRoutes() {
    // Stop any ports no longer in portRoutes
    Object.keys(portProxyProcesses).forEach(port => {
        if (!portRoutes[port]) stopPortProxy(port);
    });
    // Start/restart all defined port routes
    Object.entries(portRoutes).forEach(([port, nodeId]) => {
        const node = nodeRegistry[nodeId];
        if (node && node.enabled !== false && node.tailscaleIp) {
            startPortProxy(port, node);
        } else {
            stopPortProxy(port);
        }
    });
}

// Start port routes on boot
setTimeout(syncPortRoutes, 3000);

// ─── LOG TAILER ──────────────────────────────────────────────────────────────
function startLogTailer() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log('Log file not found yet, will retry:', LOG_FILE);
        setTimeout(startLogTailer, 5000);
        return;
    }
    let size = fs.statSync(LOG_FILE).size;
    const rl = readline.createInterface({ input: fs.createReadStream(LOG_FILE, { start: size }) });
    rl.on('line', parseLine);
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
    if (parts.length < 8) return;
    const [, time, clientIP, bytesIn, bytesOut, durationMs, sendRate, recvRate, remote] = parts;
    if (!clientIP || clientIP === '-') return;
    clientStats[clientIP] = {
        bytesIn: parseInt(bytesIn)||0, bytesOut: parseInt(bytesOut)||0,
        duration: parseInt(durationMs)||0, sendRate: parseFloat(sendRate)||0,
        recvRate: parseFloat(recvRate)||0, remote: remote||'-',
        lastSeen: new Date().toISOString(),
    };
    activeConnections.add(clientIP);
    if (parseInt(durationMs) > 0) setTimeout(() => activeConnections.delete(clientIP), 30000);
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
function rewriteHubCfg() {
    if (!fs.existsSync(HUB_CFG_FILE)) return;
    let cfg = fs.readFileSync(HUB_CFG_FILE, 'utf8');
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

    cfg = cfg.replace(/(# ── SOCKS5)/, lbSection + '\n$1');
    fs.writeFileSync(HUB_CFG_FILE, cfg);
}

// ─── SETTINGS & AUTH ─────────────────────────────────────────────────────────
app.get('/settings', (req, res) => res.json({ ...settings, hotloop, portRoutes }));

app.post('/settings/auth', (req, res) => {
    settings.ipAuthEnabled = req.body.enabled;
    saveJson(SETTINGS_FILE, settings);
    syncWhitelist(getActualWhitelist());
    addNotif('info', `IP auth ${settings.ipAuthEnabled ? 'enabled' : 'disabled'}`);
    res.json({ ok: true, ipAuthEnabled: settings.ipAuthEnabled });
});

// Dashboard auth toggle — stores the flag for UI display.
// NOTE: the middleware at the top always requires basic auth for safety.
// Toggling this to "disabled" is a display-only preference for now; if you
// truly want open access you'd also have to loosen the middleware.
app.get('/settings/dash-auth', (req, res) => {
    res.json({ enabled: settings.dashAuthEnabled !== false });
});

app.post('/settings/dash-auth', (req, res) => {
    settings.dashAuthEnabled = !!req.body.enabled;
    saveJson(SETTINGS_FILE, settings);
    addNotif('warn', `Dashboard auth flag set to: ${settings.dashAuthEnabled ? 'enabled' : 'disabled'}`);
    res.json({ ok: true, enabled: settings.dashAuthEnabled });
});

// ─── PORT ROUTES API ─────────────────────────────────────────────────────────
// GET  /port-routes          — list all port→node mappings
// POST /port-routes          — add/update { port, nodeId }
// DELETE /port-routes/:port  — remove a port route

app.get('/port-routes', (req, res) => {
    const enriched = Object.entries(portRoutes).map(([port, nodeId]) => {
        const node = nodeRegistry[nodeId];
        return {
            port: parseInt(port),
            nodeId,
            nodeName:  node?.name   || 'Unknown',
            nodeRegion: node?.region || '',
            active: !!portProxyProcesses[port],
        };
    });
    res.json({ portRoutes: enriched });
});

app.post('/port-routes', (req, res) => {
    const { port, nodeId } = req.body;
    if (!port || !nodeId) return res.status(400).json({ error: 'port and nodeId required' });
    const portNum = parseInt(port);
    if (portNum <= 1024 || portNum > 65535) return res.status(400).json({ error: 'Port must be 1025–65535' });
    if (portNum === 1080 || portNum === 3128) return res.status(400).json({ error: 'Port 1080/3128 reserved for hub' });
    if (!nodeRegistry[nodeId]) return res.status(404).json({ error: 'Node not found' });

    portRoutes[String(portNum)] = nodeId;
    settings.portRoutes = portRoutes;
    saveJson(SETTINGS_FILE, settings);
    syncPortRoutes();
    res.json({ ok: true, port: portNum, nodeId });
});

app.delete('/port-routes/:port', (req, res) => {
    const port = req.params.port;
    if (!portRoutes[port]) return res.status(404).json({ error: 'Not found' });
    delete portRoutes[port];
    settings.portRoutes = portRoutes;
    saveJson(SETTINGS_FILE, settings);
    stopPortProxy(port);
    addNotif('info', `Port route ${port} removed`);
    res.json({ ok: true });
});

// Restart a single port-route 3proxy listener on the hub
app.post('/port-routes/:port/restart', (req, res) => {
    const port   = req.params.port;
    const nodeId = portRoutes[port];
    if (!nodeId) return res.status(404).json({ error: 'Port route not found' });
    const node = nodeRegistry[nodeId];
    if (!node || !node.tailscaleIp) return res.status(404).json({ error: 'Node not found or no Tailscale IP' });
    try {
        startPortProxy(port, node);   // also stops the existing one
        addNotif('info', `Port ${port} (${node.name}) restarted`);
        res.json({ ok: true, msg: `Port ${port} restarted` });
    } catch (e) {
        addNotif('error', `Port ${port} restart failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
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
app.get('/connections', (req, res) => res.json({ count: activeConnections.size, ips: Array.from(activeConnections) }));
app.get('/client-stats', (req, res) => res.json({ stats: clientStats, count: Object.keys(clientStats).length }));

// ─── SPEEDTEST ───────────────────────────────────────────────────────────────
app.get('/speedtest', (req, res) => {
    const size = Math.min(parseInt(req.query.size)||1048576, 10*1048576);
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Access-Control-Allow-Origin','*');
    let sent = 0;
    const chunk = Buffer.alloc(65536, 0xAB);
    function send() {
        while (sent < size) {
            const n = Math.min(65536, size-sent);
            if (!res.write(chunk.slice(0,n))) { res.once('drain',send); return; }
            sent += n;
        }
        res.end();
    }
    send();
});

app.post('/speedtest/upload', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin','*');
    let bytes = 0; const start = Date.now();
    req.on('data', c => bytes += c.length);
    req.on('end', () => {
        const elapsed = (Date.now()-start)/1000;
        res.json({ bytes, elapsed, mbps: ((bytes*8)/elapsed/1000000).toFixed(2) });
    });
});

app.get('/ext/ping', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cache-Control','no-store');
    res.json({ pong: true, ts: Date.now() });
});

// ─── HOTLOOP / LOAD BALANCER ─────────────────────────────────────────────────
app.get('/hotloop', (req, res) => res.json(hotloop));

app.post('/hotloop', (req, res) => {
    const { enabled, primaryNode, fallbackNode, primaryWeight, threshold, mode } = req.body;
    if (enabled       !== undefined) hotloop.enabled       = enabled;
    if (primaryNode   !== undefined) hotloop.primaryNode   = primaryNode;
    if (fallbackNode  !== undefined) hotloop.fallbackNode  = fallbackNode;
    if (primaryWeight !== undefined) hotloop.primaryWeight = Math.max(0, Math.min(1000, parseInt(primaryWeight)));
    if (threshold     !== undefined) hotloop.threshold     = parseInt(threshold);
    if (mode          !== undefined) hotloop.mode          = mode;
    saveJson(HOTLOOP_FILE, hotloop);
    rewriteHubCfg();
    setTimeout(softRestartProxy, 500);
    res.json({ ok: true, hotloop });
});

// ─── NODE REGISTRY ───────────────────────────────────────────────────────────
function pingNode(ip, port, timeout) {
    return new Promise(resolve => {
        const start = Date.now();
        const sock  = new net.Socket();
        sock.setTimeout(timeout || 3000);
        sock.connect(port || 1080, ip, () => { const ms = Date.now()-start; sock.destroy(); resolve({ online: true, latencyMs: ms }); });
        sock.on('error',   () => { sock.destroy(); resolve({ online: false, latencyMs: null }); });
        sock.on('timeout', () => { sock.destroy(); resolve({ online: false, latencyMs: null }); });
    });
}

app.get('/nodes', (req, res) => {
    const enriched = Object.entries(nodeRegistry).map(([id, node]) => {
        const tsDev = tsDevices.find(d => d.id === node.tailscaleId || d.addresses?.includes(node.tailscaleIp));
        // Find which port is mapped to this node
        const assignedPort = Object.entries(portRoutes).find(([, nid]) => nid === id)?.[0] || null;
        return {
            ...node, id,
            online:       tsDev ? isOnline(tsDev.lastSeen) : node.online || false,
            lastSeen:     tsDev?.lastSeen || node.lastSeen || null,
            assignedPort: assignedPort ? parseInt(assignedPort) : null,
        };
    });
    res.json({ nodes: enriched, hotloop });
});

app.get('/nodes/ping', async (req, res) => {
    const results = {};
    await Promise.all(Object.entries(nodeRegistry).map(async ([id, node]) => {
        if (!node.tailscaleIp) { results[id] = { online: false, latencyMs: null }; return; }
        results[id] = await pingNode(node.tailscaleIp, 1080, 2000);
    }));
    res.json({ results, ts: Date.now() });
});

app.post('/nodes', (req, res) => {
    const { name, region, tailscaleIp, tailscaleId, enabled, offlineReason } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = tailscaleId || `node_${Date.now()}`;
    nodeRegistry[id] = {
        id, name, region: region||'Unknown',
        tailscaleIp: tailscaleIp||null, tailscaleId: tailscaleId||null,
        enabled: enabled!==false,
        offlineReason: offlineReason||null,
        maintenance: false, maintenanceReason: null,
        online: false, lastSeen: null,
        addedAt: new Date().toISOString(), connections: 0,
    };
    saveJson(NODES_FILE, nodeRegistry);
    res.json({ ok: true, node: nodeRegistry[id] });
});

app.patch('/nodes/:id', (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node) return res.status(404).json({ error: 'Not found' });
    if (req.body.enabled           !== undefined) node.enabled           = req.body.enabled;
    if (req.body.offlineReason     !== undefined) node.offlineReason     = req.body.offlineReason || null;
    if (req.body.maintenance       !== undefined) node.maintenance       = req.body.maintenance;
    if (req.body.maintenanceReason !== undefined) node.maintenanceReason = req.body.maintenanceReason || null;
    if (req.body.name)   node.name   = req.body.name;
    if (req.body.region) node.region = req.body.region;
    saveJson(NODES_FILE, nodeRegistry);
    // If node was just disabled, stop its port proxy if any
    if (req.body.enabled === false) {
        const port = Object.entries(portRoutes).find(([, nid]) => nid === req.params.id)?.[0];
        if (port) stopPortProxy(port);
    }
    res.json({ ok: true, node });
});

app.delete('/nodes/:id', (req, res) => {
    if (!nodeRegistry[req.params.id]) return res.status(404).json({ error: 'Not found' });
    // Clean up port route if assigned
    const port = Object.entries(portRoutes).find(([, nid]) => nid === req.params.id)?.[0];
    if (port) { delete portRoutes[port]; settings.portRoutes = portRoutes; saveJson(SETTINGS_FILE, settings); stopPortProxy(port); }
    delete nodeRegistry[req.params.id];
    saveJson(NODES_FILE, nodeRegistry);
    res.json({ ok: true });
});

app.get('/nodes/join-instructions', (req, res) => {
    const authKey = req.query.authKey || TS_API_KEY;
    res.json({
        steps: [
            { label: 'Install Tailscale', cmd: `curl -fsSL https://tailscale.com/install.sh | sh` },
            { label: 'Join your Tailnet', cmd: `sudo tailscale up --authkey ${authKey} --hostname vpn-node-$(hostname)` },
            { label: 'Download 3proxy', cmd: `wget https://github.com/3proxy/3proxy/releases/download/0.9.5/3proxy-0.9.5.x86_64.deb` },
            { label: 'Install 3proxy', cmd: `sudo dpkg -i 3proxy-0.9.5.x86_64.deb` },
            { label: 'Get your Tailscale IP', cmd: `tailscale ip -4` },
            { label: 'Enable & start', cmd: `sudo systemctl enable 3proxy && sudo systemctl restart 3proxy` },
        ],
        note: 'Config: /etc/3proxy/conf/3proxy.cfg | Logs: /var/log/3proxy/ | Service: systemctl status 3proxy'
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
    const totalBytesIn  = Object.values(clientStats).reduce((s,c) => s+c.bytesIn, 0);
    const totalBytesOut = Object.values(clientStats).reduce((s,c) => s+c.bytesOut, 0);
    const nodes = Object.entries(nodeRegistry).map(([id, n]) => ({
        id, name: n.name, region: n.region,
        connections: n.connections||0, enabled: n.enabled,
        maintenance: n.maintenance||false, online: n.online,
    }));
    res.json({ totalConnections: activeConnections.size, activeClients: Object.keys(clientStats).length, totalBytesIn, totalBytesOut, nodes, clients: Object.values(clientRegistry).filter(c => c.online).length, hotloop, portRoutes, timestamp: Date.now() });
});

// ─── NODE AGENT CONTROL ──────────────────────────────────────────────────────
// These endpoints forward to each node's proxyhub-agent (port 9999 over Tailscale).
// The frontend calls /nodes/:id/restart-proxy — this wires it up to the agent.

function resolveNodeIp(id) {
    const node = nodeRegistry[id];
    if (!node)              return { err: 'Node not found', status: 404 };
    if (!node.tailscaleIp)  return { err: 'Node has no Tailscale IP', status: 400 };
    return { node };
}

async function nodeAgentAction(id, agentPath, method = 'POST', timeout = 8000) {
    const r = resolveNodeIp(id);
    if (r.err) return { status: r.status, body: { error: r.err } };
    try {
        const out = await callNodeAgent(r.node.tailscaleIp, agentPath, { method, timeout });
        return out;
    } catch (e) {
        return { status: 502, body: { error: 'agent unreachable', detail: e.message } };
    }
}

// Restart 3proxy on a node  (frontend calls this)
app.post('/nodes/:id/restart-proxy', async (req, res) => {
    const node = nodeRegistry[req.params.id];
    const out  = await nodeAgentAction(req.params.id, '/restart', 'POST', 15000);
    if (out.status === 200) {
        addNotif('info', `${node?.name || req.params.id}: 3proxy restarted`);
        res.json({ ok: true, msg: `${node?.name || 'Node'} restarted`, ...out.body });
    } else {
        addNotif('error', `${node?.name || req.params.id}: restart failed (${out.status})`);
        res.status(out.status).json(out.body);
    }
});

app.post('/nodes/:id/start-proxy', async (req, res) => {
    const node = nodeRegistry[req.params.id];
    const out  = await nodeAgentAction(req.params.id, '/start', 'POST');
    if (out.status === 200) addNotif('info', `${node?.name || req.params.id}: 3proxy started`);
    else                    addNotif('error', `${node?.name || req.params.id}: start failed (${out.status})`);
    res.status(out.status).json(out.body);
});

app.post('/nodes/:id/stop-proxy', async (req, res) => {
    const node = nodeRegistry[req.params.id];
    const out  = await nodeAgentAction(req.params.id, '/stop', 'POST');
    if (out.status === 200) addNotif('warn', `${node?.name || req.params.id}: 3proxy stopped`);
    else                    addNotif('error', `${node?.name || req.params.id}: stop failed (${out.status})`);
    res.status(out.status).json(out.body);
});

app.get('/nodes/:id/agent-status', async (req, res) => {
    const out = await nodeAgentAction(req.params.id, '/status', 'GET', 4000);
    res.status(out.status).json(out.body);
});

app.get('/nodes/:id/logs', async (req, res) => {
    const r = resolveNodeIp(req.params.id);
    if (r.err) return res.status(r.status).json({ error: r.err });
    const n = Math.min(parseInt(req.query.n, 10) || 200, 2000);
    try {
        const out = await callNodeAgent(r.node.tailscaleIp, `/logs?n=${n}`, { method: 'GET', timeout: 10000 });
        res.status(out.status).type('text/plain').send(out.raw || out.body || '');
    } catch (e) {
        res.status(502).json({ error: 'agent unreachable', detail: e.message });
    }
});

app.post('/nodes/:id/reboot', async (req, res) => {
    const node = nodeRegistry[req.params.id];
    const out  = await nodeAgentAction(req.params.id, '/reboot', 'POST');
    if (out.status === 200) addNotif('warn', `${node?.name || req.params.id}: reboot scheduled`);
    res.status(out.status).json(out.body);
});

// Test if the proxy works by fetching a URL through the node
app.get('/nodes/:id/fetch-test', async (req, res) => {
    const r = resolveNodeIp(req.params.id);
    if (r.err) return res.status(r.status).json({ error: r.err });
    
    const targetUrl = req.query.url || 'http://api.ipify.org?format=json';
    const node = r.node;
    
    // Use curl with SOCKS5 proxy to test the connection
    const cmd = `curl -x socks5://${node.tailscaleIp}:1080 -m 10 -s "${targetUrl}"`;
    
    exec(cmd, { timeout: 12000 }, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({
                ok: false,
                error: 'Fetch failed',
                detail: stderr || err.message,
                node: node.name,
                nodeIp: node.tailscaleIp,
                targetUrl,
            });
        }
        
        let parsed = stdout;
        try { parsed = JSON.parse(stdout); } catch {}
        
        res.json({
            ok: true,
            node: node.name,
            nodeIp: node.tailscaleIp,
            targetUrl,
            response: parsed,
            exitIp: parsed.ip || null,
        });
    });
});

// Bulk: restart 3proxy on every node in parallel
app.post('/nodes/restart-all-proxies', async (req, res) => {
    const results = {};
    await Promise.all(Object.values(nodeRegistry).map(async n => {
        if (!n.tailscaleIp) { results[n.id] = { ok: false, error: 'no ip' }; return; }
        try {
            const r = await callNodeAgent(n.tailscaleIp, '/restart', { method: 'POST', timeout: 15000 });
            results[n.id] = { ok: r.status === 200, status: r.status };
        } catch (e) {
            results[n.id] = { ok: false, error: e.message };
        }
    }));
    const okCount = Object.values(results).filter(r => r.ok).length;
    addNotif('info', `Bulk restart: ${okCount}/${Object.keys(results).length} nodes ok`);
    res.json(results);
});

// Hub token — read by install-node.sh to bake into each agent
app.get('/agent/token', (req, res) => {
    res.type('text/plain').send(HUB_TOKEN_VALUE);
});

// ─── PORT HEALTH MONITORING ──────────────────────────────────────────────────
// Periodically checks if required ports are actually listening.
// Adds notifications when ports that should be open are closed.

async function checkPortListening(port) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        const timeout = setTimeout(() => {
            sock.destroy();
            resolve(false);
        }, 1000);

        sock.on('connect', () => {
            clearTimeout(timeout);
            sock.end();
            resolve(true);
        });

        sock.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });

        sock.connect(port, '127.0.0.1');
    });
}

let lastPortHealthCheck = {};

async function checkPortHealth() {
    const expectedPorts = new Set();
    
    // Port 1080 should always be listening (main SOCKS5)
    expectedPorts.add(1080);
    
    // Port 3128 should be listening (HTTP proxy)
    expectedPorts.add(3128);
    
    // All configured port routes should be listening
    Object.keys(portRoutes).forEach(port => expectedPorts.add(parseInt(port, 10)));
    
    for (const port of expectedPorts) {
        const isListening = await checkPortListening(port);
        const wasDown = lastPortHealthCheck[port] === false;
        const isNowDown = !isListening;
        
        // Only notify on state changes to avoid spam
        if (isNowDown && !wasDown) {
            const portDesc = port === 1080 ? 'Main proxy (1080)' 
                           : port === 3128 ? 'HTTP proxy (3128)'
                           : `Port ${port}`;
            const nodeInfo = portRoutes[port] 
                ? ` → ${nodeRegistry[portRoutes[port]]?.name || portRoutes[port]}`
                : '';
            addNotif('error', `${portDesc}${nodeInfo} is not listening`);
            console.error(`[PortHealth] ${portDesc}${nodeInfo} DOWN`);
        } else if (isListening && wasDown) {
            const portDesc = port === 1080 ? 'Main proxy (1080)' 
                           : port === 3128 ? 'HTTP proxy (3128)'
                           : `Port ${port}`;
            addNotif('info', `${portDesc} is back online`);
            console.log(`[PortHealth] ${portDesc} UP`);
        }
        
        lastPortHealthCheck[port] = isListening;
    }
}

// Run health check every 30 seconds
setInterval(checkPortHealth, 30000);
// Run first check after 5 seconds (let 3proxy start first)
setTimeout(checkPortHealth, 5000);

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
app.get('/notifications', (req, res) => {
    res.json({ notifications });
});

app.delete('/notifications', (req, res) => {
    notifications = [];
    try { saveJson(NOTIFS_FILE, notifications); } catch {}
    res.json({ ok: true });
});

// ─── TERMINAL / SSH PAGE ─────────────────────────────────────────────────────
// Opened as a popup window by the dashboard. Since browsers can't directly
// open an SSH session without a helper, this page shows the SSH command to
// copy/run, plus quick action buttons that hit the node agent for
// start/stop/restart and a live-tail of the node's 3proxy logs.

app.get('/terminal', (req, res) => {
    const nodeId = (req.query.node || '').trim();
    const token  = (req.query.token || '').trim();

    let node, targetName, targetIp, isHub = false;
    if (nodeId === 'hub') {
        isHub      = true;
        targetName = 'Hub';
        // Best-effort: grab the first tailscale IP if available
        try {
            const out  = require('child_process').execSync('tailscale ip -4', { timeout: 2000 }).toString().trim().split('\n')[0];
            if (out.startsWith('100.')) targetIp = out;
        } catch { targetIp = '(run `tailscale ip -4` on the hub)'; }
    } else {
        node = nodeRegistry[nodeId];
        if (!node) return res.status(404).send(`<pre>Node not found: ${nodeId}</pre>`);
        targetName = node.name;
        targetIp   = node.tailscaleIp || '(no tailscale ip)';
    }

    // Make the client-side JS re-send the token with each fetch so the popup
    // can call authenticated endpoints without the parent's Authorization header.
    const safeTok = token.replace(/[^a-zA-Z0-9=:_-]/g, '');

    res.setHeader('Content-Type', 'text/html');
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(targetName)} · Console</title>
<style>
  :root {
    --bg:#0f0f1e; --panel:#1a1a2e; --border:#2d2d44; --text:#e2e8f0; --muted:#94a3b8;
    --accent:#8b5cf6; --accent2:#6366f1; --green:#10b981; --red:#ef4444; --yellow:#f59e0b;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif; font-size:13.5px; }
  header { padding:14px 18px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; background:linear-gradient(90deg, rgba(139,92,246,.1), transparent); }
  header .dot { width:10px; height:10px; border-radius:50%; background:var(--muted); box-shadow:0 0 0 3px rgba(148,163,184,.2); }
  header .dot.on  { background:var(--green); box-shadow:0 0 0 3px rgba(16,185,129,.2); }
  header .dot.off { background:var(--red);   box-shadow:0 0 0 3px rgba(239,68,68,.2); }
  header h1 { margin:0; font-size:15px; font-weight:600; }
  header .sub { color:var(--muted); font-size:11px; margin-top:2px; font-variant-numeric:tabular-nums; }
  .wrap { padding:16px 18px; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px; }
  .card h2 { margin:0 0 10px; font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; }
  .ssh-line { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:12px; background:var(--bg); padding:9px 12px; border-radius:6px; border:1px solid var(--border); cursor:pointer; word-break:break-all; transition:border-color .15s; }
  .ssh-line:hover { border-color:var(--accent); }
  .ssh-label { font-size:10.5px; color:var(--muted); margin:10px 0 4px; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; }
  .btn-row { display:flex; gap:6px; flex-wrap:wrap; }
  button { padding:7px 12px; font-size:12px; font-weight:600; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); cursor:pointer; font-family:inherit; transition:all .12s; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.primary { background:linear-gradient(135deg,var(--accent),var(--accent2)); color:white; border-color:transparent; }
  button.primary:hover { filter:brightness(1.1); color:white; }
  button.danger:hover  { border-color:var(--red); color:var(--red); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .logs { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:10.5px; line-height:1.55; background:var(--bg); padding:10px; border-radius:6px; border:1px solid var(--border); height:320px; overflow:auto; white-space:pre-wrap; color:#c8c8d4; }
  .full { grid-column: 1 / -1; }
  .status-line { display:flex; gap:14px; font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; margin-bottom:8px; }
  .status-line strong { color:var(--text); font-weight:600; }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%) translateY(20px); opacity:0; background:var(--text); color:var(--bg); padding:9px 16px; border-radius:20px; font-size:12px; font-weight:500; transition:all .25s; pointer-events:none; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  a { color:var(--accent); }
</style></head>
<body>
<header>
  <div class="dot" id="dot"></div>
  <div>
    <h1>${escapeHtml(targetName)} Console</h1>
    <div class="sub" id="sub">${escapeHtml(targetIp)}</div>
  </div>
</header>

<div class="wrap">
  <div class="card">
    <h2>SSH access (over Tailscale)</h2>
    <div class="ssh-label">Tailscale SSH</div>
    <div class="ssh-line" data-copy="tailscale ssh root@${escapeHtml(targetIp)}">tailscale ssh root@${escapeHtml(targetIp)}</div>
    <div class="ssh-label">Plain SSH</div>
    <div class="ssh-line" data-copy="ssh root@${escapeHtml(targetIp)}">ssh root@${escapeHtml(targetIp)}</div>
    <div style="color:var(--muted); font-size:10.5px; margin-top:10px; line-height:1.5;">
      Click a line to copy. SSH only works from a machine that's on your tailnet.
      Browsers can't open SSH directly — paste the command into your terminal.
    </div>
  </div>

  ${isHub ? '' : `
  <div class="card">
    <h2>3proxy control</h2>
    <div class="status-line">
      <div><strong id="st-state">…</strong></div>
      <div>host <strong id="st-host">—</strong></div>
      <div>up <strong id="st-up">—</strong></div>
      <div>load <strong id="st-load">—</strong></div>
    </div>
    <div class="btn-row">
      <button class="primary" onclick="act('start-proxy')">Start</button>
      <button class="primary" onclick="act('restart-proxy')">Restart</button>
      <button class="danger"  onclick="act('stop-proxy')">Stop</button>
      <button              onclick="loadStatus()">⟳ Refresh</button>
    </div>
  </div>

  <div class="card full">
    <h2>Recent 3proxy logs — <span style="color:var(--muted); font-weight:400;">auto-refreshing every 5s</span></h2>
    <div class="logs" id="logs">Loading…</div>
  </div>
  `}
</div>

<div class="toast" id="toast"></div>

<script>
const TOKEN  = ${JSON.stringify(safeTok)};
const NODE   = ${JSON.stringify(nodeId)};
const IS_HUB = ${JSON.stringify(isHub)};
const AUTH   = 'Basic ' + (TOKEN.includes(':') ? btoa(TOKEN) : TOKEN);

function toast(t) {
  const el = document.getElementById('toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>el.classList.remove('show'), 1800);
}

document.querySelectorAll('[data-copy]').forEach(el => {
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(el.dataset.copy);
    toast('Copied: ' + el.dataset.copy.slice(0, 60));
  });
});

async function act(path) {
  toast(path + '…');
  const r = await fetch('/nodes/' + encodeURIComponent(NODE) + '/' + path, { method:'POST', headers:{ Authorization: AUTH } });
  if (r.ok) { toast('OK'); loadStatus(); loadLogs(); }
  else       toast('Failed (' + r.status + ')');
}

function fmtTime(s) {
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  if (d) return d+'d '+h+'h';
  if (h) return h+'h '+m+'m';
  return m+'m';
}

async function loadStatus() {
  if (IS_HUB) return;
  try {
    const r = await fetch('/nodes/' + encodeURIComponent(NODE) + '/agent-status', { headers:{ Authorization: AUTH } });
    const d = await r.json();
    const reachable = r.ok;
    document.getElementById('dot').className = 'dot ' + (reachable && d.active ? 'on' : 'off');
    document.getElementById('st-state').textContent = !reachable ? 'agent unreachable' : (d.active ? '3proxy running' : '3proxy stopped');
    document.getElementById('st-host').textContent  = d.hostname || '—';
    document.getElementById('st-up').textContent    = d.uptime ? fmtTime(d.uptime) : '—';
    document.getElementById('st-load').textContent  = d.loadavg?.[0]?.toFixed(2) || '—';
  } catch (e) {
    document.getElementById('dot').className = 'dot off';
    document.getElementById('st-state').textContent = 'unreachable';
  }
}

async function loadLogs() {
  if (IS_HUB) return;
  try {
    const r = await fetch('/nodes/' + encodeURIComponent(NODE) + '/logs?n=120', { headers:{ Authorization: AUTH } });
    const t = await r.text();
    const el = document.getElementById('logs');
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = t || '(no logs)';
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch {}
}

loadStatus();
loadLogs();
setInterval(loadStatus, 5000);
setInterval(loadLogs,   5000);
</script>
</body></html>`);
});

function escapeHtml(s) {
    return (s == null ? '' : String(s))
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── EXTENSION API ───────────────────────────────────────────────────────────
app.use('/ext', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Returns ALL nodes — disabled/maintenance show as offline with reason
app.get('/ext/nodes', async (req, res) => {
    const allNodes = Object.values(nodeRegistry).map(n => ({
        id:                 n.id,
        name:               n.name,
        region:             n.region,
        tailscaleIp:        n.tailscaleIp,
        enabled:            n.enabled !== false,
        maintenance:        n.maintenance || false,
        offlineReason:      n.offlineReason     || null,
        maintenanceReason:  n.maintenanceReason || null,
        // Which port to use for this node (for Omega/FoxyProxy users)
        assignedPort:       Object.entries(portRoutes).find(([,nid]) => nid === n.id)?.[0] || null,
    }));

    // Only live-ping enabled, non-maintenance nodes
    const withPing = await Promise.all(allNodes.map(async n => {
        if (!n.enabled || n.maintenance) return { ...n, latencyMs: null, online: false };
        const ping = n.tailscaleIp ? await pingNode(n.tailscaleIp, 1080, 2000) : { latencyMs: null, online: false };
        return { ...n, latencyMs: ping.latencyMs, online: ping.online };
    }));

    // Also expose port route map so extensions can show "connect via port XXXX"
    const portMap = Object.entries(portRoutes).reduce((acc, [port, nodeId]) => {
        acc[port] = nodeId; return acc;
    }, {});

    res.json({ nodes: withPing, hotloop: { enabled: hotloop.enabled, mode: hotloop.mode }, portMap });
});

app.get('/ext/check', (req, res) => {
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    const ip = rawIp.replace(/^::ffff:/, '');
    if (!settings.ipAuthEnabled) return res.json({ allowed: true, ip });
    res.json({ allowed: getActualWhitelist().some(l => l.includes(ip)), ip });
});

// ─── PER-NODE PING + SPEEDTEST PROXY ─────────────────────────────────────────
app.get('/nodes/:id/ping', async (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node?.tailscaleIp) return res.status(404).json({ error: 'Node not found or no IP' });
    const start = Date.now();
    const sock  = new net.Socket();
    sock.setTimeout(3000);
    sock.connect(3128, node.tailscaleIp, () => { const ms = Date.now()-start; sock.destroy(); res.json({ pong: true, latencyMs: ms, node: node.name, ts: Date.now() }); });
    sock.on('error',   () => { sock.destroy(); res.status(503).json({ error: 'Node unreachable', latencyMs: null }); });
    sock.on('timeout', () => { sock.destroy(); res.status(504).json({ error: 'Timeout',         latencyMs: null }); });
});

app.get('/nodes/:id/speedtest', (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node?.tailscaleIp) return res.status(404).send('Node not found');
    const size = Math.min(parseInt(req.query.size)||2097152, 10485760);
    const proxyReq = http.request({ hostname: node.tailscaleIp, port: 3128, path: `http://${node.tailscaleIp}:3128/speedtest?size=${size}`, method: 'GET', timeout: 30000 }, proxyRes => {
        res.setHeader('Content-Type','application/octet-stream');
        res.setHeader('Cache-Control','no-store');
        proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
        const chunk = Buffer.alloc(65536, 0xAB); let sent = 0;
        res.setHeader('Content-Type','application/octet-stream');
        res.setHeader('Cache-Control','no-store');
        res.setHeader('X-Speedtest-Source','hub-fallback');
        function send() { while(sent<size){const n=Math.min(65536,size-sent);if(!res.write(chunk.slice(0,n))){res.once('drain',send);return;}sent+=n;}res.end(); }
        send();
    });
    proxyReq.end();
});
// hi
app.post('/nodes/:id/speedtest/upload', (req, res) => {
    const node = nodeRegistry[req.params.id];
    if (!node?.tailscaleIp) return res.status(404).send('Node not found');
    let bytes = 0; const start = Date.now();
    req.on('data', c => bytes += c.length);
    req.on('end', () => { const elapsed = (Date.now()-start)/1000; res.json({ bytes, elapsed, mbps: ((bytes*8)/elapsed/1000000).toFixed(2) }); });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT,'0.0.0.0', () => {
    console.log(`3Proxy dashboard → http://localhost:${PORT}`);
    console.log(`IP Auth: ${settings.ipAuthEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Hotloop: ${hotloop.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Port routes: ${Object.keys(portRoutes).length} configured`);
    console.log(`Hub token: ${HUB_TOKEN_FILE} (${HUB_TOKEN_VALUE.slice(0,8)}…)`);
    addNotif('info', 'Hub dashboard started');
});