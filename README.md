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
- **Sync across devices.** Sign in with an email and password and your library, including your place in every book, shows up on your phone, tablet and computer. Sync uses [Supabase](https://supabase.com) (see below). Books are also kept in the browser, so they still open offline.
- **Pick up where you stopped.** If you read further on another device, Blink moves to that spot the next time you come back to the page.

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

## Turning on sync with Supabase

Without this, each browser keeps its own library. With it, signing in on any device brings up the same books. It takes about five minutes and the free Supabase plan is plenty.

1. Create a free account at [supabase.com](https://supabase.com) and make a new project. Any name, region and database password will do.
2. In the project, open **SQL Editor**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. This creates the two tables Blink uses and the rules that keep each person's books private.
3. Open **Authentication → URL Configuration** and set **Site URL** to your site's address, for example `https://conalmac08.github.io/Reader/`. Confirmation and sign-in emails link back there.
   - Optional: under **Authentication → Sign In / Providers → Email**, turn off **Confirm email** if you'd rather skip the confirmation email when creating your account.
4. Open **Project Settings → API** (or **API Keys**) and copy the **Project URL** and the **anon** / **publishable** key.
5. Paste both into [`js/config.js`](js/config.js) and commit. GitHub Pages republishes the site within a minute or two.

Then open the site, click **Sign in to sync** at the top of the library, and create your account. Sign in with the same email and password on your other devices.

The URL and anon key are designed to be public. Supabase only lets a signed-in person read or change rows with their own user id, as set out in `schema.sql`.

## Where books are stored

Books always live in your browser's IndexedDB storage for the site, which is what lets them open offline. Reading settings such as speed and theme are kept in `localStorage` per device.

With sync on, each book's details and reading progress are stored in the `books` table and its text in `book_texts`, split into pieces of up to 400,000 characters. Deleting a book on one device removes its text from Supabase and marks the book deleted so your other devices drop it too.

When the page runs as a claude.ai artifact instead, the library is mirrored to the artifact's own private storage.

## Project layout

```
index.html          page structure and icons
css/styles.css      all styles and the colour themes
js/config.js        your Supabase URL and key (empty = no sync)
js/text.js          splitting text into words, focal letter, pacing
js/importers.js     PDF, EPUB and text import
js/cloud.js         sign-in and the Supabase / claude.ai sync adapters
js/storage.js       the library (IndexedDB) and merging with synced data
js/app.js           library view, reader view and playback
supabase/schema.sql tables and privacy rules to run in Supabase
lib/pdfjs/          PDF.js 6.3.289 (Apache 2.0)
lib/jszip/          JSZip 3.10.2 (MIT), used for EPUB files
lib/supabase/       supabase-js 2.117.2 (MIT), loaded only when sync is set up
```

## Limits

- Scanned PDFs that are only page images have no text to read. Blink says so instead of showing an empty book.
- Password-protected PDFs and DRM-protected EPUBs can't be opened.
- Multi-column layouts, footnotes and tables in PDFs come out in whatever order the PDF stores them, which is usually but not always the reading order.
