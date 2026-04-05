# Adobe AI Assistant

An AI chatbot that ONLY answers questions about Adobe apps — Photoshop, Illustrator, Premiere Pro, After Effects, InDesign, Lightroom, XD, and more. Powered by Groq (free).

---

## 🚀 Setup (3 minutes)

### 1. Get your free Groq API key
Go to [console.groq.com](https://console.groq.com) → sign up with email → API Keys → Create key. No card needed.

### 2. Setup the backend

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and paste your key:
```
GROQ_API_KEY=your_groq_key_here
PORT=3002
```

Start the server:
```bash
npm start
```

You should see:
```
🎨 Adobe Assistant API running at http://localhost:3002
```

### 3. Open the frontend
Open `frontend/index.html` in your browser. Done!

---

## 📁 Project Structure

```
adobe-assistant/
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── .env        ← your keys go here
└── frontend/
    └── index.html
```

---

## ✨ Features

- Only answers Adobe-related questions — refuses everything else
- Filter by specific Adobe app (Photoshop, Illustrator, Premiere, etc.)
- Quick suggestion buttons in sidebar
- Clean dark UI inspired by Adobe's design language
- Markdown rendering with bold, code, bullet points
- Runs 100% free with Groq
