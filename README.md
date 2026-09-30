# Blink Reader

A speed reader for your own books. Drop in a PDF and Blink flashes it one word at a time in the same spot on the screen, so your eyes never have to move along a line. Set the pace in words per minute and read.

Everything runs in the browser. Files are opened on your device, the text is pulled out locally, and nothing is uploaded to a server.

## Features

- **PDF, EPUB and plain text.** PDFs are read with Mozilla's PDF.js. Running headers, footers and page numbers are removed, words split across lines with a hyphen are joined back together, and paragraphs are rebuilt.
- **Words per minute at the bottom.** Use the minus and plus buttons (hold them to change quickly), the up and down arrow keys, a preset, or click the number and type any speed from 50 to 1500.
- **Focal letter.** Each word is lined up on its optimal recognition point, a letter slightly left of centre shown in colour, with guide marks above and below.
- **Smart pacing.** Blink lingers a little on commas, full stops, long words and paragraph ends. It can be turned off.
- **Warm-up.** Each time you press play, it starts a bit slower and eases up to your speed.
- **One, two or three words per flash.**
- **Text on pause.** When you pause, the surrounding passage appears with the current word highlighted. Click any word to jump there.
- **Contents and search.** Jump to a chapter (taken from the PDF's bookmarks or the EPUB's table of contents), go to a page, or search for a phrase.
- **Library with saved progress.** Every book you add is saved in the browser along with your exact position, reading time and progress, so you can close the tab and continue later. Adding the same file twice opens the existing copy.
- **Themes and type.** Auto, light, sepia and dark themes; Literata, Atkinson Hyperlegible or IBM Plex Mono for the words; adjustable text size.
- **Focus mode.** While reading, the controls fade out until you move the mouse. The screen is kept awake on phones, and reading pauses when you switch tabs.
- **Account sync on claude.ai.** When Blink runs as a Claude artifact, your library is also saved to your private artifact storage, so it follows you between devices.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right | Back or forward one word |
| Shift + Left / Right | Back or forward one sentence |
| Up / Down | Faster or slower by 25 wpm |
| C | Contents and search |
| S | Settings |
| F | Full screen |
| Esc | Close a panel, or pause |

## Running it

Blink is a static site with no build step. It needs to be served over HTTP (browsers won't load the PDF engine from a `file://` page).

To try it locally, from this folder:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

To put it online with GitHub Pages, go to **Settings → Pages** in this repository, choose **Deploy from a branch**, pick the branch and the `/ (root)` folder, and save. Any other static host works the same way.

## Where books are stored

Books live in your browser's IndexedDB storage for the site. Clearing site data for the page removes them. Reading settings such as speed and theme are kept in `localStorage`.

When the page is opened as a claude.ai artifact, the library is mirrored under `data/users/<your id>/` in the artifact's database, which only you can read. Book text is stored there in chunks under each book's record.

## Project layout

```
index.html        page structure and icons
css/styles.css    all styles and the colour themes
js/text.js        splitting text into words, focal letter, pacing
js/importers.js   PDF, EPUB and text import
js/storage.js     the library (IndexedDB, plus optional sync)
js/app.js         library view, reader view and playback
lib/pdfjs/        PDF.js 6.3.289 (Apache 2.0)
lib/jszip/        JSZip 3.10.2 (MIT), used for EPUB files
```

## Limits

- Scanned PDFs that are only page images have no text to read. Blink says so instead of showing an empty book.
- Password-protected PDFs and DRM-protected EPUBs can't be opened.
- Multi-column layouts, footnotes and tables in PDFs come out in whatever order the PDF stores them, which is usually but not always the reading order.
