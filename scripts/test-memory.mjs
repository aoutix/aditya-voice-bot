// Unit tests for the ConversationMemory Durable Object. Drives the real class
// against an in-memory stand-in for `state.storage`, so the eviction, the TTL,
// the summary and the HTTP surface are all exercised without workerd.
//   node scripts/test-memory.mjs
import { ConversationMemory, MAX_TURNS, TTL_MS, summarise } from "../src/memory.js";

let pass = 0; const fails = [];
const check = async (name, fn) => {
  try { const r = await fn(); if (r === true || r === undefined) { pass++; return; } fails.push([name, String(r)]); }
  catch (e) { fails.push([name, e.stack?.split("\n")[0] || e.message]); }
};

/** The slice of DurableObjectStorage this class uses, nothing more. */
function makeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    map,
    async get(k) { return map.get(k); },
    async put(k, v) { map.set(k, structuredClone(v)); },
    async delete(k) { return map.delete(k); },
  };
}
const makeDO = (seed) => {
  const storage = makeStorage(seed);
  return [new ConversationMemory({ storage }, {}), storage];
};
const ask = (o, q, a, tier = 2) => o.append({ question: q, answer: a, tier });

await check("a fresh object has no turns", async () => {
  const [o] = makeDO();
  const v = await o.view();
  return (v.count === 0 && v.turns.length === 0) || `count ${v.count}`;
});

await check("a turn is stored and read back", async () => {
  const [o] = makeDO();
  await ask(o, "Where are you based?", "Bangalore.", 1);
  const v = await o.view();
  return (v.count === 1 && v.turns[0].q === "Where are you based?" && v.turns[0].tier === 1)
    || JSON.stringify(v.turns);
});

await check("a turn survives a new object on the same storage", async () => {
  const [o, storage] = makeDO();
  await ask(o, "What did you build at Innov8?", "An ETL pipeline.");
  const fresh = new ConversationMemory({ storage }, {});
  const v = await fresh.view();
  return v.count === 1 || `lost it: count ${v.count}`;
});

await check("a question is required", async () => {
  const [o] = makeDO();
  try { await ask(o, "   ", "an answer"); return "it accepted an empty question"; }
  catch { return true; }
});

await check("history comes out in Gemini's contents shape", async () => {
  const [o] = makeDO();
  await ask(o, "Q1", "A1");
  await ask(o, "Q2", "A2");
  const h = await o.history();
  return (h.length === 4 && h[0].role === "user" && h[0].parts[0].text === "Q1"
    && h[1].role === "model" && h[3].parts[0].text === "A2") || JSON.stringify(h);
});

await check("an unanswered question contributes no model turn", async () => {
  const [o] = makeDO();
  await ask(o, "Q1", "");
  const h = await o.history();
  return (h.length === 1 && h[0].role === "user") || JSON.stringify(h);
});

await check(`only the last ${MAX_TURNS} turns are kept verbatim`, async () => {
  const [o] = makeDO();
  for (let i = 1; i <= MAX_TURNS + 6; i++) await ask(o, `Q${i}`, `A${i}`);
  const v = await o.view();
  return (v.count === MAX_TURNS && v.turns[0].q === "Q7"
    && v.turns[MAX_TURNS - 1].q === `Q${MAX_TURNS + 6}`) || `count ${v.count}, first ${v.turns[0].q}`;
});

await check("evicted turns survive as a summary, not as nothing", async () => {
  const [o] = makeDO();
  for (let i = 1; i <= MAX_TURNS + 2; i++) await ask(o, `Question number ${i}`, `A${i}`);
  const v = await o.view();
  const h = await o.history();
  return (v.summary.includes("Question number 1") && v.summary.includes("Question number 2")
    && h[0].parts[0].text.startsWith("Earlier in this conversation:"))
    || `summary: ${v.summary.slice(0, 80)}`;
});

await check("the summary is bounded however long the conversation runs", async () => {
  let s = "";
  for (let i = 0; i < 400; i++) s = summarise(s, [{ q: `a reasonably long question number ${i}` }]);
  return s.length <= 1200 || `grew to ${s.length}`;
});

await check("a conversation idle past the TTL starts clean", async () => {
  const stale = {
    conv: { turns: [{ q: "old", a: "older", at: 1 }], summary: "", started: 1, updated: Date.now() - TTL_MS - 1000 },
  };
  const [o] = makeDO(stale);
  const v = await o.view();
  return (v.count === 0 && v.expired !== false) || `kept ${v.count} stale turns`;
});

await check("a conversation inside the TTL is kept", async () => {
  const warm = {
    conv: { turns: [{ q: "recent", a: "yes", at: Date.now() }], summary: "", started: Date.now(), updated: Date.now() - 1000 },
  };
  const [o] = makeDO(warm);
  const v = await o.view();
  return v.count === 1 || `dropped a live conversation (count ${v.count})`;
});

await check("reset clears the object", async () => {
  const [o, storage] = makeDO();
  await ask(o, "Q", "A");
  await o.reset();
  const v = await o.view();
  return (v.count === 0 && storage.map.size === 0) || `count ${v.count}, keys ${storage.map.size}`;
});

await check("text is capped so one request cannot bloat the object", async () => {
  const [o] = makeDO();
  await ask(o, "x".repeat(9000), "y".repeat(9000));
  const v = await o.view();
  return (v.turns[0].q.length === 4000 && v.turns[0].a.length === 4000)
    || `${v.turns[0].q.length}/${v.turns[0].a.length}`;
});

// ------------------------------------------------------------------ HTTP surface
const post = (path, body) =>
  new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });

await check("POST /turn then GET /history round-trips", async () => {
  const [o] = makeDO();
  const r1 = await o.fetch(post("/turn", { question: "Why Cloudflare?", answer: "The edge.", tier: 1 }));
  const b1 = await r1.json();
  const r2 = await o.fetch(new Request("https://do/history"));
  const b2 = await r2.json();
  return (r1.status === 200 && b1.count === 1 && b2.history.length === 2) || `${r1.status} ${JSON.stringify(b1)}`;
});

await check("POST /turn rejects a bad body with 400, not a 500", async () => {
  const [o] = makeDO();
  const bad = new Request("https://do/turn", { method: "POST", body: "{not json" });
  const r = await o.fetch(bad);
  const r2 = await o.fetch(post("/turn", { answer: "no question" }));
  return (r.status === 400 && r2.status === 400) || `${r.status} / ${r2.status}`;
});

await check("POST /reset empties it over HTTP", async () => {
  const [o] = makeDO();
  await o.fetch(post("/turn", { question: "Q", answer: "A" }));
  await o.fetch(post("/reset", {}));
  const b = await (await o.fetch(new Request("https://do/history"))).json();
  return b.count === 0 || `count ${b.count}`;
});

await check("an unknown path is a 404", async () => {
  const [o] = makeDO();
  const r = await o.fetch(new Request("https://do/nope"));
  return r.status === 404 || `${r.status}`;
});

console.log(`\n${"=".repeat(70)}`);
console.log(`MEMORY (ConversationMemory durable object): ${pass}/${pass + fails.length} passed, ${fails.length} failed\n`);
for (const [n, why] of fails) console.log(`FAIL  ${n}\n      ${why}`);
process.exit(fails.length ? 1 : 0);
