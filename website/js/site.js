// The page's behaviour. Everything here is an enhancement: the content and
// the download links work without it.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Runs `fn` at most once a frame. */
function perFrame(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

/* ------------------------------------------------------------- theme */
function theme() {
  const root = document.documentElement;
  const button = $("[data-theme-toggle]");
  const label = () =>
    button?.setAttribute(
      "aria-label",
      root.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
    );
  label();
  button?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("dataliq.site.theme", root.dataset.theme);
    } catch {
      // Remembered for this page only.
    }
    label();
  });
}

/* --------------------------------------------------------------- nav */
function nav() {
  const menu = $("[data-menu]");
  const toggle = $("[data-menu-toggle]");
  const close = () => {
    menu?.classList.remove("is-open");
    toggle?.setAttribute("aria-expanded", "false");
  };
  toggle?.addEventListener("click", () => {
    const open = !menu.classList.contains("is-open");
    menu.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  menu?.addEventListener("click", (e) => e.target.closest("a") && close());
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());

  // The section in view lights up in the menu and in the row header.
  const links = new Map();
  for (const a of $$('.nav__links a[href^="#"], [data-rows] a'))
    links.set(a, a.getAttribute("href").slice(1));
  const sections = $$("main > section[id]");
  const mark = (id) => {
    for (const [a, target] of links) a.classList.toggle("is-on", target === id);
  };
  const io = new IntersectionObserver(
    (entries) => {
      const seen = entries.filter((e) => e.isIntersecting);
      if (seen.length)
        mark(seen.sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0].target.id);
    },
    { rootMargin: "-35% 0px -55% 0px", threshold: [0, 0.2, 0.6] },
  );
  for (const s of sections) io.observe(s);
}

/* ------------------------------------------- the hero as a spreadsheet */
const columnName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function sheet() {
  const box = $("[data-sheet]");
  if (!box) return;
  const cols = $("[data-sheet-cols]", box);
  const rows = $("[data-sheet-rows]", box);
  const cell = $("[data-sheet-cell]", box);
  const name = $("[data-sheet-name]", box);
  let size = 64;
  let head = 26;

  const build = () => {
    const style = getComputedStyle(box);
    size = parseFloat(style.getPropertyValue("--cell")) || 64;
    head = parseFloat(style.getPropertyValue("--head")) || 26;
    const nc = Math.ceil((box.clientWidth - head) / size) + 1;
    const nr = Math.ceil((box.clientHeight - head) / size) + 1;
    cols.replaceChildren(
      ...Array.from({ length: nc }, (_, i) =>
        Object.assign(document.createElement("span"), { textContent: columnName(i) }),
      ),
    );
    rows.replaceChildren(
      ...Array.from({ length: nr }, (_, i) =>
        Object.assign(document.createElement("span"), { textContent: String(i + 1) }),
      ),
    );
  };
  build();
  new ResizeObserver(perFrame(build)).observe(box);

  if (!finePointer()) return;
  let last = "";
  const select = (c, r) => {
    const key = `${c}:${r}`;
    if (key === last) return;
    last = key;
    cell.style.transform = `translate(${head + c * size}px, ${head + r * size}px)`;
    for (const [i, s] of [...cols.children].entries()) s.classList.toggle("is-on", i === c);
    for (const [i, s] of [...rows.children].entries()) s.classList.toggle("is-on", i === r);
    name.textContent = `${columnName(c)}${r + 1}`;
  };
  box.addEventListener("pointermove", (e) => {
    const r0 = box.getBoundingClientRect();
    const x = e.clientX - r0.left - head;
    const y = e.clientY - r0.top - head;
    if (x < 0 || y < 0) return;
    box.classList.add("is-live");
    select(Math.floor(x / size), Math.floor(y / size));
  });
  box.addEventListener("pointerleave", () => {
    box.classList.remove("is-live");
    for (const s of $$(".is-on", box)) s.classList.remove("is-on");
    last = "";
    name.textContent = "A1";
  });
}

/* ------------------------------------------------------------ reveals */
function reveals() {
  const items = $$(".reveal");
  if (reduced() || !("IntersectionObserver" in window)) {
    for (const el of items) el.classList.add("in");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  for (const el of items) io.observe(el);
}

/* ------------------------------------------- the showcase, tilted back */
function tilt() {
  const fig = $("[data-tilt]");
  const win = fig && $(".window", fig);
  if (!win || reduced()) return;
  const update = () => {
    const r = fig.getBoundingClientRect();
    const vh = innerHeight;
    // Flat once its top reaches a fifth of the window; tilted below that.
    const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.8)));
    win.style.setProperty("--tilt", `${(1 - p) * 18}deg`);
    win.style.setProperty("--zoom", String(0.94 + p * 0.06));
  };
  update();
  addEventListener("scroll", perFrame(update), { passive: true });
  addEventListener("resize", perFrame(update));
}

/* -------------------------------------------- the ruler on the right */
function ruler() {
  const mark = $("[data-ruler-mark]");
  const value = $("[data-ruler-value]");
  if (!mark) return;
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, scrollY / max) : 0;
    const rail = mark.parentElement.clientHeight - 22;
    mark.style.top = `${Math.round(p * rail)}px`;
    value.textContent = String(Math.round(p * 100)).padStart(3, "0");
  };
  update();
  addEventListener("scroll", perFrame(update), { passive: true });
  addEventListener("resize", perFrame(update));
}

/* ----------------------------------------------------------- counters */
function counters() {
  const items = $$("[data-count]");
  if (reduced()) return;
  const run = (el) => {
    const to = Number(el.dataset.count);
    const dec = Number(el.dataset.decimals ?? 0);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1100);
      const eased = 1 - (1 - k) ** 3;
      el.textContent = (to * eased).toFixed(dec);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        run(e.target);
        io.unobserve(e.target);
      }
    },
    { threshold: 0.6 },
  );
  for (const el of items) io.observe(el);
}

/* -------------------------------------- the speed cells' formula bar */
function cells() {
  const ref = $("[data-fx-ref]");
  const text = $("[data-fx-text]");
  const all = $$("[data-cells] .cell");
  if (!ref || !all.length) return;
  const pick = (c) => {
    for (const x of all) x.classList.toggle("is-on", x === c);
    ref.textContent = c.dataset.ref;
    text.textContent = c.dataset.fx;
  };
  for (const c of all) {
    c.tabIndex = 0;
    c.addEventListener("pointerenter", () => pick(c));
    c.addEventListener("focus", () => pick(c));
  }
  pick(all[0]);
}

/* ------------------------------------------------------- the ticker */
function ticker() {
  const track = $("[data-ticker]");
  if (!track) return;
  // A second copy makes the loop seamless; it isn't read twice.
  for (const li of [...track.children]) {
    const copy = li.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    track.append(copy);
  }
}

/* ------------------------------------------------ terminal, typed out */
function terminal() {
  const term = $("[data-term]");
  if (!term || reduced()) return;
  const lines = $$("[data-type]", term);
  const texts = lines.map((l) => l.textContent);
  for (const l of lines) l.textContent = "";
  const type = async () => {
    for (const [i, l] of lines.entries()) {
      l.classList.add("is-typing");
      for (const ch of texts[i]) {
        l.textContent += ch;
        await new Promise((r) => setTimeout(r, 18 + Math.random() * 30));
      }
      l.classList.remove("is-typing");
      await new Promise((r) => setTimeout(r, 260));
    }
  };
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void type();
    },
    { threshold: 0.4 },
  );
  io.observe(term);
}

/* ---------------------------------------------------------- lightbox */
function lightbox() {
  const dialog = $("[data-lightbox]");
  const img = $("[data-lightbox-img]");
  if (!dialog || typeof dialog.showModal !== "function") return;
  for (const button of $$("[data-zoom]")) {
    button.addEventListener("click", () => {
      const shown = [...button.querySelectorAll("img")].find((i) => i.offsetParent !== null);
      if (!shown) return;
      // The largest version in its srcset.
      const big = (shown.getAttribute("srcset") ?? "").split(",").pop()?.trim().split(/\s+/)[0];
      img.src = big || shown.currentSrc || shown.src;
      img.alt = shown.alt;
      dialog.showModal();
    });
  }
  $("[data-lightbox-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
}

/* --------------------------- the footer's wordmark, fitted to its width */
function fitMark() {
  const word = $("[data-fit]");
  const box = word?.parentElement;
  if (!word || !box) return;
  const fit = () => {
    const style = getComputedStyle(box);
    const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const size = parseFloat(style.fontSize);
    const width = word.getBoundingClientRect().width;
    if (width > 0) box.style.fontSize = `${Math.floor(size * (room / width) * 0.995)}px`;
  };
  document.fonts?.ready.then(fit);
  new ResizeObserver(perFrame(fit)).observe(box);
}

export function initSite() {
  theme();
  nav();
  sheet();
  reveals();
  tilt();
  ruler();
  counters();
  cells();
  ticker();
  terminal();
  lightbox();
  fitMark();
}
