/*
 * Blink Reader: text utilities.
 * Book text is stored as paragraphs separated by "\n". Everything that turns
 * that text into words goes through splitWords() so word indexes (saved
 * positions, page starts, chapters) always line up.
 */
const BlinkText = (() => {
  const LIGATURES = {
    'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi',
    'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
  };

  const WORD_CHAR = /[\p{L}\p{N}]/u;
  const SENTENCE_END = /[.!?…]["'”’)\]*_]*$/;
  const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

  // Paragraph-end flag is bit 0, sentence-end flag is bit 1.
  const PARA = 1;
  const SENT = 2;

  function clean(s) {
    return s
      .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c])
      .replace(/­/g, '')
      .replace(/[​-‍⁠﻿]/g, '')
      .replace(/[\t  -   　]/g, ' ')
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  }

  // Break a paragraph into display words. Em dashes and very long
  // hyphenated or slashed runs are split so nothing becomes unreadable.
  function splitWords(paragraph) {
    const out = [];
    for (const raw of paragraph.split(/\s+/)) {
      if (!raw) continue;
      for (const piece of raw.split(/(?<=—)(?=[\p{L}\p{N}"'“‘])|(?<=\p{L}–)(?=\p{L})/u)) {
        if (!piece) continue;
        if (piece.length > 20 && /[-/]/.test(piece)) {
          for (const part of piece.split(/(?<=[-/])(?=.)/)) if (part) out.push(part);
        } else {
          out.push(piece);
        }
      }
    }
    return out;
  }

  function countWords(paragraph) {
    return splitWords(paragraph).length;
  }

  function tokenize(text) {
    const words = [];
    const ends = [];
    for (const para of text.split('\n')) {
      const parts = splitWords(para);
      if (!parts.length) continue;
      for (const w of parts) words.push(w);
      ends.push(words.length - 1);
    }
    const flags = new Uint8Array(words.length);
    for (const i of ends) flags[i] |= PARA;
    for (let i = 0; i < words.length; i++) {
      if (SENTENCE_END.test(words[i])) flags[i] |= SENT;
    }
    return { words, flags };
  }

  function letterSpan(chars) {
    let start = 0;
    while (start < chars.length && !WORD_CHAR.test(chars[start])) start++;
    let end = chars.length;
    while (end > start && !WORD_CHAR.test(chars[end - 1])) end--;
    return [start, end];
  }

  // Optimal recognition point: the letter the eye should rest on,
  // a little left of centre.
  function focusIndex(chars) {
    const [start, end] = letterSpan(chars);
    const len = end - start;
    if (len <= 0) return Math.max(0, Math.floor((chars.length - 1) / 2));
    let k;
    if (len <= 1) k = 0;
    else if (len <= 5) k = 1;
    else if (len <= 9) k = 2;
    else if (len <= 13) k = 3;
    else k = Math.floor(len * 0.3);
    return start + k;
  }

  // How long a word deserves on screen relative to an average word.
  function pauseFactor(word, flag) {
    const chars = Array.from(word);
    const [start, end] = letterSpan(chars);
    const len = end - start;
    let f = 1;
    if (len > 7) f += Math.min(0.7, (len - 7) * 0.09);
    if (flag & SENT) f += 1.1;
    else if (CLAUSE_END.test(word)) f += 0.5;
    if (flag & PARA) f += (flag & SENT) ? 0.8 : 1.4;
    if (/\d/.test(word)) f += 0.3;
    return f;
  }

  function pauseFactors(words, flags) {
    const out = new Float32Array(words.length);
    for (let i = 0; i < words.length; i++) out[i] = pauseFactor(words[i], flags[i]);
    return out;
  }

  const NUMBER_WORD = '\\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\\w-]*|thirty[\\w-]*|forty[\\w-]*|fifty[\\w-]*|the\\s+\\w+';
  const HEADING = new RegExp(
    `^(?:(?:chapter|part|book)\\s+(?:${NUMBER_WORD})\\b|(?:prologue|epilogue|introduction|preface|foreword|afterword|appendix)\\b(?!\\s+(?:of|to|is|was|and|the|in)\\b))`,
    'i',
  );

  // Guesses whether a short line is a chapter heading, for books that
  // don't come with a table of contents.
  function looksLikeHeading(line) {
    const t = line.trim();
    return t.length <= 60 && t.split(/\s+/).length <= 10 && HEADING.test(t) && !/[,;]$/.test(t);
  }

  const SAMPLE = {
    id: 'sample-getting-started',
    title: 'Getting Started with Blink',
    author: 'A two-minute tour',
    source: 'sample',
    text: [
      'Welcome to Blink.',
      'You are reading one word at a time, and your eyes are not moving at all. Most of the effort in ordinary reading goes into hopping from word to word along a line. Blink brings the words to you instead, so you can go much faster with far less effort.',
      'Keep your gaze on the coloured letter. It marks the point where your eye recognises a word fastest, and every word lines up on the same spot.',
      'Change your speed with the minus and plus buttons at the bottom of the screen, or with the up and down arrow keys. Most people start near 300 words per minute and settle between 400 and 600 after a few sessions.',
      'Press the space bar or tap the word to pause. When you pause, the surrounding text appears underneath so you can find your place. Tap any word there to jump straight to it.',
      'The left and right arrow keys step one word at a time. Hold shift with them to skip a whole sentence.',
      'Blink lingers a moment on commas, full stops, long words and the ends of paragraphs, the way your voice would. You can switch that off in Settings, along with the warm-up that eases you into your speed each time you press play.',
      'To read your own book, go back to the library and drop in a PDF, an EPUB or a plain text file. Blink saves it and remembers exactly where you stopped, so you can close the page and pick up again later.',
      'Open Contents to jump to a chapter, go to a page or search for a phrase.',
      'That is everything. Happy reading.',
    ].join('\n'),
  };

  return {
    PARA, SENT, clean, splitWords, countWords, tokenize, focusIndex,
    pauseFactor, pauseFactors, looksLikeHeading, SAMPLE,
  };
})();
