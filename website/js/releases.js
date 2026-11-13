// The download section and buttons, filled from the latest GitHub release.
// Nothing here is hard-coded: publishing a release updates the site.
import {
  LATEST_API,
  OS_NAMES,
  RELEASES_URL,
  detectOS,
  formatDate,
  summarize,
} from "./release-assets.js";

const CACHE_KEY = "dataliq.release.v1";
/** Minutes a looked-up release is reused within a tab (GitHub allows 60 lookups an hour). */
const CACHE_MINUTES = 10;
const TIMEOUT_MS = 8000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

function readCache() {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "null");
    if (hit && Date.now() - hit.at < CACHE_MINUTES * 60_000) return hit.data;
  } catch {
    // No storage (private mode): just ask again.
  }
  return undefined;
}

function writeCache(data) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Fine without it.
  }
}

/**
 * The latest published release: `{ release }`, `{ none: true }` when the
 * project has none yet, or `{ error }` when GitHub can't be reached or
 * limits requests.
 */
export async function latestRelease(fetchImpl = fetch) {
  const cached = readCache();
  if (cached !== undefined) return cached;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(LATEST_API, {
      // "full" adds the notes as HTML rendered by GitHub.
      headers: { Accept: "application/vnd.github.full+json" },
      signal: abort.signal,
    });
    if (res.status === 404) {
      const none = { none: true };
      writeCache(none);
      return none;
    }
    if (!res.ok) return { error: res.status === 403 || res.status === 429 ? "limited" : "failed" };
    const release = summarize(await res.json());
    if (!release) return { error: "failed" };
    const out = { release };
    writeCache(out);
    return out;
  } catch {
    return { error: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

const ALLOWED = new Set([
  "P",
  "UL",
  "OL",
  "LI",
  "STRONG",
  "B",
  "EM",
  "I",
  "CODE",
  "PRE",
  "BR",
  "BLOCKQUOTE",
  "HR",
  "DEL",
  "A",
]);
const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const DROPPED = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "TEMPLATE",
  "SVG",
  "MATH",
  "HEAD",
  "TITLE",
  "IMG",
  "VIDEO",
  "AUDIO",
  "FORM",
]);

/**
 * Release notes as safe DOM: only text, lists, emphasis, code and links to
 * web pages survive; everything else is unwrapped or dropped. The notes are
 * written by the project, but they still arrive over the network.
 */
export function sanitizeNotes(html) {
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const copy = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.append(document.createTextNode(node.textContent));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || DROPPED.has(node.tagName.toUpperCase())) continue;
      const tag = node.tagName.toUpperCase();
      let target = to;
      if (HEADINGS.has(tag)) target = to.appendChild(document.createElement("h4"));
      else if (ALLOWED.has(tag)) {
        target = document.createElement(tag.toLowerCase());
        if (tag === "A") {
          let href = null;
          try {
            const u = new URL(node.getAttribute("href") ?? "", RELEASES_URL);
            if (u.protocol === "https:" || u.protocol === "http:") href = u.href;
          } catch {
            // Not a link we show.
          }
          if (!href) target = document.createElement("span");
          else {
            target.setAttribute("href", href);
            target.setAttribute("rel", "noopener nofollow");
          }
        }
        to.append(target);
      }
      copy(node, target);
    }
  };
  const out = document.createDocumentFragment();
  copy(doc.body, out);
  return out;
}

function notesFragment(release) {
  if (release.notesHtml.trim()) {
    const frag = sanitizeNotes(release.notesHtml);
    if (frag.textContent.trim()) return frag;
  }
  // Plain text, one paragraph per blank-line block.
  const frag = document.createDocumentFragment();
  for (const block of release.notesText.split(/\n\s*\n/)) {
    if (block.trim()) frag.append(el("p", { text: block.trim() }));
  }
  return frag;
}

function downloadLink(d, primary) {
  return el(
    "a",
    { class: primary ? "dl dl--primary" : "dl", href: d.url, rel: "noopener", download: "" },
    [
      el("span", { class: "dl__label", text: d.label }),
      el("span", { class: "dl__detail", text: d.detail }),
      el("span", { class: "dl__size" }, [
        d.size ? document.createTextNode(d.size) : null,
        icon("i-download"),
      ]),
    ],
  );
}

function setPrimaryButtons({ href, label, note }) {
  for (const a of $$("[data-download-primary]")) {
    a.setAttribute("href", href);
    const text = $("[data-download-label]", a);
    if (text)
      text.textContent = a.classList.contains("btn--sm")
        ? label.replace(/^Download for /, "Get for ")
        : label;
  }
  const noteEl = $("[data-download-note]");
  if (noteEl && note) noteEl.textContent = note;
}

function showProblem(kind) {
  const meta = $("[data-release-meta]");
  const text =
    kind === "none"
      ? "No release has been published yet. Builds will appear here as soon as one is."
      : kind === "limited"
        ? "GitHub is limiting requests from your network right now. The downloads are on the releases page."
        : "The latest release couldn't be looked up just now. The downloads are on the releases page.";
  if (meta) meta.textContent = text;
  for (const list of $$("[data-os-list]")) {
    list.replaceChildren(
      el(
        "a",
        {
          class: "dl",
          href: kind === "none" ? RELEASES_URL : `${RELEASES_URL}/latest`,
          rel: "noopener",
        },
        [
          el("span", {
            class: "dl__label",
            text: kind === "none" ? "Releases on GitHub" : "Open the latest release",
          }),
          el("span", { class: "dl__detail", text: "github.com" }),
          el("span", { class: "dl__size" }, [icon("i-arrow")]),
        ],
      ),
    );
  }
  setPrimaryButtons({ href: "#download", label: "Download DataLiq", note: "" });
}

function render(release, os) {
  const version = release.version;
  for (const node of $$("[data-release-version]")) node.textContent = version;
  const pill = $("[data-release-pill]");
  if (pill) pill.textContent = `Version ${version} · free and open source`;
  const date = formatDate(release.publishedAt);
  const meta = $("[data-release-meta]");
  if (meta)
    meta.textContent = `Version ${version}${date ? `, released ${date}` : ""}. Free, with no account. Pick your system below.`;

  for (const card of $$("[data-os]")) {
    const name = card.dataset.os;
    const list = $("[data-os-list]", card);
    const items = release.downloads[name] ?? [];
    const yours = name === os;
    card.classList.toggle("is-yours", yours);
    if (yours) {
      card.style.order = "-1";
      if (!$(".os__badge", card))
        $("header", card).append(el("span", { class: "os__badge", text: "Your system" }));
    }
    if (items.length === 0) {
      list.replaceChildren(
        el("p", { class: "os__empty" }, [
          document.createTextNode(`This release has no ${OS_NAMES[name]} build. `),
          el("a", { href: RELEASES_URL, rel: "noopener", text: "See earlier releases" }),
        ]),
      );
      continue;
    }
    // The recommended download stands out on the visitor's own system
    // (on every card when the system isn't a desktop we know).
    list.replaceChildren(...items.map((d, i) => downloadLink(d, i === 0 && (yours || !os))));
  }

  const sums = $("[data-release-checksums]");
  if (sums && release.downloads.checksums) {
    sums.href = release.downloads.checksums;
    sums.hidden = false;
  }

  const notes = $("[data-release-notes]");
  const frag = notesFragment(release);
  if (notes && frag.textContent.trim()) {
    $("[data-release-body]", notes).replaceChildren(frag);
    $("[data-release-name]", notes).textContent = `version ${version}`;
    $("[data-release-link]", notes).href = release.url;
    notes.hidden = false;
  }

  const mine = os ? release.downloads[os]?.[0] : null;
  if (mine) {
    setPrimaryButtons({
      href: mine.url,
      label: `Download for ${OS_NAMES[os]}`,
      note: `Version ${version}${mine.size ? ` · ${mine.size}` : ""} · ${mine.label === "Installer" ? mine.detail.split(" · ")[0] : `${mine.label}, ${mine.detail.split(" · ")[0]}`}.`,
    });
  } else {
    setPrimaryButtons({
      href: "#download",
      label: os ? `Download for ${OS_NAMES[os]}` : "Download for desktop",
      note: os
        ? `Version ${version}.`
        : `Version ${version}. DataLiq is a desktop app for Windows, macOS and Linux.`,
    });
  }
}

export async function initReleases() {
  const os = detectOS({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
  const meta = $("[data-release-meta]");
  if (meta) meta.textContent = "Looking up the latest release…";
  const result = await latestRelease();
  if (result.release && result.release.hasDownloads) render(result.release, os);
  else if (result.release) {
    // A release without installers (source only): say so, link to it.
    render(result.release, os);
  } else showProblem(result.none ? "none" : result.error);
}
