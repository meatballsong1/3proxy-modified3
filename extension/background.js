let state = {
  currentNode: null,
  nodes: [],
  hotloop: { enabled: false, mode: 'weighted' },
  portMap: {},
  hubUrl: 'https://vpn.oofbomb.xyz',
  accessKey: null  // Added for authentication
};

// Load state from storage on startup
chrome.storage.local.get(['currentNode', 'hubUrl', 'accessKey'], (result) => {
  if (result.currentNode) state.currentNode = result.currentNode;
  if (result.hubUrl) state.hubUrl = result.hubUrl;
  if (result.accessKey) state.accessKey = result.accessKey;
  refreshNodes();
});

// Refresh nodes every 30 seconds
setInterval(refreshNodes, 30000);

async function refreshNodes() {
  try {
    if (!state.accessKey) {
      console.log('[ProxyHub] No access key, skipping refresh');
      return;
    }
    
    const response = await fetch(`${state.hubUrl}/ext/nodes`, {
      headers: {
        'X-Access-Key': state.accessKey
      }
    });
    
    if (response.status === 401) {
      // Invalid key, clear it
      state.accessKey = null;
      await chrome.storage.local.remove('accessKey');
      console.log('[ProxyHub] Access key invalid, cleared');
      return;
    }
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    state.nodes = data.nodes || [];
    state.hotloop = data.hotloop || { enabled: false };
    state.portMap = data.portMap || {};
    
    console.log('[ProxyHub] Nodes refreshed:', state.nodes.length);
  } catch (error) {
    console.error('[ProxyHub] Failed to refresh nodes:', error);
  }
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.hubUrl) state.hubUrl = changes.hubUrl.newValue;
    if (changes.currentNode) state.currentNode = changes.currentNode.newValue;
    if (changes.accessKey) {
      state.accessKey = changes.accessKey.newValue;
      if (state.accessKey) refreshNodes();
    }
  }
});

// Set proxy based on current node
async function applyProxy() {
  if (!state.currentNode || state.currentNode === 'DIRECT') {
    await chrome.proxy.settings.clear({});
    console.log('[ProxyHub] Proxy cleared (DIRECT)');
    return;
  }
  
  const node = state.nodes.find(n => n.id === state.currentNode);
  if (!node) {
    console.log('[ProxyHub] Node not found:', state.currentNode);
    return;
  }
  
  let proxyHost = new URL(state.hubUrl).hostname;
  let proxyPort = state.portMap[state.currentNode] || 1080;
  
  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: 'socks5',
        host: proxyHost,
        port: proxyPort
      }
    }
  };
  
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  console.log(`[ProxyHub] Proxy set: ${proxyHost}:${proxyPort} (${node.name})`);
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getState') {
    sendResponse(state);
  } else if (request.action === 'setNode') {
    state.currentNode = request.nodeId;
    chrome.storage.local.set({ currentNode: request.nodeId });
    applyProxy();
    sendResponse({ success: true });
  } else if (request.action === 'refreshNodes') {
    refreshNodes().then(() => sendResponse({ success: true }));
    return true; // Keep channel open for async
  }
});