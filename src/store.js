// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// time of the last read attempt (a restart never reads sooner than the
// interval), the pause DriveBC asked for, and per zone the ids of the events
// already seen (the scene trigger fires for new ones only) with a salted
// fingerprint of the zone (a moved zone starts a new baseline). A small JSON
// file written through a temporary file and a rename, one save after the
// other.
//
// A file that exists but cannot be read is not an empty one: it is never
// overwritten (the app runs from memory and says so in its status).
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { STATE_FILE } from './constants.js';

const MAX_STATE_BYTES = 1024 * 1024;

export function createFileStore(file = STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    /** `{ status: 'ok' | 'absent' | 'unreadable', data }`. */
    load() {
      let size;
      try {
        size = statSync(file).size;
      } catch (err) {
        return err?.code === 'ENOENT'
          ? { status: 'absent', data: {} }
          : { status: 'unreadable', data: {} };
      }
      try {
        if (size > MAX_STATE_BYTES) return { status: 'unreadable', data: {} };
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return { status: 'unreadable', data: {} };
        }
        return { status: 'ok', data };
      } catch {
        return { status: 'unreadable', data: {} };
      }
    },
    save(data) {
      const snapshot = JSON.parse(JSON.stringify(data));
      const job = queue.then(
        () => write(snapshot),
        () => write(snapshot),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `status` forces what `load` says. */
export function createMemoryStore(initial, { status } = {}) {
  let data = initial === undefined ? undefined : structuredClone(initial);
  return {
    saves: 0,
    load() {
      if (status) return { status, data: {} };
      return data === undefined
        ? { status: 'absent', data: {} }
        : { status: 'ok', data: structuredClone(data) };
    },
    async save(next) {
      this.saves += 1;
      if (this.failSave) throw new Error('disk full');
      if (this.hold) await this.hold;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
