/**
 * ConversationMemory — a Durable Object holding one visitor's conversation.
 *
 * NOT ENABLED ON THE LIVE DEPLOYMENT. `wrangler.jsonc` carries no binding for
 * this class on purpose: the public site runs the stateless Worker, where the
 * browser owns the transcript and Gemini's own session-resumption handle carries
 * live-session continuity. This file is the state layer written out in full, with
 * `scripts/test-memory.mjs` exercising it against a storage stub, so it can be
 * read and run without touching a working deployment.
 *
 * To enable it, add to wrangler.jsonc:
 *
 *   "durable_objects": {
 *     "bindings": [{ "name": "MEMORY", "class_name": "ConversationMemory" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ConversationMemory"] }]
 *
 * re-export the class from src/worker.js, and in /api/chat replace the
 * client-supplied `body.history` with `await mem.history()` — see the README.
 *
 * Why a Durable Object and not KV: a conversation is a single-writer object with
 * read-after-write ordering. Two turns arriving together must append, not clobber
 * each other, and KV's eventual consistency cannot promise that. One DO per
 * visitor gives serialised access to exactly that visitor's transcript, located
 * near them, with no coordination between visitors.
 */

/** Turns kept verbatim. Older turns collapse into a running summary line. */
export const MAX_TURNS = 24;
/** A conversation idle this long is dropped, so nothing is kept indefinitely. */
export const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_TEXT = 4000;

const clean = (v) => String(v ?? "").trim().slice(0, MAX_TEXT);

export class ConversationMemory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {{turns: Array, summary: string, updated: number, started: number}|null} */
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    const stored = await this.state.storage.get("conv");
    const now = Date.now();
    if (!stored || now - (stored.updated || 0) > TTL_MS) {
      this.cache = { turns: [], summary: "", updated: now, started: now, expired: Boolean(stored) };
    } else {
      this.cache = stored;
    }
    return this.cache;
  }

  async save() {
    this.cache.updated = Date.now();
    await this.state.storage.put("conv", this.cache);
  }

  /**
   * Append one exchange. Returns the state the caller should show.
   * `tier` records which path answered (1 live, 2 text, 3 offline bank), so the
   * transcript says how the conversation was held, not just what was said.
   */
  async append({ question, answer, tier }) {
    const q = clean(question);
    if (!q) throw new Error("question required");
    const conv = await this.load();
    conv.turns.push({
      q,
      a: clean(answer),
      tier: Number(tier) || null,
      at: Date.now(),
    });
    if (conv.turns.length > MAX_TURNS) {
      const dropped = conv.turns.splice(0, conv.turns.length - MAX_TURNS);
      conv.summary = summarise(conv.summary, dropped);
    }
    await this.save();
    return this.view();
  }

  /** The transcript in the shape `askText(env, question, history)` already takes. */
  async history() {
    const conv = await this.load();
    const out = [];
    if (conv.summary) {
      out.push({ role: "user", parts: [{ text: `Earlier in this conversation: ${conv.summary}` }] });
      out.push({ role: "model", parts: [{ text: "Understood." }] });
    }
    for (const t of conv.turns) {
      out.push({ role: "user", parts: [{ text: t.q }] });
      if (t.a) out.push({ role: "model", parts: [{ text: t.a }] });
    }
    return out;
  }

  async view() {
    const conv = await this.load();
    return {
      turns: conv.turns,
      summary: conv.summary,
      count: conv.turns.length,
      started: conv.started,
      updated: conv.updated,
    };
  }

  async reset() {
    await this.state.storage.delete("conv");
    this.cache = null;
    return { ok: true };
  }

  /** HTTP surface, so a Worker route can be a one-line `stub.fetch(request)`. */
  async fetch(request) {
    const url = new URL(request.url);
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (request.method === "GET" && url.pathname === "/history") {
      return reply({ history: await this.history(), ...(await this.view()) });
    }
    if (request.method === "POST" && url.pathname === "/turn") {
      let body;
      try { body = await request.json(); } catch { return reply({ error: "bad_json" }, 400); }
      try {
        return reply(await this.append(body));
      } catch (e) {
        return reply({ error: String(e.message || e) }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      return reply(await this.reset());
    }
    return reply({ error: "not_found" }, 404);
  }
}

/**
 * Collapse dropped turns into one sentence of topics. Deliberately mechanical:
 * a second model call on every overflowing turn would add latency and quota cost
 * to the path a visitor is waiting on, and the topics are what later turns need.
 */
export function summarise(existing, dropped) {
  const topics = dropped
    .map((t) => t.q.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((q) => (q.length > 80 ? q.slice(0, 77) + "..." : q));
  const joined = topics.join("; ");
  const merged = existing ? `${existing}; ${joined}` : joined;
  return merged.length > 1200 ? merged.slice(merged.length - 1200) : merged;
}

/** Route a visitor to their own object. One id, one conversation, one writer. */
export function memoryFor(env, conversationId) {
  return env.MEMORY.get(env.MEMORY.idFromName(String(conversationId)));
}
