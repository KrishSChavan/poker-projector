// One JSON file on disk. Writes go through a temp file and a rename, so a crash mid-save can't
// leave half a file behind, and they run one at a time, so an older save can't land last.

import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const SAVE_DELAY_MS = 250;
const RETRY_DELAY_MS = 2000;

async function writeJson(file, value, indent) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(JSON.stringify(value, null, indent));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

const timeForFileName = () => new Date().toISOString().replace(/[:.]/g, '-');

async function copyAside(file) {
  const stamped = `${file}.damaged-${timeForFileName()}`;
  for (let extra = 0; ; extra += 1) {
    const copy = extra === 0 ? stamped : `${stamped}-${extra}`;
    try {
      await copyFile(file, copy, constants.COPYFILE_EXCL);
      return copy;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export function createStore(
  file,
  { indent = 0, delayMs = SAVE_DELAY_MS, retryMs = RETRY_DELAY_MS } = {},
) {
  const name = path.basename(file);
  let latest;
  let dirty = false;
  let timer = null;
  let writing = null;
  let failed = false;
  let closed = false;
  let onFailedChange = () => {};

  async function writeLatest() {
    dirty = false;
    try {
      await writeJson(file, latest, indent);
      return true;
    } catch (error) {
      dirty = true;
      if (!failed) console.error(`Could not save ${name}: ${error.message}. Still trying.`);
      return false;
    }
  }

  function setFailed(next) {
    if (next === failed) return;
    failed = next;
    onFailedChange();
  }

  function retryLater() {
    clearTimeout(timer);
    timer = closed ? null : setTimeout(flush, retryMs);
  }

  // Stops at the first failure. `dirty` is back on by then, so looping would spin on a bad disk.
  async function drain() {
    let saved = true;
    while (dirty && saved) {
      saved = await writeLatest();
      setFailed(!saved);
    }
    if (!saved) retryLater();
    writing = null;
    return saved;
  }

  // Tries now, and resolves with whether everything saved so far is on disk.
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (dirty) writing ??= drain();
    return writing ?? Promise.resolve(true);
  }

  // Call before anything can replace a file that exists but was rejected.
  async function keepDamaged() {
    try {
      const copy = await copyAside(file);
      console.warn(`Kept a copy of ${name} as ${path.basename(copy)}`);
    } catch (error) {
      console.error(`Could not keep a copy of ${name}: ${error.message}`);
    }
  }

  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        console.warn(`Ignoring unreadable ${name}: ${error.message}`);
        await keepDamaged();
        return undefined;
      }
    },
    // A burst of saves becomes one write of the newest value. The timer is not pushed back by
    // later saves, so a long drag still reaches the disk while it is happening.
    save(value) {
      latest = value;
      dirty = true;
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    keepDamaged,
    // True while the newest value could not be written, until a retry gets it onto the disk.
    get failed() {
      return failed;
    },
    onFailedChange(listener) {
      onFailedChange = listener;
    },
    // The last write. If it fails nothing retries, so no timer outlives the server.
    close() {
      closed = true;
      return flush();
    },
  };
}
