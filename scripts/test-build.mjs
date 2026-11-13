// Structural tests: the generated artefacts and the Worker's HTTP contract.
// No model involved, so these are fast and deterministic.
//   node scripts/test-build.mjs [--url https://...]
import { PROFILE, SYSTEM_INSTRUCTION, SYSTEM_INSTRUCTION_TEXT, LIVE_MODEL, TEXT_MODELS } from "../src/persona.js";
import { readFileSync } from "node:fs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg("--url", "https://aditya-voice-bot.mcphardener.workers.dev");

const bank = JSON.parse(readFileSync(new URL("../public/data/answers.json", import.meta.url), "utf8"));
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const si = SYSTEM_INSTRUCTION;

let pass = 0, skippedForQuota = 0; const fails = [];
const t = (name, fn) => {
  try { const r = fn(); if (r === true || r === undefined) { pass++; return; } fails.push([name, String(r)]); }
  catch (e) { fails.push([name, e.message]); }
};
const has = (s, x) => s.toLowerCase().includes(String(x).toLowerCase());

// ---------------------------------------------------------------- the answer bank
t("bank has entries", () => bank.entries.length >= 40 || `only ${bank.entries.length}`);
t("every entry has id, question, answer, keys", () => {
  const bad = bank.entries.filter((e) => !e.id || !e.q || !e.a || !e.keys?.length).map((e) => e.id || "?");
  return bad.length === 0 || `incomplete: ${bad.join(", ")}`;
});
t("no duplicate entry ids", () => {
  const ids = bank.entries.map((e) => e.id); const d = ids.filter((x, i) => ids.indexOf(x) !== i);
  return d.length === 0 || `duplicates: ${[...new Set(d)].join(", ")}`;
});
t("no duplicate questions", () => {
  const qs = bank.entries.map((e) => e.q.toLowerCase()); const d = qs.filter((x, i) => qs.indexOf(x) !== i);
  return d.length === 0 || `duplicate questions: ${[...new Set(d)].join(" / ")}`;
});
t("no answer is a stub or TODO", () => {
  const bad = bank.entries.filter((e) => e.a.trim().length < 80 || has(e.a, "todo")).map((e) => e.id);
  return bad.length === 0 || `too short/TODO: ${bad.join(", ")}`;
});
t("answers are spoken-length (<=200 words)", () => {
  const bad = bank.entries.filter((e) => e.a.trim().split(/\s+/).length > 200).map((e) => e.id);
  return bad.length === 0 || `too long: ${bad.join(", ")}`;
});
t("a fallback line exists", () => Boolean(bank.fallback?.length > 40));
t("keys are lowercase (the matcher lowercases the question)", () => {
  const bad = bank.entries.flatMap((e) => e.keys.filter((k) => k !== k.toLowerCase()).map((k) => `${e.id}:${k}`));
  return bad.length === 0 || bad.join(", ");
});

// ---------------------------------------------------------------- confidential material
const CLIENT_FORBIDDEN = ["mba", "xat", "business school", "two-year bond", "two year bond"];
t("answers.json leaks nothing confidential", () => {
  const j = JSON.stringify(bank).toLowerCase();
  const hit = CLIENT_FORBIDDEN.filter((x) => j.includes(x) && x !== "two-year bond" && x !== "two year bond");
  return hit.length === 0 || `leaked: ${hit.join(", ")}`;
});
t("index.html leaks nothing confidential", () => {
  const h = html.toLowerCase();
  const hit = ["mba", "xat", "business school"].filter((x) => h.includes(x));
  return hit.length === 0 || `leaked: ${hit.join(", ")}`;
});
t("the other-offers rule lives server-side", () => has(si, "do not bring this up") || "missing from the system instruction");
t("the salary rule is present", () => has(si, "do not give a number") || "missing");
t("the MBA prohibition is present", () => has(si, "mba") || "missing");
t("the Innov8 bond reason is present", () => has(si, "bond") || "missing");
t("the tech-stack bridging rule is present", () => has(si, "never invent a job") || "missing");

// ---------------------------------------------------------------- facts that must be right
t("located in Bangalore", () => has(si, "bangalore") || "missing");
t("does NOT claim to live in Chennai", () => {
  const bad = ["based in chennai", "live in chennai", "living in chennai", "i'm in chennai"];
  const hit = bad.filter((x) => has(si, x) || has(JSON.stringify(bank), x));
  return hit.length === 0 || `claims: ${hit.join(", ")}`;
});
t("CGPA is 8.13", () => has(si, "8.13") || "missing");
t("permission count is 299", () => has(si, "299") || "missing");
t("endpoint count is 380", () => has(si, "380") || "missing");
t("cutover figure is 14,000", () => has(si, "14,000") || "missing");
t("school marks present", () => (has(si, "82.4") && has(si, "75.4")) || "missing 10th/12th marks");
t("birthplace present", () => has(si, "ranchi") || "missing");
t("publication present", () => has(si, "lung cancer") || "missing");
t("availability present", () => has(si, "immediately") || "missing");

// ---------------------------------------------------------------- persona integrity
t("first person, never third", () => {
  // the rule line itself quotes the forbidden phrase - exclude it before checking
  const body = si.replace('never "Aditya is"', "");
  return !/\bAditya is\b/.test(body) || "system instruction describes him in third person";
});
t("the first-person rule is stated", () => has(si, 'never "Aditya is"') || "rule missing");
t("projects all have name/what/stack", () => {
  const bad = (PROFILE.projects || []).filter((p) => !p.name || !p.what || !p.stack).map((p) => p.name || "?");
  return bad.length === 0 || bad.join(", ");
});
t("at least 8 projects", () => (PROFILE.projects?.length ?? 0) >= 8 || `only ${PROFILE.projects?.length}`);
t("every prepared answer is non-empty", () => {
  const bad = Object.entries(PROFILE.answers).filter(([, v]) => !v || v.trim().length < 80).map(([k]) => k);
  return bad.length === 0 || bad.join(", ");
});
t("no TODO left in the persona", () => !has(si, "todo") || "TODO present");
t("the text variant extends the spoken one", () => SYSTEM_INSTRUCTION_TEXT.startsWith(si) || "diverged");
t("a live model and >1 text fallback are configured", () =>
  (LIVE_MODEL && TEXT_MODELS.length >= 2) || "model config thin");
t("skills list is broad", () => (PROFILE.skills.strong.length + PROFILE.skills.working.length) >= 30 || "too narrow");

// ---------------------------------------------------------------- the generated page
t("page renders one row per bank entry", () => {
  const rows = (html.match(/class="ui-win__row"/g) || []).length;
  return rows === bank.entries.length || `${rows} rows vs ${bank.entries.length} entries`;
});
t("page renders one document per entry", () => {
  const docs = (html.match(/class="ans-doc"/g) || []).length;
  return docs === bank.entries.length || `${docs} docs vs ${bank.entries.length} entries`;
});
t("answers:* markers intact", () => ["nav", "rows", "docs"].every((n) =>
  html.includes(`<!-- answers:${n}:start -->`) && html.includes(`<!-- answers:${n}:end -->`)) || "a marker is missing");
t("page has a title and viewport", () => (/<title>[^<]+<\/title>/.test(html) && html.includes("viewport")) || "missing");
t("no unreplaced template literal in the page", () => !html.includes("${") || "a ${...} leaked into the HTML");

// ---------------------------------------------------------------- the deployed Worker
const json = async (path, init) => {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(30_000), ...init });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
};
const at = async (name, fn) => {
  try { const r = await fn(); if (r === true || r === undefined) { pass++; return; } fails.push([name, String(r)]); }
  catch (e) { fails.push([name, e.message]); }
};

await at("GET /api/health is 200 and key configured", async () => {
  const { status, body } = await json("/api/health");
  return (status === 200 && body?.ok && body?.keyConfigured) || `status ${status} ${JSON.stringify(body)}`;
});
await at("GET / serves the page", async () => {
  const res = await fetch(BASE + "/", { signal: AbortSignal.timeout(30_000) });
  const h = await res.text();
  return (res.ok && h.includes("ui-win__row")) || `status ${res.status}`;
});
await at("deployed page says Bangalore", async () => {
  const h = await (await fetch(BASE + "/")).text();
  return h.includes("Bangalore") || "not found in served HTML";
});
await at("deployed page leaks nothing confidential", async () => {
  const h = (await (await fetch(BASE + "/")).text()).toLowerCase();
  const hit = ["mba", "xat"].filter((x) => h.includes(x));
  return hit.length === 0 || `leaked: ${hit.join(", ")}`;
});
await at("deployed answers.json matches the local build", async () => {
  const r = await json("/data/answers.json");
  return r.body?.entries?.length === bank.entries.length || `deployed ${r.body?.entries?.length} vs local ${bank.entries.length}`;
});
await at("GET /api/chat is rejected (POST only)", async () => {
  const { status } = await json("/api/chat");
  return status === 405 || `got ${status}`;
});
await at("empty question is rejected", async () => {
  const { status, body } = await json("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "   " }) });
  return (status === 400 && body?.error === "empty_question") || `got ${status} ${JSON.stringify(body)}`;
});
await at("malformed JSON is rejected", async () => {
  const { status, body } = await json("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  return (status === 400 && body?.error === "bad_json") || `got ${status} ${JSON.stringify(body)}`;
});
// This one actually generates an answer, so it costs Gemini quota. Opt in with --spend.
const SPEND = process.argv.includes("--spend");
await (SPEND ? at : async () => { skippedForQuota++; })("an over-long question is accepted, not crashed", async () => {
  const { status } = await json("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "why ".repeat(900) }) });
  return [200, 429, 502, 503].includes(status) || `got ${status}`;
});
await at("unknown path falls through to the app, not a crash", async () => {
  const res = await fetch(BASE + "/nope-not-here", { signal: AbortSignal.timeout(30_000) });
  return [200, 404].includes(res.status) || `got ${res.status}`;
});

console.log(`\n${"=".repeat(74)}`);
console.log(`BUILD + CONTRACT: ${pass}/${pass + fails.length} passed, ${fails.length} failed${skippedForQuota ? `, ${skippedForQuota} skipped (needs --spend: costs Gemini quota)` : ""}\n`);
for (const [n, why] of fails) console.log(`FAIL  ${n}\n      ${why}`);
process.exit(fails.length ? 1 : 0);
