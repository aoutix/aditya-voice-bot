# Aditya Das — voice interview bot

A web page where a reviewer speaks a question and hears Aditya answer, in his own words.

## How it works

| Tier | Path | When |
|---|---|---|
| 1 | Gemini **Live API** over a WebSocket: mic audio in, spoken audio out, barge-in, native VAD | default |
| 2 | Browser speech recognition -> `/api/chat` (Gemini Flash) -> browser speech synthesis | the live session cannot start |
| 3 | Typed question matched against `public/data/answers.json` | no network or no API |

The browser never holds the API key. It opens a WebSocket to this site's own
`/api/live`; the Worker opens one to Google with the key and pipes frames between them.
The Worker sends the **setup frame itself** — model, system instruction and voice — and
drops any `setup` frame a client sends, so the persona cannot be replaced by editing the
page's JavaScript. Only `realtimeInput`, `clientContent` and `toolResponse` are forwarded.

> The documented ephemeral-token path (`POST /v1beta/auth_tokens` +
> `bidiGenerateContentSetup`) mints tokens fine, but the Live socket rejects them with
> `1007 API key not valid` — the feature is in preview and not enabled for this project.
> The proxy stands in for it and keeps the same security property. If tokens start
> working, `/api/live` can be swapped back without touching the frontend.

**Live URL:** https://aditya-voice-bot.mcphardener.workers.dev

## What runs where

| Component | This project | Where |
|---|---|---|
| LLM | Gemini — Live API for speech-to-speech, Flash for the text tier | `src/worker.js`, `src/persona.js` |
| Coordination | A Cloudflare **Worker**: a WebSocket proxy that owns the upstream session, substitutes its own setup frame, filters client frames and runs a three-model text fallback | `src/worker.js` |
| User input | Voice (press to ask, client-side VAD) with a typed box behind it, served as static assets from the same Worker | `public/` |
| Memory / state | Live-session continuity via Gemini's resumption handle, plus a **Durable Object** per visitor holding the transcript | `public/js/live.js`, `src/memory.js` |

The Durable Object is in the repo and under test but not bound in `wrangler.jsonc` —
see [Memory](#memory) for why and how to switch it on.

## Layout

```
wrangler.jsonc        Worker + static assets
src/worker.js         /api/live (WebSocket proxy), /api/chat, /api/health
src/persona.js        the single source of truth: his facts, his voice, his prepared answers
src/memory.js         ConversationMemory: the per-visitor durable object (not bound on the live site)
scripts/build-answers.mjs   regenerates public/data/answers.json AND the #answers panel markup
                            inside public/index.html, both from persona.js
public/index.html     the page (built with the design-taste-frontend kit in public/assets)
public/js/live.js     the realtime session: capture, stream, play, barge-in, resume
public/js/fallback.js tiers 2 and 3
public/js/app.js      the tier ladder and every DOM hook; exports askTyped, askOutLoud, onEvent
public/js/answers.js  the #answers panel: search, filters, selection, asking
```

## Running it

```bash
npm install
echo 'GEMINI_API_KEY=<key>' > .dev.vars     # gitignored
npx wrangler dev                            # http://127.0.0.1:8787
```

## Deploying

```bash
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

The text fallback tries `gemini-3.8-flash`, then `gemini-2.5-flash`, then
`gemini-flash-latest`, so one busy model (503 UNAVAILABLE) does not take the tier down.

## The answers panel

The `#answers` section is a working panel, not a picture of one. Its forty-five rows and forty-five
written answers are generated into `index.html` between `<!-- answers:* -->` markers, so they
are real HTML that reads with JavaScript off. `public/js/answers.js` adds the behaviour:

- the search box filters on question, topic, group and answer text; `/` focuses it, Escape clears
- the sidebar filters by group (Himself, Work, Background, Contact) and by topic; every count
  is counted from the data, so none of them can be wrong
- a row opens its written answer; arrow keys, Home and End move through the list
- **Ask this out loud** puts that question to the voice — opening a session first if none is
  running — and the row's status turns to `Asked` when the question actually goes out
- the box at the foot asks anything, through the same ladder as the hero: live session if one is
  open, else `/api/chat`, else the offline bank. The answer streams into the panel

There is one voice session on the page. The panel subscribes to `app.js` through `onEvent`
rather than opening a second one, so the hero's transcript and the panel show one conversation.

## Turn taking: one press, one question

The page is deliberately **half-duplex**. A mic press opens the mic for exactly one
question; client-side VAD closes it once the visitor has been quiet for 1.3s; the answer
then plays with the mic shut, and the next question needs a fresh press.

Barge-in was removed on purpose. No audio leaves the browser unless a turn is open
(`LiveSession.micOpen`), which is what makes interruption impossible rather than merely
discouraged — nothing depends on a server-side setting. A press during `thinking` or
`speaking` is refused with a note rather than cutting the answer off.

The mic is also physically released between turns (`closeMic()` stops the tracks and closes
the capture context), so the browser's recording indicator reflects reality instead of
staying lit for the whole session. The WebSocket stays open, so conversation context and
latency are unaffected.

VAD constants live at the top of `public/js/live.js`: `SILENCE_MS` (end of question),
`NO_SPEECH_MS` (pressed but said nothing), `MAX_TURN_MS` (hard cap) and `CALIBRATE_MS`,
which samples the room's noise floor for the first six chunks so a humming room is not read
as continuous speech. `scripts/test-turntaking.mjs` covers all of it without a browser.

Tier 2 behaves the same way: recognition is single-shot and is never restarted on its own.

## Quota is the real failure mode

The Gemini free tier has a **daily** quota as well as a per-minute one. A 70-question test run
exhausted it on 2026-11-10: every text model returned `429 You exceeded your current quota`, and
for about twenty minutes the page could only answer from tier 3.

What that looks like to a visitor: tier 1 cannot start, tier 2 fails, and the page says "the live
model isn't reachable — I'm answering from prepared notes", then answers from the bank by voice.
Not broken, but not the live demo either.

So:
- Do not run the full live suite casually. `npm run test:live` defaults to one request every 8s,
  and `--only id,id` runs a subset. The offline suites (`npm test`) hit no quota at all.
- If a reviewer is about to look at this, leave the quota alone for a few hours beforehand.
- Enabling billing on the key's Google Cloud project removes the daily cap, which is the only
  real fix.
- `/api/chat` reports every model it tried (`tried: ["gemini-3.8-flash=429", ...]`) so a wrong
  model name (404) is distinguishable from a busy one. Without that, a three-model fallback chain
  can be silently one model deep.

## Memory

Two kinds of state, for two different jobs.

**Within a live session** the browser keeps Gemini's resumption handle
(`public/js/live.js`) and hands it back to `/api/live?resume=...` on reconnect, so a
dropped socket resumes the same conversation rather than restarting it. The Worker is
otherwise stateless, which is what lets it run at the edge with no coordination between
visitors.

**Across sessions** that is not enough: a reload loses the transcript, and the text tier
only ever sees history the client chose to send it. `src/memory.js` is the Durable Object
that closes both gaps — one object per visitor, addressed by `idFromName(conversationId)`:

```js
import { memoryFor } from "./memory.js";
export { ConversationMemory } from "./memory.js";

// inside /api/chat
const mem = memoryFor(env, conversationId);          // one object, one conversation
const history = await (await mem.fetch(new Request("https://do/history"))).json();
const r = await askText(env, question, history.history);   // server-owned history
await mem.fetch(new Request("https://do/turn", {
  method: "POST",
  body: JSON.stringify({ question, answer: r.text, tier: 2 }),
}));
```

A conversation is a single-writer object needing read-after-write ordering: two turns
arriving together must append rather than clobber each other, which KV's eventual
consistency cannot promise. The object keeps the last `MAX_TURNS` (24) turns verbatim,
collapses older ones into a bounded summary line rather than dropping them, caps each
field at 4000 characters, and treats a conversation idle for more than six hours as gone.
Taking history from the object instead of the request body also means a visitor can no
longer forge the conversation they claim to have had.

It is deliberately **not bound in `wrangler.jsonc`**: the live site is the stateless
version, and binding a new class means a migration on a deployment a reviewer may be
looking at. The class, its HTTP surface and its eviction rules are all covered by
`npm run test:memory` (17 assertions against a storage stub, no workerd, no network), and
the header of `src/memory.js` has the binding and migration to paste in.

## Tests

| command | what it covers | network |
|---|---|---|
| `npm test` | the build, the HTTP contract, the tier-3 bank over ~70 interview questions, and tier-1 turn taking | fetches the deployed page only |
| `npm run test:turns` | push-to-ask VAD: end of speech, mid-sentence pauses, no-interruption, timeouts | no |
| `npm run test:memory` | the durable object: persistence, turn eviction, summary bound, TTL, HTTP surface | no |
| `npm run test:build` | bank integrity, confidential material, the load-bearing numbers, Worker 405/400/health | yes (add `--spend` for the one test that costs quota) |
| `npm run test:offline` | the real tier-3 matcher against the question corpus | no |
| `npm run test:live` | the same corpus against the deployed model | yes, and spends quota |

`scripts/interview-cases.mjs` holds the corpus. `NEVER_EVER` there is the list that must never
appear in any answer — anything about further study, a salary figure, system
prompt leakage, and the old Chennai location string.

## Disclosure rules in the persona

`SYSTEM_INSTRUCTION` carries explicit rules about what is and is not volunteered: other
offers and interviews are never raised, and are acknowledged only in one sentence if the
interviewer asks directly — never with a company name; no salary number or range is ever
given; further study is never raised. Those rules live only in `src/persona.js`, which is
server-side — they are deliberately absent from `public/data/answers.json` and
`index.html`, so the offline tier has nothing to leak.

## After editing the persona

`src/persona.js` feeds both API routes. After changing it, run `node scripts/build-answers.mjs`
so the offline tier and the page panel match, then redeploy. Adding an entry also needs a line
in `META` in that script (its label, initials, group and topics), or the build fails loudly.
