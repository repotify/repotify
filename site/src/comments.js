// Repotify skill comments — v1 client-side prototype (FAZ 8.2).
// No stars, no ratings: experience reports only.
// Storage: localStorage only. Submitted comments land in a per-skill "pending"
// queue. The moderation Approve/Reject buttons are DEMO-ONLY: they render only
// with ?demo=moderation in the URL (b2). On public pages the queue is read-only,
// so the page never performs moderation theater in front of visitors.
// Approved community comments shipped with the site build come from
// assets/data/comments.json. Production pipeline: site/COMMENTS-DESIGN.md.
(() => {
  const section = document.getElementById("comments");
  if (!section) return;
  const skill = section.dataset.skill;
  const root = window.__REPOTIFY_ROOT || "./";
  // b2: moderation simulation lives behind ?demo=moderation.
  const DEMO_MOD = (() => {
    try { return new URLSearchParams(location.search).get("demo") === "moderation"; }
    catch { return false; }
  })();
  const K = (k) => `repotify-comments-v1:${skill}:${k}`;
  // b1: XSS invariant — EVERY user-controlled field passes through esc()
  // before it touches innerHTML. No raw interpolation of name/text/
  // projectType/ts/id anywhere below.
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(K(k))) ?? fb; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(K(k), JSON.stringify(v)); } catch {} };
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // b3: every locally stored card carries its own "this browser only" microcopy.
  const commentHtml = (c, local) => `
    <article class="comment">
      <header><b>${esc(c.name || "Anonymous")}</b><span class="muted"> · ${esc(c.projectType || "other")} · ${esc((c.ts || "").slice(0, 10))}</span>${local ? `<span class="muted"> · saved in this browser only</span>` : ""}</header>
      <p>${esc(c.text)}</p>
    </article>`;

  // b2: Approve/Reject exist only in demo mode; public pages get no buttons.
  const modbtns = DEMO_MOD
    ? `<div class="modbtns"><button type="button" data-act="approve">Approve</button>
        <button type="button" data-act="reject">Reject</button></div>`
    : "";

  const render = (shipped) => {
    const local = load("approved-local", []);
    const all = [...shipped.map((c) => [c, false]), ...local.map((c) => [c, true])]
      .sort((a, b) => String(b[0].ts).localeCompare(String(a[0].ts)));
    const list = document.getElementById("clist");
    list.innerHTML = all.length
      ? all.map(([c, isLocal]) => commentHtml(c, isLocal)).join("")
      : `<p class="muted">No experiences shared yet — be the first.</p>`;
    const pending = load("pending", []);
    const mq = document.getElementById("mqueue");
    mq.innerHTML = pending.length
      ? pending.map((c) => `<div class="moditem" data-id="${esc(c.id)}">${commentHtml(c, true)}${modbtns}</div>`).join("")
        + (DEMO_MOD ? "" : `<p class="muted small">Approve/Reject is a demo-only simulation — add <code>?demo=moderation</code> to this page's URL to try it.</p>`)
      : `<p class="muted">Empty.</p>`;
  };

  fetch(`${root}assets/data/comments.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const shipped = (d?.comments ?? []).filter((c) => c.skill === skill);
      render(shipped);
      document.getElementById("mqueue").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const item = btn.closest(".moditem");
        const id = item?.dataset.id;
        let pending = load("pending", []);
        const c = pending.find((x) => x.id === id);
        pending = pending.filter((x) => x.id !== id);
        save("pending", pending);
        if (c && btn.dataset.act === "approve") {
          const local = load("approved-local", []);
          local.push({ ...c, status: "approved" });
          save("approved-local", local);
        }
        render(shipped);
      });
      document.getElementById("cform").addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const text = String(fd.get("text") || "").trim();
        if (!text) return;
        const pending = load("pending", []);
        pending.push({
          id: uid(), ts: new Date().toISOString(), skill,
          name: String(fd.get("name") || "").trim().slice(0, 60) || null,
          projectType: String(fd.get("projectType") || "other"),
          text: text.slice(0, 2000), status: "pending",
        });
        save("pending", pending);
        e.target.reset();
        render(shipped);
        document.querySelector(".modq").open = true;
      });
    })
    .catch(() => {
      document.getElementById("clist").innerHTML = `<p class="muted">Comments unavailable offline.</p>`;
    });
})();
