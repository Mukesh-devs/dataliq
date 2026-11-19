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

/** ".exe", ".dmg", ".AppImage": the kind of file, from its name. */
const extOf = (name) => `.${name.split(".").pop()}`;

/** "Installer · .exe", "AppImage" (its name says the kind already). */
const kindOf = (d) => {
  const ext = extOf(d.name);
  return d.label.toLowerCase().includes(ext.slice(1).toLowerCase())
    ? d.label
    : `${d.label} · ${ext}`;
};

/** A download's detail without the trailing ".exe" (the file name says it). */
const plainDetail = (detail) => detail.replace(/ · \.\w+$/, "");

const OS_ICONS = { windows: "i-windows", macos: "i-apple", linux: "i-linux" };
const SYSTEMS = Object.keys(OS_NAMES);

/* ------------------------------------------------ the recommended file */
function recPanel({ iconId, kicker, title, meta, action }) {
  const rec = $("[data-rec]");
  if (!rec) return;
  rec.replaceChildren(
    el("span", { class: "rec__icon" }, [icon(iconId)]),
    el("div", {}, [
      el("p", { class: "rec__kicker", text: kicker }),
      el("h3", { class: "rec__title", text: title }),
      meta ? el("p", { class: "rec__meta" }, meta) : null,
    ]),
    ...(action ? [action] : []),
  );
}

function downloadButton(d) {
  return el("a", { class: "btn btn--primary", href: d.url, rel: "noopener", download: "" }, [
    icon("i-download"),
    el("span", { text: `Download ${extOf(d.name)}` }),
    d.size ? el("small", { text: d.size }) : null,
  ]);
}

function linkButton(href, text, iconId = "i-out") {
  return el("a", { class: "btn", href, rel: "noopener" }, [icon(iconId), el("span", { text })]);
}

/* --------------------------------------- every file: the workbook sheet */
function fileRow(d, i) {
  return el("a", { class: "book__row", href: d.url, rel: "noopener", download: "" }, [
    el("span", { text: String(i + 1) }),
    el("span", { class: "book__file" }, [
      el("b", {}, [
        document.createTextNode(d.label),
        i === 0 ? el("span", { class: "book__chip", text: "Recommended" }) : null,
      ]),
      el("small", { text: d.name, title: d.name }),
    ]),
    el("span", { class: "book__for", text: plainDetail(d.detail) }),
    el("span", { class: "book__size", text: d.size || "" }),
    el("span", {}, [el("span", { class: "book__get" }, [icon("i-download")])]),
  ]);
}

function messageRow(children) {
  return el("div", { class: "book__row" }, [
    el("span", { text: "1" }),
    el("span", { class: "book__empty" }, children),
  ]);
}

/** The sheet tabs: one per system, arrow keys move between them. */
function tabs(onSelect) {
  const list = $("[data-dl-tabs]");
  const panel = $("#dl-panel");
  if (!list || !panel) return () => {};
  const buttons = $$("[data-os-tab]", list);
  const select = (os, focus = false) => {
    for (const b of buttons) {
      const on = b.dataset.osTab === os;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) {
        panel.setAttribute("aria-labelledby", b.id);
        if (focus) b.focus();
      }
    }
    onSelect(os);
  };
  for (const b of buttons) b.addEventListener("click", () => select(b.dataset.osTab));
  list.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % buttons.length
        : e.key === "ArrowLeft"
          ? (i - 1 + buttons.length) % buttons.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    select(buttons[next].dataset.osTab, true);
  });
  return select;
}

function setPrimaryButtons({ href, label, note }) {
  for (const a of $$("[data-download-primary]")) {
    a.setAttribute("href", href);
    const text = $("[data-download-label]", a);
    if (text)
      text.textContent = a.classList.contains("nav__get")
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
  const href = kind === "none" ? RELEASES_URL : `${RELEASES_URL}/latest`;
  recPanel({
    iconId: "i-download",
    kicker: kind === "none" ? "Coming soon" : "On GitHub",
    title: "Find the installers on GitHub",
    meta: [el("span", { text: "Windows, macOS and Linux, from the project's releases page." })],
    action: linkButton(href, kind === "none" ? "Releases" : "Latest release"),
  });
  const list = $("[data-dl-tabs]");
  if (list) list.hidden = true;
  $("#dl-panel")?.removeAttribute("role");
  $("[data-dl-rows]")?.replaceChildren(
    messageRow([
      document.createTextNode("The file list isn't available right now. "),
      el("a", { href, rel: "noopener", text: "See every file on GitHub" }),
    ]),
  );
  setPrimaryButtons({ href: "#download", label: "Download DataLiq", note: "" });
}

function render(release, os) {
  const version = release.version;
  for (const node of $$("[data-release-version]")) node.textContent = `v${version}`;
  const date = formatDate(release.publishedAt);
  const meta = $("[data-release-meta]");
  if (meta) meta.textContent = `Version ${version}${date ? `, released ${date}` : ""}.`;

  // The file for this computer, with one big button.
  const mine = os ? release.downloads[os]?.[0] : null;
  if (mine) {
    recPanel({
      iconId: OS_ICONS[os],
      kicker: "Recommended for this computer",
      title: `DataLiq for ${OS_NAMES[os]}`,
      meta: [
        el("span", { text: `${mine.label} · ${plainDetail(mine.detail)}` }),
        el("code", { text: mine.name }),
      ],
      action: downloadButton(mine),
    });
  } else if (os) {
    recPanel({
      iconId: OS_ICONS[os],
      kicker: "Your system",
      title: `No ${OS_NAMES[os]} build in version ${version}`,
      meta: [el("span", { text: "Earlier releases may have one." })],
      action: linkButton(RELEASES_URL, "All releases"),
    });
  } else {
    recPanel({
      iconId: "i-download",
      kicker: `Version ${version}`,
      title: "DataLiq is a desktop app",
      meta: [el("span", { text: "For Windows, macOS and Linux. Pick your system below." })],
      action: null,
    });
  }

  // Every file, one sheet per system; this computer's system first shown.
  const rows = $("[data-dl-rows]");
  const show = (name) => {
    const items = release.downloads[name] ?? [];
    rows?.replaceChildren(
      ...(items.length
        ? items.map(fileRow)
        : [
            messageRow([
              document.createTextNode(`This release has no ${OS_NAMES[name]} build. `),
              el("a", { href: RELEASES_URL, rel: "noopener", text: "See earlier releases" }),
            ]),
          ]),
    );
  };
  for (const b of $$("[data-os-tab]")) {
    const yours = b.dataset.osTab === os;
    b.classList.toggle("is-yours", yours);
    if (yours) b.title = "Your system";
  }
  tabs(show)(os && SYSTEMS.includes(os) ? os : "windows");

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

  if (mine) {
    setPrimaryButtons({
      href: mine.url,
      label: `Download for ${OS_NAMES[os]}`,
      note: `For ${OS_NAMES[os]} · ${kindOf(mine)}${mine.size ? ` · ${mine.size}` : ""}`,
    });
  } else {
    setPrimaryButtons({
      href: "#download",
      label: os ? `Download for ${OS_NAMES[os]}` : "Download for desktop",
      note: os ? `Version ${version}` : "DataLiq is a desktop app for Windows, macOS and Linux",
    });
  }
}

export async function initReleases() {
  const os = detectOS({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
  const result = await latestRelease();
  // A release without installers (source only) still shows, with its links.
  if (result.release) render(result.release, os);
  else showProblem(result.none ? "none" : result.error);
}
