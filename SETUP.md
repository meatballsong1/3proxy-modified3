# ProxyHub - Quick Setup After Update

## ✅ What's New

1. **Access Key System** - Extension now requires login with access token
2. **Login Screen** - Clean purple UI for authentication
3. **Key Management Dashboard** - Create/disable/delete keys at /keys.html
4. **Fixed Tooltip Colors** - Dark background, light text (readable now!)
5. **Port Health Monitoring** - Notifications when ports go down

## 🚀 Deploy Steps

### 1. Update Hub Server

```bash
cd ~/3proxy-modified3/bin64

# Backup old version
cp server-linux.js server-linux.js.backup

# Replace with new server.js
# (Upload the one from proxyhub-with-keys.zip)

# Copy keys.html to bin64/
cp keys.html ~/3proxy-modified3/bin64/

# Restart dashboard
sudo systemctl restart proxyhub

# Verify
curl http://localhost:8080/keys -u oofbomb:malaop0989
# Should return: {"keys":{}}
```

### 2. Create Your First Access Key

**Option A: Web UI (easier)**
```
Open: http://vpn.oofbomb.xyz:8080/keys.html
Click: "create random key"
Copy the key (e.g., "deltaecho394")
```

**Option B: API**
```bash
curl -X POST http://localhost:8080/keys \
  -u oofbomb:malaop0989 \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 3. Update Extension

```
1. chrome://extensions
2. Remove old ProxyHub extension
3. Click "Load unpacked"
4. Select the new extension/ folder
5. Click extension icon
6. You'll see login screen
7. Enter your access key
8. Click "login"
9. Welcome screen appears, then redirects to main popup
```

### 4. Test It Works

```
1. Extension should show your nodes
2. Click NYC node → Should route through port 1081
3. Visit: https://ipinfo.io
4. Should show NYC IP: 162.248.100.58
```

## 🔧 Still Need To Fix Manually

### Issue 1: NYC Node Shows as "Chicago"

**Problem:** Node region field has wrong data

**Fix:**
```bash
# On hub, edit nodes.json
nano ~/3proxy-modified3/bin64/nodes.json

# Find the NYC node entry and change:
"region": "Chicago, IL"
# to:
"region": "NYC, NY"

# Save and restart
sudo systemctl restart proxyhub
```

### Issue 2: Port 1081 Routing

**Current Status:**
- Port 1081 listener exists on hub
- But parent chain to NYC node not configured properly

**Fix:**
Check hub's 3proxy config needs parent directive:

```bash
# View port 1081 config
cat /etc/3proxy/hub/3proxy.cfg

# Should have something like:
parent 1000 socks5 100.83.25.74 1080
socks -p1081
```

If missing, the hub's 3proxy isn't chaining to nodes - it's trying to exit directly (which won't work).

### Issue 3: Extension Shows Wrong Node

If NYC node still shows Chicago after fixing nodes.json:
```javascript
// Clear extension storage:
// Right-click extension → Inspect popup → Console:
chrome.storage.local.clear()
// Then reload extension
```

## 📋 Quick Test Checklist

- [ ] Hub server running with new server.js
- [ ] `/keys` endpoint returns empty object
- [ ] Created at least one access key
- [ ] keys.html page loads at /keys.html
- [ ] Extension login screen appears
- [ ] Can login with valid key
- [ ] Extension shows node list
- [ ] Tooltips show with dark background
- [ ] Notifications bell icon works
- [ ] Port health monitoring working

## 🐛 Debugging

**Extension won't login:**
```javascript
// Check console for errors
// Verify hub URL is correct in extension settings

// Test key validation manually:
fetch('https://vpn.oofbomb.xyz/keys/validate', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({key: 'deltaecho394'})
}).then(r => r.json()).then(console.log)
```

**Keys not saving:**
```bash
# Check file permissions
ls -la ~/3proxy-modified3/bin64/keys.json

# Check server logs
journalctl -u proxyhub -f
```

**Nodes not loading:**
```javascript
// In extension console:
chrome.storage.local.get(['accessKey'], console.log)

// Should show your key
// If null, you're not logged in
```

## 📝 Next: GitHub Sync (Optional)

To auto-push keys.json to GitHub when keys change:

```bash
cd ~/3proxy-modified3

# Set up git remote (if not already)
git remote add origin https://github.com/meatballsong1/3proxy-modified3.git

# Test push
git add bin64/keys.json
git commit -m "Test keys sync"
git push origin main

# If works, add to server.js saveKeys() function:
# exec('cd /home/oofbomb/3proxy-modified3 && git add bin64/keys.json && git commit -m "Update keys" && git push', ...)
```

Then extension could fetch from:
`https://raw.githubusercontent.com/meatballsong1/3proxy-modified3/main/bin64/keys.json`

But this is optional - validation happens server-side, not client-side.
