const $ = id => document.getElementById(id);

async function validateKey(key) {
    try {
        const hubApi = 'https://vpn.oofbomb.xyz';  // Default hub URL
        const res = await fetch(`${hubApi}/keys/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        });
        const data = await res.json();
        return data;
    } catch (e) {
        return { valid: false, error: 'Connection failed' };
    }
}

function showError(msg) {
    const errorEl = $('error');
    errorEl.textContent = msg;
    errorEl.classList.add('show');
    setTimeout(() => errorEl.classList.remove('show'), 3000);
}

function showWelcome() {
    const welcomeEl = $('welcome');
    welcomeEl.classList.add('show');
    
    setTimeout(() => {
        welcomeEl.style.animation = 'fadeOut 0.5s';
        setTimeout(() => {
            // Redirect to main popup
            window.location.href = 'popup.html';
        }, 500);
    }, 1500);
}

$('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const key = $('accessKey').value.trim();
    if (!key) {
        showError('Please enter an access token');
        return;
    }
    
    const loginBtn = $('loginBtn');
    loginBtn.disabled = true;
    loginBtn.textContent = 'validating...';
    
    const result = await validateKey(key);
    
    if (result.valid) {
        // Save the key to extension state
        await chrome.storage.local.set({ accessKey: key });
        
        showWelcome();
    } else {
        showError(result.error || 'Invalid access token');
        loginBtn.disabled = false;
        loginBtn.textContent = 'login';
    }
});

// Check if already logged in
chrome.storage.local.get(['accessKey'], async (data) => {
    if (data.accessKey) {
        // Verify it's still valid
        const result = await validateKey(data.accessKey);
        if (result.valid) {
            window.location.href = 'popup.html';
        }
    }
});
