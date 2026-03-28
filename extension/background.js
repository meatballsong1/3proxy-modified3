// background.js — ProxyHub VPN Extension
// MV3 service worker — no inline scripts, no self.addEventListener conflicts

const DEFAULT_HUB = 'http://node0.vpn.oofbomb.xyz';

let state = {
    connected: false,
    nodeId:    null,
    nodeIp:    null,
    nodeName:  null,
    hubUrl:    DEFAULT_HUB,
};

// ── Init: restore persisted state on service worker startup ───────────────────
chrome.storage.local.get(['vpnState', 'hubUrl'], (data) => {
    if (data.hubUrl) state.hubUrl = data.hubUrl;
    if (data.vpnState?.connected && data.vpnState.nodeIp) {
        state = { ...state, ...data.vpnState };
        applyProxy(state.nodeIp, 1080);
        updateBadge(true);
    }
    fetchNodes();
});

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        switch (msg.type) {

            case 'CONNECT': {
                const node = msg.node;
                if (!node?.tailscaleIp) {
                    sendResponse({ ok: false, error: 'No Tailscale IP for this node' });
                    break;
                }
                try {
                    await applyProxy(node.tailscaleIp, 1080);
                    state.connected = true;
                    state.nodeId    = node.id;
                    state.nodeIp    = node.tailscaleIp;
                    state.nodeName  = node.name;
                    await chrome.storage.local.set({ vpnState: state });
                    updateBadge(true);
                    notify('ProxyHub Connected', `${node.name} — ${node.tailscaleIp}`);
                    broadcast({ type: 'CONNECTED', node });
                    sendResponse({ ok: true });
                } catch(e) {
                    sendResponse({ ok: false, error: e.message });
                }
                break;
            }

            case 'DISCONNECT': {
                await clearProxy();
                state.connected = false;
                state.nodeId    = null;
                state.nodeIp    = null;
                state.nodeName  = null;
                await chrome.storage.local.set({ vpnState: state });
                updateBadge(false);
                notify('ProxyHub', 'Disconnected');
                broadcast({ type: 'DISCONNECTED' });
                sendResponse({ ok: true });
                break;
            }

            case 'FETCH_NODES': {
                const nodes = await fetchNodes();
                sendResponse({ nodes });
                break;
            }

            case 'CHECK_WHITELIST': {
                const result = await checkWhitelist();
                sendResponse(result);
                break;
            }

            case 'GET_STATE':
                sendResponse(state);
                break;

            case 'SET_HUB':
                state.hubUrl = msg.url;
                await chrome.storage.local.set({ hubUrl: msg.url });
                sendResponse({ ok: true });
                break;

            case 'PING_NODE': {
                const latency = await pingNode(msg.url);
                sendResponse({ latencyMs: latency });
                break;
            }
        }
    })();
    return true;
});

// ── Proxy helpers ─────────────────────────────────────────────────────────────
function applyProxy(host, port) {
    return new Promise((resolve, reject) => {
        chrome.proxy.settings.set({
            value: {
                mode: 'fixed_servers',
                rules: {
                    singleProxy: { scheme: 'socks5', host, port: parseInt(port) }
                }
            },
            scope: 'regular'
        }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}

function clearProxy() {
    return new Promise(resolve => {
        chrome.proxy.settings.clear({ scope: 'regular' }, resolve);
    });
}

// ── Badge ─────────────────────────────────────────────────────────────────────
function updateBadge(connected) {
    chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ color: connected ? '#34d399' : '#f87171' });
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notify(title, message) {
    chrome.notifications.create('proxyhub_' + Date.now(), {
        type:     'basic',
        iconUrl:  'icons/icon.png',
        title,
        message,
    });
}

// ── Broadcast to popup ────────────────────────────────────────────────────────
function broadcast(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Fetch nodes ───────────────────────────────────────────────────────────────
async function fetchNodes() {
    try {
        const r = await fetch(`${state.hubUrl}/ext/nodes`, {
            signal: AbortSignal.timeout(5000),
            cache:  'no-store',
        });
        if (!r.ok) throw new Error('Non-OK response');
        const { nodes } = await r.json();
        await chrome.storage.local.set({ availableNodes: nodes || [], hubOnline: true, lastFetch: Date.now() });
        broadcast({ type: 'NODES_UPDATED', nodes: nodes || [] });
        return nodes || [];
    } catch(e) {
        await chrome.storage.local.set({ hubOnline: false });
        broadcast({ type: 'HUB_OFFLINE', error: e.message });
        return [];
    }
}

// ── Whitelist check ───────────────────────────────────────────────────────────
async function checkWhitelist() {
    try {
        const r = await fetch(`${state.hubUrl}/ext/check`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error();
        return await r.json();
    } catch {
        return { allowed: null, ip: null, error: 'Hub unreachable' };
    }
}

// ── Latency ping ──────────────────────────────────────────────────────────────
async function pingNode(url) {
    try {
        const start = Date.now();
        await fetch(url, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
        return Date.now() - start;
    } catch {
        return null;
    }
}

// ── Alarms — periodic node refresh every 30s ──────────────────────────────────
// chrome.alarms requires "alarms" in manifest permissions
chrome.alarms.create('refreshNodes', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refreshNodes') fetchNodes();
});

// ── Extension install/update handler ──────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
    console.log('[ProxyHub] Extension installed/updated');
    // Re-create alarm on install in case it was cleared
    chrome.alarms.create('refreshNodes', { periodInMinutes: 0.5 });
});