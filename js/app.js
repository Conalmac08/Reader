/*
 * Blink Reader: the app. Library view, reader view and the word clock.
 */
(() => {
  const { tokenize, pauseFactor, pauseFactors, focusIndex, SAMPLE, PARA, SENT } = BlinkText;
  const $ = (id) => document.getElementById(id);

  const ANCHOR = 0.4; // keep in step with --anchor in styles.css
  const RAMP_WORDS = 10;
  const WPM_MIN = 50;
  const WPM_MAX = 1500;
  const WPM_STEP = 25;
  const PACING_AVG = 1.2; // rough average slowdown from smart pacing, for estimates

  /* ---------- Settings (per device) ---------- */

  const DEFAULTS = {
    wpm: 300, chunk: 1, pacing: true, ramp: true, focal: true, guides: true,
    context: true, font: 'serif', size: 100, theme: 'auto',
  };
  const SETTINGS_KEY = 'blink.settings';
  const SEEDED_KEY = 'blink.sampleSeeded';

  const settings = (() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  })();
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* not saved */ }
  }

  /* ---------- Elements ---------- */

  const el = {
    library: $('libraryView'), reader: $('readerView'),
    shelf: $('shelf'), shelfCount: $('shelfCount'), shelfEmpty: $('shelfEmpty'),
    dropzone: $('dropzone'), fileInput: $('fileInput'), imports: $('imports'),
    syncState: $('syncState'), syncText: $('syncText'),
    bookTitle: $('bookTitle'), bookWhere: $('bookWhere'),
    stageMain: $('stageMain'), stageNote: $('stageNote'), context: $('context'),
    scrubber: $('scrubber'), scrubTicks: $('scrubTicks'), posLabel: $('posLabel'), timeLeft: $('timeLeft'),
    session: $('sessionLabel'), playBtn: $('playBtn'),
    wpmDisplay: $('wpmDisplay'), wpmDigits: $('wpmDigits'), wpmInput: $('wpmInput'),
    scrim: $('scrim'), settingsSheet: $('settingsSheet'), contentsSheet: $('contentsSheet'), accountSheet: $('accountSheet'),
    chapterList: $('chapterList'), chaptersEmpty: $('chaptersEmpty'),
    searchForm: $('searchForm'), searchInput: $('searchInput'), searchResults: $('searchResults'),
    gotoForm: $('gotoForm'), gotoPage: $('gotoPage'), gotoOf: $('gotoOf'),
    toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
  };

  function wordEls(container) {
    const word = container.querySelector('.word');
    return {
      box: container,
      word,
      left: word.querySelector('.w-left'),
      focal: word.querySelector('.w-focal'),
      right: word.querySelector('.w-right'),
    };
  }
  const stageWord = wordEls(el.stageMain);
  const demoWord = wordEls(document.querySelector('.demo-rsvp'));

  /* ---------- Formatting ---------- */

  const nf = new Intl.NumberFormat();
  const fmt = (n) => nf.format(n);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function formatDuration(ms) {
    const min = Math.round(ms / 60000);
    if (ms < 45000) return '<1 min';
    if (min < 60) return `${Math.max(1, min)} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function formatClock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function relativeDay(ts) {
    if (!ts) return '';
    const day = 86400000;
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    if (ts >= startOfToday) return 'today';
    if (ts >= startOfToday - day) return 'yesterday';
    const days = Math.ceil((startOfToday - ts) / day);
    if (days < 7) return `${days} days ago`;
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
  }

  // Book-cloth colours for the generated covers.
  const COVER_HUES = [222, 352, 152, 36, 288, 186, 14, 96];
  function hue(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 9973;
    return COVER_HUES[h % COVER_HUES.length];
  }

  /* ---------- Word rendering ---------- */

  function renderWord(w, text) {
    const chars = Array.from(text);
    const f = focusIndex(chars);
    w.left.textContent = chars.slice(0, f).join('');
    w.focal.textContent = chars[f] || '';
    w.right.textContent = chars.slice(f + 1).join('');
    fitWord(w);
  }

  // Shrinks a long word just enough to stay inside the stage.
  function fitWord(w) {
    w.word.style.setProperty('--fit', '1');
    const width = w.box.clientWidth;
    if (!width) return;
    const anchorX = width * ANCHOR;
    const pad = Math.min(24, width * 0.04);
    const half = w.focal.offsetWidth / 2;
    const leftNeed = w.left.offsetWidth + half;
    const rightNeed = w.right.offsetWidth + half;
    const scale = Math.min(
      1,
      leftNeed ? (anchorX - pad) / leftNeed : 1,
      rightNeed ? (width - anchorX - pad) / rightNeed : 1,
    );
    if (scale < 1) w.word.style.setProperty('--fit', Math.max(0.3, scale * 0.98).toFixed(3));
  }

  /* ---------- Toast ---------- */

  let toastTimer = 0;
  let toastHandler = null;
  function toast(text, action) {
    el.toastText.textContent = text;
    toastHandler = action ? action.run : null;
    el.toastAction.hidden = !action;
    if (action) el.toastAction.textContent = action.label;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, action ? 6000 : 3200);
  }
  el.toastAction.addEventListener('click', () => {
    el.toast.hidden = true;
    if (toastHandler) toastHandler();
  });

  /* ---------- Themes and reader preferences ---------- */

  function applyPrefs() {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-reader-theme');
    else root.setAttribute('data-reader-theme', settings.theme);
    el.reader.dataset.font = settings.font;
    el.reader.style.setProperty('--size', String(settings.size / 100));
    el.reader.classList.toggle('no-focal', !settings.focal);
    el.reader.classList.toggle('no-guides', !settings.guides);
    document.querySelectorAll('.segmented[data-setting]').forEach((group) => {
      const key = group.dataset.setting;
      group.querySelectorAll('button').forEach((b) => {
        b.setAttribute('aria-pressed', String(String(settings[key]) === b.dataset.value));
      });
    });
    document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((box) => {
      box.checked = !!settings[box.dataset.setting];
    });
    $('optSize').value = settings.size;
    $('sizeOut').textContent = `${settings.size}%`;
    document.querySelectorAll('#wpmPresets button').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.wpm) === settings.wpm));
    });
  }

  /* ---------- Speed ---------- */

  let shownWpm = '';
  function renderWpm() {
    const next = String(settings.wpm);
    const up = Number(next) >= Number(shownWpm || 0);
    const prev = shownWpm.padStart(next.length, ' ');
    const frag = document.createDocumentFragment();
    Array.from(next).forEach((d, i) => {
      const span = document.createElement('span');
      span.textContent = d;
      if (shownWpm && prev[i] !== d) span.className = up ? 'roll-up' : 'roll-down';
      frag.appendChild(span);
    });
    el.wpmDigits.replaceChildren(frag);
    el.wpmDisplay.setAttribute('aria-label', `${next} words per minute. Select to type a speed.`);
    shownWpm = next;
  }

  function setWpm(value) {
    const v = clamp(Math.round(Number(value) || settings.wpm), WPM_MIN, WPM_MAX);
    if (v === settings.wpm) return;
    settings.wpm = v;
    saveSettings();
    renderWpm();
    applyPrefs();
    if (R.book) updateProgress();
  }
  const faster = () => setWpm(Math.floor(settings.wpm / WPM_STEP) * WPM_STEP + WPM_STEP);
  const slower = () => setWpm(Math.ceil(settings.wpm / WPM_STEP) * WPM_STEP - WPM_STEP);

  // Press and hold to keep changing; keyboard activation still works via click.
  function holdToRepeat(btn, fn) {
    let delay = 0;
    let repeat = 0;
    let pressedAt = -Infinity;
    const stop = () => { clearTimeout(delay); clearInterval(repeat); };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pressedAt = performance.now();
      fn();
      delay = setTimeout(() => { repeat = setInterval(fn, 70); }, 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (performance.now() - pressedAt < 1500) return;
      fn();
    });
  }

  function startWpmEdit() {
    el.wpmDisplay.hidden = true;
    el.wpmInput.hidden = false;
    el.wpmInput.value = settings.wpm;
    el.wpmInput.focus();
    el.wpmInput.select();
  }
  function endWpmEdit(commit) {
    if (el.wpmInput.hidden) return;
    if (commit) setWpm(el.wpmInput.value.replace(/\D/g, ''));
    el.wpmInput.hidden = true;
    el.wpmDisplay.hidden = false;
  }

  /* ---------- Reader state ---------- */

  const R = {
    book: null,
    words: [],
    flags: new Uint8Array(0),
    factors: new Float32Array(0),
    prefix: new Float64Array(1),
    index: 0,
    frameEnd: 0,
    playing: false,
    finished: false,
    timer: 0,
    due: 0,
    ramp: 0,
    clock: 0,
    lastSave: 0,
    sessionWords: 0,
    sessionMs: 0,
    wakeLock: null,
    resumeAfterScrub: false,
    lastWhere: '',
  };

  function frameEndAt(i) {
    let end = i + 1;
    while (end < R.words.length && end - i < settings.chunk && !(R.flags[end - 1] & (PARA | SENT))) end++;
    return end;
  }

  function frameDuration(start, end) {
    const base = 60000 / settings.wpm;
    let units = 0;
    for (let k = start; k < end; k++) units += settings.pacing ? R.factors[k] : 1;
    let ms = units * base;
    if (R.ramp > 0) {
      ms *= 1 + 0.9 * (R.ramp / RAMP_WORDS);
      R.ramp = Math.max(0, R.ramp - (end - start));
    }
    return ms;
  }

  function msLeft(from) {
    const n = R.words.length;
    const base = 60000 / settings.wpm;
    return base * (settings.pacing ? R.prefix[n] - R.prefix[from] : n - from);
  }

  function showCurrent() {
    const end = frameEndAt(R.index);
    renderWord(stageWord, R.words.slice(R.index, end).join(' '));
    return end;
  }

  /* ---------- Playback ---------- */

  function play() {
    if (!R.book || R.playing) return;
    if (R.finished) {
      R.index = 0;
      R.finished = false;
    }
    endWpmEdit(true);
    R.playing = true;
    R.ramp = settings.ramp ? RAMP_WORDS : 0;
    R.clock = performance.now();
    R.due = R.clock;
    el.reader.classList.add('is-playing');
    el.playBtn.setAttribute('aria-label', 'Pause');
    el.context.hidden = true;
    requestWakeLock();
    pokeChrome();
    tick();
  }

  function tick() {
    if (!R.playing) return;
    const start = R.index;
    R.frameEnd = showCurrent();
    const now = performance.now();
    if (now - R.due > 250) R.due = now; // we fell behind (tab throttled); don't sprint to catch up
    R.due += frameDuration(start, R.frameEnd);
    R.timer = setTimeout(advance, Math.max(0, R.due - performance.now()));
  }

  function advance() {
    if (!R.playing) return;
    const moved = R.frameEnd - R.index;
    R.sessionWords += moved;
    R.book.wordsRead = (R.book.wordsRead || 0) + moved;
    if (R.frameEnd >= R.words.length) {
      finishBook();
      return;
    }
    R.index = R.frameEnd;
    updateProgress();
    if (performance.now() - R.lastSave > 5000) persist();
    tick();
  }

  function stopClock() {
    clearTimeout(R.timer);
    const now = performance.now();
    const spent = now - R.clock;
    R.sessionMs += spent;
    R.book.timeSpentMs = (R.book.timeSpentMs || 0) + spent;
    R.clock = now;
  }

  function pause() {
    if (!R.playing) return;
    stopClock();
    R.playing = false;
    el.reader.classList.remove('is-playing');
    el.playBtn.setAttribute('aria-label', 'Play');
    releaseWakeLock();
    showChrome();
    setNote();
    renderContext();
    updateProgress();
    persist({ flush: true });
  }

  const toggle = () => (R.playing ? pause() : play());

  function finishBook() {
    stopClock();
    R.playing = false;
    R.finished = true;
    R.index = R.words.length - 1;
    R.book.finishedAt = Date.now();
    el.reader.classList.remove('is-playing');
    el.playBtn.setAttribute('aria-label', 'Play');
    releaseWakeLock();
    showChrome();
    updateProgress();
    setNote();
    renderContext();
    persist({ flush: true });
  }

  function seek(i) {
    if (!R.book) return;
    R.index = clamp(i, 0, R.words.length - 1);
    R.finished = false;
    if (R.playing) {
      clearTimeout(R.timer);
      R.due = performance.now();
      R.ramp = settings.ramp ? 4 : 0;
      tick();
    } else {
      showCurrent();
      renderContext();
      setNote();
    }
    updateProgress();
    persistSoon();
  }

  function sentenceStart(i) {
    let k = i;
    while (k > 0 && !(R.flags[k - 1] & (SENT | PARA))) k--;
    return k;
  }
  function prevSentence() {
    let s = sentenceStart(R.index);
    if (R.index - s < 2 && s > 0) s = sentenceStart(s - 1);
    seek(s);
  }
  function nextSentence() {
    let k = R.index;
    while (k < R.words.length - 1 && !(R.flags[k] & (SENT | PARA))) k++;
    seek(k + 1);
  }
  const nextWord = () => seek(frameEndAt(R.index));
  const prevWord = () => seek(R.index - settings.chunk);

  /* ---------- Saving ---------- */

  let persistTimer = 0;
  function persist(opts) {
    if (!R.book) return;
    clearTimeout(persistTimer);
    if (R.playing) {
      const now = performance.now();
      R.book.timeSpentMs = (R.book.timeSpentMs || 0) + (now - R.clock);
      R.sessionMs += now - R.clock;
      R.clock = now;
    }
    R.lastSave = performance.now();
    R.book.position = R.index;
    R.book.updatedAt = Date.now();
    return BlinkStore.saveProgress({ ...R.book }, opts).catch((e) => console.warn('Blink: could not save progress', e));
  }
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 700);
  }

  /* ---------- Screen wake lock ---------- */

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock && !R.wakeLock) {
        R.wakeLock = await navigator.wakeLock.request('screen');
        R.wakeLock.addEventListener?.('release', () => { R.wakeLock = null; });
      }
    } catch {
      R.wakeLock = null;
    }
  }
  function releaseWakeLock() {
    try { R.wakeLock?.release(); } catch { /* already released */ }
    R.wakeLock = null;
  }

  /* ---------- Focus mode: hide controls while reading ---------- */

  let chromeTimer = 0;
  function showChrome() {
    clearTimeout(chromeTimer);
    el.reader.classList.remove('chrome-hidden');
  }
  function pokeChrome() {
    showChrome();
    if (R.playing && !isSheetOpen()) {
      chromeTimer = setTimeout(() => {
        if (R.playing && !isSheetOpen()) el.reader.classList.add('chrome-hidden');
      }, 2200);
    }
  }

  /* ---------- Progress, location, context ---------- */

  function findLast(arr, value, key) {
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = key ? arr[mid][key] : arr[mid];
      if (v <= value) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function currentChapter() {
    const chapters = R.book.chapters || [];
    return findLast(chapters, R.index, 'word');
  }

  function updateProgress() {
    const n = R.words.length;
    const i = R.index;
    const pct = n > 1 ? (i / (n - 1)) * 100 : 100;
    el.scrubber.value = i;
    el.scrubber.style.setProperty('--pct', `${pct}%`);
    el.posLabel.textContent = `${Math.floor(pct)}% · word ${fmt(i + 1)} of ${fmt(n)}`;
    el.timeLeft.textContent = R.finished ? 'Finished' : `${formatDuration(msLeft(i))} left at ${settings.wpm} wpm`;

    const parts = [];
    const ch = currentChapter();
    if (ch >= 0) parts.push(R.book.chapters[ch].title);
    const pages = R.book.pageStarts || [];
    if (pages.length > 1) parts.push(`Page ${findLast(pages, i) + 1} of ${pages.length}`);
    const where = parts.join(' · ');
    if (where !== R.lastWhere) {
      el.bookWhere.textContent = where;
      R.lastWhere = where;
      markChapter(ch);
    }
    const minutes = R.sessionMs + (R.playing ? performance.now() - R.clock : 0);
    el.session.textContent = R.sessionWords
      ? `This session: ${fmt(R.sessionWords)} words · ${formatClock(minutes)}`
      : '';
  }

  function setNote() {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (R.finished) {
      el.stageNote.textContent = `You finished the book. ${touch ? 'Tap' : 'Press play'} to read it again.`;
    } else {
      el.stageNote.textContent = touch ? 'Tap the word to play or pause' : 'Press space or click the word to play or pause';
    }
  }

  function renderContext() {
    if (!R.book || R.playing || !settings.context) {
      el.context.hidden = true;
      return;
    }
    const n = R.words.length;
    const i = R.index;
    const end = frameEndAt(i);
    let from = i;
    let back = 0;
    while (from > 0 && back < 140 && (back < 45 || !(R.flags[from - 1] & PARA))) { from--; back++; }
    let to = end;
    let fwd = 0;
    while (to < n && fwd < 220 && (fwd < 90 || !(R.flags[to - 1] & PARA))) { to++; fwd++; }

    const frag = document.createElement('div');
    frag.className = 'context-inner';
    const hint = document.createElement('p');
    hint.className = 'context-hint';
    hint.textContent = matchMedia('(pointer: coarse)').matches ? 'Tap any word to jump there' : 'Click any word to jump there';
    frag.appendChild(hint);
    let p = document.createElement('p');
    if (from > 0 && !(R.flags[from - 1] & PARA)) p.append('… ');
    let current = null;
    for (let k = from; k < to; k++) {
      const span = document.createElement('span');
      span.className = 'cw';
      span.dataset.i = k;
      span.textContent = R.words[k];
      if (k >= i && k < end) {
        span.classList.add('is-current');
        current = current || span;
      }
      p.appendChild(span);
      if (R.flags[k] & PARA) {
        frag.appendChild(p);
        p = document.createElement('p');
      } else {
        p.append(' ');
      }
    }
    if (to < n && !(R.flags[to - 1] & PARA)) p.append('…');
    if (p.childNodes.length) frag.appendChild(p);
    el.context.replaceChildren(frag);
    el.context.hidden = false;
    if (current) {
      el.context.scrollTop = Math.max(0, current.offsetTop - el.context.clientHeight / 2 + current.offsetHeight / 2);
    }
  }

  function renderTicks() {
    const n = R.words.length;
    const frag = document.createDocumentFragment();
    if (n > 1) {
      for (const c of R.book.chapters || []) {
        if (c.depth > 0 || c.word <= 0) continue;
        const t = document.createElement('span');
        t.style.left = `${(c.word / (n - 1)) * 100}%`;
        frag.appendChild(t);
      }
    }
    el.scrubTicks.replaceChildren(frag);
  }

  /* ---------- Contents sheet ---------- */

  function renderChapters() {
    const chapters = R.book.chapters || [];
    const n = R.words.length;
    el.chaptersEmpty.hidden = chapters.length > 0;
    el.chapterList.replaceChildren(...chapters.map((c, idx) => {
      const li = document.createElement('li');
      li.className = `depth-${Math.min(2, c.depth || 0)}`;
      li.dataset.idx = idx;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.word = c.word;
      const title = document.createElement('span');
      title.textContent = c.title;
      const pct = document.createElement('span');
      pct.className = 'ch-pct';
      pct.textContent = `${Math.floor((c.word / Math.max(1, n - 1)) * 100)}%`;
      b.append(title, pct);
      li.appendChild(b);
      return li;
    }));
    const pages = R.book.pageStarts || [];
    el.gotoForm.hidden = pages.length < 2;
    el.gotoPage.max = pages.length;
    el.gotoOf.textContent = `of ${pages.length}`;
    el.searchResults.replaceChildren();
    el.searchInput.value = '';
  }

  function markChapter(idx) {
    el.chapterList.querySelectorAll('.is-current').forEach((li) => li.classList.remove('is-current'));
    const li = el.chapterList.querySelector(`li[data-idx="${idx}"]`);
    if (li) li.classList.add('is-current');
  }

  const normalize = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

  function search(query) {
    const q = query.split(/\s+/).map(normalize).filter(Boolean);
    el.searchResults.replaceChildren();
    if (!q.length) return;
    if (!R.norm) R.norm = R.words.map(normalize);
    const norm = R.norm;
    const hits = [];
    for (let i = 0; i < norm.length && hits.length < 60; i++) {
      let ok = true;
      for (let j = 0; j < q.length; j++) {
        const w = norm[i + j];
        if (w === undefined) { ok = false; break; }
        const last = j === q.length - 1;
        if (last ? !w.startsWith(q[j]) : w !== q[j]) { ok = false; break; }
      }
      if (ok) hits.push(i);
    }
    const note = document.createElement('p');
    note.className = 'results-note';
    note.textContent = hits.length
      ? `${hits.length >= 60 ? 'First 60' : hits.length} ${hits.length === 1 ? 'match' : 'matches'}`
      : `No matches for “${query.trim()}”`;
    el.searchResults.appendChild(note);
    const pages = R.book.pageStarts || [];
    for (const i of hits) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      b.dataset.word = i;
      const from = Math.max(0, i - 7);
      const to = Math.min(R.words.length, i + q.length + 9);
      b.append(`${from > 0 ? '… ' : ''}${R.words.slice(from, i).join(' ')} `);
      const mark = document.createElement('mark');
      mark.textContent = R.words.slice(i, i + q.length).join(' ');
      b.append(mark, ` ${R.words.slice(i + q.length, to).join(' ')}${to < R.words.length ? ' …' : ''}`);
      const where = document.createElement('small');
      const ch = findLast(R.book.chapters || [], i, 'word');
      where.textContent = [
        pages.length > 1 ? `Page ${findLast(pages, i) + 1}` : '',
        ch >= 0 ? R.book.chapters[ch].title : '',
        `${Math.floor((i / Math.max(1, R.words.length - 1)) * 100)}%`,
      ].filter(Boolean).join(' · ');
      b.appendChild(where);
      el.searchResults.appendChild(b);
    }
  }

  /* ---------- Sheets ---------- */

  let lastFocus = null;
  const sheets = () => [el.settingsSheet, el.contentsSheet, el.accountSheet];
  const isSheetOpen = () => sheets().some((sh) => !sh.hidden);

  function openSheet(sheet) {
    if (!R.book && sheet !== el.accountSheet) return;
    sheets().forEach((sh) => { if (sh !== sheet) sh.hidden = true; });
    if (R.playing) pause();
    lastFocus = document.activeElement;
    sheet.hidden = false;
    el.scrim.hidden = false;
    showChrome();
    let first = sheet === el.contentsSheet ? el.searchInput : sheet.querySelector('[data-close]');
    if (sheet === el.accountSheet) {
      renderAccount();
      if (!$('accountSignedOut').hidden) first = $('authEmail');
    }
    if (sheet === el.contentsSheet) {
      const cur = el.chapterList.querySelector('.is-current');
      if (cur) cur.scrollIntoView({ block: 'center' });
    }
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  }
  function closeSheets() {
    if (!isSheetOpen()) return false;
    const active = document.activeElement;
    const inside = active && sheets().some((sh) => sh.contains(active));
    sheets().forEach((sh) => { sh.hidden = true; });
    el.scrim.hidden = true;
    if (inside) active.blur();
    const back = lastFocus && lastFocus !== document.body && document.contains(lastFocus) ? lastFocus : (R.book ? el.stageMain : null);
    if (back) back.focus({ preventScroll: true });
    return true;
  }

  /* ---------- Opening and closing books ---------- */

  function prefixSums(factors) {
    const out = new Float64Array(factors.length + 1);
    for (let i = 0; i < factors.length; i++) out[i + 1] = out[i] + factors[i];
    return out;
  }

  let opening = false;
  async function openBook(id) {
    if (opening) return;
    opening = true;
    try {
      const book = await BlinkStore.get(id);
      if (!book) return;
      if (book.textLocal === false) toast(`Downloading “${book.title}” from your synced library…`);
      const text = await BlinkStore.getText(book);
      if (text == null) {
        toast('This book’s text isn’t on this device yet. Check your connection and try again.');
        return;
      }
      const { words, flags } = tokenize(text);
      if (!words.length) {
        toast('This book has no words to show.');
        return;
      }
      closeSheets();
      R.book = { ...book, wordCount: words.length, openedAt: Date.now() };
      R.words = words;
      R.norm = null;
      R.flags = flags;
      R.factors = pauseFactors(words, flags);
      R.prefix = prefixSums(R.factors);
      R.index = clamp(book.position || 0, 0, words.length - 1);
      R.finished = !!book.finishedAt && R.index >= words.length - 1;
      R.sessionWords = 0;
      R.sessionMs = 0;
      R.lastWhere = null;

      el.bookTitle.textContent = book.title;
      document.title = `${book.title} · Blink Reader`;
      el.scrubber.max = Math.max(0, words.length - 1);
      renderChapters();
      renderTicks();

      el.library.hidden = true;
      el.reader.hidden = false;
      document.body.classList.add('in-reader');
      stopDemo();
      showCurrent();
      setNote();
      updateProgress();
      renderContext();
      persist();
      if (!matchMedia('(pointer: coarse)').matches) el.stageMain.focus({ preventScroll: true });
    } catch (e) {
      console.error(e);
      toast('This book could not be opened.');
    } finally {
      opening = false;
    }
  }

  async function closeBook() {
    if (!R.book) return;
    pause();
    await persist({ flush: true });
    closeSheets();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    const id = R.book.id;
    R.book = null;
    R.words = [];
    el.reader.hidden = true;
    el.library.hidden = false;
    document.body.classList.remove('in-reader');
    document.title = 'Blink Reader';
    await renderLibrary();
    startDemo();
    const card = el.shelf.querySelector(`[data-id="${id}"] .book-open`);
    if (card) card.focus({ preventScroll: true });
  }

  /* ---------- Library ---------- */

  const KIND = { pdf: 'PDF', epub: 'EPUB', text: 'Text', sample: 'Guide' };

  function bookCard(book) {
    const li = document.createElement('li');
    li.className = 'book';
    li.dataset.id = book.id;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'book-open';
    open.dataset.action = 'open';

    const cover = document.createElement('span');
    cover.className = 'cover';
    cover.style.setProperty('--h', hue(book.title));
    const letter = document.createElement('span');
    letter.className = 'cover-letter';
    letter.textContent = (Array.from(book.title.replace(/^(the|a|an)\s+/i, '')).find((c) => /\p{L}|\p{N}/u.test(c)) || '·').toUpperCase();
    const kind = document.createElement('span');
    kind.className = 'cover-kind';
    kind.textContent = KIND[book.source] || 'Book';
    cover.append(letter, kind);

    const body = document.createElement('span');
    body.className = 'book-body';
    const title = document.createElement('span');
    title.className = 'book-title';
    title.textContent = book.title;
    if (book.source === 'sample') {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = 'Sample';
      title.appendChild(chip);
    }
    const sub = document.createElement('span');
    sub.className = 'book-sub';
    const pages = (book.pageStarts || []).length;
    const bits = [];
    if (book.author) bits.push(book.author);
    else if (pages > 1) bits.push(`${fmt(pages)} pages`);
    bits.push(`${fmt(book.wordCount)} words`);
    if (book.openedAt && book.source !== 'sample') bits.push(`opened ${relativeDay(book.openedAt)}`);
    sub.textContent = bits.join(' · ');

    const n = book.wordCount || 1;
    const done = book.finishedAt && (book.position || 0) >= n - 1;
    const pct = done ? 100 : Math.floor(((book.position || 0) / Math.max(1, n - 1)) * 100);
    const meter = document.createElement('span');
    meter.className = 'meter';
    const fill = document.createElement('span');
    fill.style.width = `${pct}%`;
    meter.appendChild(fill);
    const stats = document.createElement('span');
    stats.className = 'book-stats';
    const left = document.createElement('span');
    left.textContent = done ? 'Finished' : (book.position ? `${pct}% read` : 'Not started');
    const right = document.createElement('span');
    const remaining = ((n - (book.position || 0)) / settings.wpm) * 60000 * (settings.pacing ? PACING_AVG : 1);
    right.textContent = done ? '' : `${formatDuration(remaining)} left`;
    stats.append(left, right);

    body.append(title, sub, meter, stats);
    open.append(cover, body);
    open.setAttribute('aria-label', `${book.title}. ${left.textContent}. Open`);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn book-del';
    del.dataset.action = 'delete';
    del.setAttribute('aria-label', `Delete ${book.title}`);
    del.title = 'Delete from library';
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';

    li.append(open, del);
    return li;
  }

  let renderSeq = 0;
  async function renderLibrary() {
    const seq = ++renderSeq;
    const books = await BlinkStore.listBooks();
    if (seq !== renderSeq) return;
    el.shelf.replaceChildren(...books.map(bookCard));
    el.shelfCount.textContent = books.length ? (books.length === 1 ? '1 book' : `${books.length} books`) : '';
    el.shelfEmpty.hidden = books.length > 0;
    renderSyncState();
  }

  function renderSyncState() {
    const s = BlinkStore.status();
    const signedOut = s.account.configured && !s.account.email;
    let icon = 'i-device';
    let text = 'Saved in this browser';
    let warn = false;
    if (!s.persistent) {
      icon = 'i-alert';
      text = 'This browser is blocking storage, so books last only until you close the page';
      warn = true;
    } else if (s.message) {
      icon = 'i-alert';
      text = s.message;
      warn = true;
    } else if (s.cloud === 'syncing') {
      icon = 'i-cloud';
      text = 'Syncing your library…';
    } else if (s.cloud === 'synced') {
      icon = 'i-cloud';
      text = s.account.email ? `Synced as ${s.account.email}` : 'Synced to your account';
    }
    el.syncState.classList.toggle('is-warning', warn);
    el.syncState.querySelector('use').setAttribute('href', `#${icon}`);
    el.syncText.textContent = text;
    if (signedOut && !warn) {
      const cta = document.createElement('span');
      cta.className = 'sync-cta';
      cta.textContent = ' · Sign in to sync';
      el.syncText.appendChild(cta);
    }
    if (!el.accountSheet.hidden) renderAccount();
  }

  /* ---------- Account and sync ---------- */

  function renderAccount() {
    const s = BlinkStore.status();
    const { configured, email } = s.account;
    $('accountSignedOut').hidden = !configured || !!email;
    $('accountSignedIn').hidden = !configured || !email;
    $('accountOff').hidden = configured;
    if (email) {
      $('accountEmail').textContent = email;
      $('accountStatus').textContent = s.message
        || (s.cloud === 'syncing' ? 'Syncing your library…' : 'Your library is up to date on this device.');
    }
    if (!configured) {
      $('accountOffText').textContent = s.cloud === 'synced'
        ? 'Your library syncs through your Claude account automatically, so it is the same wherever you open this page.'
        : 'Sync isn’t switched on for this copy of Blink, so books are kept only in this browser. To turn it on, add a Supabase project’s URL and key to js/config.js (the README explains how).';
    }
  }

  function authMessage(text, isError) {
    const msg = $('authMsg');
    msg.textContent = text;
    msg.classList.toggle('is-error', !!isError);
    msg.hidden = !text;
  }

  function friendlyAuthError(e) {
    const m = (e && e.message) || '';
    if (/invalid login/i.test(m)) return 'That email and password don’t match an account. Check them, or create an account.';
    if (/not confirmed/i.test(m)) return 'Confirm your email first: open the link in the email we sent you, then sign in here.';
    if (/already (registered|exists)/i.test(m)) return 'There’s already an account with that email. Sign in instead.';
    if (/password.*(at least|short|characters)/i.test(m)) return 'Use a password with at least 6 characters.';
    if (/rate limit|too many|security purposes/i.test(m)) return 'Too many tries in a row. Wait a minute, then try again.';
    if (/fetch|network|load/i.test(m) || (e && e.name === 'TypeError')) return 'Couldn’t reach the sync service. Check your connection and try again.';
    return m || 'Something went wrong. Try again.';
  }

  async function authAction(button, needsPassword, run) {
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { authMessage('Enter your email address.', true); $('authEmail').focus(); return; }
    if (needsPassword && password.length < 6) { authMessage('Enter a password of at least 6 characters.', true); $('authPassword').focus(); return; }
    const buttons = el.accountSheet.querySelectorAll('.auth button');
    buttons.forEach((b) => { b.disabled = true; });
    authMessage('Working…');
    try {
      await run(email, password);
    } catch (e) {
      console.warn('Blink: sign-in problem', e);
      authMessage(friendlyAuthError(e), true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    authAction($('signInBtn'), true, async (email, password) => {
      await BlinkCloud.signIn(email, password);
      authMessage('');
      $('authPassword').value = '';
      closeSheets();
      toast('Signed in. Syncing your library…');
    });
  });
  $('signUpBtn').addEventListener('click', () => {
    authAction($('signUpBtn'), true, async (email, password) => {
      const ready = await BlinkCloud.signUp(email, password);
      if (ready) {
        authMessage('');
        $('authPassword').value = '';
        closeSheets();
        toast('Account created. Syncing your library…');
      } else {
        authMessage(`Almost done. We sent a confirmation link to ${email}. Open it, then come back and sign in.`);
      }
    });
  });
  $('linkBtn').addEventListener('click', () => {
    authAction($('linkBtn'), false, async (email) => {
      await BlinkCloud.sendLink(email);
      authMessage(`Check ${email} for a sign-in link. Opening it signs you in on that device.`);
    });
  });
  $('syncNowBtn').addEventListener('click', async () => {
    $('syncNowBtn').disabled = true;
    await syncNow();
    $('syncNowBtn').disabled = false;
  });
  $('signOutBtn').addEventListener('click', async () => {
    $('signOutBtn').disabled = true;
    try {
      await BlinkCloud.signOut();
      closeSheets();
      toast('Signed out. Books you read here stay on this device.');
    } catch (e) {
      toast('Couldn’t sign out. Check your connection and try again.');
    } finally {
      $('signOutBtn').disabled = false;
    }
  });
  el.syncState.addEventListener('click', () => openSheet(el.accountSheet));

  let lastSync = 0;
  async function syncNow() {
    lastSync = Date.now();
    await BlinkStore.sync();
    if (!R.book) await renderLibrary();
    else adoptRemoteProgress();
    renderSyncState();
  }

  // If this book was read further on another device, pick up from there.
  async function adoptRemoteProgress() {
    if (!R.book || R.playing) return;
    const id = R.book.id;
    const stored = await BlinkStore.get(id);
    if (!stored || !R.book || R.book.id !== id || R.playing) return;
    if ((stored.updatedAt || 0) > (R.book.updatedAt || 0) && stored.position !== R.index) {
      R.book.updatedAt = stored.updatedAt;
      for (const k of ['timeSpentMs', 'wordsRead', 'finishedAt']) R.book[k] = stored[k];
      seek(stored.position);
      toast('Moved to where you stopped on your other device');
    }
  }

  function confirmDelete(li) {
    if (li.querySelector('.book-confirm')) return;
    const title = li.querySelector('.book-title').firstChild.textContent;
    const box = document.createElement('div');
    box.className = 'book-confirm';
    const p = document.createElement('p');
    p.textContent = `Delete “${title}” and your place in it?`;
    const row = document.createElement('div');
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn-small btn-danger';
    yes.textContent = 'Delete';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn-small';
    no.textContent = 'Keep it';
    row.append(yes, no);
    box.append(p, row);
    li.appendChild(box);
    no.focus();
    no.addEventListener('click', () => { box.remove(); li.querySelector('.book-del').focus(); });
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      await BlinkStore.deleteBook(li.dataset.id);
      if (li.dataset.id === SAMPLE.id) {
        try { localStorage.setItem(SEEDED_KEY, '1'); } catch { /* ignore */ }
      }
      await renderLibrary();
      toast(`Deleted “${title}”`);
    });
  }

  el.shelf.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const li = btn.closest('.book');
    if (btn.dataset.action === 'open') openBook(li.dataset.id);
    else if (btn.dataset.action === 'delete') confirmDelete(li);
  });

  async function seedSample() {
    let seeded = false;
    try { seeded = localStorage.getItem(SEEDED_KEY) === '1'; } catch { /* ignore */ }
    if (seeded) return;
    const existing = await BlinkStore.get(SAMPLE.id);
    if (!existing) {
      const { words } = tokenize(SAMPLE.text);
      await BlinkStore.addBook({ ...SAMPLE, wordCount: words.length, openedAt: 1 }, SAMPLE.text);
    }
    try { localStorage.setItem(SEEDED_KEY, '1'); } catch { /* ignore */ }
  }

  /* ---------- Importing ---------- */

  function importRow(name) {
    const row = document.createElement('div');
    row.className = 'import-row';
    const title = document.createElement('span');
    title.className = 'import-name';
    title.textContent = `Reading “${name}”`;
    const step = document.createElement('span');
    step.className = 'import-step';
    step.textContent = 'Starting…';
    const bar = document.createElement('div');
    bar.className = 'import-bar is-indeterminate';
    const fill = document.createElement('span');
    bar.appendChild(fill);
    row.append(title, step, bar);
    el.imports.appendChild(row);
    return {
      progress({ unit, done, total }) {
        bar.classList.remove('is-indeterminate');
        fill.style.width = `${(done / total) * 100}%`;
        step.textContent = `${unit === 'page' ? 'Page' : 'Section'} ${fmt(done)} of ${fmt(total)}`;
      },
      fail(message, detail) {
        row.classList.add('is-error');
        title.textContent = `Couldn’t add “${name}”`;
        step.replaceChildren();
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'icon-btn';
        dismiss.setAttribute('aria-label', 'Dismiss');
        dismiss.innerHTML = '<svg class="icon"><use href="#i-close"/></svg>';
        dismiss.addEventListener('click', () => row.remove());
        step.appendChild(dismiss);
        const err = document.createElement('p');
        err.className = 'import-error';
        err.setAttribute('role', 'alert');
        err.innerHTML = '<svg class="icon"><use href="#i-alert"/></svg>';
        const text = document.createElement('span');
        text.append(message);
        if (detail) {
          const small = document.createElement('small');
          small.className = 'import-detail';
          small.textContent = `Details: ${detail}`;
          text.append(small);
        }
        err.append(text);
        bar.replaceWith(err);
      },
      remove() { row.remove(); },
    };
  }

  function errorDetail(e) {
    if (!e) return '';
    const text = `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message || String(e)}`;
    return text.length > 220 ? `${text.slice(0, 217)}…` : text;
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let lastAdded = null;
    for (const file of files) {
      const row = importRow(file.name);
      let book;
      try {
        const dup = await BlinkStore.findDuplicate(file.name, file.size);
        if (dup) {
          row.remove();
          toast(`“${dup.title}” is already in your library`, { label: 'Open', run: () => openBook(dup.id) });
          const card = el.shelf.querySelector(`[data-id="${dup.id}"]`);
          if (card) { card.classList.remove('is-flash'); void card.offsetWidth; card.classList.add('is-flash'); }
          continue;
        }
        book = await BlinkImport.importFile(file, (p) => row.progress(p));
      } catch (e) {
        (e instanceof BlinkImport.ImportError ? console.warn : console.error)(e);
        if (e instanceof BlinkImport.ImportError) row.fail(e.message, e.cause ? errorDetail(e.cause) : '');
        else row.fail('Blink couldn’t read the text in this file.', errorDetail(e));
        continue;
      }
      let saved;
      try {
        saved = await BlinkStore.addBook(book, book.text);
      } catch (e) {
        console.error(e);
        row.fail('Blink read the book but couldn’t save it in this browser. If you’re in a private window, switch to a normal one. Otherwise, close other tabs and try again.', errorDetail(e));
        continue;
      }
      row.remove();
      lastAdded = saved;
      if (book.skippedPages) {
        toast(`Added “${saved.title}”. ${book.skippedPages} ${book.skippedPages === 1 ? 'page' : 'pages'} couldn’t be read and were skipped.`);
      }
      try { await renderLibrary(); } catch (e) { console.error(e); }
    }
    if (!lastAdded) return;
    if (files.length === 1 && !R.book) {
      openBook(lastAdded.id);
    } else {
      toast(`Added “${lastAdded.title}” · ${fmt(lastAdded.wordCount)} words`, { label: 'Read now', run: () => openBook(lastAdded.id) });
    }
  }

  el.fileInput.addEventListener('change', () => {
    importFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropzone.classList.add('is-over');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropzone.classList.remove('is-over');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.remove('is-over');
    if (R.book) {
      toast('Adding to your library. It will be there when you go back.');
    }
    importFiles(e.dataTransfer.files);
  });

  /* ---------- Library demo ---------- */

  const DEMO_TEXT = 'Blink shows you one word at a time, right where your eyes already are. No more hopping along the lines. Just read.';
  const demo = tokenize(DEMO_TEXT);
  let demoTimer = 0;
  let demoIndex = 0;
  function stopDemo() { clearTimeout(demoTimer); }
  function startDemo() {
    stopDemo();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      renderWord(demoWord, 'Blink');
      return;
    }
    const step = () => {
      if (el.library.hidden) return;
      const i = demoIndex;
      if (!document.hidden) renderWord(demoWord, demo.words[i]);
      demoIndex = (i + 1) % demo.words.length;
      let ms = (60000 / 300) * pauseFactor(demo.words[i], demo.flags[i]);
      if (demoIndex === 0) ms += 1400;
      demoTimer = setTimeout(step, ms);
    };
    step();
  }

  /* ---------- Events ---------- */

  $('backBtn').addEventListener('click', closeBook);
  $('contentsBtn').addEventListener('click', () => openSheet(el.contentsSheet));
  $('settingsBtn').addEventListener('click', () => openSheet(el.settingsSheet));
  $('fullscreenBtn').addEventListener('click', toggleFullscreen);
  el.scrim.addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen isn’t available here.'));
    } catch {
      toast('Full screen isn’t available here.');
    }
  }

  el.playBtn.addEventListener('click', toggle);
  el.stageMain.addEventListener('click', toggle);
  el.stageMain.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); toggle(); }
  });
  $('prevWord').addEventListener('click', prevWord);
  $('nextWord').addEventListener('click', nextWord);
  $('prevSentence').addEventListener('click', prevSentence);
  $('nextSentence').addEventListener('click', nextSentence);
  holdToRepeat($('fasterBtn'), faster);
  holdToRepeat($('slowerBtn'), slower);

  el.wpmDisplay.addEventListener('click', startWpmEdit);
  el.wpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endWpmEdit(true); el.wpmDisplay.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endWpmEdit(false); el.wpmDisplay.focus(); }
  });
  el.wpmInput.addEventListener('blur', () => endWpmEdit(true));

  el.scrubber.addEventListener('input', () => {
    if (R.playing) {
      R.resumeAfterScrub = true;
      pause();
    }
    seek(Number(el.scrubber.value));
  });
  el.scrubber.addEventListener('change', () => {
    if (R.resumeAfterScrub) {
      R.resumeAfterScrub = false;
      play();
    }
  });

  el.context.addEventListener('click', (e) => {
    const w = e.target.closest('.cw');
    if (w) seek(Number(w.dataset.i));
  });

  el.chapterList.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-word]');
    if (!b) return;
    closeSheets();
    seek(Number(b.dataset.word));
  });
  el.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    search(el.searchInput.value);
  });
  el.searchResults.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-word]');
    if (!b) return;
    closeSheets();
    seek(Number(b.dataset.word));
  });
  el.gotoForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pages = R.book.pageStarts || [];
    const p = clamp(Math.round(Number(el.gotoPage.value) || 1), 1, pages.length);
    closeSheets();
    seek(pages[p - 1]);
  });

  // Settings controls
  document.querySelectorAll('.segmented[data-setting]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      const key = group.dataset.setting;
      settings[key] = key === 'chunk' ? Number(b.dataset.value) : b.dataset.value;
      saveSettings();
      applyPrefs();
      refreshAfterPrefChange();
    });
  });
  document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((box) => {
    box.addEventListener('change', () => {
      settings[box.dataset.setting] = box.checked;
      saveSettings();
      applyPrefs();
      refreshAfterPrefChange();
    });
  });
  $('optSize').addEventListener('input', (e) => {
    settings.size = Number(e.target.value);
    saveSettings();
    applyPrefs();
    refreshAfterPrefChange();
  });
  $('wpmPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wpm]');
    if (b) setWpm(Number(b.dataset.wpm));
  });

  function refreshAfterPrefChange() {
    if (!R.book) return;
    if (!R.playing) {
      showCurrent();
      renderContext();
    }
    updateProgress();
  }

  // Keyboard shortcuts. Space always means play/pause in the reader (Enter
  // still activates a focused button), except inside the panels.
  let spaceTookOver = false;
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && spaceTookOver) {
      spaceTookOver = false;
      e.preventDefault();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.accountSheet.hidden) { closeSheets(); return; }
    if (!R.book || el.reader.hidden) return;
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && t.type !== 'range' && t.type !== 'checkbox';
    if (e.key === 'Escape') {
      if (closeSheets()) return;
      if (R.playing) pause();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const inSheet = isSheetOpen();
    const onRange = t && t.type === 'range';
    if (inSheet && !/^[cCsS]$/.test(e.key)) return;
    pokeChrome();
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        if (e.key === ' ') spaceTookOver = true;
        if (!e.repeat) toggle();
        break;
      case 'ArrowRight':
        if (onRange) return;
        e.preventDefault();
        if (e.shiftKey) nextSentence(); else nextWord();
        break;
      case 'ArrowLeft':
        if (onRange) return;
        e.preventDefault();
        if (e.shiftKey) prevSentence(); else prevWord();
        break;
      case 'ArrowUp':
      case '+':
      case '=':
        if (onRange) return;
        e.preventDefault();
        faster();
        break;
      case 'ArrowDown':
      case '-':
      case '_':
        if (onRange) return;
        e.preventDefault();
        slower();
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        if (!el.contentsSheet.hidden) closeSheets(); else openSheet(el.contentsSheet);
        break;
      case 's':
      case 'S':
        e.preventDefault();
        if (!el.settingsSheet.hidden) closeSheets(); else openSheet(el.settingsSheet);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      default:
        break;
    }
  });

  ['pointermove', 'pointerdown'].forEach((ev) => el.reader.addEventListener(ev, pokeChrome, { passive: true }));

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (R.book) fitWord(stageWord);
      if (!el.library.hidden) fitWord(demoWord);
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (R.playing) pause();
      else persist({ flush: true });
    } else if (Date.now() - lastSync > 15000) {
      // Coming back to the tab: pick up anything read on another device.
      syncNow();
    }
  });
  window.addEventListener('pagehide', () => persist({ flush: true }));

  /* ---------- Start ---------- */

  async function start(hot) {
    applyPrefs();
    renderWpm();
    startDemo();
    await BlinkStore.ready();
    try { await seedSample(); } catch (e) { console.warn('Blink: could not add the sample', e); }
    await renderLibrary();
    BlinkStore.onChange(() => {
      if (R.book) renderSyncState(); else renderLibrary();
    });
    BlinkCloud.onAuthChange(() => syncNow());
    syncNow();
    if (hot && hot.bookId) openBook(hot.bookId);
  }

  try {
    window.claude?.hot?.snapshot?.(() => ({ bookId: R.book ? R.book.id : null }));
  } catch { /* not in a viewer */ }
  try {
    if (window.claude?.hot?.ready) window.claude.hot.ready(start);
    else start(window.claude?.hot?.data ?? {});
  } catch {
    start({});
  }
})();
