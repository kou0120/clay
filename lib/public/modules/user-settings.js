// user-settings.js — Modal dialog for user settings
// Account management and logout

import { refreshIcons } from './icons.js';
import { showToast } from './utils.js';

var ctx = null;
var settingsEl = null;
var openBtn = null;
var closeBtn = null;
var backdrop = null;
var navItems = null;
var sections = null;


export function initUserSettings(appCtx) {
  ctx = appCtx;
  settingsEl = document.getElementById('user-settings');
  openBtn = document.getElementById('user-settings-btn');
  closeBtn = document.getElementById('user-settings-close');
  backdrop = document.getElementById('user-settings-backdrop');

  if (!settingsEl || !openBtn) return;

  navItems = settingsEl.querySelectorAll('.us-nav-item');
  sections = settingsEl.querySelectorAll('.us-section');

  openBtn.addEventListener('click', function () {
    openUserSettings();
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      closeUserSettings();
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', function () {
      closeUserSettings();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isUserSettingsOpen()) {
      closeUserSettings();
    }
  });

  for (var i = 0; i < navItems.length; i++) {
    navItems[i].addEventListener('click', function () {
      var section = this.dataset.section;
      switchSection(section);
    });
  }

  // Mobile nav dropdown
  var navDropdown = document.getElementById('user-settings-nav-dropdown');
  if (navDropdown) {
    navDropdown.addEventListener('change', function () {
      switchSection(this.value);
    });
  }

  // PIN save button
  var pinInput = document.getElementById('us-pin-input');
  var pinSave = document.getElementById('us-pin-save');
  if (pinInput && pinSave) {
    pinInput.addEventListener('input', function () {
      pinSave.disabled = !/^\d{6}$/.test(pinInput.value);
    });
    pinInput.addEventListener('keydown', stopProp);
    pinInput.addEventListener('keyup', stopProp);
    pinInput.addEventListener('keypress', stopProp);
    pinSave.addEventListener('click', function () {
      savePin(pinInput.value);
    });
  }

  // Logout button
  var logoutBtn = document.getElementById('us-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      fetch('/auth/logout', { method: 'POST' }).then(function () {
        window.location.reload();
      }).catch(function () {
        window.location.reload();
      });
    });
  }
}

function openUserSettings() {
  settingsEl.classList.remove('hidden');
  openBtn.classList.add('active');
  refreshIcons(settingsEl);
  populateAccount();
  switchSection('us-account');
}

export function closeUserSettings() {
  settingsEl.classList.add('hidden');
  openBtn.classList.remove('active');
}

export function isUserSettingsOpen() {
  return settingsEl && !settingsEl.classList.contains('hidden');
}

function switchSection(sectionName) {
  for (var i = 0; i < navItems.length; i++) {
    navItems[i].classList.toggle('active', navItems[i].dataset.section === sectionName);
  }
  for (var j = 0; j < sections.length; j++) {
    sections[j].classList.toggle('active', sections[j].dataset.section === sectionName);
  }
  var navDropdown = document.getElementById('user-settings-nav-dropdown');
  if (navDropdown) navDropdown.value = sectionName;
}

function stopProp(e) {
  e.stopPropagation();
}

// --- Account population ---

function populateAccount() {
  fetch('/api/profile').then(function (r) {
    if (!r.ok) return null;
    return r.json();
  }).then(function (data) {
    if (!data) return;
    var usernameEl = document.getElementById('us-username');
    if (usernameEl && data.username) {
      usernameEl.textContent = data.username;
    }
    // Hide account section in single-user mode (no username)
    var accountNav = settingsEl.querySelector('[data-section="us-account"]');
    if (accountNav && !data.username) {
      accountNav.style.display = 'none';
    }
  }).catch(function () {});
}

function savePin(pin) {
  var pinInput = document.getElementById('us-pin-input');
  var pinSave = document.getElementById('us-pin-save');
  var pinMsg = document.getElementById('us-pin-msg');

  pinSave.disabled = true;
  pinSave.textContent = 'Saving...';

  fetch('/api/user/pin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin }),
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok) {
      pinInput.value = '';
      pinSave.textContent = 'Update PIN';
      if (pinMsg) {
        pinMsg.textContent = 'PIN updated successfully.';
        pinMsg.className = 'us-pin-msg us-pin-msg-ok';
        pinMsg.classList.remove('hidden');
      }
      showToast('PIN updated');
    } else {
      pinSave.disabled = false;
      pinSave.textContent = 'Update PIN';
      if (pinMsg) {
        pinMsg.textContent = data.error || 'Failed to update PIN.';
        pinMsg.className = 'us-pin-msg us-pin-msg-err';
        pinMsg.classList.remove('hidden');
      }
    }
  }).catch(function () {
    pinSave.disabled = false;
    pinSave.textContent = 'Update PIN';
    if (pinMsg) {
      pinMsg.textContent = 'Network error.';
      pinMsg.className = 'us-pin-msg us-pin-msg-err';
      pinMsg.classList.remove('hidden');
    }
  });
}
