# The DataLiq website

The product site, published at <https://mukesh-devs.github.io/dataliq/> by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) whenever this
folder changes on `main`. Plain HTML, CSS and JavaScript modules: no framework
and no build step, so what is in this folder is what is served.

**One-time setup on GitHub:** Settings › Pages › Build and deployment › Source: **GitHub Actions**.

## Look at it locally

```bash
python3 -m http.server 4321 --directory website
```

Then open <http://localhost:4321/>. (Modules need a server; opening the file directly won't work.)

## How it stays up to date

- **Version and downloads** are not written in the page. `js/releases.js` asks the GitHub
  Releases API for the latest published release in the visitor's browser, sorts its files
  into Windows, macOS and Linux downloads (`js/release-assets.js`), and shows its notes.
  Publishing a release updates the site; nothing is deployed again. If GitHub can't be
  reached, limits requests, or there is no release, the page says so and links to the
  releases page.
- **The icon** (`assets/icon.svg`, the favicons) is written by `pnpm icons`, from the same
  drawing as the app's.
- **Screenshots** (`assets/shots/`) are real captures of the app at 1280 × 800, 2× scale,
  saved as WebP at two widths (`name-light-1280.webp`, `name-light-2560.webp`, and the same
  for `-dark`). Each picture has a light and a dark version; the page shows the one that
  matches its theme (`only-light` / `only-dark`). There are four: the hero (`hero`) and three
  features (`sql`, `json`, `chart`). Timings quoted beside a screenshot are the ones its
  status bar shows; change both together.

## The design

The page is a sheet. The hero sits on a cell grid with column letters and row numbers where
a highlighted cell follows the pointer; "in seconds." is a selected range with Excel's fill
handle, and the app's icon sits in a "copied" cell with marching ants. Each section starts
with its cell reference (`A2 Speed`), the speed figures are cells with a formula bar, the
other features are a table, and the downloads show the file for your computer first, then
one column per system with its recommended file and its other files. The
header floats, rounded, with a line that shows how far down the page you are; a row header
of the sections appears on the left of wide screens once the hero has scrolled away.

Scrolling is the site's own (`js/scroll.js`, no library): the mouse wheel eases instead of
jumping and in-page links glide, while the browser still does the scrolling (scroll bar,
keyboard, touch and find-in-page behave as usual). The effects borrow spreadsheet gestures:
headings are filled in by a selection box dragged across with the fill handle, rows fill in
one after another with their row number lighting up, screenshots un-crop in step with the
scroll, the speed cells are selected one by one, the hero eases away, and the header's name
box shows the cell reference of the section in view. With "reduce motion" set, none of this
runs and everything is shown at once.

Type is Geist (headings and text) with JetBrains Mono for data (file names, cell
references); both are variable fonts under the SIL Open Font License, served from
`assets/fonts/`. Light and dark themes follow the system until the visitor picks one with
the button in the header (remembered in the browser).

## Files

| | |
| --- | --- |
| `index.html` | The page: every section, in order |
| `css/site.css` | Design tokens, then the pieces, then the sections top to bottom |
| `js/main.js` | Starts the parts below |
| `js/scroll.js` | Eased wheel scrolling, gliding in-page links, the hero easing away, screenshots un-cropping with the scroll |
| `js/site.js` | Theme, menu, the row header and name box, the hero's cell grid, reveals (rise, sweep, fill), the tilted showcase, the header's progress line, counters, formula bar, ticker, terminal typing, lightbox, the footer's fitted wordmark |
| `js/releases.js` | The latest release: lookup, the file for this computer, one column of files per system, release notes (sanitized) |
| `js/release-assets.js` | Pure functions: which file is which download, which system the visitor has |
| `404.html`, `robots.txt`, `sitemap.xml`, `site.webmanifest` | For GitHub Pages and search engines |

## Checks

```bash
node --test scripts/website.test.mjs
```

covers the release logic (file names to downloads, system detection, only GitHub-hosted
links), that no version or download link is written into the page, and that every file
the page names exists. It runs with `pnpm test`.

## Rules the page keeps

- DataLiq is a desktop app: desktop windows only, no phone or tablet mock-ups. The layout
  itself adapts to any screen.
- Only features the app has, shown with real screenshots.
- No third-party requests except the GitHub API call: fonts and images are served from here.
- Works without JavaScript (content and a download link), and with reduced motion.
