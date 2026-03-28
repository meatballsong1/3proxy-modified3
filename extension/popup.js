// popup.js — ProxyHub VPN Extension

const HUB_DEFAULT      = 'http://vpn2.oofbomb.xyz';
const CONNECT_DELAY_MS = 2800; // ms overlay shown before marking connected

let vpnState     = { connected: false };
let nodes        = [];
let selectedNode = null;
let hubOnline    = false;
let pingSmooth   = {}; // { nodeId: { samples:[], avg:null } }

// ── Helpers ───────────────────────────────────────────────────────────────────
const store = (op, d) => new Promise(r => op === 'get' ? chrome.storage.local.get(d, r) : chrome.storage.local.set(d, r));
const msg   = m => new Promise(r => chrome.runtime.sendMessage(m, res => r(res || {})));
const $     = id => document.getElementById(id);

// Rolling average — keeps last 4 samples, rejects spikes > 3x current avg
function smoothPing(nodeId, newMs) {
    if (newMs == null) return pingSmooth[nodeId]?.avg ?? null;
    if (!pingSmooth[nodeId]) pingSmooth[nodeId] = { samples: [], avg: null };
    const s = pingSmooth[nodeId];
    if (s.avg !== null && newMs > s.avg * 3 && newMs > 200) return s.avg; // spike rejected
    s.samples.push(newMs);
    if (s.samples.length > 4) s.samples.shift();
    s.avg = Math.round(s.samples.reduce((a, b) => a + b, 0) / s.samples.length);
    return s.avg;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    const data = await store('get', ['vpnState', 'hubUrl', 'availableNodes', 'hubOnline']);
    $('hubUrlIn').value = data.hubUrl || HUB_DEFAULT;
    hubOnline = !!data.hubOnline;
    vpnState  = await msg({ type: 'GET_STATE' });
    applyVisual(vpnState);
    if (data.availableNodes?.length) { nodes = data.availableNodes; renderServers(); }
    doRefresh();
    if (!vpnState.connected) checkWhitelist();
}

document.addEventListener('DOMContentLoaded', () => {
    $('powerBtn').addEventListener('click', toggleConnect);
    $('hubPill').addEventListener('click', toggleSettings);
    $('settingsToggleBtn').addEventListener('click', toggleSettings);
    $('saveHubBtn').addEventListener('click', saveHub);
    $('refreshBtn').addEventListener('click', doRefresh);
    $('autoBtn').addEventListener('click', autoSelect);
    $('hubUrlIn').addEventListener('keydown', e => { if (e.key === 'Enter') saveHub(); });
    init();
});

chrome.runtime.onMessage.addListener(m => {
    switch (m.type) {
        case 'CONNECTED':
            vpnState = { connected: true, nodeName: m.node?.name, nodeId: m.node?.id };
            applyVisual(vpnState); break;
        case 'DISCONNECTED':
            vpnState = { connected: false };
            applyVisual(vpnState); checkWhitelist(); break;
        case 'NODES_UPDATED':
            nodes = m.nodes || []; renderServers(); pingAll(); break;
        case 'HUB_OFFLINE':
            setHubStatus(false); break;
    }
});

// ── Connect / Disconnect ──────────────────────────────────────────────────────
async function toggleConnect() {
    if (vpnState.connected) {
        showOverlay('Disconnecting', 'Clearing proxy settings');
        await msg({ type: 'DISCONNECT' });
        hideOverlay();
    } else {
        if (!selectedNode) { showErr('No server selected', 'Pick a server from the list below.'); return; }
        hideErr();
        await doConnect(selectedNode);
    }
}

async function doConnect(node) {
    showOverlay('Establishing tunnel', 'Routing through ' + node.name);
    setConnecting();

    const r = await msg({ type: 'CONNECT', node });
    if (!r.ok) {
        hideOverlay(); setDisconnected();
        showErr('Connection Failed', r.error || 'Could not reach node.');
        return;
    }

    // Animated progress through the delay
    const steps = [
        [500,  'Authenticating node'],
        [1200, 'Establishing route'],
        [2000, 'Verifying tunnel'],
        [CONNECT_DELAY_MS, 'Connected!'],
    ];
    await new Promise(res => {
        let elapsed = 0;
        const iv = setInterval(() => {
            elapsed += 80;
            const step = steps.slice().reverse().find(([t]) => elapsed >= t);
            if (step) $('connSub').textContent = step[1];
            if (elapsed >= CONNECT_DELAY_MS) { clearInterval(iv); res(); }
        }, 80);
    });

    hideOverlay();
}

// ── Auto ──────────────────────────────────────────────────────────────────────
async function autoSelect() {
    if (!nodes.length) return;
    await pingAll();
    let best = null, bestMs = Infinity;
    nodes.forEach(n => { const ms = pingSmooth[n.id]?.avg; if (ms != null && ms < bestMs) { bestMs = ms; best = n; } });
    if (!best) { showErr('Auto-select failed', 'No nodes responded to ping.'); return; }
    selectNode(best);
    if (!vpnState.connected) await doConnect(best);
}

// ── Ping ──────────────────────────────────────────────────────────────────────
async function pingAll() {
    const data = await store('get', ['hubUrl']);
    const hub  = (data.hubUrl || HUB_DEFAULT).replace(/\/$/, '');
    await Promise.all(nodes.map(async n => {
        try {
            const r = await msg({ type: 'PING_NODE', url: `${hub}/nodes/${n.id}/ping` });
            smoothPing(n.id, r.latencyMs ?? null);
        } catch { /* keep existing smooth */ }
    }));
    renderServers();
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderServers() {
    const list = $('serverList');
    if (!nodes.length) {
        list.innerHTML = `<div class="empty-msg">${hubOnline ? 'No nodes available' : '🔴 Hub offline — check settings'}</div>`;
        return;
    }
    list.innerHTML = '';
    nodes.forEach((node, i) => {
        const isSel     = selectedNode?.id === node.id;
        const isConn    = vpnState.connected && vpnState.nodeId === node.id;
        const isDisabled = node.enabled === false;
        const ms        = isDisabled ? null : (pingSmooth[node.id]?.avg ?? null);
        const { bars, cls, label } = isDisabled ? { bars: 0, cls: 'r', label: '—' } : pingDisplay(ms);

        const card = document.createElement('div');
        card.className = ['srv-card', isSel && !isDisabled ? 'sel' : '', isConn ? 'active' : '', isDisabled ? 'disabled' : ''].filter(Boolean).join(' ');
        card.style.animationDelay = (i * 45) + 'ms';

        const barHTML = [0,1,2,3].map(j =>
            `<div class="ping-bar ${j < bars ? 'pb-' + cls : ''}"></div>`
        ).join('');

        const regionLine = node.region || '';
        const reasonLine = isDisabled && node.offlineReason
            ? `<div class="srv-reason">⚠ ${node.offlineReason}</div>`
            : '';

        card.innerHTML = `
            <div class="srv-dot${isDisabled ? ' dot-off' : ''}"></div>
            <div class="srv-info">
                <div class="srv-name${isDisabled ? ' name-off' : ''}">${node.name}${isDisabled ? ' <span class="offline-tag">OFFLINE</span>' : ''}</div>
                <div class="srv-region">${regionLine}${node.tailscaleIp && !isDisabled ? ' · ' + node.tailscaleIp : ''}</div>
                ${reasonLine}
            </div>
            <div class="ping-wrap">
                ${isDisabled ? '<span class="ping-ms pm-r">offline</span>' : `<div class="ping-bars">${barHTML}</div><span class="ping-ms${cls ? ' pm-' + cls : ''}">${label}</span>`}
            </div>
            ${isDisabled ? '<button class="srv-btn btn-off" disabled>Off</button>' : `<button class="srv-btn">${isConn ? '✓ ON' : isSel ? 'Go' : 'Use'}</button>`}
        `;

        if (!isDisabled) {
            card.addEventListener('click', () => selectNode(node));
            card.querySelector('.srv-btn').addEventListener('click', async e => {
                e.stopPropagation();
                selectNode(node);
                if (vpnState.connected && vpnState.nodeId === node.id) {
                    showOverlay('Disconnecting', 'Clearing proxy settings');
                    await msg({ type: 'DISCONNECT' });
                    hideOverlay();
                } else {
                    await doConnect(node);
                }
            });
        }

        list.appendChild(card);
    });
}

function pingDisplay(ms) {
    if (ms == null)  return { bars: 0, cls: '',  label: '—'     };
    if (ms < 60)     return { bars: 4, cls: 'g', label: ms+'ms' };
    if (ms < 130)    return { bars: 3, cls: 'g', label: ms+'ms' };
    if (ms < 260)    return { bars: 2, cls: 'y', label: ms+'ms' };
    if (ms < 500)    return { bars: 1, cls: 'r', label: ms+'ms' };
    return                  { bars: 1, cls: 'r', label: '500+'  };
}

function selectNode(node) {
    selectedNode = node;
    $('footerInfo').textContent = '→ ' + node.name;
    if (!vpnState.connected) $('statusSub').textContent = node.name;
    renderServers();
}

// ── Visual states ─────────────────────────────────────────────────────────────
function applyVisual(s) { s.connected ? setConnected(s.nodeName) : setDisconnected(); }

function setConnected(name) {
    $('powerBtn').className    = 'power-btn connected';
    $('orbitLine').className   = 'orbit-line filled';
    $('orbitDashes').className = 'orbit-dashes';
    $('statusMain').className  = 'status-main on';
    $('statusMain').textContent = '● Protected';
    $('statusSub').textContent  = 'via ' + (name || 'VPN Node');
    $('powerLbl').textContent   = 'Disconnect';
    $('logoMark').className = 'logo-mark connected';
    $('logoEm').className   = 'connected';
    $('glowA').className    = 'glow glow-a connected';
    $('glowB').className    = 'glow glow-b connected';
    vpnState.connected = true;
    hideErr(); renderServers();
}

function setDisconnected() {
    $('powerBtn').className    = 'power-btn';
    $('orbitLine').className   = 'orbit-line';
    $('orbitDashes').className = 'orbit-dashes';
    $('statusMain').className  = 'status-main';
    $('statusMain').textContent = 'Not Connected';
    $('statusSub').textContent  = selectedNode ? selectedNode.name : 'Select a server';
    $('powerLbl').textContent   = 'Connect';
    $('logoMark').className = 'logo-mark';
    $('logoEm').className   = '';
    $('glowA').className    = 'glow glow-a';
    $('glowB').className    = 'glow glow-b';
    vpnState.connected = false;
    renderServers();
}

function setConnecting() {
    $('powerBtn').className    = 'power-btn connecting';
    $('orbitLine').className   = 'orbit-line spinning';
    $('orbitDashes').className = 'orbit-dashes spinning';
    $('statusMain').className  = 'status-main conn';
    $('statusMain').textContent = 'Connecting…';
    $('powerLbl').textContent   = '…';
}

// ── Overlay ───────────────────────────────────────────────────────────────────
function showOverlay(title, sub) {
    $('connOverlay').querySelector('.conn-msg').innerHTML = title + '<span class="conn-dots"></span>';
    $('connSub').textContent = sub || '';
    $('connOverlay').classList.add('show');
}
function hideOverlay() { $('connOverlay').classList.remove('show'); }

// ── Hub status ────────────────────────────────────────────────────────────────
function setHubStatus(online) {
    hubOnline = online;
    $('hubDot').className   = 'hub-dot ' + (online ? 'on' : 'off');
    $('hubTxt').textContent = online ? 'Hub Online' : 'Hub Offline';
}

// ── Whitelist ─────────────────────────────────────────────────────────────────
async function checkWhitelist() {
    if (vpnState.connected) { hideErr(); return; }
    const r = await msg({ type: 'CHECK_WHITELIST' });
    if (r.allowed === false) {
        showErr('Not Whitelisted', `Your IP ${(r.ip||'').replace(/^::ffff:/,'')} isn't on the access list.`);
    } else if (r.allowed === true) {
        hideErr(); setHubStatus(true);
    }
}

function showErr(title, body) { $('errTitle').textContent = title; $('errBody').textContent = body; $('errBanner').classList.add('show'); }
function hideErr() { $('errBanner').classList.remove('show'); }

function toggleSettings() { $('settingsPanel').classList.toggle('open'); }
async function saveHub() {
    const url = $('hubUrlIn').value.trim().replace(/\/$/, '');
    if (!url) return;
    await msg({ type: 'SET_HUB', url });
    $('settingsPanel').classList.remove('open');
    doRefresh(); checkWhitelist();
}

async function doRefresh() {
    const btn = $('refreshBtn');
    btn.classList.add('spinning');
    const r  = await msg({ type: 'FETCH_NODES' });
    nodes     = r.nodes || [];
    hubOnline = nodes.length > 0;
    renderServers(); setHubStatus(hubOnline);
    btn.classList.remove('spinning');
    if (nodes.length) pingAll();
}