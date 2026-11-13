// The #answers panel, for real. The forty-five prepared questions are rendered into the page by
// scripts/build-answers.mjs, so they read with JavaScript off; this file makes them work:
//
//   search filters the rows · the sidebar filters by group and topic · a row opens its written
//   answer · "Ask this out loud" puts the question to the live voice · the box at the foot asks
//   for real and the answer streams back here.
//
// There is one voice session on the page. This panel borrows app.js's rather than opening a second.
import { askTyped, askOutLoud, onEvent } from "./app.js";

const root = document.querySelector("[data-answers]");
if (root) init(root);

function init(root) {
  const rows = [...root.querySelectorAll("[data-row]")];
  const docs = new Map([...root.querySelectorAll("[data-doc]")].map((d) => [d.dataset.doc, d]));
  const navs = [...root.querySelectorAll("[data-filter]")];
  const search = root.querySelector("[data-search]");
  const empty = root.querySelector("[data-empty]");
  const body = root.querySelector("[data-body]");
  const thread = root.querySelector("[data-thread]");
  const form = root.querySelector("[data-ask-form]");
  const input = root.querySelector("[data-ask-input]");
  const statusEl = root.querySelector("[data-panel-status]");
  const back = root.querySelector("[data-back]");
  if (!rows.length || !docs.size) return;

  const IDLE_STATUS = statusEl?.textContent.trim() || "Written answers";
  const spoken = new Set();
  let filter = "all";
  let selected = null;

  /* ---------------------------------------------------------------- rows */

  const visible = () => rows.filter((r) => !r.hidden);

  function setStatusWord(row) {
    const st = row.querySelector("[data-st]");
    if (!st) return;
    const id = row.dataset.id;
    const word = spoken.has(id) ? "Asked" : row === selected ? "Open" : "Ready";
    st.textContent = word;
    st.className = `ui-win__st ${word === "Asked" ? "is-done" : word === "Open" ? "is-you" : ""}`.trim();
  }

  function select(row, { focus = false, scroll = true } = {}) {
    if (!row) return;
    selected = row;
    for (const r of rows) {
      const on = r === row;
      r.setAttribute("aria-selected", on ? "true" : "false");
      r.tabIndex = on ? 0 : -1;
      const doc = docs.get(r.dataset.id);
      if (doc) doc.hidden = !on;
      setStatusWord(r);
    }
    root.classList.add("is-open");
    if (scroll) row.scrollIntoView({ block: "nearest" });
    if (focus) row.focus();
    if (body) body.scrollTop = 0;
  }

  function markSpoken(id) {
    if (!id || spoken.has(id)) return;
    spoken.add(id);
    const row = rows.find((r) => r.dataset.id === id);
    if (row) setStatusWord(row);
  }

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9#\s]/g, " ").replace(/\s+/g, " ").trim();

  function apply() {
    const q = norm(search?.value || "");
    const terms = q ? q.split(" ") : [];
    let shown = 0;
    for (const row of rows) {
      const inFilter =
        filter === "all" ||
        (filter.startsWith("group:") && row.dataset.group === filter.slice(6)) ||
        (filter.startsWith("tag:") && row.dataset.tags.split(" ").includes(filter.slice(4)));
      const hay = norm(
        `${row.dataset.q} ${row.querySelector(".ui-win__who")?.textContent || ""} ${row.dataset.tags} ${row.dataset.group} ${docs.get(row.dataset.id)?.querySelector(".ui-chat__answer")?.textContent || ""}`,
      );
      const hit = terms.every((t) => hay.includes(t));
      row.hidden = !(inFilter && hit);
      if (!row.hidden) shown++;
    }
    if (empty) empty.hidden = shown > 0;
    // keep a visible row selected, so the open answer always matches the list
    if (selected?.hidden && shown) select(visible()[0], { scroll: false });
  }

  root.querySelector("[data-rows]")?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-row]");
    if (row) select(row);
  });

  root.querySelector("[data-rows]")?.addEventListener("keydown", (e) => {
    const list = visible();
    const i = list.indexOf(document.activeElement.closest?.("[data-row]"));
    if (i < 0) return;
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    select(list[Math.max(0, Math.min(list.length - 1, go))], { focus: true });
  });

  for (const nav of navs) {
    nav.addEventListener("click", () => {
      filter = nav.dataset.filter;
      for (const n of navs) {
        const on = n === nav;
        n.classList.toggle("is-on", on);
        n.setAttribute("aria-pressed", on ? "true" : "false");
      }
      apply();
    });
  }

  search?.addEventListener("input", apply);
  search?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { search.value = ""; apply(); }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = visible()[0];
      if (first) select(first, { focus: true });
    }
  });

  // "/" focuses the search, the way the key cap in the bar says it does
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    e.preventDefault();
    search?.focus();
    search?.select();
  });

  back?.addEventListener("click", () => {
    root.classList.remove("is-open");
    selected?.focus();
  });

  /* ---------------------------------------------------------------- asking */

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-say]");
    if (!btn) return;
    // the row turns to "Asked" when the question actually goes out, not when the button is pressed
    askOutLoud(btn.dataset.say);
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    askTyped(q);
  });

  /* ---------------------------------------------------------------- the live thread */

  const live = { you: null, bot: null };

  function bubble(who) {
    const node = document.createElement("div");
    if (who === "you") {
      node.className = "ui-msg ui-msg--me";
      const span = document.createElement("span");
      span.className = "ui-msg__text";
      node.append(span);
      node._text = span;
    } else {
      node.className = "ui-msg ui-msg--bot";
      const av = document.createElement("span");
      av.className = "ui-agent ui-msg__av";
      av.setAttribute("aria-hidden", "true");
      const col = document.createElement("span");
      col.className = "ui-msg__col";
      const span = document.createElement("span");
      span.className = "ui-chat__answer";
      col.append(span);
      node.append(av, col);
      node._text = span;
    }
    thread?.append(node);
    return node;
  }

  function toFoot() {
    if (body) body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }

  onEvent((ev) => {
    if (ev.type === "status") {
      if (statusEl) statusEl.textContent = ev.status === "idle" || ev.status === "closed" ? IDLE_STATUS : ev.label;
      return;
    }
    if (ev.type === "note") {
      const n = document.createElement("p");
      n.className = "ans-note";
      n.textContent = ev.text;
      thread?.append(n);
      toFoot();
      return;
    }
    if (ev.type !== "turn") return;
    const key = ev.who === "you" ? "you" : "bot";
    if (!live[key]) live[key] = bubble(key);
    live[key]._text.textContent = ev.text;
    live[key].dataset.partial = ev.final ? "false" : "true";
    if (ev.final) {
      if (key === "you") {
        const match = rows.find((r) => norm(r.dataset.q) === norm(ev.text));
        if (match) markSpoken(match.dataset.id);
      }
      live[key] = null;
    }
    toFoot();
  });

  /* ---------------------------------------------------------------- start */

  // JavaScript off, every answer is on the page; with it, one is open and the rest are a click away.
  root.classList.remove("is-open");
  select(rows[0], { scroll: false });
  root.classList.remove("is-open");
  apply();
}
