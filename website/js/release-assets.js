// What a GitHub release holds, sorted into downloads per desktop OS.
// Pure functions (no DOM), so `node --test scripts/website.test.mjs` can check them.

/** The repository the site belongs to. */
export const REPO = "Mukesh-devs/dataliq";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * Installer kinds by file name, in the order they are offered. The first
 * match of an OS is its recommended download.
 */
const KINDS = [
  {
    os: "windows",
    test: /[-_]setup\.exe$/i,
    label: "Installer",
    detail: "Windows 10 and 11, 64-bit · .exe",
  },
  { os: "windows", test: /\.msi$/i, label: "MSI package", detail: "For managed installs · .msi" },
  {
    os: "macos",
    test: /(aarch64|arm64)\.dmg$/i,
    label: "Apple silicon",
    detail: "M1 and later · .dmg",
  },
  {
    os: "macos",
    test: /universal\.dmg$/i,
    label: "Universal",
    detail: "Apple silicon and Intel · .dmg",
  },
  { os: "macos", test: /(x64|x86_64|intel)\.dmg$/i, label: "Intel", detail: "Intel Macs · .dmg" },
  { os: "macos", test: /\.dmg$/i, label: "Disk image", detail: ".dmg" },
  { os: "linux", test: /\.AppImage$/i, label: "AppImage", detail: "Runs on most distributions" },
  { os: "linux", test: /\.deb$/i, label: ".deb", detail: "Debian, Ubuntu, Mint" },
  { os: "linux", test: /\.rpm$/i, label: ".rpm", detail: "Fedora, openSUSE, RHEL" },
];

export const OS_NAMES = { windows: "Windows", macos: "macOS", linux: "Linux" };

/** "14.6 MB", "980 KB". */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / 1e6;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Only links to GitHub are ever shown as downloads. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)github(usercontent)?\.com$/.test(u.hostname)
      ? u.href
      : null;
  } catch {
    return null;
  }
}

/**
 * A release's assets as `{ windows: [], macos: [], linux: [], checksums }`:
 * each download with its label, detail, URL and size, the recommended one
 * first. Files that aren't installers (signatures, the updater's manifest,
 * update archives) are left out.
 */
export function classifyAssets(assets) {
  const out = { windows: [], macos: [], linux: [], checksums: null };
  for (const asset of Array.isArray(assets) ? assets : []) {
    const name = String(asset?.name ?? "");
    const url = safeUrl(asset?.browser_download_url);
    if (!name || !url) continue;
    if (/^sha256sums/i.test(name)) {
      out.checksums = url;
      continue;
    }
    const rank = KINDS.findIndex((k) => k.test.test(name));
    if (rank < 0) continue;
    const kind = KINDS[rank];
    out[kind.os].push({
      rank,
      name,
      url,
      label: kind.label,
      detail: kind.detail,
      size: formatSize(Number(asset.size)),
    });
  }
  for (const os of Object.keys(OS_NAMES)) out[os].sort((a, b) => a.rank - b.rank);
  return out;
}

/**
 * The visitor's desktop OS: "windows", "macos", "linux", or null on a phone,
 * a tablet or anything unknown (DataLiq is a desktop app).
 */
export function detectOS({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  const ua = `${userAgent} ${platform}`;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return null;
  // iPadOS says it is a Mac; a Mac has no touch screen.
  if (/Mac/i.test(ua)) return maxTouchPoints > 1 ? null : "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return null;
}

/** What the site needs of a release from the API (null when it isn't one). */
export function summarize(release) {
  if (!release || typeof release !== "object" || !release.tag_name) return null;
  const downloads = classifyAssets(release.assets);
  const tag = String(release.tag_name);
  return {
    tag,
    version: tag.replace(/^v/i, ""),
    name: String(release.name || tag),
    url: safeUrl(release.html_url) ?? `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
    publishedAt: release.published_at ?? null,
    downloads,
    hasDownloads: Object.keys(OS_NAMES).some((os) => downloads[os].length > 0),
    notesHtml: typeof release.body_html === "string" ? release.body_html : "",
    notesText: typeof release.body === "string" ? release.body : "",
  };
}

/** "29 October 2026" (or "" when the date is missing or wrong). */
export function formatDate(iso, locale = "en-GB") {
  const d = new Date(iso ?? NaN);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
