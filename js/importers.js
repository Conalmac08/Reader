/*
 * Blink Reader: turning files into books.
 * Each importer returns { title, author, text, pageStarts, chapters, wordCount }
 * where text is paragraphs joined by "\n" and page/chapter positions are
 * word indexes into that text.
 */
const BlinkImport = (() => {
  const { clean, countWords, looksLikeHeading } = BlinkText;

  // A problem worth explaining to the reader. `cause` keeps the underlying
  // error, if any, so the message can show what actually went wrong.
  class ImportError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = 'ImportError';
      this.cause = cause;
    }
  }

  const assetUrl = (path) => new URL(path, document.baseURI).href;

  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(assetUrl('lib/pdfjs/pdf.min.mjs')).then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = assetUrl('lib/pdfjs/pdf.worker.min.mjs');
        return lib;
      });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  let jszipPromise = null;
  function loadJsZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!jszipPromise) {
      jszipPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = assetUrl('lib/jszip/jszip.min.js');
        s.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip missing')));
        s.onerror = () => reject(new Error('JSZip failed to load'));
        document.head.appendChild(s);
      });
      jszipPromise.catch(() => { jszipPromise = null; });
    }
    return jszipPromise;
  }

  // Collects paragraphs and keeps a running word count.
  function createBuilder() {
    const paras = [];
    let words = 0;
    return {
      paras,
      get words() { return words; },
      push(p) {
        const t = clean(p).replace(/\s+/g, ' ').trim();
        if (!t) return;
        const n = countWords(t);
        if (!n) return;
        paras.push(t);
        words += n;
      },
    };
  }

  function finish(b, fields) {
    const total = b.words;
    const clamp = (w) => Math.max(0, Math.min(total - 1, w));
    const seen = new Set();
    const chapters = (fields.chapters || [])
      .filter((c) => c && typeof c.title === 'string' && c.title.trim() && Number.isFinite(c.word))
      .map((c) => ({ title: c.title.replace(/\s+/g, ' ').trim().slice(0, 140), word: clamp(c.word), depth: c.depth || 0 }))
      .sort((a, b) => a.word - b.word)
      .filter((c) => {
        const k = `${c.word}|${c.title}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 400);
    return {
      title: fields.title,
      author: fields.author || '',
      text: b.paras.join('\n'),
      wordCount: total,
      pageStarts: (fields.pageStarts || []).map(clamp),
      chapters,
    };
  }

  const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  const titleCase = (t) => t.split(' ').map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

  function titleFrom(metaTitle, fileName) {
    let t = (metaTitle || '').replace(/\s+/g, ' ').trim()
      .replace(/^microsoft (word|powerpoint)\s*-\s*/i, '')
      .replace(/\.(docx?|pdf|indd|epub|txt|rtf|pptx?)$/i, '');
    if (!t || t.length < 2 || t.length > 160 || /^(untitled|unknown|document|title|none)\b/i.test(t) || /^(about:|https?:|file:|[a-z]:\\)/i.test(t) || !/\p{L}/u.test(t)) {
      t = fileName.replace(/\.[^.]+$/, '');
      if (!/\s/.test(t)) t = t.replace(/[-_.]+/g, ' ');
      t = t.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (t && t === t.toLowerCase()) t = titleCase(t);
    return t || 'Untitled';
  }

  /* ---------- PDF ---------- */

  const PAGE_NUMBER = /^([Pp]age\s+)?[-–—([]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[-–—)\]]?(\s+of\s+\d{1,4})?$/;
  const ENDS_SENTENCE = /[.!?:…]["'”’)\]]*$/;

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function linesFromItems(items) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.abs(it.height) || Math.hypot(it.transform[2], it.transform[3]) || 10;
      const str = it.str;
      if (cur && str.trim() && Math.abs(y - cur.y) > Math.max(Math.min(cur.h, h), 1) * 0.6) {
        lines.push(cur);
        cur = null;
      }
      if (str) {
        if (!cur) {
          if (str.trim()) cur = { text: '', x, y, h, right: x };
        } else if (x - cur.right > h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(str)) {
          cur.text += ' ';
        }
        if (cur) {
          cur.text += str;
          cur.right = Math.max(cur.right, x + (it.width || 0));
          if (str.trim()) cur.h = Math.max(cur.h, h);
        }
      }
      if (it.hasEOL && cur) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);
    return lines
      .map((l) => ({ ...l, text: clean(l.text).replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.text);
  }

  // Running headers, footers and page numbers repeat at the top or bottom
  // of many pages; drop them so they don't interrupt the text.
  function stripRunningLines(pages) {
    const key = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const edges = (lines) => (lines.length <= 4 ? lines : [...lines.slice(0, 2), ...lines.slice(-2)]);
    const repeated = new Set();
    if (pages.length >= 4) {
      const counts = new Map();
      for (const lines of pages) {
        const seen = new Set(edges(lines).map((l) => key(l.text)));
        for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
      }
      const min = Math.max(3, Math.ceil(pages.length * 0.3));
      for (const [k, c] of counts) if (c >= min && k.length <= 120) repeated.add(k);
    }
    return pages.map((lines) => lines.filter((l, i) => {
      if (i >= 2 && i < lines.length - 2) return true;
      return !repeated.has(key(l.text)) && !PAGE_NUMBER.test(l.text);
    }));
  }

  function joinLine(buf, text) {
    if (!buf) return text;
    if (/\p{L}-$/u.test(buf) && /^\p{Ll}/u.test(text)) return buf.slice(0, -1) + text;
    return `${buf} ${text}`;
  }

  function assemblePdf(rawPages) {
    const pages = stripRunningLines(rawPages);
    const b = createBuilder();
    const pageStarts = [];
    const headings = [];
    let buf = '';
    let prevEnds = true;
    const flush = () => { if (buf) b.push(buf); buf = ''; };

    for (const lines of pages) {
      pageStarts.push(b.words + (buf ? countWords(buf) : 0));
      if (!lines.length) continue;

      const h = percentile(lines.map((l) => l.h).sort((m, n) => m - n), 0.5) || 10;
      const gaps = [];
      for (let i = 1; i < lines.length; i++) {
        const g = lines[i - 1].y - lines[i].y;
        if (g > h * 0.5 && g < h * 3) gaps.push(g);
      }
      const lineGap = percentile(gaps.sort((m, n) => m - n), 0.5) || h * 1.25;
      const left = percentile(lines.map((l) => l.x).sort((m, n) => m - n), 0.1);
      const right = percentile(lines.map((l) => l.right).sort((m, n) => m - n), 0.9);

      lines.forEach((line, i) => {
        const prev = i > 0 ? lines[i - 1] : null;
        const indented = line.x > left + h * 0.8;
        const named = looksLikeHeading(line.text);
        let brk;
        if (!prev || prev.y - line.y < -h) {
          // First line on the page, or the text jumped up to a new column.
          brk = prevEnds && (indented || line.h > h * 1.3);
        } else {
          const gap = prev.y - line.y;
          const prevShort = prev.right < right - h * 3;
          brk = gap > lineGap * 1.45
            || (prevEnds && (indented || prevShort))
            || Math.abs(line.h - prev.h) > h * 0.35;
        }
        if (brk || named) flush();
        if (named) headings.push({ title: line.text, word: b.words, depth: 0 });
        buf = joinLine(buf, line.text);
        if (named) flush();
        prevEnds = ENDS_SENTENCE.test(line.text);
      });
    }
    flush();
    return { b, pageStarts, headings };
  }

  async function resolveOutline(doc) {
    let outline;
    try { outline = await doc.getOutline(); } catch { return []; }
    if (!outline || !outline.length) return [];
    const out = [];
    async function walk(items, depth) {
      for (const item of items) {
        if (out.length >= 400) return;
        let page = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          if (Array.isArray(dest) && dest[0] != null) {
            const ref = dest[0];
            page = typeof ref === 'object' ? await doc.getPageIndex(ref) : (Number.isInteger(ref) ? ref : null);
          }
        } catch { page = null; }
        if (page != null && item.title) out.push({ title: String(item.title), page, depth });
        if (item.items && item.items.length && depth < 2) await walk(item.items, depth + 1);
      }
    }
    await walk(outline, 0);
    return out;
  }

  async function importPdf(file, onProgress) {
    let pdfjs;
    try {
      pdfjs = await loadPdfJs();
    } catch {
      throw new ImportError('The PDF engine could not load. If you opened Blink straight from a file on your computer, run it from a web server instead (the README explains how).');
    }
    let task = null;
    let doc;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      // Only text is needed, so fonts are never loaded into the page and
      // pdf.js's warnings about missing font files are silenced.
      task = pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 });
      doc = await task.promise;
    } catch (e) {
      if (task) task.destroy();
      if (e && e.name === 'PasswordException') throw new ImportError('This PDF is locked with a password. Save an unlocked copy and add that instead.');
      throw new ImportError('This file could not be opened as a PDF. It may be damaged or not really a PDF.', e);
    }
    try {
      let info = {};
      try { info = (await doc.getMetadata())?.info || {}; } catch { info = {}; }
      const pages = [];
      let skipped = 0;
      let lastError = null;
      // A damaged or unusual page shouldn't sink the whole book: skip it
      // and keep going.
      for (let p = 1; p <= doc.numPages; p++) {
        try {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          pages.push(linesFromItems(content.items || []));
          try { page.cleanup(); } catch { /* nothing to free */ }
        } catch (e) {
          console.warn(`Blink: skipped page ${p}`, e);
          skipped++;
          lastError = e;
          pages.push([]);
        }
        onProgress?.({ unit: 'page', done: p, total: doc.numPages });
      }
      if (doc.numPages && skipped === doc.numPages) {
        throw new ImportError('Blink couldn’t read the text on any page of this PDF.', lastError);
      }
      const outline = await resolveOutline(doc);
      const { b, pageStarts, headings } = assemblePdf(pages);
      if (!b.words) {
        throw new ImportError('This PDF has no selectable text. It is probably scanned page images, which Blink cannot read yet.');
      }
      const chapters = outline.length
        ? outline.filter((o) => o.page < pageStarts.length).map((o) => ({ title: o.title, word: pageStarts[o.page], depth: o.depth }))
        : headings;
      const book = finish(b, {
        title: titleFrom(typeof info.Title === 'string' ? info.Title : '', file.name),
        author: typeof info.Author === 'string' ? info.Author.trim() : '',
        pageStarts,
        chapters,
      });
      return { ...book, skippedPages: skipped };
    } finally {
      task.destroy();
    }
  }

  /* ---------- EPUB ---------- */

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
    'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
    'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
  ]);
  const SKIP_TAGS = new Set(['head', 'script', 'style', 'title', 'rt', 'rp', 'noscript', 'template', 'svg', 'math']);
  const OPS_NS = 'http://www.idpf.org/2007/ops';

  function parseMarkup(text, type) {
    const doc = new DOMParser().parseFromString(text, type);
    if (doc.getElementsByTagName('parsererror').length) {
      return new DOMParser().parseFromString(text, 'text/html');
    }
    return doc;
  }

  function splitHref(baseDir, href) {
    const [p, frag = ''] = (href || '').split('#');
    const url = new URL(p || '.', `https://book.invalid/${baseDir}`);
    let path = url.pathname.slice(1);
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
    return { path, frag };
  }

  const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
  const byTag = (root, tag) => Array.from(root.getElementsByTagNameNS('*', tag));

  function extractHtml(src, path, b, anchors) {
    const doc = parseMarkup(src, 'application/xhtml+xml');
    const body = doc.body || byTag(doc, 'body')[0] || doc.documentElement;
    let buf = '';
    const flush = () => { if (buf.trim()) b.push(buf); buf = ''; };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3 || child.nodeType === 4) { buf += child.nodeValue; continue; }
        if (child.nodeType !== 1) continue;
        const tag = (child.localName || '').toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const id = child.getAttribute('id');
        if (id) anchors.set(`${path}#${id}`, b.words + (buf.trim() ? countWords(buf) : 0));
        if (tag === 'br') { buf += ' '; continue; }
        const block = BLOCK_TAGS.has(tag);
        if (block) flush();
        walk(child);
        if (block) flush();
      }
    };
    if (body) walk(body);
    flush();
  }

  async function readToc(zip, opf, manifest, baseDir) {
    const read = async (path) => (zip.file(path) ? zip.file(path).async('string') : null);
    const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
    if (navItem) {
      const src = await read(navItem.path);
      if (src) {
        const doc = parseMarkup(src, 'application/xhtml+xml');
        const navs = byTag(doc, 'nav');
        const nav = navs.find((n) => /\btoc\b/.test(n.getAttributeNS(OPS_NS, 'type') || n.getAttribute('epub:type') || '')) || navs[0];
        if (nav) {
          const out = [];
          for (const a of byTag(nav, 'a')) {
            const href = a.getAttribute('href');
            if (!href) continue;
            let depth = 0;
            for (let el = a.parentNode; el && el !== nav; el = el.parentNode) if ((el.localName || '').toLowerCase() === 'ol') depth++;
            out.push({ title: a.textContent, ...splitHref(dirOf(navItem.path), href), depth: Math.max(0, depth - 1) });
          }
          if (out.length) return out;
        }
      }
    }
    const spine = byTag(opf, 'spine')[0];
    const ncxItem = (spine && manifest.get(spine.getAttribute('toc'))) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    if (!ncxItem) return [];
    const src = await read(ncxItem.path);
    if (!src) return [];
    const ncx = parseMarkup(src, 'application/xml');
    const out = [];
    for (const point of byTag(ncx, 'navPoint')) {
      const label = byTag(point, 'text')[0];
      const content = byTag(point, 'content')[0];
      if (!label || !content) continue;
      let depth = 0;
      for (let el = point.parentNode; el; el = el.parentNode) if (el.localName === 'navPoint') depth++;
      out.push({ title: label.textContent, ...splitHref(dirOf(ncxItem.path), content.getAttribute('src')), depth });
    }
    return out;
  }

  async function importEpub(file, onProgress) {
    let JSZip;
    try { JSZip = await loadJsZip(); } catch { throw new ImportError('The EPUB reader could not load. Check your connection and try again.'); }
    let zip;
    try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new ImportError('This EPUB could not be opened. The file may be damaged.'); }
    const read = async (path) => (zip.file(path) ? zip.file(path).async('string') : null);

    const container = await read('META-INF/container.xml');
    const rootfile = container && byTag(parseMarkup(container, 'application/xml'), 'rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    const opfSrc = opfPath && (await read(opfPath));
    if (!opfSrc) throw new ImportError('This EPUB is missing its table of contents file, so Blink cannot find the chapters.');
    if (zip.file('META-INF/encryption.xml') && /EncryptedData/.test((await read('META-INF/encryption.xml')) || '')) {
      throw new ImportError('This EPUB is protected with DRM, so its text cannot be read.');
    }
    const opf = parseMarkup(opfSrc, 'application/xml');
    const baseDir = dirOf(opfPath);
    const meta = (tag) => (byTag(opf, tag)[0]?.textContent || '').replace(/\s+/g, ' ').trim();

    const manifest = new Map();
    for (const item of byTag(opf, 'item')) {
      manifest.set(item.getAttribute('id'), {
        path: splitHref(baseDir, item.getAttribute('href')).path,
        type: item.getAttribute('media-type') || '',
        props: item.getAttribute('properties') || '',
      });
    }
    const spine = byTag(opf, 'itemref')
      .map((ref) => manifest.get(ref.getAttribute('idref')))
      .filter((it) => it && /html|xml/.test(it.type) && !/\bnav\b/.test(it.props));

    const b = createBuilder();
    const anchors = new Map();
    for (let i = 0; i < spine.length; i++) {
      const path = spine[i].path;
      anchors.set(path, b.words);
      try {
        const src = await read(path);
        if (src) extractHtml(src, path, b, anchors);
      } catch (e) {
        console.warn(`Blink: skipped ${path}`, e);
      }
      onProgress?.({ unit: 'section', done: i + 1, total: spine.length });
    }
    if (!b.words) throw new ImportError('This EPUB does not contain any readable text.');

    let toc = [];
    try { toc = await readToc(zip, opf, manifest, baseDir); } catch (e) { console.warn('Blink: no table of contents', e); }
    const chapters = toc.map((t) => ({
      title: t.title,
      word: anchors.get(t.frag ? `${t.path}#${t.frag}` : t.path) ?? anchors.get(t.path),
      depth: t.depth,
    })).filter((c) => c.word != null);

    return finish(b, { title: titleFrom(meta('title'), file.name), author: meta('creator'), chapters });
  }

  /* ---------- Plain text ---------- */

  async function importText(file) {
    let text = clean((await file.text()).replace(/\r\n?/g, '\n'));
    const start = text.search(/^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG.*$/im);
    if (start >= 0) text = text.slice(text.indexOf('\n', start) + 1);
    const end = text.search(/^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG/im);
    if (end >= 0) text = text.slice(0, end);

    let blocks = text.split(/\n[ \t]*\n/);
    if (blocks.length < 3 && text.split('\n').length > 20) blocks = text.split('\n');
    const b = createBuilder();
    const headings = [];
    for (const block of blocks) {
      const t = block.replace(/\s*\n\s*/g, ' ').replace(/^#+\s+/, '').trim();
      if (!t) continue;
      if (looksLikeHeading(t)) headings.push({ title: t, word: b.words, depth: 0 });
      b.push(t);
    }
    if (!b.words) throw new ImportError('This text file is empty.');
    return finish(b, { title: titleFrom('', file.name), chapters: headings });
  }

  async function importFile(file, onProgress) {
    const name = file.name || 'Untitled';
    const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    let book;
    if (ext === 'pdf' || file.type === 'application/pdf') book = await importPdf(file, onProgress);
    else if (ext === 'epub' || file.type === 'application/epub+zip') book = await importEpub(file, onProgress);
    else if (['txt', 'text', 'md', 'markdown'].includes(ext) || (file.type || '').startsWith('text/')) book = await importText(file);
    else throw new ImportError(`Blink opens PDF, EPUB and plain text files, and “${name}” isn’t one of those.`);
    return { ...book, fileName: name, fileSize: file.size, source: ext === 'epub' ? 'epub' : ext === 'pdf' ? 'pdf' : 'text' };
  }

  return { importFile, ImportError, loadPdfJs };
})();
