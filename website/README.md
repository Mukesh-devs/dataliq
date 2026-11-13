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
  saved as WebP at two widths (`name-1280.webp`, `name-2560.webp`). To add or replace one,
  capture the app window at that size, save both widths, and reference it by name in
  `index.html` (`data-lazy="name"`, or `data-shot="name"` for the tour). Timings quoted
  beside a screenshot are the ones its status bar shows; change both together.

## Files

| | |
| --- | --- |
| `index.html` | The page: every section, in order |
| `css/site.css` | Design tokens, then the pieces, then the sections top to bottom |
| `js/main.js` | Starts the two parts below |
| `js/site.js` | Navigation, reveals, the tour, the light/dark slider, counters, parallax, lightbox |
| `js/releases.js` | The latest release: lookup, download cards, release notes (sanitized) |
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
