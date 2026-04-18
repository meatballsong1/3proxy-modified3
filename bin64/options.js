// ProxyHub  ·  options.js

const $ = id => document.getElementById(id);
const send = msg => new Promise(r => chrome.runtime.sendMessage(msg, resp => r(resp || { ok: false })));

let state = null;
let rules = [];

function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

function availableProfiles() {
    const out = [
        { id: 'direct', label: 'Direct' },
        { id: 'auto',   label: 'Auto (load-balanced)' },
    ];
    for (const n of state.nodes || []) {
        out.push({ id: 'node_' + n.id, label: n.name });
    }
    return out;
}

function optionsHtml(selected) {
    return availableProfiles().map(p =>
        `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${escapeHtml(p.label)}</option>`
    ).join('');
}

function escapeHtml(s) {
    return (s == null ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderRules() {
    const container = $('rules');
    container.innerHTML = '';

    if (!rules.length) {
        container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; padding:10px 0;">No rules yet. Add one to route specific URLs through a chosen profile.</div>`;
    }

    rules.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'rule-row';
        row.innerHTML = `
            <select data-field="match">
                <option value="host"  ${r.match==='host'?'selected':''}>Host</option>
                <option value="url"   ${r.match==='url'?'selected':''}>URL wildcard</option>
                <option value="regex" ${r.match==='regex'?'selected':''}>Regex</option>
            </select>
            <input type="text" data-field="pattern" value="${escapeHtml(r.pattern||'')}" placeholder="${r.match==='regex'?'^https?://api\\\\.':'*.example.com or https://api.*'}">
            <select data-field="profile">${optionsHtml(r.profile)}</select>
            <button class="btn-danger" data-action="remove" title="Remove">×</button>
        `;
        row.querySelectorAll('[data-field]').forEach(input => {
            input.addEventListener('change', (e) => {
                rules[i][e.target.dataset.field] = e.target.value;
            });
        });
        row.querySelector('[data-action=remove]').addEventListener('click', () => {
            rules.splice(i, 1);
            renderRules();
        });
        container.appendChild(row);
    });
}

async function testHub() {
    const pill = $('hubStatus');
    const txt  = $('hubStatusText');
    pill.className = 'status-pill';
    txt.textContent = 'checking…';

    await send({ type: 'SAVE_SETTINGS', patch: { hubApi: $('hubApi').value.trim() } });

    const r = await send({ type: 'PING_HUB' });
    if (r.ok) {
        pill.className = 'status-pill ok';
        txt.textContent = `reachable · ${r.latencyMs}ms`;
    } else {
        pill.className = 'status-pill err';
        txt.textContent = r.error || 'unreachable';
    }

    await send({ type: 'REFRESH_NODES' });
    const s = await send({ type: 'GET_STATE' });
    if (s.ok) state = s.state;
    refreshFallback();
    renderRules();
}

function refreshFallback() {
    $('fallback').innerHTML = optionsHtml(state.autoSwitch?.fallback || 'auto');
}

async function save() {
    const bypass = $('bypassList').value
        .split('\n').map(s => s.trim()).filter(Boolean);

    const cleanRules = rules.filter(r => r.pattern && r.profile);

    const patch = {
        hubApi:      $('hubApi').value.trim().replace(/\/+$/, ''),
        proxyHost:   $('proxyHost').value.trim(),
        defaultPort: parseInt($('defaultPort').value, 10) || 1080,
        bypassList:  bypass,
        autoSwitch:  { rules: cleanRules, fallback: $('fallback').value || 'auto' },
    };

    const r = await send({ type: 'SAVE_SETTINGS', patch });
    if (r.ok) {
        toast('Saved');
        const s = await send({ type: 'GET_STATE' });
        if (s.ok) state = s.state;
    } else {
        toast('Save failed: ' + (r.error || 'unknown'));
    }
}

async function reset() {
    if (!confirm('Reset all settings to defaults? This will clear auto-switch rules and custom hub URL.')) return;
    await chrome.storage.local.clear();
    window.location.reload();
}

(async function init() {
    const r = await send({ type: 'GET_STATE' });
    if (!r.ok) { toast('Failed to load state'); return; }
    state = r.state;

    $('hubApi').value      = state.hubApi      || 'https://hub.oofbomb.xyz';
    $('proxyHost').value   = state.proxyHost   || 'hub.oofbomb.xyz';
    $('defaultPort').value = state.defaultPort || 1080;
    $('bypassList').value  = (state.bypassList || []).join('\n');
    rules                  = JSON.parse(JSON.stringify(state.autoSwitch?.rules || []));

    refreshFallback();
    renderRules();
    testHub();

    $('testBtn').addEventListener('click', testHub);
    $('saveBtn').addEventListener('click', save);
    $('resetBtn').addEventListener('click', reset);
    $('addRuleBtn').addEventListener('click', () => {
        rules.push({ match: 'host', pattern: '', profile: 'auto' });
        renderRules();
    });
})();