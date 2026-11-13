// Orchestration. Owns the tier ladder and every DOM hook the page exposes:
//   [data-mic] [data-orb] [data-status] [data-tier] [data-transcript]
//   [data-chips] > button[data-question]   [data-typed-form] > [data-typed-input]
import { LiveSession } from "./live.js";
import { SpeechFallback, OfflineAnswers, hasSpeechRecognition, speakText } from "./fallback.js";

const $ = (sel) => document.querySelector(sel);
const all = (sel) => Array.from(document.querySelectorAll(sel));
const el = {
  mic: all("[data-mic]"),
  orb: $("[data-orb]"),
  status: $("[data-status]"),
  tier: $("[data-tier]"),
  transcript: $("[data-transcript]"),
  chips: $("[data-chips]"),
  form: $("[data-typed-form]"),
  input: $("[data-typed-input]"),
};

// Anything else on the page that wants to follow the conversation (the #answers panel)
// subscribes here, so there is one voice session and one history, not two.
const subs = new Set();
export function onEvent(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(ev) { for (const fn of subs) { try { fn(ev); } catch (err) { console.warn("[voice] subscriber threw:", err); } } }

const state = {
  tier: 0,          // 0 idle, 1 realtime, 2 speech fallback, 3 offline
  live: null,
  speech: null,
  offline: new OfflineAnswers(),
  history: [],
  active: false,
  status: "idle",
  live_user: null,  // the DOM node currently being streamed into
  live_bot: null,
};

const TIER_LABEL = {
  1: "Live voice",
  2: "Voice (fallback)",
  3: "Offline — prepared answers",
};

const STATUS_TEXT = {
  idle: "Tap the mic to ask",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  closed: "Tap the mic to ask",
  error: "Something went wrong",
};

function micPressed(v) {
  for (const b of el.mic) b.setAttribute("aria-pressed", v ? "true" : "false");
}

function setStatus(s, detail) {
  state.status = s;
  // The mic button only looks pressed while it is actually recording.
  micPressed(s === "listening");
  if (el.status) el.status.textContent = STATUS_TEXT[s] || s;
  document.documentElement.dataset.voice = s;
  if (detail) console.info("[voice]", s, detail);
  emit({ type: "status", status: s, label: STATUS_TEXT[s] || s, tier: state.tier });
}

function setTier(n) {
  state.tier = n;
  if (el.tier) {
    el.tier.textContent = TIER_LABEL[n] || "";
    el.tier.hidden = !TIER_LABEL[n];
    el.tier.dataset.tier = String(n);
  }
}

function setLevel(v) {
  if (el.orb) el.orb.style.setProperty("--level", String(Math.min(1, v * 2.2)));
}

function turn(who) {
  el.transcript?.closest(".vb")?.classList.add("is-talking");
  const node = document.createElement("div");
  node.className = "turn";
  node.dataset.who = who;
  const label = document.createElement("span");
  label.className = "turn__who";
  label.textContent = who === "you" ? "You" : "Aditya";
  const p = document.createElement("p");
  p.className = "turn__text";
  node.append(label, p);
  el.transcript?.append(node);
  el.transcript?.scrollTo({ top: el.transcript.scrollHeight, behavior: "smooth" });
  return p;
}

function stream(which, text, final) {
  const key = which === "you" ? "live_user" : "live_bot";
  if (!state[key]) state[key] = turn(which);
  state[key].textContent = text;
  state[key].parentElement.dataset.partial = final ? "false" : "true";
  el.transcript?.scrollTo({ top: el.transcript.scrollHeight, behavior: "smooth" });
  emit({ type: "turn", who: which, text, final: !!final });
  if (final) {
    state.history.push({ role: which === "you" ? "user" : "bot", text });
    state[key] = null;
  }
}

const handlers = {
  onStatus: setStatus,
  onLevel: setLevel,
  onUserText: (t, f) => stream("you", t, f),
  onBotText: (t, f) => stream("bot", t, f),
  history: () => state.history,
  // The live tier answered in text but produced no sound: speak it ourselves rather
  // than leaving the visitor reading. An unread answer is a broken voice bot.
  onSpeakFallback: (text) => {
    console.warn("[voice] live audio missing - speaking the transcript instead");
    speakText(text, setStatus);
  },
  onNothingHeard: (reason) => {
    note(reason === "silence"
      ? "I didn't catch anything — tap the mic and ask away."
      : "I didn't catch that. Tap the mic and try again.");
  },
};

async function startTier1() {
  const live = new LiveSession({
    ...handlers,
    onFatal: (err) => {
      console.warn("[voice] tier 1 failed:", err?.message || err);
      downgrade(err);
    },
  });
  state.live = live;
  await live.start();
  setTier(1);
}

/** Start a session without opening the mic - for a typed or tapped question. */
async function ensureSession() {
  unlockAudio();                       // while the click is still in scope
  if (state.active && (state.live || state.speech)) return;
  state.active = true;
  setStatus("connecting");
  try { await startTier1(); }
  catch (err) { console.warn("[voice] tier 1 unavailable:", err?.message || err); startTier2(); }
  // The session now exists, so its player can be unlocked too. Still the same task
  // as the originating click in every browser that honours activation propagation.
  try { await state.live?.primeAudio?.(); } catch { /* ignore */ }
}

function startTier2() {
  if (!hasSpeechRecognition()) { startTier3("This browser has no speech recognition"); return; }
  const sf = new SpeechFallback({
    ...handlers,
    onFatal: (err, question) => {
      console.warn("[voice] tier 2 failed:", err?.message || err);
      if (String(err?.message) === "mic_denied") { stopAll(); note("I need microphone access to hear you. You can type instead."); setTier(3); openTyping(); }
      else startTier3("The live model isn't reachable", question);
    },
  });
  state.speech = sf;
  setTier(2);
  sf.start();
}

async function startTier3(reason, pendingQuestion) {
  await state.offline.load().catch(() => {});
  setTier(3);
  setStatus("idle");
  note(`${reason}. I'm answering from prepared notes — type a question below.`);
  openTyping();

  // If a question was already asked and the model could not take it, answer it here
  // rather than dropping it. An interviewer who spoke a question should hear an answer.
  if (pendingQuestion) {
    const answer = state.offline.answer(pendingQuestion);
    stream("bot", answer, true);
    speakText(answer, setStatus);
  }
}

function openTyping() {
  if (el.form) { el.form.hidden = false; el.input?.focus(); }
}

function note(text) {
  el.transcript?.closest(".vb")?.classList.add("is-talking");
  const node = document.createElement("div");
  node.className = "turn turn--note";
  node.textContent = text;
  emit({ type: "note", text });
  el.transcript?.append(node);
  el.transcript?.scrollTo({ top: el.transcript.scrollHeight, behavior: "smooth" });
}

async function downgrade(err) {
  const msg = String(err?.message || "");
  await stopAll({ keepTranscript: true });
  if (msg.includes("mic_denied") || msg === "NotAllowedError") {
    note("I couldn't get the microphone. You can type instead.");
    await startTier3("Microphone unavailable");
    return;
  }
  note("Switching to backup voice.");
  startTier2();
}

async function stopAll({ keepTranscript = true } = {}) {
  state.active = false;
  try { await state.live?.stop(); } catch {}
  try { state.speech?.stop(); } catch {}
  // Also cancels speech started outside a session (a chip tapped cold).
  try { window.speechSynthesis?.cancel(); } catch {}
  state.live = null;
  state.speech = null;
  setLevel(0);
  if (!keepTranscript && el.transcript) el.transcript.innerHTML = "";
}

let synthUnlocked = false;

/**
 * Unlock audio output while the click that triggered us is still in scope.
 * Two separate engines need it: the live player's AudioContext, and, for tiers 2 and 3,
 * speechSynthesis - which on some browsers refuses to speak at all unless it has been
 * spoken to once from a gesture. Cheap, idempotent, and must not be deferred.
 */
function unlockAudio() {
  try { state.live?.primeAudio?.(); } catch { /* nothing to prime yet */ }
  if (synthUnlocked) return;
  synthUnlocked = true;
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch { /* not supported */ }
}

async function micPress() {
  unlockAudio();
  // An answer is being prepared or spoken: refuse rather than cut it off. The whole
  // point of press-to-ask is that the room cannot talk over the reply.
  if (state.status === "thinking" || state.status === "speaking") {
    note("Let me finish this one — then tap the mic again.");
    return;
  }

  // A live session is already up: this press either ends the current question early
  // or starts the next one.
  if (state.tier === 1 && state.live) {
    if (state.live.micOpen) { state.live.endTurn("manual"); return; }
    try {
      if (await state.live.beginTurn()) return;
    } catch (err) {
      await micFailure(err);
      return;
    }
  }

  // Tier 2 works the same way: one press, one question.
  if (state.tier === 2 && state.speech) {
    if (state.speech.listening) { state.speech.endTurn(); return; }
    try { state.speech.beginTurn(); return; } catch (err) { await micFailure(err); return; }
  }

  if (state.tier === 3) { openTyping(); return; }

  state.active = true;
  setStatus("connecting");

  try {
    await startTier1();
    // Opening the mic is a separate step, so the first press both connects and listens.
    await state.live?.beginTurn();
  } catch (err) {
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      await micFailure(err);
      return;
    }
    console.warn("[voice] tier 1 unavailable:", err?.message || err);
    note("Live voice isn't available — switching to backup.");
    startTier2();
    try { state.speech?.beginTurn(); } catch { /* handled by onFatal */ }
  }
}

async function micFailure(err) {
  console.warn("[voice] microphone unavailable:", err?.name || err?.message || err);
  await stopAll();
  note("I couldn't get the microphone. You can type instead.");
  await startTier3("Microphone unavailable");
}

/** Ask in text. In tier 1 the live session answers out loud; otherwise /api/chat, then the bank. */
export async function askTyped(question) {
  if (!question) return;
  unlockAudio();

  // In tier 1 the typed question goes into the live session, so the answer is still spoken.
  if (state.tier === 1 && state.live?.sendText(question)) return;

  stream("you", question, true);

  if (state.tier === 3) {
    await state.offline.load().catch(() => {});
    const answer = state.offline.answer(question);
    stream("bot", answer, true);
    speakText(answer, setStatus);
    return;
  }

  setStatus("thinking");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, history: state.history.slice(-6) }),
    });
    if (!res.ok) throw new Error(`chat_${res.status}`);
    const { text } = await res.json();
    stream("bot", text, true);
    // Tiers 2 and 0 (a question asked before any session was started) both speak
    // through the browser; tier 1 already answered in audio.
    if (state.tier === 1) setStatus("idle");
    else speakText(text, setStatus);
  } catch (err) {
    console.warn("[voice] typed ask failed:", err?.message || err);
    await state.offline.load().catch(() => {});
    setTier(3);
    const answer = state.offline.answer(question);
    stream("bot", answer, true);
    speakText(answer, setStatus);
  }
}

/** Ask with the voice: open a session if none is running, then put the question to it. */
export async function askOutLoud(question) {
  if (!question) return;
  await ensureSession();
  if (state.tier === 1 && state.live?.sendText(question)) return;
  return askTyped(question);
}

/** The live status, for a panel that renders itself before the first event arrives. */
export const voice = { get tier() { return state.tier; }, get active() { return state.active; } };

for (const b of el.mic) b.addEventListener("click", micPress);

el.chips?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-question]");
  if (!btn) return;
  const question = btn.dataset.question;
  openTyping();
  // A chip tapped cold should still be a *voice* answer. Bring a session up
  // first; whichever tier survives, the answer comes back out loud.
  if (!state.active && state.tier === 0) {
    await ensureSession();
    if (state.tier === 1 && state.live?.sendText(question)) return;
  }
  askTyped(question);
});

el.form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el.input.value.trim();
  el.input.value = "";
  askTyped(q);
});

// Preload the offline bank so tier 3 works even if the network drops mid-visit.
state.offline.load().catch(() => {});
setStatus("idle");
setTier(0);

window.addEventListener("beforeunload", () => { state.live?.stop(); state.speech?.stop(); });
