// ProxyHub  ·  popup.js

const $  = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

const ICONS = {
    direct: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
    auto:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
    switch: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
    node:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="8" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><circle cx="7" cy="8" r="0.5"/><circle cx="7" cy="17" r="0.5"/></svg>`,
};

let state = null;

function send(msg) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (resp) => {
            if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
            resolve(resp || { ok: false, error: 'no response' });
        });
    });
}

function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

function timeAgo(ms) {
    if (!ms) return 'never';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 5)   return 'just now';
    if (s < 60)  return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    return `${Math.floor(s/3600)}h ago`;
}

function pingClass(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 80)  return 'ping-good';
    if (ms < 200) return 'ping-ok';
    return 'ping-bad';
}

function escapeHtml(s) {
    return (s == null ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderStatus() {
    const dot = $('statusDot');
    const val = $('statusValue');
    const meta = $('statusMeta');
    const powerBtn = $('powerBtn');
    const p = state.activeProfile;

    dot.className = 'status-dot';
    powerBtn.className = 'power-btn';

    const isActive = p !== 'direct' && p !== 'system';

    if (isActive) {
        powerBtn.classList.add('on');
    }

    if (p === 'direct') {
        val.textContent = 'Direct';
        meta.textContent = 'No proxy';
    } else if (p === 'system') {
        val.textContent = 'System proxy';
        meta.textContent = 'Using OS settings';
    } else if (p === 'auto') {
        dot.classList.add('on');
        val.textContent = 'Auto (load-balanced)';
        meta.textContent = `SOCKS5 ${state.proxyHost}:${state.defaultPort}`;
    } else if (p === 'auto_switch') {
        dot.classList.add('pac');
        val.textContent = 'Auto-switch';
        const n = (state.autoSwitch?.rules || []).length;
        meta.textContent = `${n} rule${n===1?'':'s'} · fallback: ${state.autoSwitch?.fallback || 'auto'}`;
    } else if (p.startsWith('node_')) {
        dot.classList.add('on');
        const node = (state.nodes || []).find(n => n.id === p);
        if (node) {
            val.textContent = node.name;
            const port = node.assignedPort || state.defaultPort;
            meta.textContent = `${node.region || '—'} · SOCKS5 ${state.proxyHost}:${port}`;
        } else {
            val.textContent = 'Unknown node';
            meta.textContent = '';
        }
    }
}

async function togglePower() {
    const isActive = state.activeProfile !== 'direct' && state.activeProfile !== 'system';
    
    if (isActive) {
        // Turn off - go to direct
        await pickProfile('direct');
    } else {
        // Turn on - go to last used profile or auto
        const lastProfile = state.lastActiveProfile || 'auto';
        await pickProfile(lastProfile);
    }
}

function renderProfiles() {
    const list = $('profileList');
    list.innerHTML = '';

    const profiles = [
        { id: 'direct',      name: 'Direct',      sub: 'No proxy',           icon: ICONS.direct },
        { id: 'auto',        name: 'Auto',        sub: 'Load-balanced',      icon: ICONS.auto },
        { id: 'auto_switch', name: 'Auto-switch', sub: 'URL-based rules',    icon: ICONS.switch },
    ];

    for (const p of profiles) {
        const item = el('div', 'item' + (state.activeProfile === p.id ? ' active' : ''));
        item.innerHTML = `
            <div class="item-icon">${p.icon}</div>
            <div class="item-main">
                <div class="item-name">${p.name}</div>
                <div class="item-sub">${p.sub}</div>
            </div>`;
        item.addEventListener('click', () => pickProfile(p.id));
        list.appendChild(item);
    }
}

function renderNodes() {
    const list = $('nodeList');
    const nodes = state.nodes || [];
    $('nodeCount').textContent = nodes.length ? `${nodes.filter(n=>n.online).length}/${nodes.length} online` : '';

    if (!nodes.length) {
        list.innerHTML = `<div class="item disabled"><div class="item-main"><div class="item-name">No nodes found</div><div class="item-sub">Check hub URL in settings</div></div></div>`;
        return;
    }

    list.innerHTML = '';

    const sorted = [...nodes].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.latencyMs == null) return 1;
        if (b.latencyMs == null) return -1;
        return a.latencyMs - b.latencyMs;
    });

    for (const n of sorted) {
        const profId = 'node_' + n.id;
        const active = state.activeProfile === profId;
        const canUse = n.enabled && !n.maintenance;

        const item = el('div', 'item' + (active ? ' active' : '') + (canUse ? '' : ' disabled'));
        const portNote = n.assignedPort
            ? `:${n.assignedPort}`
            : `:${state.defaultPort} (shared)`;

        let badge = '';
        let tooltip = '';
        
        if (n.maintenance) {
            badge = `<span class="badge badge-maint">Maintenance</span>`;
            if (n.reason) {
                tooltip = `<div class="node-tooltip">${escapeHtml(n.reason)}</div>`;
            }
        } else if (!n.enabled) {
            badge = `<span class="badge badge-off">Offline</span>`;
            if (n.reason) {
                tooltip = `<div class="node-tooltip">${escapeHtml(n.reason)}</div>`;
            }
        } else if (!n.online) {
            badge = `<span class="badge badge-off">Down</span>`;
        }

        const pingHtml = n.latencyMs != null
            ? `<span class="item-ping ${pingClass(n.latencyMs)}"><span class="ping-dot"></span>${n.latencyMs}ms</span>`
            : (canUse ? `<span class="item-ping"><span class="ping-dot"></span>—</span>` : '');

        item.innerHTML = `
            ${tooltip}
            <div class="item-icon">${ICONS.node}</div>
            <div class="item-main">
                <div class="item-name">${escapeHtml(n.name)}${badge}</div>
                <div class="item-sub">${escapeHtml(n.region || '—')} · ${portNote}</div>
            </div>
            ${pingHtml}`;

        if (canUse) item.addEventListener('click', () => pickProfile(profId));
        list.appendChild(item);
    }
}

function renderFooter() {
    $('lastUpdate').textContent = state.lastFetch
        ? `Updated ${timeAgo(state.lastFetch)}`
        : 'Never updated';
    $('hubHost').textContent = (state.hubApi || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    checkHubConnection();
}

async function checkHubConnection() {
    const statusEl = $('hubStatus');
    const textEl = statusEl?.querySelector('.hub-status-text');
    if (!statusEl || !textEl) return;

    statusEl.className = 'hub-status';
    textEl.textContent = 'checking...';

    const r = await send({ type: 'PING_HUB' });
    if (r.ok) {
        statusEl.classList.add('connected');
        textEl.textContent = `✓ connected · ${r.latencyMs}ms`;
    } else {
        statusEl.classList.add('error');
        textEl.textContent = r.error || 'unreachable';
    }
}

async function pickProfile(id) {
    if (state.activeProfile === id) {
        if (id !== 'direct') id = 'direct';
        else return;
    }
    
    // Save last active profile (for power button memory)
    if (id !== 'direct' && id !== 'system') {
        await send({ type: 'SAVE_SETTINGS', patch: { lastActiveProfile: id } });
        state.lastActiveProfile = id;
    }
    
    const r = await send({ type: 'SET_PROFILE', profile: id });
    if (!r.ok) return toast('Failed: ' + (r.error || 'unknown'));
    state.activeProfile = id;
    renderAll();
}

async function refreshNodes() {
    const btn = $('refreshBtn');
    btn.style.opacity = 0.5;
    btn.style.transform = 'rotate(180deg)';
    btn.style.transition = 'all .4s';

    const r = await send({ type: 'REFRESH_NODES' });
    const s = await send({ type: 'GET_STATE' });
    if (s.ok) state = s.state;

    btn.style.opacity = '';
    btn.style.transform = '';

    if (r.ok) toast(`Loaded ${r.nodes?.length || 0} nodes`);
    else      toast('Refresh failed: ' + (r.error || 'unknown'));

    renderAll();
}

function renderAll() {
    renderStatus();
    renderProfiles();
    renderNodes();
    renderFooter();
}

(async function init() {
    const r = await send({ type: 'GET_STATE' });
    if (!r.ok) {
        toast('Failed to load state');
        return;
    }
    state = r.state;
    renderAll();

    if (!state.lastFetch || Date.now() - state.lastFetch > 30000) {
        refreshNodes();
    }

    $('powerBtn').addEventListener('click', togglePower);
    $('refreshBtn').addEventListener('click', refreshNodes);
    $('optionsBtn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
    $('openHubBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: state.hubApi });
    });
})();