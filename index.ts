// ════════════════════════════════════════════════════════════════
//  StudyVerse — llama-proxy Edge Function
//  Powers "AB Ai" — keeps the Llama 3.1 API key on the server;
//  the browser never sees it.
//
//  Uses Groq's OpenAI-compatible chat completions endpoint, which
//  serves Meta's Llama 3.1 models with very fast inference.
//
//  Deploy:
//    supabase functions deploy llama-proxy --project-ref ftingspmkdrdkddsdgtv
//    supabase secrets set GROQ_API_KEY=gsk_... --project-ref ftingspmkdrdkddsdgtv
//
//  Get a free Groq API key at: https://console.groq.com/keys
//
//  Want a different Llama 3.1 host instead (Together AI, Fireworks,
//  Replicate, a self-hosted Ollama box, etc.)? The request/response
//  shape below is the only thing that would need to change — say the
//  word and this function can be adapted.
// ════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const MODEL = "llama-3.1-8b-instant";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_INSTRUCTION =
  "You are AB Ai, StudyVerse's AI study assistant — a friendly, encouraging tutor for " +
  "students studying Biology, Chemistry, Physics, Mathematics, and the Arts. " +
  "Explain concepts clearly and simply, use examples when helpful, and keep a " +
  "warm, supportive tone. Keep answers reasonably concise unless asked for depth.";

// The front-end sends { history: [{role, parts:[{text}]}], message } to
// match the shape used previously — we translate that into OpenAI-style
// chat messages here so the front-end didn't need to change its calling
// convention.
type FrontendChatTurn = { role: string; parts: Array<{ text: string }> };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!GROQ_API_KEY) {
      return json({ error: "GROQ_API_KEY not configured. Run: supabase secrets set GROQ_API_KEY=your_key" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const history: FrontendChatTurn[] = Array.isArray(body.history) ? body.history : [];
    const message: string = typeof body.message === "string" ? body.message : "";

    if (!message.trim()) {
      return json({ error: "Missing 'message' in request body." }, 400);
    }

    const messages = [
      { role: "system", content: SYSTEM_INSTRUCTION },
      ...history.map((turn) => ({
        role: turn.role === "model" ? "assistant" : "user",
        content: (turn.parts || []).map((p) => p.text || "").join(""),
      })),
      { role: "user", content: message },
    ];

    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const msg = data?.error?.message || `Llama API error (${resp.status})`;
      return json({ error: msg }, resp.status);
    }

    const reply: string = data?.choices?.[0]?.message?.content || "";

    if (!reply) {
      return json({ error: "Empty response from AB Ai." }, 502);
    }

    return json({ reply });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown server error." }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
