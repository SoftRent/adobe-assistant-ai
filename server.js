const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ---- SERVE FRONTEND ----
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
  }
}));

const PORT = process.env.PORT || 3002;

// ---- SUPABASE JWT VERIFICATION ----
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function verifySupabaseToken(token) {
  if (!token) return null;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set — skipping auth check.");
    return { id: "anonymous" };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": SUPABASE_ANON_KEY,
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const user = await verifySupabaseToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized. Please sign in." });
  req.user = user;
  next();
}

// ---- MULTI-KEY MANAGER ----
const groqKeys = [];
let keyIndex = 0;
const keyStatus = {};

function loadKeys() {
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GROQ_API_KEY_${i}`];
    if (key && key.trim()) groqKeys.push(key.trim());
  }
  if (groqKeys.length === 0 && process.env.GROQ_API_KEY) {
    groqKeys.push(process.env.GROQ_API_KEY.trim());
  }
  groqKeys.forEach((_, i) => {
    keyStatus[i] = { rateLimited: false, cooldownUntil: 0, requests: 0, errors: 0 };
  });
}
loadKeys();

function getNextKey() {
  const now = Date.now();
  for (let i = 0; i < groqKeys.length; i++) {
    const idx = (keyIndex + i) % groqKeys.length;
    const status = keyStatus[idx];
    if (status.rateLimited && now > status.cooldownUntil) {
      status.rateLimited = false;
      console.log(`Key ${idx + 1} cooldown expired, back in rotation`);
    }
    if (!status.rateLimited) {
      keyIndex = (idx + 1) % groqKeys.length;
      keyStatus[idx].requests++;
      return { key: groqKeys[idx], idx };
    }
  }
  let soonestIdx = 0, soonest = Infinity;
  groqKeys.forEach((_, i) => {
    if (keyStatus[i].cooldownUntil < soonest) { soonest = keyStatus[i].cooldownUntil; soonestIdx = i; }
  });
  console.warn(`All keys rate-limited. Using key ${soonestIdx + 1} anyway.`);
  return { key: groqKeys[soonestIdx], idx: soonestIdx };
}

function markKeyRateLimited(idx, retryAfterMs = 60000) {
  keyStatus[idx].rateLimited = true;
  keyStatus[idx].cooldownUntil = Date.now() + retryAfterMs;
  keyStatus[idx].errors++;
  console.warn(`Key ${idx + 1} rate-limited. Cooldown ${retryAfterMs / 1000}s.`);
}

// ---- API ROUTES ----
app.get("/api/health", (req, res) => res.json({ status: "ok", keys: groqKeys.length }));

app.get("/api/keys/status", (req, res) => {
  const now = Date.now();
  res.json({
    total: groqKeys.length,
    available: groqKeys.filter((_, i) => !keyStatus[i].rateLimited).length,
    keys: groqKeys.map((k, i) => ({
      index: i + 1,
      preview: k.slice(0, 8) + "...",
      rateLimited: keyStatus[i].rateLimited,
      cooldownRemaining: keyStatus[i].rateLimited ? Math.max(0, Math.ceil((keyStatus[i].cooldownUntil - now) / 1000)) : 0,
      requests: keyStatus[i].requests,
      errors: keyStatus[i].errors,
    }))
  });
});

function buildSystemPrompt(adobeApp, skillLevel) {
  const appContext = adobeApp && adobeApp !== "all" ? ` The user is specifically asking about ${adobeApp}.` : "";
  const levelContext = {
    beginner: "The user is a BEGINNER. Use simple language, avoid jargon, explain every term, and give very detailed step-by-step instructions.",
    intermediate: "The user has INTERMEDIATE knowledge. You can use standard Adobe terminology and assume basic familiarity with the interface.",
    advanced: "The user is ADVANCED. Be concise, use technical terminology, mention shortcuts and power-user tips, skip basic explanations.",
  }[skillLevel] || "";

  return `You are an expert Adobe software assistant. You ONLY answer questions related to Adobe applications including Photoshop, Illustrator, Premiere Pro, After Effects, InDesign, Lightroom, Adobe XD, Audition, Animate, Acrobat, Bridge, Dreamweaver, Fresco, Dimension, and Substance.${appContext}

${levelContext}

If the user asks about ANYTHING not related to Adobe software or creative workflows in Adobe apps, respond with exactly this word and nothing else: OFFTOPIC

For Adobe questions:
- Give clear, step-by-step answers
- Mention specific menu paths like **File > Export > Export As**
- Highlight keyboard shortcuts like **Ctrl+T** (Windows) / **Cmd+T** (Mac)
- Use **bold** for important terms
- After your answer, on a new line write FOLLOWUPS: then list exactly 3 short follow-up questions starting with "- "
- Keep answers thorough but scannable`;
}

async function callGroqStream(messages, attempt = 0) {
  if (groqKeys.length === 0) throw new Error("No GROQ API keys configured");
  if (attempt >= groqKeys.length) throw new Error("All API keys are rate-limited. Please wait a moment and try again.");

  const { key, idx } = getNextKey();
  console.log(`Using key ${idx + 1} (attempt ${attempt + 1})`);

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 1024, stream: true, messages }),
  });

  if (groqRes.status === 429) {
    const retryAfter = parseInt(groqRes.headers.get("retry-after") || "60") * 1000;
    markKeyRateLimited(idx, retryAfter);
    return callGroqStream(messages, attempt + 1);
  }

  if (!groqRes.ok) {
    const err = await groqRes.json().catch(() => ({}));
    keyStatus[idx].errors++;
    throw new Error(err.error?.message || `Groq API error: ${groqRes.status}`);
  }

  return { groqRes, keyIdx: idx };
}

app.post("/api/chat/stream", requireAuth, async (req, res) => {
  const { message, app: adobeApp, skillLevel, history } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });
  if (groqKeys.length === 0) return res.status(500).json({ error: "No GROQ API keys configured" });

  const messages = [
    { role: "system", content: buildSystemPrompt(adobeApp, skillLevel) },
    ...(history || []).slice(-10),
    { role: "user", content: message },
  ];

  try {
    const { groqRes } = await callGroqStream(messages);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";

    for await (const chunk of groqRes.body) {
      const lines = chunk.toString().split("\n").filter(l => l.startsWith("data: "));
      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          if (fullText.trim() === "OFFTOPIC" || fullText.trim().startsWith("OFFTOPIC")) {
            res.write(`data: ${JSON.stringify({ offTopic: true })}\n\n`);
          } else {
            const parts = fullText.split("FOLLOWUPS:");
            const answer = parts[0].trim();
            const followups = parts[1]
              ? parts[1].trim().split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean).slice(0, 3)
              : [];
            res.write(`data: ${JSON.stringify({ done: true, followups, fullAnswer: answer })}\n\n`);
          }
          res.end(); return;
        }
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content || "";
          if (token) {
            fullText += token;
            if (!fullText.includes("FOLLOWUPS:")) {
              res.write(`data: ${JSON.stringify({ token })}\n\n`);
            }
          }
        } catch {}
      }
    }
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ---- CATCH-ALL: always serve index.html for non-API routes ----
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🎨 Adobe Assistant running at http://localhost:${PORT}`);
  console.log(`🔑 Loaded ${groqKeys.length} API key(s)`);
  groqKeys.forEach((k, i) => console.log(`   Key ${i + 1}: ${k.slice(0, 8)}...`));
  console.log(`🌐 Frontend: /public\n`);
});
