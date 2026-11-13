// Unit tests for push-to-ask turn taking in tier 1. Drives the real LiveSession's
// VAD by feeding it synthetic audio chunks. No browser, no network, no Gemini quota.
//   node scripts/test-turntaking.mjs
import { LiveSession } from "../public/js/live.js";

const CHUNK = 64;              // ms per chunk, matching the worklet
const LOUD = new Float32Array(1024).fill(0.3);
const QUIET = new Float32Array(1024).fill(0.001);

let pass = 0; const fails = [];
const check = async (name, fn) => {
  try { const r = await fn(); if (r === true || r === undefined) { pass++; return; } fails.push([name, String(r)]); }
  catch (e) { fails.push([name, e.stack?.split("\n")[0] || e.message]); }
};

/** A session with the browser parts stubbed out and a clock we control. */
function makeSession() {
  const log = { status: [], sent: [], notes: [], spoken: [] };
  const s = new LiveSession({
    onStatus: (st) => log.status.push(st),
    onLevel: () => {},
    onUserText: () => {}, onBotText: () => {},
    onNothingHeard: (r) => log.notes.push(r),
    onSpeakFallback: (t) => log.spoken.push(t),
    onTurnDone: () => log.notes.push("turn_done"),
  });
  s.openMic = async () => { s.captureCtx = {}; };
  s.closeMic = () => { s.captureCtx = null; };
  s.ready = true;
  s.ws = { readyState: 1, send: (m) => log.sent.push(JSON.parse(m)) };

  let now = 1_000_000;
  s._tick = (ms) => { now += ms; };
  const realNow = Date.now;
  Date.now = () => now;
  s._restore = () => { Date.now = realNow; };

  // Feed n chunks of a given loudness, advancing the clock as the worklet would.
  s._feed = (peakSample, n) => {
    const peak = Math.abs(peakSample[0]);
    for (let i = 0; i < n; i++) { s._tick(CHUNK); s.onAudioChunk({ pcm: peakSample, peak }); }
  };
  return { s, log };
}
const audioFrames = (log) => log.sent.filter((m) => m.realtimeInput?.audio).length;
const endedStream = (log) => log.sent.some((m) => m.realtimeInput?.audioStreamEnd);

// ---------------------------------------------------------------- the mic is shut by default
await check("no audio is sent before a turn is opened", () => {
  const { s, log } = makeSession();
  s._feed(LOUD, 10);
  s._restore();
  return audioFrames(log) === 0 || `${audioFrames(log)} frames leaked`;
});

// ---------------------------------------------------------------- press -> listening
await check("beginTurn opens the mic and reports listening", async () => {
  const { s, log } = makeSession();
  const ok = await s.beginTurn();
  s._restore();
  return (ok === true && s.micOpen === true && log.status.includes("listening")) || `ok=${ok} micOpen=${s.micOpen} status=${log.status}`;
});

// ---------------------------------------------------------------- speech then silence ends the turn
await check("the turn ends itself after the visitor stops speaking", async () => {
  const { s, log } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, 6);                       // calibration window
  s._feed(LOUD, 20);                       // ~1.3s of speech
  const duringSpeech = s.micOpen;
  s._feed(QUIET, Math.ceil(1300 / CHUNK) + 2);
  s._restore();
  if (!duringSpeech) return "mic closed while still speaking";
  if (s.micOpen) return "mic never closed after the silence";
  if (!endedStream(log)) return "audioStreamEnd was not sent";
  return log.status.includes("thinking") || `status never reached thinking: ${log.status}`;
});

// ---------------------------------------------------------------- it does not cut you off mid-sentence
await check("a short pause mid-sentence does NOT end the turn", async () => {
  const { s } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, 6);
  s._feed(LOUD, 10);
  s._feed(QUIET, 8);        // ~0.5s pause, well under the 1.3s threshold
  s._feed(LOUD, 10);
  const stillOpen = s.micOpen;
  s._restore();
  return stillOpen === true || "the mic closed during a natural pause";
});

// ---------------------------------------------------------------- silence alone asks nothing
await check("pressing the mic and saying nothing does not ask the model anything", async () => {
  const { s, log } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, Math.ceil(9000 / CHUNK) + 4);
  s._restore();
  if (s.micOpen) return "mic stayed open past the no-speech timeout";
  if (endedStream(log)) return "it asked the model to answer silence";
  if (!log.notes.includes("silence")) return "the visitor was not told nothing was heard";
  return log.status.includes("idle") || `status: ${log.status}`;
});

// ---------------------------------------------------------------- a hard cap on the open mic
await check("the mic cannot stay open forever", async () => {
  const { s } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, 6);
  for (let i = 0; i < 1100; i++) { s._tick(CHUNK); s.onAudioChunk({ pcm: LOUD, peak: 0.3 }); }
  s._restore();
  return s.micOpen === false || "the mic was still open after 60s of talking";
});

// ---------------------------------------------------------------- no interrupting the answer
await check("the mic cannot be opened while the answer is playing", async () => {
  const { s } = makeSession();
  s.player.speaking = true;
  const ok = await s.beginTurn();
  s._restore();
  return (ok === false && s.micOpen === false) || `beginTurn returned ${ok}`;
});

await check("no audio is sent while the answer is playing", async () => {
  const { s, log } = makeSession();
  await s.beginTurn();
  s.endTurn("manual");           // question over, answer about to play
  s.player.speaking = true;
  s._feed(LOUD, 30);             // the room keeps talking
  s._restore();
  return audioFrames(log) === 0 || `${audioFrames(log)} frames sent during the answer`;
});

// ---------------------------------------------------------------- tapping to finish early
await check("a second press ends the question early", async () => {
  const { s, log } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, 6);
  s._feed(LOUD, 8);
  s.endTurn("manual");
  s._restore();
  if (s.micOpen) return "mic still open";
  return endedStream(log) || "audioStreamEnd was not sent on a manual finish";
});

await check("endTurn is safe to call twice", async () => {
  const { s, log } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, 6);
  s._feed(LOUD, 8);
  s.endTurn("manual");
  s.endTurn("manual");
  s._restore();
  const ends = log.sent.filter((m) => m.realtimeInput?.audioStreamEnd).length;
  return ends === 1 || `audioStreamEnd sent ${ends} times`;
});

// ---------------------------------------------------------------- noisy room
await check("a noisy room does not read as continuous speech", async () => {
  const { s } = makeSession();
  await s.beginTurn();
  const HUM = new Float32Array(1024).fill(0.05);   // steady background hum
  s._feed(HUM, 6);                                  // calibrated against the hum
  s._feed(HUM, 40);                                 // more hum, no speech
  const open = s.micOpen;
  s._restore();
  return open === true || "the hum alone was treated as a question";
});

// ---------------------------------------------------------------- an answer is never silent
await check("a transcript with no audio is spoken by the browser instead", async () => {
  const { s, log } = makeSession();
  s.handle({ serverContent: { outputTranscription: { text: "I'm based in Bangalore." } } });
  s.handle({ serverContent: { turnComplete: true } });
  s._restore();
  return (log.spoken.length === 1 && log.spoken[0] === "I'm based in Bangalore.")
    || `spoken=${JSON.stringify(log.spoken)}`;
});

await check("a normal audio answer is NOT spoken twice", async () => {
  const { s, log } = makeSession();
  s.player.push = async () => {};                     // stub the audio graph
  s.handle({ serverContent: { outputTranscription: { text: "Bangalore." } } });
  s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAA" } }] } } });
  s.handle({ serverContent: { turnComplete: true } });
  s._restore();
  return log.spoken.length === 0 || `double-spoke: ${JSON.stringify(log.spoken)}`;
});

await check("the audio flag resets between turns", async () => {
  const { s, log } = makeSession();
  s.player.push = async () => {};
  s.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAA" } }] } } });
  s.handle({ serverContent: { outputTranscription: { text: "one" } } });
  s.handle({ serverContent: { turnComplete: true } });      // had audio, not spoken
  s.handle({ serverContent: { outputTranscription: { text: "two" } } });
  s.handle({ serverContent: { turnComplete: true } });      // no audio this time
  s._restore();
  return (log.spoken.length === 1 && log.spoken[0] === "two") || `spoken=${JSON.stringify(log.spoken)}`;
});

await check("an empty transcript is not spoken", async () => {
  const { s, log } = makeSession();
  s.handle({ serverContent: { outputTranscription: { text: "   " } } });
  s.handle({ serverContent: { turnComplete: true } });
  s._restore();
  return log.spoken.length === 0 || `spoke whitespace: ${JSON.stringify(log.spoken)}`;
});

await check("the mic is still held after a turn ends", async () => {
  const { s } = makeSession();
  await s.beginTurn();
  s._feed(QUIET, 6);
  s._feed(LOUD, 8);
  s.endTurn("manual");
  const held = Boolean(s.captureCtx);
  s._restore();
  return held === true || "the mic was released, which breaks the playback graph";
});

await new Promise((r) => setTimeout(r, 10));
console.log(`\n${"=".repeat(70)}`);
console.log(`TURN TAKING (tier 1 VAD): ${pass}/${pass + fails.length} passed, ${fails.length} failed\n`);
for (const [n, why] of fails) console.log(`FAIL  ${n}\n      ${why}`);
process.exit(fails.length ? 1 : 0);
