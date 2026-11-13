import {
  SYSTEM_INSTRUCTION,
  SYSTEM_INSTRUCTION_TEXT,
  VOICE_NAME,
  LIVE_MODEL,
  TEXT_MODELS,
} from "./persona.js";

const GL = "https://generativelanguage.googleapis.com/v1beta";
// Workers open an outbound socket with an https:// URL plus the Upgrade header;
// a wss:// URL is refused by fetch().
const WS = "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Best-effort per-isolate throttle. Not a security boundary — just enough that one
// visitor hammering the page cannot drain a free-tier quota in a minute.
const hits = new Map();
function throttled(ip, limit, windowMs) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 2000) hits.clear();
    return false;
  }
  rec.n += 1;
  return rec.n > limit;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * The setup frame the upstream session actually runs on. The browser never sends
 * this: the Worker substitutes its own, so the model, the persona and the voice
 * cannot be changed by editing the page's JavaScript.
 */
function liveSetup(resume) {
  return {
    setup: {
      model: LIVE_MODEL,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
      },
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: resume ? { handle: resume } : {},
    },
  };
}

// Frames a visitor is allowed to send upstream. Anything else (a second setup,
// an unknown field) is dropped rather than forwarded.
const CLIENT_FRAMES = new Set(["realtimeInput", "clientContent", "toolResponse"]);

function sanitize(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object") return null;
  const out = {};
  for (const k of Object.keys(msg)) if (CLIENT_FRAMES.has(k)) out[k] = msg[k];
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Upstream frames arrive as a string, an ArrayBuffer or a Blob depending on the
// runtime; normalise to text once so the browser always receives a string.
async function frameText(d) {
  if (typeof d === "string") return d;
  if (d instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(d));
  if (ArrayBuffer.isView(d)) return new TextDecoder().decode(d);
  if (d && typeof d.text === "function") return await d.text();
  if (d && typeof d.arrayBuffer === "function") return new TextDecoder().decode(new Uint8Array(await d.arrayBuffer()));
  return "";
}

/**
 * Realtime voice. The browser opens a WebSocket here; the Worker opens one to
 * Google with the API key and pipes frames between them. The key never leaves
 * the Worker, and the session's persona is fixed above.
 *
 * (The documented ephemeral-token path is in preview and the Live socket rejects
 * those tokens — `1007 API key not valid` — so this proxy stands in its place.)
 */
async function liveProxy(request, env, resume) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected_websocket" }, 426);
  }

  let upstream;
  try {
    upstream = await fetch(`${WS}?key=${env.GEMINI_API_KEY}`, {
      headers: { Upgrade: "websocket" },
    });
  } catch (err) {
    // Never echo the error text: it contains the request URL, and the key is in it.
    console.error("live upstream failed:", err);
    return json({ error: "upstream_unreachable" }, 502);
  }

  const server = upstream.webSocket;
  if (!server) return json({ error: "upstream_refused", status: upstream.status }, 502);
  server.accept();

  const pair = new WebSocketPair();
  const [toClient, fromClient] = [pair[0], pair[1]];
  fromClient.accept();

  let ready = false;
  const queued = [];

  // Our setup, not theirs.
  server.send(JSON.stringify(liveSetup(resume)));

  server.addEventListener("message", (ev) => {
    (async () => {
      const data = await frameText(ev.data);
      if (!data) return;
      if (!ready && data.includes("setupComplete")) {
        ready = true;
        for (const q of queued.splice(0)) { try { server.send(q); } catch {} }
      }
      try { fromClient.send(data); } catch { /* client gone */ }
    })().catch((err) => console.error("live downstream:", err));
  });
  server.addEventListener("close", (ev) => {
    try { fromClient.close(ev.code >= 1000 && ev.code <= 4999 ? ev.code : 1011, ev.reason || ""); } catch {}
  });
  server.addEventListener("error", () => { try { fromClient.close(1011, "upstream error"); } catch {} });

  fromClient.addEventListener("message", (ev) => {
    (async () => {
      const safe = sanitize(await frameText(ev.data));
      if (!safe) return;                     // a setup frame or junk: dropped
      if (!ready) { if (queued.length < 64) queued.push(safe); return; }
      try { server.send(safe); } catch { /* upstream gone */ }
    })().catch((err) => console.error("live upstream send:", err));
  });
  fromClient.addEventListener("close", () => { try { server.close(1000, "client closed"); } catch {} });
  fromClient.addEventListener("error", () => { try { server.close(1011, "client error"); } catch {} });

  return new Response(null, { status: 101, webSocket: toClient });
}

async function askText(env, question, history) {
  const contents = [];
  for (const turn of (history || []).slice(-6)) {
    if (!turn?.text) continue;
    contents.push({
      role: turn.role === "bot" ? "model" : "user",
      parts: [{ text: String(turn.text).slice(0, 2000) }],
    });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION_TEXT }] },
    contents,
    // Room for the model's own thinking tokens as well as the answer: too small a
    // budget comes back with a finishReason and no text at all.
    generationConfig: { temperature: 0.85, maxOutputTokens: 1200 },
  });

  // Collect every attempt, not just the last: otherwise a model name that is wrong
  // (404) looks identical to one that is merely busy, and the fallback chain can be
  // silently one model deep.
  const tried = [];
  let last = { ok: false, status: 502, detail: "no model tried" };
  for (const model of TEXT_MODELS) {
    let res, text;
    try {
      res = await fetch(`${GL}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      text = await res.text();
    } catch (err) {
      last = { ok: false, status: 502, detail: `${model}: ${String(err).slice(0, 160)}` };
      tried.push(`${model}=transport`);
      continue;
    }
    if (!res.ok) {
      last = { ok: false, status: res.status, detail: `${model}: ${text.slice(0, 300)}` };
      tried.push(`${model}=${res.status}`);
      continue;            // busy or rate-limited: try the next one
    }
    let data;
    try { data = JSON.parse(text); } catch {
      last = { ok: false, status: 502, detail: `${model}: non-JSON` };
      tried.push(`${model}=non-json`);
      continue;
    }
    const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("").trim();
    if (!out) {
      last = { ok: false, status: 502, detail: `${model}: empty (${data?.candidates?.[0]?.finishReason})` };
      tried.push(`${model}=empty`);
      continue;
    }
    return { ok: true, text: out, model };
  }
  return { ...last, tried };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const ip = request.headers.get("cf-connecting-ip") || "local";

    if (url.pathname === "/api/health") {
      return json({ ok: true, keyConfigured: Boolean(env.GEMINI_API_KEY), liveModel: LIVE_MODEL, textModels: TEXT_MODELS });
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "no_key", message: "GEMINI_API_KEY is not configured on this Worker." }, 503);
    }

    // GET /api/quota - is the key actually able to answer right now?
    // Sends the smallest possible generate call to each text model and reports the
    // status, so "is my quota gone?" is one request rather than a dashboard hunt.
    // Costs one request per model, so it is rate-limited to 4/min.
    if (url.pathname === "/api/quota") {
      if (throttled(ip, 4, 60_000)) return json({ error: "rate_limited", message: "Wait a minute between probes." }, 429);
      const probe = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 1 },
      });
      const models = {};
      let anyOk = false, quotaHit = false;
      for (const model of TEXT_MODELS) {
        try {
          const res = await fetch(`${GL}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: probe,
          });
          if (res.ok) { models[model] = "ok"; anyOk = true; continue; }
          const t = await res.text();
          models[model] = res.status === 429 ? "quota_exhausted"
            : res.status === 503 ? "busy"
            : res.status === 404 ? "no_such_model"
            : res.status === 400 && t.includes("API key") ? "bad_key"
            : `http_${res.status}`;
          if (res.status === 429) quotaHit = true;
        } catch (err) {
          models[model] = "unreachable";
        }
      }
      const verdict = anyOk ? "ready"
        : quotaHit ? "out_of_quota"
        : "unavailable";
      return json({
        verdict,
        models,
        meaning: {
          ready: "At least one text model answered. Tiers 1 and 2 should work.",
          out_of_quota: "Every model returned 429. The page will fall back to prepared notes until the daily quota resets at midnight US Pacific.",
          unavailable: "No model answered, but not for quota reasons - check the statuses.",
        }[verdict],
      });
    }

    if (url.pathname === "/api/live") {
      if (throttled(ip, 12, 60_000)) return json({ error: "rate_limited" }, 429);
      return liveProxy(request, env, url.searchParams.get("resume") || "");
    }

    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    if (url.pathname === "/api/chat") {
      if (throttled(ip, 25, 60_000)) return json({ error: "rate_limited" }, 429);
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
      const question = String(body?.question || "").trim().slice(0, 1000);
      if (!question) return json({ error: "empty_question" }, 400);
      const r = await askText(env, question, body?.history);
      if (!r.ok) return json({ error: "chat_failed", status: r.status, detail: r.detail, tried: r.tried }, 502);
      return json({ text: r.text });
    }

    return json({ error: "not_found" }, 404);
  },
};
