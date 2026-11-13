// Page behaviour: navigation, reveals, the tour, the light/dark comparison,
// counters, hero parallax and the screenshot lightbox. No dependencies.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const shot = (name, width) => `assets/shots/${name}-${width}.webp`;
const srcset = (name) => `${shot(name, 1280)} 1280w, ${shot(name, 2560)} 2560w`;

function nav() {
  const bar = $("[data-nav]");
  if (!bar) return;
  const onScroll = () => bar.classList.toggle("is-stuck", scrollY > 12);
  onScroll();
  addEventListener("scroll", onScroll, { passive: true });

  // The section in view is marked in the navigation.
  const links = new Map($$(".nav__links a").map((a) => [a.getAttribute("href").slice(1), a]));
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links.values()) a.classList.remove("is-current");
        links.get(e.target.id)?.classList.add("is-current");
      }
    },
    { rootMargin: "-45% 0px -50% 0px" },
  );
  // The hero has no link: at the top nothing is marked.
  for (const id of [...links.keys(), "top"]) {
    const section = document.getElementById(id);
    if (section) seen.observe(section);
  }
}

function reveals() {
  const items = $$("[data-reveal]");
  if (!("IntersectionObserver" in window)) {
    for (const i of items) i.classList.add("is-in");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  for (const item of items) {
    // Neighbours come in one after another.
    const siblings = [...item.parentElement.children].filter((c) => c.hasAttribute("data-reveal"));
    item.style.setProperty("--d", `${Math.min(siblings.indexOf(item), 6) * 70}ms`);
    io.observe(item);
  }
}

/** Images outside the first screen get their sources here (the browser still loads them lazily). */
function lazyShots() {
  for (const img of $$("img[data-lazy]")) {
    const name = img.dataset.lazy;
    img.sizes = img.sizes || "(min-width: 1100px) 700px, 94vw";
    img.srcset = srcset(name);
    img.src = shot(name, 1280);
  }
}

function counters() {
  const run = (node) => {
    const target = Number(node.dataset.count);
    const decimals = Number(node.dataset.decimals ?? 0);
    if (calm.matches || !Number.isFinite(target)) return;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 1100);
      const eased = 1 - (1 - t) ** 3;
      node.textContent = (target * eased).toFixed(decimals);
      if (t < 1) requestAnimationFrame(tick);
      else node.textContent = target.toFixed(decimals);
    };
    requestAnimationFrame(tick);
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
  for (const node of $$("[data-count]")) io.observe(node);
}

function tour() {
  const root = $("[data-tour]");
  if (!root) return;
  const tabs = $$('[role="tab"]', root);
  const panel = $('[role="tabpanel"]', root);
  const title = $("[data-tour-title]", root);
  const images = new Map($$("[data-tour-img]", root).map((img) => [img.dataset.tourImg, img]));
  const PERIOD = 7000;
  let current = 0;
  let auto = !calm.matches;
  let paused = false;
  let visible = false;
  let elapsed = 0;
  let last = 0;

  const load = (img) => {
    if (!img || img.src) return;
    img.sizes = "(min-width: 1100px) 780px, 94vw";
    img.srcset = srcset(img.dataset.src);
    img.src = shot(img.dataset.src, 1280);
  };

  const select = (index, { focus = false } = {}) => {
    current = (index + tabs.length) % tabs.length;
    elapsed = 0;
    tabs.forEach((tab, i) => {
      const on = i === current;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.style.setProperty("--p", "0");
    });
    const tab = tabs[current];
    const img = images.get(tab.dataset.shot);
    load(img);
    load(images.get(tabs[(current + 1) % tabs.length].dataset.shot));
    for (const other of images.values()) other.classList.toggle("is-active", other === img);
    panel.setAttribute("aria-labelledby", tab.id);
    if (title) title.textContent = tab.dataset.title;
    if (focus) tab.focus();
    // On narrow screens the tabs scroll sideways: keep the chosen one in view.
    if (tab.parentElement.scrollWidth > tab.parentElement.clientWidth) {
      tab.parentElement.scrollTo({
        left: tab.offsetLeft - (tab.parentElement.clientWidth - tab.offsetWidth) / 2,
        behavior: calm.matches ? "auto" : "smooth",
      });
    }
  };

  const stop = () => {
    auto = false;
    for (const tab of tabs) tab.style.setProperty("--p", "0");
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      stop();
      select(i);
    });
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (step) {
        e.preventDefault();
        stop();
        select(current + step, { focus: true });
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        stop();
        select(e.key === "Home" ? 0 : tabs.length - 1, { focus: true });
      }
    });
  });

  // Advances on its own while it is on screen and nobody is using it.
  for (const type of ["pointerenter", "focusin"])
    root.addEventListener(type, () => (paused = true));
  for (const type of ["pointerleave", "focusout"])
    root.addEventListener(type, () => (paused = false));
  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.35 }).observe(
    root,
  );
  const frame = (now) => {
    const dt = last ? now - last : 0;
    last = now;
    if (auto && visible && !paused && !document.hidden) {
      elapsed += Math.min(dt, 100);
      tabs[current].style.setProperty("--p", String(Math.min(1, elapsed / PERIOD)));
      if (elapsed >= PERIOD) select(current + 1);
    }
    if (auto) requestAnimationFrame(frame);
  };
  if (auto) requestAnimationFrame(frame);
  load(images.get(tabs[1].dataset.shot));

  // The enlarge button shows the frame on screen at full size.
  const box = $("[data-lightbox]");
  const zoom = $("[data-zoom]", root);
  if (box && zoom && typeof box.showModal === "function") {
    zoom.addEventListener("click", () => {
      const tab = tabs[current];
      const big = $("img", box);
      big.src = shot(tab.dataset.shot, 2560);
      big.alt = images.get(tab.dataset.shot)?.alt ?? "";
      paused = true;
      box.showModal();
    });
    box.addEventListener("click", (e) => {
      if (e.target === box) box.close();
    });
    box.addEventListener("close", () => (paused = false));
  } else if (zoom) zoom.hidden = true;
}

function compare() {
  for (const root of $$("[data-compare]")) {
    const stage = $(".compare__stage", root);
    const range = $(".compare__range", root);
    if (!stage || !range) continue;
    const set = () => stage.style.setProperty("--pos", `${range.value}%`);
    range.addEventListener("input", set);
    set();
    // A gentle nudge the first time it scrolls into view shows that it moves.
    if (calm.matches) continue;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const from = Number(range.value);
        const start = performance.now();
        const sway = (now) => {
          const t = (now - start) / 1400;
          if (t >= 1 || document.activeElement === range) return;
          range.value = String(from + Math.sin(t * Math.PI * 2) * 14 * (1 - t));
          set();
          requestAnimationFrame(sway);
        };
        requestAnimationFrame(sway);
        range.addEventListener("pointerdown", () => (range.dataset.touched = "1"), { once: true });
      },
      { threshold: 0.55 },
    );
    io.observe(stage);
  }
}

/** The hero's windows and chips drift at different speeds while scrolling. */
function parallax() {
  const root = $("[data-parallax-root]");
  if (!root || calm.matches) return;
  const layers = $$("[data-parallax]", root).map((node) => ({
    node,
    factor: Number(node.dataset.parallax),
    tilt: getComputedStyle(node).getPropertyValue("--tilt").trim() || "0deg",
  }));
  const wide = matchMedia("(min-width: 701px)");
  let queued = false;
  const paint = () => {
    queued = false;
    const y = wide.matches ? Math.min(scrollY, 1400) : 0;
    for (const { node, factor, tilt } of layers)
      node.style.transform = `translate3d(0, ${(y * factor).toFixed(1)}px, 0) rotate(${tilt})`;
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };
  addEventListener("scroll", onScroll, { passive: true });
  wide.addEventListener("change", paint);
  paint();
}

export function initSite() {
  nav();
  lazyShots();
  reveals();
  counters();
  tour();
  compare();
  parallax();
}
