// How the phone proves it may run the game. The QR code carries the pairing code in the URL
// fragment. It moves straight into storage so it never stays in the address bar, and storage is
// optional: without it a reload just asks for the code again.

import { $ } from './dealer-dom.js';

const STORAGE_KEY = 'poker-projection.pairing-code';
const CHECK_TIMEOUT_MS = 3000;
// So the retry lands after the block ends. Landing early would only mean one more wait.
const BLOCK_MARGIN_MS = 250;

function storedCode() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCode(code) {
  try {
    if (code === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private browsing can refuse storage. The code still works until the next reload.
  }
}

function takeCodeFromUrl() {
  const code = window.location.hash.slice(1).trim().toUpperCase();
  if (code === '') return null;
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', pathname + search);
  storeCode(code);
  return code;
}

export function createPairing({ onCode, onChange }) {
  const field = $('#code-field');
  const message = $('#code-message');
  let code = takeCodeFromUrl() ?? storedCode();
  let checking = false;
  let checkTimer = 0;
  let blockTimer = 0;

  function stopChecking() {
    clearTimeout(checkTimer);
    checking = false;
  }

  // If the server has gone the reply never comes, and the banner has to take over.
  function giveUpChecking() {
    stopChecking();
    message.textContent = '';
    onChange();
  }

  function check(next) {
    code = next;
    checking = true;
    clearTimeout(checkTimer);
    clearTimeout(blockTimer);
    checkTimer = setTimeout(giveUpChecking, CHECK_TIMEOUT_MS);
    storeCode(next);
    message.textContent = 'Checking the code...';
    message.classList.remove('bad');
    onChange();
    onCode(next);
  }

  $('#code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = field.value.trim().toUpperCase();
    if (typed !== '' && !checking) check(typed);
  });

  field.addEventListener('input', () => {
    message.textContent = '';
  });

  window.addEventListener('hashchange', () => {
    const next = takeCodeFromUrl();
    if (next !== null) check(next);
  });

  function refuse() {
    message.textContent = 'That code did not work. Check the laptop and try again.';
    message.classList.add('bad');
    field.select();
  }

  // The server never looked at the code, so it says nothing about the code and it stays.
  function waitOutBlock(retryInMs) {
    message.textContent = 'Too many tries. Wait a minute.';
    message.classList.add('bad');
    blockTimer = setTimeout(() => {
      message.textContent = '';
      if (code !== null) check(code);
    }, retryInMs + BLOCK_MARGIN_MS);
  }

  return {
    get code() {
      return code;
    },
    get isChecking() {
      return checking;
    },
    // A refused code is dropped, so it can't use up guesses on every reconnect.
    onWelcome({ canControl, blocked, retryInMs }) {
      const hadCode = code !== null;
      stopChecking();
      clearTimeout(blockTimer);
      if (canControl) {
        field.value = '';
        message.textContent = '';
        return;
      }
      if (blocked) {
        waitOutBlock(retryInMs);
        return;
      }
      code = null;
      storeCode(null);
      if (hadCode) refuse();
      else message.textContent = '';
    },
  };
}
