// Tier 1: true realtime speech-to-speech over the Gemini Live API.
// The socket goes to this site's own Worker, which holds the API key and pipes frames
// to Google. Raw WebSocket rather than the SDK: no CDN dependency, no bundler, and full
// control over barge-in and reconnection, where the SDK abstractions get in the way.

const WS_PATH = "/api/live";

const CAPTURE_RATE = 16000; // required: raw 16-bit PCM, 16 kHz, little-endian
const PLAYBACK_RATE = 24000; // the server sends raw 16-bit PCM at 24 kHz

// One question per mic press. Audio is only sent while a turn is open, so the model
// can never be interrupted by the room, by the answer playing back, or by a cough.
// The worklet hands us a peak (0..1) every ~64 ms, which is enough for simple VAD.
const CHUNK_MS = 64;
const FLOOR_MIN = 0.07;     // never treat anything quieter than this as speech
const CALIBRATE_MS = 384;   // sample the room for six chunks before deciding
const SILENCE_MS = 1300;    // this much quiet after speech ends the turn
const NO_SPEECH_MS = 9000;  // pressed the mic and said nothing
const MAX_TURN_MS = 60000;  // a hard stop, so the mic cannot stay open forever

function b64encode(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function floatToPCM16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function pcm16ToFloat(bytes) {
  // Byte offset may be unaligned after base64 decode, so read via DataView.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Schedules incoming PCM chunks back-to-back so speech plays gaplessly,
 *  and can be cut off instantly when the model is interrupted. */
class Player {
  constructor(onState) {
    this.ctx = null;
    this.gain = null;
    this.playHead = 0;
    this.sources = new Set();
    this.onState = onState || (() => {});
    this.speaking = false;
  }

  async ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PLAYBACK_RATE });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  async push(float32) {
    const ctx = await this.ensure();
    const buf = ctx.createBuffer(1, float32.length, PLAYBACK_RATE);
    buf.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    const now = ctx.currentTime;
    // A small lead keeps the first chunk from being clipped by scheduling jitter.
    if (this.playHead < now + 0.04) this.playHead = now + 0.04;
    src.start(this.playHead);
    this.playHead += buf.duration;

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0 && this.speaking) {
        this.speaking = false;
        this.onState(false);
      }
    };

    if (!this.speaking) {
      this.speaking = true;
      this.onState(true);
    }
  }

  /** Barge-in: drop everything already scheduled, immediately. */
  flush() {
    for (const src of this.sources) {
      try { src.onended = null; src.stop(); } catch { /* already finished */ }
    }
    this.sources.clear();
    this.playHead = this.ctx ? this.ctx.currentTime : 0;
    if (this.speaking) {
      this.speaking = false;
      this.onState(false);
    }
  }
}

export class LiveSession {
  /**
   * @param {object} handlers
   *   onStatus(state, detail)   connecting | listening | thinking | speaking | closed | error
   *   onUserText(text, final)   live transcript of what the visitor said
   *   onBotText(text, final)    live transcript of what the bot said
   *   onLevel(peak)             0..1 mic level for the orb
   *   onFatal(err)              tier 1 has failed; caller should fall back
   */
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.captureCtx = null;
    this.stream = null;
    this.node = null;
    this.player = new Player((sp) => this.h.onStatus?.(sp ? "speaking" : (this.micOpen ? "listening" : "idle")));
    this.micOpen = false;
    this.vad = null;
    this.gotAudio = false;   // did THIS turn actually produce sound?
    this.model = null;
    this.resumeHandle = null;
    this.closedByUser = false;
    this.ready = false;
    this.userBuf = "";
    this.botBuf = "";
    this.reconnects = 0;
  }

  async start() {
    this.closedByUser = false;
    this.h.onStatus?.("connecting");
    // Both of these must happen while the originating click is still in scope, or the
    // browser refuses to start audio and the answer arrives as text with no sound.
    // Closing the mic between turns broke exactly that, so the mic now stays open for
    // the whole session; what prevents interruption is that no audio is SENT unless a
    // turn is open (see onAudioChunk), not that the device is released.
    await this.openMic();
    await this.primeAudio();
    await this.connect();
  }

  /**
   * Create and unlock the playback AudioContext. MUST be called from inside a click
   * handler: browsers only let audio start while user activation is live, and the
   * first answer chunk arrives from a WebSocket message, which is not a gesture.
   * Before turn-taking, openMic() happened on the click and incidentally covered this.
   */
  async primeAudio() {
    try { await this.player.ensure(); } catch { /* no output device, or blocked */ }
  }

  /** Open the mic and start a single question. Resolves false if the session isn't ready. */
  async beginTurn() {
    if (!this.ready || this.micOpen) return false;
    if (this.player.speaking) return false;        // never talk over the answer
    await this.openMic();     // a no-op when the session already holds the mic
    await this.primeAudio();  // cheap, and keeps playback alive after a tab suspend
    this.vad = { opened: Date.now(), floor: 0, calibrated: false, spoke: false, quietFor: 0 };
    this.micOpen = true;
    this.h.onStatus?.("listening");
    return true;
  }

  /**
   * Close the mic and hand the turn to the model.
   * @param {"vad"|"manual"|"silence"|"timeout"} reason
   */
  endTurn(reason = "manual") {
    if (!this.micOpen) return;
    const spoke = Boolean(this.vad?.spoke);
    this.micOpen = false;
    this.vad = null;
    // The mic stays open and simply stops being forwarded. Releasing the device here
    // also tore down the audio graph the answer plays through.
    if (!spoke) {
      // Nothing was said, so there is no turn to complete: stay put rather than
      // asking the model to answer silence.
      this.h.onLevel?.(0);
      this.h.onStatus?.("idle");
      this.h.onNothingHeard?.(reason);
      return;
    }
    // Tell the server the question is finished; its own VAD would get there eventually,
    // but this makes the end of the turn deterministic and immediate.
    this.gotAudio = false;
    this.send({ realtimeInput: { audioStreamEnd: true } });
    this.h.onLevel?.(0);
    this.h.onStatus?.("thinking");
  }

  async openMic() {
    if (this.captureCtx) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no_getusermedia");

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("no_audiocontext");
    // Asking for 16 kHz directly lets the browser resample; no hand-rolled downsampler.
    this.captureCtx = new Ctx({ sampleRate: CAPTURE_RATE });
    if (this.captureCtx.state === "suspended") await this.captureCtx.resume();
    if (!this.captureCtx.audioWorklet) throw new Error("no_audioworklet");

    await this.captureCtx.audioWorklet.addModule("/js/pcm-worklet.js");
    const src = this.captureCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.captureCtx, "pcm-capture");
    this.node.port.onmessage = (e) => this.onAudioChunk(e.data);
    src.connect(this.node);
    // Keep the worklet pulled without routing the mic to the speakers.
    const sink = this.captureCtx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.captureCtx.destination);
  }

  closeMic() {
    try { this.node?.disconnect(); } catch { /* already gone */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    try { this.captureCtx?.close(); } catch { /* already gone */ }
    this.captureCtx = null; this.stream = null; this.node = null;
  }

  onAudioChunk({ pcm, peak }) {
    // No open turn means no audio leaves the browser at all: that is what makes
    // interruption impossible rather than merely discouraged.
    if (!this.micOpen) return;
    this.h.onLevel?.(peak || 0);
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;

    this.send({
      realtimeInput: {
        audio: { data: b64encode(floatToPCM16(pcm)), mimeType: `audio/pcm;rate=${CAPTURE_RATE}` },
      },
    });

    const v = this.vad;
    if (!v) return;
    const elapsed = Date.now() - v.opened;
    const level = peak || 0;

    if (!v.calibrated) {
      // Learn the room's noise floor from the first few chunks, so a noisy cafe
      // does not read as continuous speech and a silent room is not over-sensitive.
      if (level > v.floor) v.floor = level;
      if (elapsed >= CALIBRATE_MS) { v.calibrated = true; v.threshold = Math.max(FLOOR_MIN, v.floor * 2.2); }
      return;
    }

    if (level >= v.threshold) {
      v.spoke = true;
      v.quietFor = 0;
    } else if (v.spoke) {
      v.quietFor += CHUNK_MS;
      if (v.quietFor >= SILENCE_MS) { this.endTurn("vad"); return; }
    }

    if (!v.spoke && elapsed >= NO_SPEECH_MS) { this.endTurn("silence"); return; }
    if (elapsed >= MAX_TURN_MS) this.endTurn("timeout");
  }

  async connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // The handle lets the Worker resume the same conversation after the ~10 minute
    // connection cap, so a long interview never visibly drops.
    const q = this.resumeHandle ? `?resume=${encodeURIComponent(this.resumeHandle)}` : "";
    const url = `${proto}//${location.host}${WS_PATH}${q}`;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let settled = false;

      const giveUp = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error("ws_timeout")); }
      }, 12000);

      ws.onopen = () => {
        // The Worker sends the setup frame itself — model, persona, voice and
        // transcription are fixed server-side — so there is nothing to send here.
        // Audio starts flowing once setupComplete arrives.
      };

      ws.onmessage = async (ev) => {
        let msg;
        try {
          const text = ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : ev.data;
          msg = JSON.parse(text);
        } catch { return; }

        if (msg.setupComplete !== undefined) {
          clearTimeout(giveUp);
          this.ready = true;
          this.reconnects = 0;
          this.h.onStatus?.("listening");
          if (!settled) { settled = true; resolve(); }
          return;
        }
        this.handle(msg);
      };

      ws.onerror = () => {
        clearTimeout(giveUp);
        if (!settled) { settled = true; reject(new Error("ws_error")); }
      };

      ws.onclose = (e) => {
        clearTimeout(giveUp);
        this.ready = false;
        if (!settled) { settled = true; reject(new Error(`ws_closed_${e.code}`)); return; }
        this.onClosed(e);
      };
    });
  }

  handle(msg) {
    const sc = msg.serverContent;

    if (msg.sessionResumptionUpdate?.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }

    if (msg.goAway) {
      // The server is about to end this connection; reconnect under it.
      this.reconnectSoon();
      return;
    }

    if (!sc) return;

    // Barge-in. This is the line that makes it feel realtime rather than a player.
    if (sc.interrupted) {
      this.player.flush();
      if (this.botBuf) { this.h.onBotText?.(this.botBuf, true); this.botBuf = ""; }
      this.h.onStatus?.("listening");
      return;
    }

    if (sc.inputTranscription?.text) {
      this.userBuf += sc.inputTranscription.text;
      this.h.onUserText?.(this.userBuf, false);
    }

    if (sc.outputTranscription?.text) {
      this.botBuf += sc.outputTranscription.text;
      this.h.onBotText?.(this.botBuf, false);
    }

    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      const d = p.inlineData;
      if (d?.data && (d.mimeType || "").startsWith("audio/")) {
        this.gotAudio = true;
        this.player.push(pcm16ToFloat(b64decode(d.data)));
      }
    }

    if (sc.generationComplete || sc.turnComplete) {
      if (this.userBuf) { this.h.onUserText?.(this.userBuf, true); this.userBuf = ""; }
      const finalText = this.botBuf;
      if (this.botBuf) { this.h.onBotText?.(this.botBuf, true); this.botBuf = ""; }

      // Safety net: an answer must never be silent. If this turn produced a transcript
      // but no audio - the model returned text only, playback was blocked, or the audio
      // parts never arrived - read it out with the browser's own voice instead.
      if (!this.gotAudio && finalText.trim()) {
        this.h.onSpeakFallback?.(finalText.trim());
      } else if (!this.micOpen && !this.player.speaking) {
        this.h.onStatus?.("idle");
      }
      this.gotAudio = false;
      this.h.onTurnDone?.();
    }
  }

  /** Send a typed question into the same live session; the reply still comes back as speech. */
  sendText(text) {
    if (!this.ready) return false;
    this.gotAudio = false;
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
    this.h.onUserText?.(text, true);
    this.h.onStatus?.("thinking");
    return true;
  }

  send(obj) {
    try { this.ws.send(JSON.stringify(obj)); } catch { /* socket closing */ }
  }

  onClosed(e) {
    if (this.closedByUser) { this.h.onStatus?.("closed"); return; }
    // 1007/1011 and friends after a long session are expected: connections cap at ~10 min.
    if (this.reconnects < 3) { this.reconnectSoon(); return; }
    this.h.onStatus?.("error", `closed_${e?.code ?? "?"}`);
    this.h.onFatal?.(new Error(`ws_closed_${e?.code ?? "?"}`));
  }

  reconnectSoon() {
    if (this.closedByUser || this._reconnecting) return;
    this._reconnecting = true;
    this.reconnects += 1;
    this.ready = false;
    this.h.onStatus?.("connecting", "reconnecting");
    try { this.ws?.close(); } catch {}
    setTimeout(async () => {
      this._reconnecting = false;
      if (this.closedByUser) return;
      try { await this.connect(); } catch (err) {
        if (this.reconnects >= 3) { this.h.onStatus?.("error", String(err.message || err)); this.h.onFatal?.(err); }
        else this.reconnectSoon();
      }
    }, 400 * this.reconnects);
  }

  async stop() {
    this.closedByUser = true;
    this.ready = false;
    this.player.flush();
    this.micOpen = false;
    this.vad = null;
    try { this.ws?.close(); } catch {}
    this.closeMic();
    this.ws = null;
    this.h.onStatus?.("closed");
  }
}
