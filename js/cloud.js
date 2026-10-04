/*
 * Blink Reader: where the library syncs to.
 * - Supabase, when js/config.js has a project URL and key and the person is
 *   signed in. Works on any host, including GitHub Pages.
 * - The claude.ai artifact database, when the page runs as a Claude artifact.
 * Each returns an adapter with the same five calls, used by storage.js.
 */
const BlinkCloud = (() => {
  const cfg = window.BLINK_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);

  const PIECE_CHARS = 400000;
  let clientPromise = null;
  let session = null;
  let listeners = [];

  function chunk(text, size) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + size);
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
      out.push(text.slice(i, end));
      i = end;
    }
    return out;
  }

  /* ---------- Supabase ---------- */

  const COLUMNS = {
    id: 'id', title: 'title', author: 'author', source: 'source', fileName: 'file_name',
    fileSize: 'file_size', wordCount: 'word_count', pageStarts: 'page_starts', chapters: 'chapters',
    position: 'position', addedAt: 'added_at', openedAt: 'opened_at', updatedAt: 'updated_at',
    timeSpentMs: 'time_spent_ms', wordsRead: 'words_read', finishedAt: 'finished_at', deleted: 'deleted',
  };

  function toRow(fields) {
    const row = {};
    for (const [key, col] of Object.entries(COLUMNS)) {
      if (fields[key] !== undefined) row[col] = fields[key];
    }
    return row;
  }

  function fromRow(row) {
    const book = {};
    for (const [key, col] of Object.entries(COLUMNS)) {
      if (row[col] !== undefined && row[col] !== null) book[key] = row[col];
    }
    return book;
  }

  async function ok(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function client() {
    if (!configured) return Promise.resolve(null);
    if (!clientPromise) {
      clientPromise = (async () => {
        if (!window.supabase) await loadScript(new URL('lib/supabase/supabase.js', document.baseURI).href);
        const c = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        const { data } = await c.auth.getSession();
        session = data.session;
        c.auth.onAuthStateChange((event, next) => {
          const before = session && session.user.id;
          session = next;
          const after = next && next.user.id;
          // Run listeners outside this callback; Supabase warns against
          // calling back into the client from inside it.
          if (before !== after) setTimeout(() => listeners.forEach((fn) => fn(event)), 0);
        });
        return c;
      })();
      clientPromise.catch((e) => {
        console.warn('Blink: could not start Supabase', e);
        clientPromise = null;
      });
    }
    return clientPromise;
  }

  function supabaseAdapter(c, uid) {
    return {
      key: `supabase:${uid}`,
      async list() {
        const rows = await ok(c.from('books').select('*'));
        return rows.map(fromRow);
      },
      async upload(book, text) {
        const pieces = chunk(text, PIECE_CHARS);
        for (let n = 0; n < pieces.length; n++) {
          await ok(c.from('book_texts').upsert(
            { user_id: uid, book_id: book.id, n, text: pieces[n] },
            { onConflict: 'user_id,book_id,n' },
          ));
        }
        await ok(c.from('books').upsert(
          { ...toRow(book), user_id: uid, deleted: false },
          { onConflict: 'user_id,id' },
        ));
        return {};
      },
      async download(book) {
        const rows = await ok(c.from('book_texts').select('n,text').eq('user_id', uid).eq('book_id', book.id).order('n'));
        return rows.length ? rows.map((r) => r.text).join('') : null;
      },
      async push(id, patch) {
        await ok(c.from('books').update(toRow(patch)).eq('user_id', uid).eq('id', id));
      },
      async remove(id) {
        await ok(c.from('books').update({ deleted: true, updated_at: Date.now() }).eq('user_id', uid).eq('id', id));
        await ok(c.from('book_texts').delete().eq('user_id', uid).eq('book_id', id));
      },
    };
  }

  /* ---------- claude.ai artifact database ---------- */

  function claudeAdapter(col, uid) {
    // data/users/<uid>/book_<id> holds a book's details and progress; its
    // text lives in the subcollection book_<id>/text as numbered chunks.
    const metaDoc = (id) => col.doc(`book_${id}`);
    const textDoc = (id, n) => metaDoc(id).collection('text').doc(`c${n}`);
    return {
      key: `claude:${uid}`,
      async list() {
        const snap = await col.where('kind', '==', 'book').get();
        return snap.docs.map((d) => d.data()).filter((d) => d && d.id).map(({ kind, ...rest }) => rest);
      },
      async upload(book, text) {
        const parts = chunk(text, 60000);
        for (let n = 0; n < parts.length; n++) await textDoc(book.id, n).set({ n, text: parts[n] });
        await metaDoc(book.id).set({ ...book, kind: 'book', chunks: parts.length });
        return { chunks: parts.length };
      },
      async download(book) {
        const parts = [];
        for (let n = 0; n < (book.chunks || 0); n++) {
          const snap = await textDoc(book.id, n).get();
          const data = snap.exists ? snap.data() : null;
          if (!data || typeof data.text !== 'string') return null;
          parts.push(data.text);
        }
        return parts.length ? parts.join('') : null;
      },
      async push(id, patch) {
        await metaDoc(id).update(patch);
      },
      async remove(id, book) {
        await metaDoc(id).set({ kind: 'book', id, deleted: true, updatedAt: Date.now() });
        for (let n = 0; n < ((book && book.chunks) || 0); n++) await textDoc(id, n).delete();
      },
    };
  }

  async function claudeConnection() {
    const c = window.claude;
    if (!c || typeof c.use !== 'function') return null;
    try {
      const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
      if (!db || !user) return null;
      const uid = await user.id();
      return uid ? claudeAdapter(db.collection(`data/users/${uid}`), uid) : null;
    } catch (e) {
      console.warn('Blink: claude.ai sync unavailable', e);
      return null;
    }
  }

  /* ---------- Public ---------- */

  // The adapter to sync with right now, or null to stay on this device.
  async function adapter() {
    if (configured) {
      const c = await client().catch(() => null);
      return c && session ? supabaseAdapter(c, session.user.id) : null;
    }
    return claudeConnection();
  }

  const redirectTo = () => `${location.origin}${location.pathname}`;

  async function signIn(email, password) {
    const c = await client();
    await ok(c.auth.signInWithPassword({ email, password }));
  }

  // Resolves true when the account is ready, false when Supabase first
  // wants the email address confirmed.
  async function signUp(email, password) {
    const c = await client();
    const data = await ok(c.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } }));
    return !!data.session;
  }

  async function sendLink(email) {
    const c = await client();
    await ok(c.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } }));
  }

  async function signOut() {
    const c = await client();
    if (c) await c.auth.signOut();
  }

  function account() {
    return {
      configured,
      email: session && session.user ? session.user.email || 'your account' : null,
    };
  }

  function onAuthChange(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter((f) => f !== fn); };
  }

  return { configured, init: client, adapter, signIn, signUp, sendLink, signOut, account, onAuthChange };
})();
