// Leash Dedicated Auth Gate Client
(function () {
  const $ = (sel) => document.querySelector(sel);
  const authForm = $('#auth-form');
  const authError = $('#auth-error');
  const btnSubmit = $('#btn-submit');
  const btnSubmitText = $('#btn-submit-text');
  const tabSignin = $('#tab-signin');
  const tabSignup = $('#tab-signup');
  const groupName = $('#group-name');
  const nameInput = $('#name');
  const emailInput = $('#email');
  const passwordInput = $('#password');
  const demoList = $('#demo-profiles-list');
  const btnPaypal = $('#btn-paypal-oauth');

  let mode = 'signin'; // 'signin' | 'signup'

  function showError(msg) {
    if (!msg) {
      authError.style.display = 'none';
      authError.textContent = '';
      return;
    }
    authError.textContent = msg;
    authError.style.display = 'block';
  }

  function setMode(newMode) {
    mode = newMode;
    showError(null);
    if (mode === 'signup') {
      tabSignup.classList.add('active');
      tabSignin.classList.remove('active');
      groupName.style.display = 'block';
      nameInput.required = true;
      btnSubmitText.textContent = 'Create Account & Connect';
      emailInput.value = '';
      passwordInput.value = '';
    } else {
      tabSignin.classList.add('active');
      tabSignup.classList.remove('active');
      groupName.style.display = 'none';
      nameInput.required = false;
      btnSubmitText.textContent = 'Sign In to Dashboard';
      if (!emailInput.value) emailInput.value = 'alex@personal.example';
      if (!passwordInput.value) passwordInput.value = 'password123';
    }
  }

  tabSignin?.addEventListener('click', () => setMode('signin'));
  tabSignup?.addEventListener('click', () => setMode('signup'));

  // Load and render 1-click Judge Profiles
  async function loadProfiles() {
    try {
      const res = await fetch('/api/auth/profiles');
      if (!res.ok) return;
      const profiles = await res.json();
      if (!demoList) return;

      demoList.innerHTML = profiles
        .map(
          (p) => `
        <div class="profile-card" data-id="${p.id}" tabindex="0" role="button" title="Log in as ${p.name}">
          <div class="profile-card-left">
            <div class="profile-avatar">${p.avatar}</div>
            <div>
              <div class="profile-name">${p.name}</div>
              <div class="profile-role">${p.role} • ${p.paypalConnected ? '<span style="color:var(--ok)">PayPal Active</span>' : '<span style="color:var(--text-muted)">Unlinked</span>'}</div>
            </div>
          </div>
          <span style="font-size:11px; font-family:var(--font-mono); color:var(--brand); display:flex; align-items:center; gap:4px;">
            Select ➔
          </span>
        </div>
      `,
        )
        .join('');

      demoList.querySelectorAll('.profile-card').forEach((card) => {
        const doLogin = async () => {
          const profileId = card.dataset.id;
          card.style.opacity = '0.6';
          card.style.pointerEvents = 'none';
          showError(null);
          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profileId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Login failed');
            window.location.href = '/';
          } catch (err) {
            showError(err.message);
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
          }
        };

        card.addEventListener('click', doLogin);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            doLogin();
          }
        });
      });
    } catch {
      // ignore
    }
  }

  // Handle Form Submission
  authForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(null);
    btnSubmit.disabled = true;
    const prevText = btnSubmitText.textContent;
    btnSubmitText.textContent = mode === 'signup' ? 'Creating...' : 'Authenticating...';

    const payload =
      mode === 'signup'
        ? {
            name: nameInput.value.trim(),
            email: emailInput.value.trim(),
            password: passwordInput.value,
          }
        : {
            email: emailInput.value.trim(),
            password: passwordInput.value,
          };

    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');

      window.location.href = '/';
    } catch (err) {
      showError(err.message);
      btnSubmit.disabled = false;
      btnSubmitText.textContent = prevText;
    }
  });

  // Handle PayPal Sandbox OAuth simulation
  btnPaypal?.addEventListener('click', async () => {
    btnPaypal.disabled = true;
    const origHTML = btnPaypal.innerHTML;
    btnPaypal.innerHTML = `
      <span class="spinner" style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.8s linear infinite;display:inline-block;"></span>
      <span>Connecting to PayPal Sandbox...</span>
    `;

    try {
      // Log in with the pre-seeded Alex Rivera (Personal Shopper) who has PayPal Sandbox connected
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'usr_personal' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'PayPal OAuth simulation failed');
      setTimeout(() => {
        window.location.href = '/';
      }, 450);
    } catch (err) {
      showError(err.message);
      btnPaypal.disabled = false;
      btnPaypal.innerHTML = origHTML;
    }
  });

  // Initial load
  loadProfiles();
})();
