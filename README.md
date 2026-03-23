# First Sample — AI Video Creator

AI-powered video generator built with Remotion. Upload your clips, describe the video, get a rendered MP4.

## Deploy on Railway (free)

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Select this repo
4. Railway auto-detects Node.js and deploys

## Local development

```bash
npm install
npm start
```

Open http://localhost:3000

## How it works

1. User uploads clips + writes prompt
2. Groq AI (free) generates video plan: clip order, timing, text overlays, song recommendation
3. Remotion renders a real MP4 server-side
4. User downloads MP4 and uploads to TikTok with recommended song
