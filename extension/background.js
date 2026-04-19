let state = {
  accessKey: null,
  activeProfile: 'direct',
  lastActiveProfile: 'auto',
  nodes: [],
  defaultPort: 1080,
  proxyHost: 'vpn.oofbomb.xyz',
  hubApi: 'https://vpn.oofbomb.xyz',
  autoSwitch: { rules: [], fallback: 'auto' },
  bypassList: [],
  lastFetch: null,
  notifications: []
};

// Load state from storage on startup
chrome.storage.local.get(null, (result) => {
  Object.assign(state, result);
  if (state.accessKey) {
    refreshNodes();
  }
});

// Refresh nodes every 30 seconds
setInterval(() => {
  if (state.accessKey) refreshNodes();
}, 30000);

async function refreshNodes() {
  try {
    if (!state.accessKey) {
      console.log('[ProxyHub] No access key, skipping refresh');
      return;
    }
    
    const hubApi = state.hubApi || 'https://vpn.oofbomb.xyz';
    const response = await fetch(`${hubApi}/ext/nodes`, {
      headers: {
        'X-Access-Key': state.accessKey
      }
    });
    
    if (response.status === 401) {
      state.accessKey = null;
      await chrome.storage.local.remove('accessKey');
      console.log('[ProxyHub] Access key invalid, cleared');
      return;
    }
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    state.nodes = data.nodes || [];
    state.lastFetch = Date.now();
    await chrome.storage.local.set({ nodes: state.nodes, lastFetch: state.lastFetch });
    
    console.log('[ProxyHub] Nodes refreshed:', state.nodes.length);
  } catch (error) {
    console.error('[ProxyHub] Failed to refresh nodes:', error);
  }
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.activeProfile) state.activeProfile = changes.activeProfile.newValue;
    if (changes.hubApi) state.hubApi = changes.hubApi.newValue;
    if (changes.accessKey) {
      state.accessKey = changes.accessKey.newValue;
      if (state.accessKey) refreshNodes();
    }
  }
});

// Message handler with new protocol
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    const type = request.type;
    
    if (type === 'GET_STATE') {
      sendResponse({ ok: true, state });
    }
    else if (type === 'SET_PROFILE') {
      const profileId = request.profile;
      state.activeProfile = profileId;
      await chrome.storage.local.set({ activeProfile: profileId });
      sendResponse({ ok: true });
    }
    else if (type === 'REFRESH_NODES') {
      try {
        await refreshNodes();
        sendResponse({ ok: true, nodes: state.nodes });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    }
    else if (type === 'PING_HUB') {
      try {
        const hubApi = state.hubApi || 'https://vpn.oofbomb.xyz';
        const start = Date.now();
        const response = await fetch(`${hubApi}/health`, { timeout: 5000 });
        const latencyMs = Date.now() - start;
        
        if (response.ok) {
          sendResponse({ ok: true, latencyMs });
        } else {
          sendResponse({ ok: false, error: `HTTP ${response.status}` });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    }
    else if (type === 'SAVE_SETTINGS') {
      const patch = request.patch || {};
      Object.assign(state, patch);
      await chrome.storage.local.set(patch);
      sendResponse({ ok: true });
    }
    else {
      sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  
  return true; // Keep channel open for async
});