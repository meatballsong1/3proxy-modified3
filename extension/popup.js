// popup.js — ProxyHub VPN Extension

const HUB_DEFAULT = 'http://vpn2.oofbomb.xyz';

let vpnState     = { connected: false };
let nodes        = [];
let selectedNode = null;
let hubOnline    = false;
let pingResults  = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function store(op, keysOrObj) {
    return new Promise(r =>
        op === 'get'
            ? chrome.storage.local.get(keysOrObj, r)
            : chrome.storage.local.set(keysOrObj, r)
    );
}
function msg(m) {
    return new Promise(r => chrome.runtime.sendMessage(m, res => r(res || {})));
}
function $(id) { return document.getElementById(id); }

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    const data = await store('get', ['vpnState', 'hubUrl', 'availableNodes', 'hubOnline']);
    $('hubUrlIn').value = data.hubUrl || HUB_DEFAULT;
    hubOnline = !!data.hubOnline;

    vpnState = await msg({ type: 'GET_STATE' });
    applyVisualState(vpnState);

    if (data.availableNodes?.length) {
        nodes = data.availableNodes;
        renderServers();
    }

    doRefresh();
    // Only check whitelist if not already connected — no point showing the error
    // to someone who is actively tunnelled through the proxy
    if (!vpnState.connected) checkWhitelist();
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    $('connectBtn').addEventListener('click', toggleConnect);
    $('hubPill').addEventListener('click', toggleSettings);
    $('settingsToggleBtn').addEventListener('click', toggleSettings);
    $('saveHubBtn').addEventListener('click', saveHub);
    $('refreshBtn').addEventListener('click', doRefresh);
    $('autoChip').addEventListener('click', autoSelect);
    $('hubUrlIn').addEventListener('keydown', e => { if (e.key === 'Enter') saveHub(); });
    init();
});

// ── Background messages ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(m => {
    switch (m.type) {
        case 'CONNECTED':
            vpnState = { connected: true, nodeName: m.node?.name, nodeId: m.node?.id };
            applyVisualState(vpnState);
            break;
        case 'DISCONNECTED':
            vpnState = { connected: false };
            applyVisualState(vpnState);
            // Re-check whitelist now that they're disconnected
            checkWhitelist();
            break;
        case 'NODES_UPDATED':
            nodes = m.nodes || [];
            renderServers();
            pingAll();
            break;
        case 'HUB_OFFLINE':
            setHubStatus(false);
            break;
    }
});

// ── Connect / Disconnect ──────────────────────────────────────────────────────
async function toggleConnect() {
    if (vpnState.connected) {
        setConnectingAnim('Disconnecting…');
        await msg({ type: 'DISCONNECT' });
    } else {
        if (!selectedNode) {
            showErr('No Server Selected', 'Pick a server from the list first.');
            return;
        }
        hideErr();
        setConnectingAnim('Connecting…');
        const r = await msg({ type: 'CONNECT', node: selectedNode });
        if (!r.ok) {
            showErr('Connection Failed', r.error || 'Could not apply proxy settings.');
            setDisconnected();
        }
    }
}

// ── Auto-select fastest ───────────────────────────────────────────────────────
async function autoSelect() {
    if (!nodes.length) return;
    await pingAll();
    let best = null; let bestMs = Infinity;
    nodes.forEach(n => {
        const ms = pingResults[n.id];
        if (ms !== null && ms !== undefined && ms < bestMs) { bestMs = ms; best = n; }
    });
    if (!best) { showErr('Auto-select failed', 'No nodes responded to ping.'); return; }
    selectNode(best);
    if (!vpnState.connected) {
        setConnectingAnim('Connecting…');
        const r = await msg({ type: 'CONNECT', node: best });
        if (!r.ok) { showErr('Connection Failed', r.error || ''); setDisconnected(); }
    }
}

// ── Ping all nodes ────────────────────────────────────────────────────────────
async function pingAll() {
    const data = await store('get', ['hubUrl']);
    const hub = (data.hubUrl || HUB_DEFAULT).replace(/\/$/, '');
    await Promise.all(nodes.map(async n => {
        const r = await msg({ type: 'PING_NODE', url: `${hub}/ext/ping` });
        pingResults[n.id] = r.latencyMs;
    }));
    renderServers();
}

// ── Render servers ────────────────────────────────────────────────────────────
function renderServers() {
    const list = $('serverList');
    if (!nodes.length) {
        list.innerHTML = `<div class="empty-msg">${
            hubOnline ? 'No enabled nodes — check dashboard' : '🔴 Hub offline — check settings'
        }</div>`;
        return;
    }
    list.innerHTML = '';
    nodes.forEach(node => {
        const isSelected  = selectedNode?.id === node.id;
        const isConnected = vpnState.connected && vpnState.nodeId === node.id;
        const { bars, cls, label } = getPingDisplay(pingResults[node.id]);

        const card = document.createElement('div');
        card.className = ['server-card', isSelected ? 'selected' : '', isConnected ? 'active-conn' : ''].join(' ').trim();

        const barHTML = [0,1,2,3].map(i => `<div class="ping-bar ${i < bars ? 'lit-' + cls : ''}"></div>`).join('');

        const info = document.createElement('div');
        info.className = 'srv-info';
        info.innerHTML = `
            <div class="srv-name">${node.name}</div>
            <div class="srv-region">📍 ${node.region}${node.tailscaleIp ? ' · ' + node.tailscaleIp : ''}</div>
        `;

        const meter = document.createElement('div');
        meter.className = 'ping-meter';
        meter.innerHTML = barHTML + `<span class="ping-label ${cls}">${label}</span>`;

        const srvBtn = document.createElement('button');
        srvBtn.className = 'connect-srv-btn' + (isConnected ? ' active' : '');
        srvBtn.textContent = isConnected ? '✓ ON' : isSelected ? 'Go' : 'Use';

        card.appendChild(info);
        card.appendChild(meter);
        card.appendChild(srvBtn);

        card.addEventListener('click', () => selectNode(node));
        srvBtn.addEventListener('click', async e => {
            e.stopPropagation();
            selectNode(node);
            if (vpnState.connected && vpnState.nodeId === node.id) {
                setConnectingAnim('Disconnecting…');
                await msg({ type: 'DISCONNECT' });
            } else {
                setConnectingAnim('Connecting…');
                const r = await msg({ type: 'CONNECT', node });
                if (!r.ok) { showErr('Failed', r.error || ''); setDisconnected(); }
            }
        });

        list.appendChild(card);
    });
}

function getPingDisplay(ms) {
    if (ms === null || ms === undefined) return { bars: 0, cls: 'grey',   label: '—'       };
    if (ms < 50)                         return { bars: 4, cls: 'green',  label: ms + 'ms'  };
    if (ms < 120)                        return { bars: 3, cls: 'green',  label: ms + 'ms'  };
    if (ms < 250)                        return { bars: 2, cls: 'yellow', label: ms + 'ms'  };
    if (ms < 500)                        return { bars: 1, cls: 'red',    label: ms + 'ms'  };
    return                                      { bars: 1, cls: 'red',    label: '500+'     };
}

function selectNode(node) {
    selectedNode = node;
    $('selectedLbl').textContent = '→ ' + node.name;
    if (!vpnState.connected) $('statusSub').textContent = node.name + ' selected';
    renderServers();
}

// ── Visual states ─────────────────────────────────────────────────────────────
function applyVisualState(s) {
    if (s.connected) setConnected(s.nodeName);
    else setDisconnected();
}

function setConnected(name) {
    // Button — power on glow
    const btn = $('connectBtn');
    btn.className = 'connect-btn connected';

    // Ring fills green
    $('ringFill').className = 'ring-fill connected';

    // Status text
    $('statusMain').className   = 'status-main on';
    $('statusMain').textContent = '● Protected';
    $('statusSub').textContent  = 'via ' + (name || 'VPN Node');

    // Button label — centered with no extra spacing
    $('btnLbl').textContent = 'Disconnect';

    // Mesh background shifts green
    $('mesh').className = 'mesh connected';

    // Logo
    $('logoIcon').className  = 'logo-icon connected';
    $('logoSpan').className  = 'connected';

    $('connectedLbl').textContent = name || '';
    vpnState.connected = true;

    // Hide whitelist error — they're connected, it's irrelevant
    hideErr();

    renderServers();
}

function setDisconnected() {
    $('connectBtn').className     = 'connect-btn';
    $('ringFill').className       = 'ring-fill';
    $('statusMain').className     = 'status-main off';
    $('statusMain').textContent   = 'Not Connected';
    $('statusSub').textContent    = selectedNode ? selectedNode.name + ' selected' : 'Select a server below';
    $('btnLbl').textContent       = 'Connect';
    $('mesh').className           = 'mesh';
    $('logoIcon').className       = 'logo-icon';
    $('logoSpan').className       = '';
    $('connectedLbl').textContent = '';
    vpnState.connected = false;
    renderServers();
}

// Accepts optional label so "Disconnecting…" and "Connecting…" both work
function setConnectingAnim(label) {
    $('connectBtn').className   = 'connect-btn connecting';
    $('ringFill').className     = 'ring-fill connecting';
    $('statusMain').className   = 'status-main conn';
    $('statusMain').textContent = label || 'Connecting…';
    $('btnLbl').textContent     = '…';
}

// ── Hub status ────────────────────────────────────────────────────────────────
function setHubStatus(online) {
    hubOnline = online;
    $('hubDot').className   = 'hub-dot ' + (online ? 'online' : 'offline');
    $('hubTxt').textContent = online ? 'Hub Online' : 'Hub Offline';
}

// ── Whitelist check ───────────────────────────────────────────────────────────
async function checkWhitelist() {
    // Never show whitelist error while actively connected through the proxy
    if (vpnState.connected) { hideErr(); return; }

    const r = await msg({ type: 'CHECK_WHITELIST' });
    if (r.allowed === false) {
        // Strip IPv6-mapped prefix ::ffff: for cleaner display
        const cleanIp = (r.ip || '').replace(/^::ffff:/, '');
        showErr('Not Whitelisted ✗', `Your IP ${cleanIp} isn't on the access list. Ask your admin to add it.`);
    } else if (r.allowed === true) {
        hideErr();
        setHubStatus(true);
    }
}

// ── Error banner ──────────────────────────────────────────────────────────────
function showErr(title, body) {
    $('errTitle').textContent = title;
    $('errBody').textContent  = body;
    $('errBanner').classList.add('show');
}
function hideErr() { $('errBanner').classList.remove('show'); }

// ── Settings ──────────────────────────────────────────────────────────────────
function toggleSettings() { $('settingsPanel').classList.toggle('show'); }

async function saveHub() {
    const url = $('hubUrlIn').value.trim().replace(/\/$/, '');
    if (!url) return;
    await msg({ type: 'SET_HUB', url });
    $('settingsPanel').classList.remove('show');
    doRefresh();
    checkWhitelist();
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function doRefresh() {
    const btn = $('refreshBtn');
    btn.classList.add('spinning');
    const r = await msg({ type: 'FETCH_NODES' });
    nodes = r.nodes || [];
    hubOnline = nodes.length > 0;
    renderServers();
    setHubStatus(hubOnline);
    btn.classList.remove('spinning');
    if (nodes.length) pingAll();
}