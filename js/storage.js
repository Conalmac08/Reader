/*
 * Blink Reader: the library.
 * Books are kept in IndexedDB in this browser, which also makes them work
 * offline. When sync is available (a signed-in Supabase account, or the
 * claude.ai artifact database) the library is mirrored there too, so it
 * follows the reader to other devices.
 */
const BlinkStore = (() => {
  const DB_NAME = 'blink-reader';
  const PROGRESS_FIELDS = ['position', 'openedAt', 'updatedAt', 'timeSpentMs', 'wordsRead', 'finishedAt'];

  /* ---------- IndexedDB, with an in-memory fallback ---------- */

  const memory = { books: new Map(), texts: new Map() };
  let persistent = true;
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      const current = new Promise((resolve, reject) => {
        let req;
        try {
          req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
        };
        req.onsuccess = () => {
          const db = req.result;
          // Safari can drop the connection while the page is in the
          // background (for example while the file picker is open).
          db.onclose = () => { if (dbPromise === current) dbPromise = null; };
          db.onversionchange = () => { db.close(); if (dbPromise === current) dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      }).catch((e) => {
        persistent = false;
        console.warn('Blink: IndexedDB unavailable, keeping books in memory only.', e);
        return null;
      });
      dbPromise = current;
    }
    return dbPromise;
  }

  const LOST_CONNECTION = /^(InvalidStateError|UnknownError|TransactionInactiveError|AbortError)$/;

  async function run(store, mode, fn, retry = true) {
    const db = await openDb();
    if (!db) return fn(null, memory[store]);
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        let result;
        const req = fn(os, null);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
      });
    } catch (e) {
      // Reconnect once if the browser closed the database under us.
      if (retry && e && LOST_CONNECTION.test(e.name)) {
        try { db.close(); } catch { /* already closed */ }
        dbPromise = null;
        return run(store, mode, fn, false);
      }
      throw e;
    }
  }

  const getAll = (store) => run(store, 'readonly', (os, mem) => (os ? os.getAll() : [...mem.values()]));
  const get = (store, id) => run(store, 'readonly', (os, mem) => (os ? os.get(id) : mem.get(id)));
  const put = (store, value) => run(store, 'readwrite', (os, mem) => (os ? os.put(value) : void mem.set(value.id, value)));
  const del = (store, id) => run(store, 'readwrite', (os, mem) => (os ? os.delete(id) : void mem.delete(id)));

  /* ---------- Sync (see cloud.js for where it syncs to) ---------- */

  const remote = { a: null, status: 'local', message: '', queue: new Map(), timers: new Map() };
  let listeners = [];
  const emit = () => listeners.forEach((fn) => fn());

  // One remote write at a time per book.
  function serial(key, task) {
    const prev = remote.queue.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    remote.queue.set(key, next);
    next.finally(() => { if (remote.queue.get(key) === next) remote.queue.delete(key); }).catch(() => {});
    return next;
  }

  const transient = (e) => e && (
    e.code === 'unavailable' || e.code === 'resource_exhausted'
    || e.name === 'TypeError' || /fetch|network/i.test(e.message || '') || Number(e.status) >= 500
  );
  async function retrying(task) {
    try {
      return await task();
    } catch (e) {
      if (!transient(e)) throw e;
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
      return task();
    }
  }

  function failed(e) {
    if (e && e.code === 'quota_exceeded') {
      remote.message = 'Your synced library is full. New books stay on this device.';
    } else if (e && (e.code === 'revoked' || e.code === 'not_granted' || e.code === 'capability_disabled')) {
      remote.a = null;
      remote.status = 'local';
    } else if (transient(e)) {
      remote.message = 'Couldn’t reach your synced library. Changes are saved here and will sync later.';
    } else {
      remote.message = 'Sync ran into a problem. Your books are still saved on this device.';
    }
    console.warn('Blink: sync problem', e);
    emit();
  }

  // The fields that travel to the server.
  function shareable(book) {
    const { textLocal, synced, syncedTo, chunks, ...rest } = book;
    return rest;
  }

  const isSynced = (book) => !!(remote.a && book && book.syncedTo === remote.a.key);

  async function upload(book, text) {
    const a = remote.a;
    if (!a || book.source === 'sample') return;
    try {
      const res = await serial(book.id, () => retrying(() => a.upload(shareable(book), text)));
      const local = await get('books', book.id);
      if (local && remote.a === a) await put('books', { ...local, syncedTo: a.key, chunks: res && res.chunks });
      emit();
    } catch (e) {
      failed(e);
    }
  }

  function pushProgress(book) {
    const a = remote.a;
    if (!isSynced(book) || book.source === 'sample') return Promise.resolve();
    const patch = {};
    for (const k of PROGRESS_FIELDS) if (book[k] !== undefined) patch[k] = book[k];
    return serial(book.id, () => retrying(() => a.push(book.id, patch))).catch(failed);
  }

  // Books that were only ever downloaded for another account can't be
  // opened any more, so they leave the shelf when that account isn't active.
  async function pruneOtherAccounts(key) {
    for (const b of await getAll('books')) {
      if (b.textLocal === false && b.syncedTo !== key) await del('books', b.id);
    }
  }

  // Merge the synced library with this browser's: newer progress wins,
  // deletions made elsewhere are applied, and local-only books are uploaded.
  let syncing = null;
  function sync() {
    if (!syncing) syncing = runSync().finally(() => { syncing = null; });
    return syncing;
  }

  async function runSync() {
    let a = null;
    try { a = await BlinkCloud.adapter(); } catch { a = null; }
    remote.a = a;
    remote.message = '';
    await pruneOtherAccounts(a ? a.key : null);
    if (!a) {
      remote.status = 'local';
      emit();
      return;
    }
    remote.status = 'syncing';
    emit();
    try {
      const list = await retrying(() => a.list());
      const local = await getAll('books');
      const localById = new Map(local.map((b) => [b.id, b]));
      const remoteIds = new Set();
      for (const r of list) {
        if (!r.id) continue;
        remoteIds.add(r.id);
        const l = localById.get(r.id);
        if (r.deleted) {
          if (l) { await del('books', r.id); await del('texts', r.id); }
          continue;
        }
        const { deleted, ...fields } = r;
        if (!l) {
          await put('books', { ...fields, textLocal: false, syncedTo: a.key });
        } else if ((r.updatedAt || 0) > (l.updatedAt || 0)) {
          const merged = { ...l, syncedTo: a.key, chunks: r.chunks ?? l.chunks };
          for (const k of PROGRESS_FIELDS) if (k in r) merged[k] = r[k];
          await put('books', merged);
        } else {
          const merged = { ...l, syncedTo: a.key, chunks: r.chunks ?? l.chunks };
          if (l.syncedTo !== a.key || merged.chunks !== l.chunks) await put('books', merged);
          if ((l.updatedAt || 0) > (r.updatedAt || 0)) pushProgress(merged);
        }
      }
      remote.status = 'synced';
      emit();
      for (const l of local) {
        if (l.source === 'sample' || remoteIds.has(l.id) || l.textLocal === false) continue;
        const rec = await get('texts', l.id);
        if (rec) await upload(l, rec.text);
      }
      emit();
    } catch (e) {
      remote.status = 'synced';
      failed(e);
    }
  }

  /* ---------- Public API ---------- */

  function newId() {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  async function listBooks() {
    const books = await getAll('books');
    return books.sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0));
  }

  async function addBook(fields, text) {
    const now = Date.now();
    const book = {
      id: fields.id || newId(),
      title: fields.title,
      author: fields.author || '',
      source: fields.source,
      fileName: fields.fileName || '',
      fileSize: fields.fileSize || 0,
      wordCount: fields.wordCount,
      pageStarts: fields.pageStarts || [],
      chapters: fields.chapters || [],
      position: 0,
      addedAt: now,
      openedAt: fields.openedAt || now,
      updatedAt: now,
      timeSpentMs: 0,
      wordsRead: 0,
    };
    await put('texts', { id: book.id, text });
    await put('books', book);
    upload(book, text);
    return book;
  }

  async function getText(book) {
    const rec = await get('texts', book.id);
    if (rec) return rec.text;
    if (syncing && book.textLocal === false) await syncing.catch(() => {});
    if (!isSynced(book)) return null;
    const a = remote.a;
    const text = await retrying(() => a.download(book));
    if (text != null) {
      await put('texts', { id: book.id, text });
      const local = await get('books', book.id);
      if (local) await put('books', { ...local, textLocal: true });
    }
    return text;
  }

  // Saves reading progress locally right away and to the cloud at most
  // every 20 seconds (or immediately with {flush: true}).
  async function saveProgress(book, { flush = false } = {}) {
    const local = await get('books', book.id);
    const merged = { ...(local || book) };
    for (const k of PROGRESS_FIELDS) if (book[k] !== undefined) merged[k] = book[k];
    await put('books', merged);
    if (!isSynced(merged)) return;
    if (flush) {
      clearTimeout(remote.timers.get(book.id));
      remote.timers.delete(book.id);
      pushProgress(merged);
    } else if (!remote.timers.has(book.id)) {
      remote.timers.set(book.id, setTimeout(async () => {
        remote.timers.delete(book.id);
        const latest = await get('books', book.id);
        if (latest) pushProgress(latest);
      }, 20000));
    }
  }

  async function deleteBook(id) {
    const book = await get('books', id);
    await del('books', id);
    await del('texts', id);
    if (isSynced(book)) {
      const a = remote.a;
      try {
        await serial(id, () => retrying(() => a.remove(id, book)));
      } catch (e) {
        failed(e);
      }
    }
  }

  async function findDuplicate(fileName, fileSize) {
    const books = await getAll('books');
    return books.find((b) => b.fileName === fileName && b.fileSize === fileSize) || null;
  }

  function status() {
    return { persistent, cloud: remote.status, message: remote.message, account: BlinkCloud.account() };
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter((f) => f !== fn); };
  }

  return {
    ready: openDb, listBooks, addBook, getText, saveProgress, deleteBook,
    findDuplicate, get: (id) => get('books', id), sync, status, onChange,
  };
})();
