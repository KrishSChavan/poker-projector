// The phone proves it may run the game with a code shown on the laptop. On a laptop, loopback needs
// no code and anyone else on the LAN gets a few guesses a minute. Hosted, every visitor comes
// through the same proxy, so an address proves nothing and a limit per address would let one
// stranger lock the dealer out. There the host signs in with a password, and the code is long
// enough that guessing it isn't worth limiting.

import { randomInt, timingSafeEqual } from 'node:crypto';
import { isLoopback } from './network.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LOCAL_CODE_LENGTH = 6;
const HOSTED_CODE_LENGTH = 12;
const VALID_CODE = new RegExp(`^[${ALPHABET}]+$`);
const MAX_BAD_CODES = 5;
const WINDOW_MS = 60_000;

export const MIN_HOST_PASSWORD_LENGTH = 12;

function generateCode(isHosted) {
  const length = isHosted ? HOSTED_CODE_LENGTH : LOCAL_CODE_LENGTH;
  const picks = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return picks.join('');
}

export async function loadPairingCode(store, isHosted = false) {
  const saved = await store.load();
  const length = isHosted ? HOSTED_CODE_LENGTH : LOCAL_CODE_LENGTH;
  const isUsable = (code) => typeof code === 'string' && VALID_CODE.test(code);
  if (isUsable(saved?.code) && saved.code.length === length) return saved.code;
  if (saved !== undefined) {
    console.warn('Ignoring unusable pairing.json');
    await store.keepDamaged();
  }
  const code = generateCode(isHosted);
  store.save({ code });
  await store.flush();
  return code;
}

function isSameCode(attempt, code) {
  const [a, b] = [Buffer.from(attempt), Buffer.from(code)];
  return a.length === b.length && timingSafeEqual(a, b);
}

function createGuessThrottle(now) {
  const records = new Map();

  function forgetExpired(time) {
    for (const [address, record] of records) {
      record.failures = record.failures.filter((at) => time - at < WINDOW_MS);
      if (record.failures.length === 0 && record.blockedUntil <= time) records.delete(address);
    }
  }

  return {
    // How long until this address may try again, 0 if it can try now.
    blockLeftMs(address) {
      const time = now();
      forgetExpired(time);
      return Math.max(0, (records.get(address)?.blockedUntil ?? 0) - time);
    },
    recordFailure(address) {
      const time = now();
      const record = records.get(address) ?? { failures: [], blockedUntil: 0 };
      record.failures.push(time);
      if (record.failures.length >= MAX_BAD_CODES) record.blockedUntil = time + WINDOW_MS;
      records.set(address, record);
    },
  };
}

export function createGate(firstCode, now = Date.now, hostPassword = null) {
  const isHosted = hostPassword !== null;
  const throttle = createGuessThrottle(now);
  const { blockLeftMs } = throttle;
  const isBlocked = (address) => blockLeftMs(address) > 0;
  let code = firstCode;

  // The host can see the code and replace it, which a paired phone can't.
  function isHost(address, key) {
    if (!isHosted) return isLoopback(address);
    return typeof key === 'string' && isSameCode(key, hostPassword);
  }

  return {
    isHosted,
    get code() {
      return code;
    },
    newCode() {
      code = generateCode(isHosted);
      return code;
    },
    isHost,
    isBlocked,
    blockLeftMs,
    mayControl(address, key) {
      if (isHost(address, key)) return true;
      // People type this on a phone keyboard. The code has no lowercase letters to lose.
      const attempt = typeof key === 'string' ? key.trim().toUpperCase() : '';
      if (isHosted) return attempt !== '' && isSameCode(attempt, code);
      if (attempt === '' || isBlocked(address)) return false;
      if (isSameCode(attempt, code)) return true;
      throttle.recordFailure(address);
      return false;
    },
  };
}
