# ProxyHub Access Key System

## Overview

The access key system protects your proxy hub from unauthorized use. Users must have a valid access token to use the extension.

## Setup on Hub

### 1. Install/Update Server

```bash
cd ~/3proxy-modified3/bin64

# Replace server-linux.js with the new version
# (The one with key management endpoints)

# Restart dashboard
sudo systemctl restart proxyhub

# Verify key endpoints work
curl http://localhost:8080/keys -u oofbomb:malaop0989
```

### 2. Access Key Management Dashboard

Open: `http://vpn.oofbomb.xyz:8080/keys.html`

**Features:**
- Create random keys (e.g., "dogcat394")
- Create custom keys
- Set expiration (7 days, 30 days, 1 year, or infinite)
- Enable/disable keys without deleting
- View all active keys

### 3. Create Your First Key

```bash
# Via API:
curl -X POST http://localhost:8080/keys \
  -u oofbomb:malaop0989 \
  -H "Content-Type: application/json" \
  -d '{"custom": null, "expires": null}'

# Returns:
# {
#   "ok": true,
#   "keyId": "key_1713564892123",
#   "key": {
#     "key": "deltaecho394",
#     "created": "2026-04-19T19:15:00.000Z",
#     "expires": null,
#     "enabled": true,
#     "custom": false
#   }
# }
```

**Or use the web UI** at `/keys.html` - click "create random key"

### 4. Optional: Sync to GitHub

If you want the extension to fetch keys directly from GitHub:

```bash
cd ~/3proxy-modified3

# Create a post-save hook that pushes to GitHub
cat > bin64/sync-keys.sh << 'EOF'
#!/bin/bash
git add bin64/keys.json
git commit -m "Update access keys" || true
git push origin main
EOF

chmod +x bin64/sync-keys.sh

# Modify server.js saveKeys() function to call this script:
# (Add at the end of saveKeys function)
#   exec('bash sync-keys.sh', { cwd: __dirname }, (err) => {
#       if (err) console.warn('[keys] git push failed:', err.message);
#   });
```

## Extension Setup

### 1. First Launch

When users install the extension, they'll see a login screen:

```
┌─────────────────────────────┐
│         🔒                  │
│      proxy hub              │
│  enter your credentials     │
│                             │
│  Access Token               │
│  ┌───────────────────────┐ │
│  │ deltaecho394          │ │
│  └───────────────────────┘ │
│  enter the access token    │
│  you were given             │
│                             │
│  ┌───────────────────────┐ │
│  │       login           │ │
│  └───────────────────────┘ │
└─────────────────────────────┘
```

### 2. Key Validation

- Extension sends key to `POST /keys/validate`
- Server checks if key exists, is enabled, and not expired
- If valid: saved to extension storage
- If invalid: shows error message

### 3. Key Expiration Handling

When a key expires:
- Extension gets 401 from `/ext/nodes`
- Shows red notification: "access token expired!"
- Redirects to login screen
- User must enter new valid key

## API Endpoints

### Public (No Auth)
- `POST /keys/validate` - Check if a key is valid

### Admin (Requires Basic Auth)
- `GET /keys` - List all keys
- `POST /keys` - Create new key
- `PUT /keys/:id` - Update key (enable/disable/expiration)
- `DELETE /keys/:id` - Delete key

## Key Storage Format

`bin64/keys.json`:
```json
{
  "key_1713564892123": {
    "key": "deltaecho394",
    "created": "2026-04-19T19:15:00.000Z",
    "expires": null,
    "enabled": true,
    "custom": false
  },
  "key_1713564999456": {
    "key": "mycustomkey",
    "created": "2026-04-19T19:16:39.000Z",
    "expires": "2026-04-26T19:16:39.000Z",
    "enabled": false,
    "custom": true
  }
}
```

## Security Notes

- Keys are validated on every `/ext/nodes` request
- Disabled keys are immediately rejected
- Expired keys are automatically rejected
- No rate limiting on validation (hub is internal)
- Keys are stored in plain text (they're not passwords)
- Anyone with a valid key can use your proxies

## Troubleshooting

**Extension shows "Invalid access key":**
1. Check key exists: `curl http://localhost:8080/keys -u oofbomb:malaop0989`
2. Verify it's enabled and not expired
3. Try creating a new key

**Can't access /keys.html:**
1. Make sure keys.html is in bin64/public/ or bin64/
2. Check server logs: `journalctl -u proxyhub -f`
3. Verify you're using updated server.js

**Keys not syncing to GitHub:**
1. Check git remote is configured: `git remote -v`
2. Verify SSH keys or credentials are set up
3. Test manual push: `cd ~/3proxy-modified3 && git push`
