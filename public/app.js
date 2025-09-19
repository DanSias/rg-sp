/* eslint-env browser */
(() => {
  const shopEl = document.getElementById('shop');
  const saveMsgEl = document.getElementById('saveMsg');
  const hpResultEl = document.getElementById('hpResult');

  // --- Load shop context (whoami) ---
  async function loadWhoami() {
    try {
      const resp = await fetch('/app-api/whoami');
      const json = await resp.json();
      if (json.ok && json.shop) {
        shopEl.textContent = json.shop;
      }
    } catch (err) {
      console.error('Failed to load whoami', err);
    }
  }

  // --- Load settings from API ---
  async function loadSettings() {
    try {
      const resp = await fetch('/app-api/rg-settings');
      const json = await resp.json();
      if (json.ok && json.settings) {
        const s = json.settings;
        if (s.merchantId) document.getElementById('merchantId').value = s.merchantId;
        if (s.merchantKey) document.getElementById('merchantKey').value = '********';
        if (s.mode) document.getElementById('mode').value = s.mode;
        if (s.returnUrl) document.getElementById('returnUrl').value = s.returnUrl;
        if (s.cancelUrl) document.getElementById('cancelUrl').value = s.cancelUrl;
      }
    } catch (err) {
      console.error('Failed to load settings', err);
    }
  }

  // --- Handle save settings ---
  document.getElementById('rgSettings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const resp = await fetch('/app-api/rg-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await resp.json();
      if (json.ok) {
        saveMsgEl.textContent = '✅ Settings saved successfully';
        saveMsgEl.style.color = 'green';
        await loadSettings(); // refresh with masked values
      } else {
        saveMsgEl.textContent = '❌ Error: ' + (json.error || 'unknown');
        saveMsgEl.style.color = 'red';
      }
    } catch (err) {
      saveMsgEl.textContent = '❌ Error saving settings';
      saveMsgEl.style.color = 'red';
      console.error('Save error', err);
    }
  });

  // --- Handle Hosted Page test ---
  document.getElementById('hpTest').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const resp = await fetch('/app-api/test-hosted-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await resp.json();
      if (json.ok && json.url) {
        hpResultEl.innerHTML = `Hosted Page URL: <a target="_blank" rel="noopener" href="${json.url}">Open</a>`;
      } else {
        hpResultEl.textContent = 'Error: ' + (json.error || 'unknown');
      }
    } catch (err) {
      hpResultEl.textContent = '❌ Error testing Hosted Page';
      console.error('Hosted Page test error', err);
    }
  });

  // Kick off initial loads
  loadWhoami();
  loadSettings();
})();
