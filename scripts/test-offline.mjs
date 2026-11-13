// Tier-3 unit tests: the prepared answer bank, offline and deterministic.
// Exercises the REAL matcher from public/js/fallback.js, with the real answers.json.
//   node scripts/test-offline.mjs            all cases
//   node scripts/test-offline.mjs -v         print every answer
import { OfflineAnswers } from "../public/js/fallback.js";
import { CASES, NEVER_EVER } from "./interview-cases.mjs";
import { readFileSync } from "node:fs";

const verbose = process.argv.includes("-v");
const bank = new OfflineAnswers();
bank.data = JSON.parse(readFileSync(new URL("../public/data/answers.json", import.meta.url), "utf8"));

const low = (s) => String(s).toLowerCase();
let pass = 0, skipped = 0; const fails = [];

for (const c of CASES) {
  if (c.liveOnly) { skipped++; continue; }   // judged only against the live model
  const hit = bank.match(c.q);
  const answer = bank.answer(c.q);
  const a = low(answer);
  const problems = [];

  if (c.bank && hit?.id !== c.bank) problems.push(`routed to "${hit?.id ?? "no match"}", expected "${c.bank}"`);
  if (!hit) problems.push("no bank entry matched — would return the generic fallback");

  for (const group of c.any || []) {
    if (!group.some((alt) => a.includes(low(alt)))) problems.push(`missing any of [${group.join(" | ")}]`);
  }
  for (const banned of [...(c.never || []), ...(c.id === "offers" ? [] : NEVER_EVER)]) {
    if (a.includes(low(banned))) problems.push(`LEAKED "${banned}"`);
  }

  if (problems.length) fails.push({ c, hit, answer, problems });
  else pass++;
  if (verbose) console.log(`\n[${problems.length ? "FAIL" : "ok"}] ${c.q}\n  -> (${hit?.id ?? "none"}) ${answer.slice(0, 180)}`);
}

console.log(`\n${"=".repeat(70)}\nTIER 3 (offline bank): ${pass}/${CASES.length - skipped} passed, ${fails.length} failed, ${skipped} live-only`);
for (const f of fails) {
  console.log(`\nFAIL  ${f.c.id}  "${f.c.q}"`);
  for (const p of f.problems) console.log(`      - ${p}`);
  console.log(`      got (${f.hit?.id ?? "none"}): ${f.answer.slice(0, 220)}`);
}
process.exit(fails.length ? 1 : 0);
