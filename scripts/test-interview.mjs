// Integration tests against the DEPLOYED worker: what a reviewer actually hears.
//   node scripts/test-interview.mjs [--url https://...] [--only id,id]
// The Worker rate-limits /api/chat to 25 requests per minute per IP, and Gemini
// returns 503 under load, so requests are paced and retried rather than blasted.
import { CASES, NEVER_EVER, DIRECT_OFFER_CASE } from "./interview-cases.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const URL_BASE = arg("--url", "https://aditya-voice-bot.mcphardener.workers.dev");
const only = arg("--only", "")?.split(",").filter(Boolean);
const all = [...CASES, DIRECT_OFFER_CASE];
const todo = only?.length ? all.filter((c) => only.includes(c.id)) : all;

const low = (s) => String(s).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~16 requests/minute, under the Worker's 25/min limit, with room for retries.
// The Gemini free tier has a daily quota as well as a per-minute one, and a 70-question
// burst exhausted it once (429 "You exceeded your current quota"). Default to a gentle
// pace and raise it with --gap if you are deliberately load-testing.
const GAP_MS = Number(arg("--gap", "8000"));
let lastSent = 0;

async function ask(question, attempt = 0) {
  const wait = Math.max(0, lastSent + GAP_MS - Date.now());
  if (wait) await sleep(wait);
  lastSent = Date.now();
  let res, body;
  try {
    res = await fetch(`${URL_BASE}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(120_000),
    });
    body = await res.json();
  } catch (err) {
    if (attempt < 3) { await sleep(4000 * (attempt + 1)); return ask(question, attempt + 1); }
    return { error: `transport: ${err.message}` };
  }
  // 503 = every text model busy; 429 = our own rate limit. Both are transient.
  if (!res.ok && (res.status === 503 || res.status === 429) && attempt < 3) {
    await sleep((res.status === 429 ? 20000 : 6000) * (attempt + 1));
    return ask(question, attempt + 1);
  }
  if (!res.ok) return { error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 160)}` };
  return { text: body.text || "" };
}

const results = [];
for (const [i, c] of todo.entries()) {
  const { text, error } = await ask(c.q);
  const a = low(text || "");
  const problems = [];
  if (error) problems.push(error);
  else {
    for (const g of c.any || []) if (!g.some((alt) => a.includes(low(alt)))) problems.push(`missing any of [${g.join(" | ")}]`);
    for (const b of [...(c.never || []), ...NEVER_EVER]) {
      if (a.includes(low(b))) problems.push(`LEAKED "${b}"`);
    }
    if (!text.trim()) problems.push("empty answer");
  }
  results.push({ c, text, problems });
  process.stderr.write(`${problems.length ? "x" : "."}${(i + 1) % 50 === 0 ? "\n" : ""}`);
}

const fails = results.filter((r) => r.problems.length);
console.log(`\n\n${"=".repeat(74)}`);
console.log(`LIVE MODEL (${URL_BASE}): ${results.length - fails.length}/${results.length} passed, ${fails.length} failed\n`);
for (const r of results) {
  console.log(`${r.problems.length ? "FAIL" : " ok "}  [${r.c.id}] ${r.c.q}`);
  console.log(`      ${(r.text || "(no answer)").replace(/\s+/g, " ").slice(0, 400)}`);
  for (const p of r.problems) console.log(`      !! ${p}`);
  console.log();
}
process.exit(fails.length ? 1 : 0);
