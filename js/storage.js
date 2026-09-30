/*
 * Blink Reader: the library.
 * Books are kept in IndexedDB in this browser. When the page runs inside a
 * claude.ai artifact viewer that offers the `db` capability, the library is
 * also mirrored to the signed-in person's private storage there, so it
 * follows them to other devices.
 */
const BlinkStore = (() => {
  const DB_NAME = 'blink-reader';
  const CHUNK_CHARS = 60000;
  const PROGRESS_FIELDS = ['position', 'openedAt', 'updatedAt', 'timeSpentMs', 'wordsRead', 'finishedAt'];

  /* ---------- IndexedDB, with an in-memory fallback ---------- */

  const memory = { books: new Map(), texts: new Map() };
  let persistent = true;
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
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
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      }).catch((e) => {
        persistent = false;
        console.warn('Blink: IndexedDB unavailable, keeping books in memory only.', e);
        return null;
      });
    }
    return dbPromise;
  }

  async function run(store, mode, fn) {
    const db = await openDb();
    if (!db) return fn(null, memory[store]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      const req = fn(os, null);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const getAll = (store) => run(store, 'readonly', (os, mem) => (os ? os.getAll() : [...mem.values()]));
  const get = (store, id) => run(store, 'readonly', (os, mem) => (os ? os.get(id) : mem.get(id)));
  const put = (store, value) => run(store, 'readwrite', (os, mem) => (os ? os.put(value) : void mem.set(value.id, value)));
  const del = (store, id) => run(store, 'readwrite', (os, mem) => (os ? os.delete(id) : void mem.delete(id)));

  /* ---------- Cloud mirror (claude.ai artifact db) ---------- */

  const cloud = { col: null, status: 'local', message: '', queue: new Map(), timers: new Map() };
  let listeners = [];
  const emit = () => listeners.forEach((fn) => fn());

  // data/users/<uid>/book_<id> holds a book's details and progress; its
  // text lives in the subcollection book_<id>/text as numbered chunks.
  const metaDoc = (id) => cloud.col.doc(`book_${id}`);
  const textDoc = (id, n) => metaDoc(id).collection('text').doc(`c${n}`);

  // One write at a time per cloud document.
  function serial(key, task) {
    const prev = cloud.queue.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    cloud.queue.set(key, next);
    next.finally(() => { if (cloud.queue.get(key) === next) cloud.queue.delete(key); }).catch(() => {});
    return next;
  }

  async function retrying(task) {
    try {
      return await task();
    } catch (e) {
      if (e && (e.code === 'unavailable' || e.code === 'resource_exhausted')) {
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
        return task();
      }
      throw e;
    }
  }

  function cloudFailed(e) {
    if (e && e.code === 'quota_exceeded') {
      cloud.message = 'Your synced library is full. New books stay on this device.';
    } else if (e && (e.code === 'revoked' || e.code === 'not_granted' || e.code === 'capability_disabled')) {
      cloud.col = null;
      cloud.status = 'local';
    }
    console.warn('Blink: sync problem', e);
    emit();
  }

  function cloudMeta(book) {
    const { textLocal, synced, ...rest } = book;
    return { ...rest, kind: 'book' };
  }

  function chunk(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + CHUNK_CHARS);
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
      out.push(text.slice(i, end));
      i = end;
    }
    return out;
  }

  async function upload(book, text) {
    if (!cloud.col || book.source === 'sample') return;
    try {
      const parts = chunk(text);
      for (let n = 0; n < parts.length; n++) {
        await serial(`text_${book.id}_${n}`, () => retrying(() => textDoc(book.id, n).set({ n, text: parts[n] })));
      }
      await serial(`book_${book.id}`, () => retrying(() => metaDoc(book.id).set({ ...cloudMeta(book), chunks: parts.length })));
      const local = await get('books', book.id);
      if (local) await put('books', { ...local, synced: true, chunks: parts.length });
    } catch (e) {
      cloudFailed(e);
    }
  }

  async function download(book) {
    const parts = [];
    for (let n = 0; n < (book.chunks || 0); n++) {
      const snap = await retrying(() => textDoc(book.id, n).get());
      const data = snap.exists ? snap.data() : null;
      if (!data || typeof data.text !== 'string') return null;
      parts.push(data.text);
    }
    return parts.join('');
  }

  function pushProgress(book) {
    if (!cloud.col || book.source === 'sample' || !book.synced) return Promise.resolve();
    const patch = {};
    for (const k of PROGRESS_FIELDS) if (book[k] !== undefined) patch[k] = book[k];
    return serial(`book_${book.id}`, () => retrying(() => metaDoc(book.id).update(patch))).catch(cloudFailed);
  }

  async function connectCloud() {
    const c = window.claude;
    if (!c || typeof c.use !== 'function') return false;
    try {
      const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
      if (!db || !user) return false;
      const uid = await user.id();
      if (!uid) return false;
      cloud.col = db.collection(`data/users/${uid}`);
      cloud.status = 'syncing';
      emit();
      return true;
    } catch (e) {
      console.warn('Blink: sync unavailable', e);
      return false;
    }
  }

  // Merge the cloud library with this browser's: newer progress wins,
  // deletions made elsewhere are applied, and local-only books are uploaded.
  async function sync() {
    if (!(await connectCloud())) return;
    try {
      const snap = await retrying(() => cloud.col.where('kind', '==', 'book').get());
      const remote = new Map();
      for (const d of snap.docs) {
        const data = d.data();
        if (data && data.id) remote.set(data.id, data);
      }
      const local = await getAll('books');
      const localById = new Map(local.map((b) => [b.id, b]));
      for (const [id, r] of remote) {
        const l = localById.get(id);
        if (r.deleted) {
          if (l) { await del('books', id); await del('texts', id); }
          continue;
        }
        const { kind, ...fields } = r;
        if (!l) {
          await put('books', { ...fields, textLocal: false, synced: true });
        } else if ((r.updatedAt || 0) > (l.updatedAt || 0)) {
          const merged = { ...l, synced: true, chunks: r.chunks };
          for (const k of PROGRESS_FIELDS) if (r[k] !== undefined) merged[k] = r[k];
          await put('books', merged);
        } else {
          if (!l.synced) await put('books', { ...l, synced: true, chunks: r.chunks });
          if ((l.updatedAt || 0) > (r.updatedAt || 0)) pushProgress({ ...l, synced: true });
        }
      }
      cloud.status = 'synced';
      emit();
      for (const l of local) {
        if (l.source === 'sample' || remote.has(l.id) || l.textLocal === false) continue;
        const rec = await get('texts', l.id);
        if (rec) await upload(l, rec.text);
      }
      emit();
    } catch (e) {
      cloud.status = cloud.col ? 'synced' : 'local';
      cloudFailed(e);
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
    upload(book, text).then(emit);
    return book;
  }

  async function getText(book) {
    const rec = await get('texts', book.id);
    if (rec) return rec.text;
    if (!cloud.col || !book.chunks) return null;
    const text = await download(book);
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
    if (!cloud.col || !merged.synced) return;
    if (flush) {
      clearTimeout(cloud.timers.get(book.id));
      cloud.timers.delete(book.id);
      pushProgress(merged);
    } else if (!cloud.timers.has(book.id)) {
      cloud.timers.set(book.id, setTimeout(async () => {
        cloud.timers.delete(book.id);
        const latest = await get('books', book.id);
        if (latest) pushProgress(latest);
      }, 20000));
    }
  }

  async function deleteBook(id) {
    const book = await get('books', id);
    await del('books', id);
    await del('texts', id);
    if (cloud.col && book && book.synced) {
      try {
        await serial(`book_${id}`, () => retrying(() => metaDoc(id).set({ kind: 'book', id, deleted: true, updatedAt: Date.now() })));
        for (let n = 0; n < (book.chunks || 0); n++) {
          await serial(`text_${id}_${n}`, () => retrying(() => textDoc(id, n).delete()));
        }
      } catch (e) {
        cloudFailed(e);
      }
    }
  }

  async function findDuplicate(fileName, fileSize) {
    const books = await getAll('books');
    return books.find((b) => b.fileName === fileName && b.fileSize === fileSize) || null;
  }

  function status() {
    return { persistent, cloud: cloud.status, message: cloud.message };
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
