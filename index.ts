// ════════════════════════════════════════════════════════════════
//  StudyVerse — gemini-proxy Edge Function
//  Keeps the Gemini API key on the server; the browser never sees it.
//
//  Deploy:
//    supabase functions deploy gemini-proxy --project-ref ftingspmkdrdkddsdgtv
//    supabase secrets set GEMINI_API_KEY=AIza... --project-ref ftingspmkdrdkddsdgtv
//
//  Get a free Gemini API key at: https://aistudio.google.com/apikey
// ════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = "gemini-2.0-flash";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_INSTRUCTION =
  "You are the StudyVerse AI Study Assistant — a friendly, encouraging tutor for " +
  "students studying Biology, Chemistry, Physics, Mathematics, and the Arts. " +
  "Explain concepts clearly and simply, use examples when helpful, and keep a " +
  "warm, supportive tone. Keep answers reasonably concise unless asked for depth.";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!GEMINI_API_KEY) {
      return json({ error: "GEMINI_API_KEY not configured. Run: supabase secrets set GEMINI_API_KEY=your_key" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const history: Array<{ role: string; parts: Array<{ text: string }> }> = Array.isArray(body.history) ? body.history : [];
    const message: string = typeof body.message === "string" ? body.message : "";

    if (!message.trim()) {
      return json({ error: "Missing 'message' in request body." }, 400);
    }

    const contents = [...history, { role: "user", parts: [{ text: message }] }];

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        }),
      },
    );

    const data = await resp.json();

    if (!resp.ok) {
      const msg = data?.error?.message || `Gemini API error (${resp.status})`;
      return json({ error: msg }, resp.status);
    }

    const reply: string = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: { text?: string }) => p.text || "")
      .join("");

    if (!reply) {
      const blockReason = data?.promptFeedback?.blockReason;
      return json({ error: blockReason ? `Response blocked: ${blockReason}` : "Empty response from Gemini." }, 502);
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
