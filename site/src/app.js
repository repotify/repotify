// Repotify site: scroll reveals, the typed terminal, copy buttons, card spotlight, the language menu, a hint towards
// the visitor's own language, and the live GitHub star count.
// Everything is progressive: without this file the page is complete, and reduced motion turns the motion off.
(() => {
  const doc = document.documentElement;
  doc.classList.add("ready");
  const lang = doc.lang || "en";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (el, fn, threshold = 0.25) => {
    if (!("IntersectionObserver" in window)) return fn();
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      fn();
    }, { threshold, rootMargin: "0px 0px -6% 0px" });
    io.observe(el);
  };

  // Reveal on scroll.
  for (const el of document.querySelectorAll(".reveal")) {
    if (reduce) el.classList.add("in");
    else once(el, () => el.classList.add("in"), 0.12);
  }

  // The terminal types its commands and prints the output line by line.
  const term = document.querySelector("[data-typed]");
  if (term) {
    const lines = [...term.children];
    if (reduce) lines.forEach((l) => l.classList.add("shown"));
    else once(term, async () => {
      for (const line of lines) {
        if (line.classList.contains("c")) {
          const html = line.innerHTML;
          const text = line.textContent;
          line.textContent = "";
          line.classList.add("shown", "caret");
          for (let i = 1; i <= text.length; i++) {
            line.textContent = text.slice(0, i);
            await wait(16 + Math.random() * 38);
          }
          line.innerHTML = html;
          await wait(320);
          line.classList.remove("caret");
        } else {
          line.classList.add("shown");
          await wait(120);
        }
      }
      lines.at(-1).classList.add("caret");
    }, 0.35);
  }

  // Copy the install command.
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(button.previousElementSibling);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      const label = button.textContent;
      button.textContent = button.dataset.done;
      button.classList.add("done");
      setTimeout(() => {
        button.textContent = label;
        button.classList.remove("done");
      }, 1600);
    });
  }

  // A soft light follows the pointer across cards.
  if (!reduce) {
    for (const card of document.querySelectorAll(".card")) {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    }
  }

  // Language menu: close on an outside click or Escape.
  const menu = document.querySelector(".lang");
  if (menu) {
    document.addEventListener("click", (e) => {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
    });
  }

  // If the browser prefers another language this page exists in, offer it once (never redirect).
  try {
    const links = [...document.querySelectorAll(".lang a[hreflang]")];
    const current = lang.toLowerCase();
    const wanted = (navigator.languages || [navigator.language]).map((l) => l.toLowerCase());
    let match = null;
    for (const w of wanted) {
      match = links.find((a) => a.hreflang.toLowerCase() === w) || links.find((a) => a.hreflang.toLowerCase().split("-")[0] === w.split("-")[0]);
      if (match) break;
    }
    if (match && match.hreflang.toLowerCase() !== current && !localStorage.getItem("repotify-lang-hint")) {
      const hint = document.createElement("a");
      hint.className = "lang-hint";
      hint.href = match.href;
      hint.lang = match.hreflang;
      hint.dir = "auto";
      hint.textContent = `🌐 ${match.textContent}`;
      hint.addEventListener("click", () => localStorage.setItem("repotify-lang-hint", "1"));
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Dismiss");
      close.addEventListener("click", (e) => {
        e.preventDefault();
        localStorage.setItem("repotify-lang-hint", "1");
        hint.remove();
      });
      hint.append(close);
      document.body.append(hint);
    }
  } catch {
    // Storage may be blocked; the hint is optional.
  }

  // Scroll progress bar.
  const bar = document.querySelector("[data-progress]");
  if (bar) {
    const update = () => {
      const max = doc.scrollHeight - doc.clientHeight;
      const y = window.scrollY || doc.scrollTop;
      bar.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    };
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    update();
  }

  // Scrollspy: mark the nav link of the section in view.
  const navLinks = [...document.querySelectorAll(".links a[href^='#']")];
  const targets = navLinks.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  if (navLinks.length && targets.length && "IntersectionObserver" in window) {
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = "#" + e.target.id;
        navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === id));
      }
    }, { rootMargin: "-35% 0px -55% 0px" });
    targets.forEach((t) => spy.observe(t));
  }

  // Count-up stats.
  const fmt = (n) => n.toLocaleString("en-US");
  for (const el of document.querySelectorAll("[data-count]")) {
    const target = Number.parseInt(el.dataset.count, 10);
    if (!Number.isFinite(target)) continue;
    if (reduce || !("IntersectionObserver" in window)) { el.textContent = fmt(target); continue; }
    once(el, () => {
      const t0 = performance.now(), dur = 1400;
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, 0.4);
  }

  // Live star count from GitHub's public API, cached for an hour (the only request to another site).
  const star = document.querySelector("[data-stars]");
  if (star) {
    const show = (n) => {
      if (!(n >= 100)) return; // a small count says nothing useful yet
      star.textContent = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1, numberingSystem: "latn" }).format(n);
      star.hidden = false;
    };
    try {
      const cached = JSON.parse(sessionStorage.getItem("repotify-stars") || "null");
      if (cached && Date.now() - cached.t < 3600000) show(cached.n);
      else fetch("https://api.github.com/repos/repotify/repotify")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          sessionStorage.setItem("repotify-stars", JSON.stringify({ t: Date.now(), n: d.stargazers_count }));
          show(d.stargazers_count);
        })
        .catch(() => {});
    } catch {
      // Offline or storage blocked: the button still links to GitHub.
    }
  }
})();
