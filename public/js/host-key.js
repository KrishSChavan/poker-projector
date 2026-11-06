// The hosted password, kept so that the wall window and a reload stay signed in. Storage is
// optional: without it the page just asks again.

const STORAGE_KEY = 'poker-projection.host-password';

export function storedHostKey() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeHostKey(key) {
  try {
    if (key === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private browsing can refuse storage. The key still works until the next reload.
  }
}
