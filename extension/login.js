const loginForm = document.getElementById('loginForm');
const accessTokenInput = document.getElementById('accessToken');
const loginBtn = document.getElementById('loginBtn');
const errorDiv = document.getElementById('error');

// Focus input on load
accessTokenInput.focus();

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const key = accessTokenInput.value.trim();
  if (!key) {
    showError('Please enter an access token');
    return;
  }
  
  loginBtn.disabled = true;
  loginBtn.textContent = 'Validating...';
  errorDiv.classList.remove('show');
  
  try {
    // Get hub URL from storage
    const result = await chrome.storage.local.get(['hubUrl']);
    const hubUrl = result.hubUrl || 'https://vpn.oofbomb.xyz';
    
    // Validate the key
    const response = await fetch(`${hubUrl}/keys/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    
    const data = await response.json();
    
    if (data.valid) {
      // Save the key
      await chrome.storage.local.set({ accessKey: key });
      
      // Show success and redirect
      loginBtn.textContent = 'Success!';
      loginBtn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
      
      setTimeout(() => {
        window.location.href = 'popup.html';
      }, 500);
    } else {
      showError(data.error || 'Invalid access key');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  } catch (error) {
    showError('Connection failed. Check hub URL in settings.');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';
    console.error('Login error:', error);
  }
});

function showError(message) {
  errorDiv.textContent = message;
  errorDiv.classList.add('show');
  accessTokenInput.focus();
}