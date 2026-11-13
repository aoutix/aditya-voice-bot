// Tier 2: browser speech recognition -> /api/chat -> browser speech synthesis.
// Tier 3: typed question -> baked answer bank, no network at all.

export function hasSpeechRecognition() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Tier 2 voice: not duplex, but still speak-in and speak-out. */
export class SpeechFallback {
  constructor(handlers) {
    this.h = handlers;
    this.rec = null;
    this.running = false;
    this.listening = false;   // true only between a mic press and the end of the question
  }

  /** Build the recogniser but do not listen yet: listening starts on a mic press. */
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("no_speech_recognition");

    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    this.rec = rec;

    rec.onresult = (e) => {
      this.listening = false;   // a result means the question is over
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      if (interim) this.h.onUserText?.(interim, false);
      if (final) { this.h.onUserText?.(final, true); this.ask(final.trim()); }
    };
    rec.onerror = (e) => {
      this.running = false;
      this.listening = false;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.h.onFatal?.(new Error("mic_denied"));
      else if (e.error === "no-speech") { this.h.onStatus?.("idle"); this.h.onNothingHeard?.("silence"); }
      else this.h.onStatus?.("idle");
    };
    // Single-shot: recognition is never restarted on its own, so the mic closes as
    // soon as the question ends and nothing is captured while the answer plays.
    rec.onend = () => {
      this.running = false;
      this.listening = false;
      if (!this.answering) this.h.onStatus?.("idle");
    };

    this.h.onStatus?.("idle");
  }

  /** Open the mic for exactly one question. */
  beginTurn() {
    if (this.running || this.answering) return false;
    if (!this.rec) this.start();
    this.running = true;
    this.listening = true;
    this.h.onStatus?.("listening");
    this.rec.start();
    return true;
  }

  /** Close the mic early, when the visitor taps to say they are done. */
  endTurn() {
    this.listening = false;
    try { this.rec?.stop(); } catch { /* not started */ }
  }

  stop() {
    try { this.rec?.stop(); } catch {}
    this.running = false;
    this.listening = false;
    this.answering = false;
    window.speechSynthesis?.cancel();
  }

  async ask(question) {
    this.answering = true;
    this.h.onStatus?.("thinking");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history: this.h.history?.() || [] }),
      });
      if (!res.ok) throw new Error(`chat_${res.status}`);
      const { text } = await res.json();
      this.h.onBotText?.(text, true);
      this.speak(text);
    } catch (err) {
      this.answering = false;
      // Hand the question down with the error: tier 3 can still answer it from the
      // prepared bank, so a busy model does not swallow what the interviewer asked.
      this.h.onFatal?.(err, question);
    }
  }

  speak(text) {
    // The mic stays shut for the whole answer; the next question needs a fresh press.
    speakText(text, (st) => {
      if (st === "idle") this.answering = false;
      this.h.onStatus?.(st);
    });
  }
}

/**
 * Browser speech synthesis, usable without a SpeechFallback session. Tapping a
 * question chip before any session exists still has to produce a spoken answer —
 * this is a voice bot, so no path through the page should end in silent text.
 */
export function speakText(text, onStatus) {
  const synth = window.speechSynthesis;
  if (!synth || !text) { onStatus?.("idle"); return; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.03;
  u.pitch = 1;
  // Prefer a male en-IN / en-GB voice if the platform has one; otherwise whatever is default.
  const voices = synth.getVoices();
  const pick = voices.find((v) => /en-IN/i.test(v.lang)) ||
               voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur/i.test(v.name)) ||
               voices.find((v) => /en/i.test(v.lang));
  if (pick) u.voice = pick;
  u.onstart = () => onStatus?.("speaking");
  u.onend = () => onStatus?.("idle");
  synth.speak(u);
}

/** Tier 3: no network. Keyword/intent scoring over the prepared answer bank. */
export class OfflineAnswers {
  constructor() { this.data = null; }

  async load() {
    if (this.data) return this.data;
    const res = await fetch("/data/answers.json");
    this.data = await res.json();
    return this.data;
  }

  match(question) {
    if (!this.data) return null;
    // Scoring rules, in order of trust:
    //   a multi-word phrase found in the question    4 + one per word
    //   a single-word key present as a whole word    3
    //   a word sharing a stem with a key             2   ("deadlines" ~ "deadline")
    // The earlier version also scored any key that merely *contained* a question
    // word, which let filler like "about" or "you" outvote the real keyword — so
    // "tell me about a time you failed" matched the life story. Hence whole words.
    const q = question.toLowerCase().replace(/[^a-z0-9#'+.]+/g, " ").trim();
    // "." is kept so "next.js" survives tokenising, but a trailing one would make
    // the last word of a sentence ("...in a team.") match nothing at all.
    const words = q.split(" ").map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);

    let best = null, bestScore = 0;
    for (const e of this.data.entries) {
      let score = 0;
      for (const key of e.keys) {
        const k = key.toLowerCase();
        if (k.includes(" ")) {
          if (q.includes(k)) score += 4 + k.split(" ").length;
        } else if (words.includes(k)) {
          score += 3;
        } else if (k.length >= 4 && words.some((w) => w.length >= 4 && (w.startsWith(k) || k.startsWith(w)))) {
          score += 2;
        }
      }
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return bestScore >= 3 ? best : null;
  }

  answer(question) {
    const hit = this.match(question);
    return hit ? hit.a : this.data?.fallback || "I can't reach my live voice right now.";
  }

  suggestions() {
    return (this.data?.entries || []).slice(0, 5).map((e) => e.q);
  }
}
