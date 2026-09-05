// ════════════════════════════════════════════════════════════════
//  StudyVerse — openai-proxy Edge Function
//  Powers "AB Ai" using OpenAI's Chat Completions API.
//  The API key lives in Supabase secrets — the browser never sees it.
//
//  Deploy:
//    supabase functions deploy openai-proxy --project-ref ftingspmkdrdkddsdgtv
//    supabase secrets set OPENAI_API_KEY=sk-... --project-ref ftingspmkdrdkddsdgtv
//
//  IMPORTANT: use a NEW key here. Any key that has ever been pasted into a
//  chat, screenshot, or ticket should be treated as compromised and revoked
//  at platform.openai.com/api-keys before a replacement is issued.
// ════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const MODEL = "gpt-4o-mini"; // swap for any chat model your OpenAI account has access to

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

// Same frontend turn shape used by the existing proxies — no front-end
// calling-convention changes needed.
type FrontendChatTurn = { role: string; parts: Array<{ text: string }> };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!OPENAI_API_KEY) {
      return json({ error: "OPENAI_API_KEY not configured. Run: supabase secrets set OPENAI_API_KEY=your_key" }, 500);
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

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
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
      const msg = data?.error?.message || `OpenAI API error (${resp.status})`;
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
