// ============================================================================
//  ProxyHub  ·  background.js (MV3 service worker)
// ----------------------------------------------------------------------------
//  Routes traffic through hub.oofbomb.xyz. The hub chains to Tailscale nodes
//  via `parent socks5` — clients never dial Tailscale IPs directly.
//
//  Profiles:
//    direct       → no proxy
//    auto         → hub.oofbomb.xyz:1080 (load-balanced across all nodes)
//    node_<id>    → hub.oofbomb.xyz:<assignedPort>  (one specific node)
//    auto_switch  → PAC script with URL rules → profile
// ============================================================================

const DEFAULTS = {
    hubApi:        'https://hub.oofbomb.xyz',  // Dashboard API base
    proxyHost:     'hub.oofbomb.xyz',          // Host in the browser's SOCKS5 config
    defaultPort:   1080,                       // Load-balanced port on the hub
    activeProfile: 'direct',                   // Current profile id
    bypassList:    ['<local>', 'localhost', '127.0.0.1/8', '::1', '192.168.0.0/16', '10.0.0.0/8'],
    autoSwitch:    { rules: [], fallback: 'auto' },  // [{pattern, match, profile}], match: 'host'|'url'|'wildcard'
    nodes:         [],                         // Cached from hub
    lastFetch:     0,
};

// ── storage helpers ────────────────────────────────────────────────────────
const store = {
    get:    (keys)       => new Promise(r => chrome.storage.local.get(keys, r)),
    set:    (obj)        => new Promise(r => chrome.storage.local.set(obj, r)),
    remove: (key)        => new Promise(r => chrome.storage.local.remove(key, r)),
};

async function getState() {
    const s = await store.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...s };
}

// ── install / startup ─────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
    const existing = await store.get(Object.keys(DEFAULTS));
    const patch = {};
    for (const k of Object.keys(DEFAULTS)) if (existing[k] === undefined) patch[k] = DEFAULTS[k];
    if (Object.keys(patch).length) await store.set(patch);
    await refreshNodes();
    await applyActiveProfile();
});

chrome.runtime.onStartup.addListener(async () => {
    await refreshNodes();
    await applyActiveProfile();
});

// Refresh node list every 60s while browser is open
chrome.alarms?.create?.('refresh-nodes', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(a => { if (a.name === 'refresh-nodes') refreshNodes(); });

// ── node list from hub ─────────────────────────────────────────────────────
async function refreshNodes() {
    const { hubApi } = await getState();
    try {
        const res  = await fetch(`${hubApi.replace(/\/$/, '')}/ext/nodes`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const nodes = (data.nodes || []).map(n => ({
            id:            n.id,
            name:          n.name,
            region:        n.region,
            enabled:       n.enabled !== false,
            online:        n.online === true,
            maintenance:   n.maintenance === true,
            latencyMs:     n.latencyMs ?? null,
            assignedPort:  n.assignedPort || null,
            reason:        n.maintenanceReason || n.offlineReason || null,
        }));
        await store.set({ nodes, lastFetch: Date.now() });
        return { ok: true, nodes };
    } catch (e) {
        console.warn('[ProxyHub] node refresh failed:', e.message);
        return { ok: false, error: e.message };
    }
}

// ── proxy config ───────────────────────────────────────────────────────────
function bypassPac(list) {
    // Returns a JS expression that evaluates to true if host should bypass
    return list.map(p => {
        if (p === '<local>')       return `isPlainHostName(host)`;
        if (p.includes('/'))        return `isInNet(host, "${p.split('/')[0]}", "${cidrMask(p)}")`;
        if (p.includes('*'))        return `shExpMatch(host, "${p}")`;
        return `dnsDomainIs(host, "${p.startsWith('.') ? p : '.'+p}") || host === "${p}"`;
    }).join(' || ');
}

function cidrMask(cidr) {
    const bits = parseInt(cidr.split('/')[1], 10);
    const mask = 0xffffffff << (32 - bits) >>> 0;
    return [mask>>>24, mask>>>16 & 255, mask>>>8 & 255, mask & 255].join('.');
}

async function applyActiveProfile() {
    const s = await getState();
    const profile = s.activeProfile || 'direct';

    if (profile === 'direct') {
        await setChromeProxy({ mode: 'direct' });
        await setBadge('', '#6366f1');
        notify('Proxy off', 'Direct connection — no proxy');
        return;
    }

    if (profile === 'system') {
        await setChromeProxy({ mode: 'system' });
        await setBadge('SYS', '#64748b');
        return;
    }

    if (profile === 'auto') {
        // Load-balanced across all nodes via hub's default port
        await setFixedSocks5(s.proxyHost, s.defaultPort, s.bypassList);
        await setBadge('ON', '#10b981');
        notify('ProxyHub connected', `Auto — ${s.proxyHost}:${s.defaultPort}`);
        return;
    }

    if (profile === 'auto_switch') {
        await setPacScript(buildAutoSwitchPac(s));
        await setBadge('AS', '#8b5cf6');
        notify('ProxyHub connected', 'Auto-switch active');
        return;
    }

    if (profile.startsWith('node_')) {
        const node = (s.nodes || []).find(n => n.id === profile);
        if (!node) {
            console.warn('[ProxyHub] unknown node profile, falling back to auto');
            await store.set({ activeProfile: 'auto' });
            return applyActiveProfile();
        }
        const port = node.assignedPort || s.defaultPort;
        await setFixedSocks5(s.proxyHost, port, s.bypassList);
        await setBadge('ON', '#10b981');
        notify('ProxyHub connected', `${node.name} — ${s.proxyHost}:${port}`);
        return;
    }
}

function setChromeProxy(config) {
    return new Promise((resolve, reject) => {
        chrome.proxy.settings.set(
            { value: config, scope: 'regular' },
            () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
        );
    });
}

function setFixedSocks5(host, port, bypassList) {
    return setChromeProxy({
        mode: 'fixed_servers',
        rules: {
            singleProxy: { scheme: 'socks5', host, port: parseInt(port, 10) },
            bypassList,
        },
    });
}

function setPacScript(pac) {
    return setChromeProxy({
        mode: 'pac_script',
        pacScript: { data: pac, mandatory: false },
    });
}

// ── Auto-switch: build a PAC script from rules ─────────────────────────────
function buildAutoSwitchPac(s) {
    const nodeMap = {};
    for (const n of s.nodes || []) nodeMap[n.id] = n;

    function profileToProxyString(profId) {
        if (profId === 'direct')      return 'DIRECT';
        if (profId === 'auto')        return `SOCKS5 ${s.proxyHost}:${s.defaultPort}; DIRECT`;
        if (profId.startsWith('node_')) {
            const n = nodeMap[profId];
            const port = (n && n.assignedPort) ? n.assignedPort : s.defaultPort;
            return `SOCKS5 ${s.proxyHost}:${port}; DIRECT`;
        }
        return 'DIRECT';
    }

    const bypassExpr = bypassPac(s.bypassList || []);
    const rulesJs = (s.autoSwitch?.rules || []).map(r => {
        const proxy = profileToProxyString(r.profile);
        let cond;
        if (r.match === 'host')            cond = `shExpMatch(host, ${JSON.stringify(r.pattern)})`;
        else if (r.match === 'url')        cond = `shExpMatch(url,  ${JSON.stringify(r.pattern)})`;
        else if (r.match === 'regex')      cond = `(new RegExp(${JSON.stringify(r.pattern)})).test(url)`;
        else                               cond = `shExpMatch(host, ${JSON.stringify(r.pattern)})`;
        return `  if (${cond}) return ${JSON.stringify(proxy)};`;
    }).join('\n');

    const fallback = profileToProxyString(s.autoSwitch?.fallback || 'auto');

    return `
function FindProxyForURL(url, host) {
  if (${bypassExpr || 'false'}) return "DIRECT";
${rulesJs}
  return ${JSON.stringify(fallback)};
}`.trim();
}

// ── badge + notifications ──────────────────────────────────────────────────
function setBadge(text, color) {
    try {
        chrome.action.setBadgeText({ text: text || '' });
        if (color) chrome.action.setBadgeBackgroundColor({ color });
    } catch {}
    return Promise.resolve();
}

let lastNotifyAt = 0;
function notify(title, message) {
    // Rate limit: 1 notification per 2s (avoid spam on rapid switches)
    const now = Date.now();
    if (now - lastNotifyAt < 2000) return;
    lastNotifyAt = now;
    try {
        chrome.notifications.create({
            type:    'basic',
            iconUrl: 'icons/icon48.png',
            title,
            message: message || '',
            priority: 0,
        });
    } catch {}
}

// ── message API (popup / options call these) ───────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            switch (msg.type) {
                case 'GET_STATE': {
                    const s = await getState();
                    sendResponse({ ok: true, state: s });
                    break;
                }
                case 'SET_PROFILE': {
                    await store.set({ activeProfile: msg.profile });
                    await applyActiveProfile();
                    sendResponse({ ok: true });
                    break;
                }
                case 'REFRESH_NODES': {
                    const r = await refreshNodes();
                    sendResponse(r);
                    break;
                }
                case 'SAVE_SETTINGS': {
                    await store.set(msg.patch || {});
                    // If hub URL changed, refresh nodes so we pull from the new hub
                    if (msg.patch?.hubApi) await refreshNodes();
                    await applyActiveProfile();
                    sendResponse({ ok: true });
                    break;
                }
                case 'PING_HUB': {
                    const { hubApi } = await getState();
                    const t0 = performance.now();
                    try {
                        const r = await fetch(`${hubApi.replace(/\/$/, '')}/ext/ping`, { cache: 'no-store' });
                        sendResponse({ ok: r.ok, latencyMs: Math.round(performance.now() - t0) });
                    } catch (e) {
                        sendResponse({ ok: false, error: e.message });
                    }
                    break;
                }
                default:
                    sendResponse({ ok: false, error: 'unknown message' });
            }
        } catch (e) {
            sendResponse({ ok: false, error: e.message });
        }
    })();
    return true;  // async response
});

// ── proxy error surface (helps debug unreachable hub) ──────────────────────
chrome.proxy?.onProxyError?.addListener(details => {
    console.warn('[ProxyHub] proxy error:', details);
});