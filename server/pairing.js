// The phone proves it may run the game with a short code shown on the laptop. Loopback needs no
// code. Anyone else on the LAN gets a few guesses a minute.

import { randomInt, timingSafeEqual } from 'node:crypto';
import { isLoopback } from './network.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const VALID_CODE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const MAX_BAD_CODES = 5;
const WINDOW_MS = 60_000;

function generateCode() {
  const picks = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return picks.join('');
}

export async function loadPairingCode(store) {
  const saved = await store.load();
  if (typeof saved?.code === 'string' && VALID_CODE.test(saved.code)) return saved.code;
  if (saved !== undefined) {
    console.warn('Ignoring unusable pairing.json');
    await store.keepDamaged();
  }
  const code = generateCode();
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

export function createGate(firstCode, now = Date.now) {
  const throttle = createGuessThrottle(now);
  const { blockLeftMs } = throttle;
  const isBlocked = (address) => blockLeftMs(address) > 0;
  let code = firstCode;
  return {
    get code() {
      return code;
    },
    newCode() {
      code = generateCode();
      return code;
    },
    isBlocked,
    blockLeftMs,
    mayControl(address, key) {
      if (isLoopback(address)) return true;
      // People type this on a phone keyboard. The code has no lowercase letters to lose.
      const attempt = typeof key === 'string' ? key.trim().toUpperCase() : '';
      if (attempt === '' || isBlocked(address)) return false;
      if (isSameCode(attempt, code)) return true;
      throttle.recordFailure(address);
      return false;
    },
  };
}
