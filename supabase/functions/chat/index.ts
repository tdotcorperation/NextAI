import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4"

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
  }

  const { messages } = await req.json()

  // Get the user's session from the Authorization header
  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.replace('Bearer ', '')

  // Use the newly named SERVICE_ROLE_KEY
  const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';

  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    SERVICE_ROLE_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  )

  const { data: { user } } = await supabaseClient.auth.getUser()

  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      status: 401,
    })
  }

  // Rate Limiting Logic
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const MAX_MESSAGES_PER_DAY = 100;

  let { data: countData, error: countError } = await supabaseClient
    .from('daily_message_counts')
    .select('count, last_reset_date')
    .eq('user_id', user.id)
    .single();

  if (countError && countError.code !== 'PGRST116') { // PGRST116 means no rows found
    console.error("Error fetching daily message count:", countError);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      status: 500,
    });
  }

  let currentCount = 0;
  let lastResetDate = today;

  if (countData) {
    currentCount = countData.count;
    lastResetDate = countData.last_reset_date;

    if (lastResetDate !== today) {
      // Reset count for a new day
      currentCount = 0;
      const { error: updateError } = await supabaseClient
        .from('daily_message_counts')
        .update({ count: 0, last_reset_date: today })
        .eq('user_id', user.id);
      if (updateError) console.error("Error resetting daily message count:", updateError);
    }
  }

  if (currentCount >= MAX_MESSAGES_PER_DAY) {
    return new Response(JSON.stringify({ error: `Daily message limit (${MAX_MESSAGES_PER_DAY}) exceeded.` }), {
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      status: 429, // Too Many Requests
    });
  }

  // Increment count
  if (countData) {
    const { error: updateError } = await supabaseClient
      .from('daily_message_counts')
      .update({ count: currentCount + 1 })
      .eq('user_id', user.id);
    if (updateError) console.error("Error incrementing daily message count:", updateError);
  } else {
    const { error: insertError } = await supabaseClient
      .from('daily_message_counts')
      .insert({ user_id: user.id, count: 1, last_reset_date: today });
    if (insertError) console.error("Error inserting daily message count:", insertError);
  }

  // End Rate Limiting Logic

  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in Supabase Secrets.");
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not set" }), {
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      status: 500,
    })
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent"
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": GEMINI_API_KEY,
  }

  const body = JSON.stringify({
    contents: messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model', // Gemini API uses 'model' for assistant
      parts: [{ text: msg.content }]
    }))
  })

  console.log("Attempting to call Gemini API with URL:", url);
  console.log("Request body (first 200 chars):", body.substring(0, 200));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: body,
    })

    console.log("Gemini API response status:", response.status);

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Gemini API error response:", errorData);
      return new Response(JSON.stringify({ error: "Failed to get response from Gemini API", details: errorData }), {
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        status: response.status,
      })
    }

    let accumulatedRawResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      const chunk = decoder.decode(value, { stream: true });
      console.log("Raw Gemini stream chunk:", chunk); // Keep this for debugging
      accumulatedRawResponse += chunk;
      if (done) break;
    }

    let fullTextResponse = '';
    try {
      const jsonResponse = JSON.parse(accumulatedRawResponse);
      if (Array.isArray(jsonResponse)) {
        jsonResponse.forEach(item => {
          const text = item.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (text) {
            fullTextResponse += text;
          } else if (item.promptFeedback && item.promptFeedback.blockReason) {
            fullTextResponse += `[Blocked: ${item.promptFeedback.blockReason}]`;
            console.warn("Gemini content blocked:", item.promptFeedback.blockReason);
          }
        });
      } else {
        const text = jsonResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) {
          fullTextResponse += text;
        } else if (jsonResponse.promptFeedback && jsonResponse.promptFeedback.blockReason) {
          fullTextResponse += `[Blocked: ${jsonResponse.promptFeedback.blockReason}]`;
          console.warn("Gemini content blocked:", jsonResponse.promptFeedback.blockReason);
        }
      }
      console.log("Final extracted text to send to frontend:", fullTextResponse);
    } catch (e) {
      console.error("Error parsing final Gemini response:", e, accumulatedRawResponse);
      fullTextResponse = `[Error: Failed to parse Gemini response]`;
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }

    return new Response(fullTextResponse, {
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    })

  } catch (error) {
    console.error("Error fetching from Gemini API:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
