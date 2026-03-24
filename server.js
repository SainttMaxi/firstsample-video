const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const uploadsDir = path.join(__dirname, 'uploads');
const outputsDir = path.join(__dirname, 'outputs');
[uploadsDir, outputsDir].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── UPLOADCARE ──
async function uploadToUploadcare(filePath, filename) {
  const publicKey = process.env.UPLOADCARE_PUBLIC_KEY || '6ecb544be80204c9c52b';
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = '----UCBoundary' + uuidv4().replace(/-/g, '');

  const bodyStart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="UPLOADCARE_PUB_KEY"\r\n\r\n${publicKey}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="UPLOADCARE_STORE"\r\n\r\n1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'upload.uploadcare.com',
      path: '/base/',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Uploadcare raw response:', data.substring(0, 200));
        try {
          const parsed = JSON.parse(data);
          if (parsed.file) {
            // Explicit filename required for Shotstack
            const url = `https://ucarecdn.com/${parsed.file}/-/format/jpeg/image.jpg`;
            resolve(url);
          } else {
            reject(new Error('Uploadcare error: ' + JSON.stringify(parsed)));
          }
        } catch (e) {
          reject(new Error('Uploadcare parse error - raw: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

// ── GROQ AI PLAN ──
async function generatePlan(prompt, vibe, format, length, files, groqKey) {
  const lengthMap = { short: '10-15', medium: '15-25', long: '25-40' };
  const targetSecs = lengthMap[length] || '15-25';
  const clipCount = length === 'short' ? '4-6' : length === 'medium' ? '5-8' : '8-12';
  const fileContext = files.length > 0
    ? `User uploaded ${files.length} files: ${files.map(f => f.originalname).join(', ')}.`
    : 'No files uploaded.';

  const systemPrompt = `You are an expert TikTok video director for streetwear brands. Respond ONLY with valid JSON, no markdown, no backticks.
JSON structure:
{
  "projectName": "string",
  "totalDuration": number,
  "vibe": "string",
  "song": { "title": "string", "artist": "string", "startTime": number, "bpm": number, "tiktokSearch": "string", "reason": "string" },
  "clips": [{ "order": number, "description": "string", "fileName": "string|null", "duration": number }],
  "textOverlays": [{ "text": "string", "startTime": number, "duration": number, "position": "center|top|bottom", "style": "filled|outline|blue" }],
  "caption": "string",
  "directorNotes": "string"
}`;

  const userPrompt = `Video concept: "${prompt}"
Vibe: ${vibe}, Format: ${format}, Length: ${targetSecs}s, Clips: ${clipCount}
${fileContext}
Rules: Text max 3 words ALL CAPS. Song must be real TikTok track. Beat-sync cuts.`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content || '';
          const cleaned = text.replace(/```json|```/g, '').trim();
          resolve(JSON.parse(cleaned));
        } catch (e) { reject(new Error('Failed to parse AI response: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SHOTSTACK RENDER ──
async function renderWithShotstack(plan, mediaUrls, shotstackKey) {
  let timeAccum = 0;

  const clips = plan.clips.map((clip, i) => {
    // Loop through available mediaUrls if fewer files than clips
    const rawSrc = mediaUrls.length > 0 ? mediaUrls[i % mediaUrls.length] : null;
    
    // If no uploaded file, use black placeholder
    if (!rawSrc) {
      const shotstackClip = {
        asset: { type: 'video', src: 'https://shotstack-assets.s3.amazonaws.com/footage/black.mp4', volume: 0 },
        start: timeAccum,
        length: clip.duration,
        fit: 'cover',
      };
      timeAccum += clip.duration;
      return shotstackClip;
    }

    // All Uploadcare URLs — treat as image since we cannot guarantee video format
    // Uploadcare CDN URLs end with / and work as images
    const shotstackClip = {
      asset: { type: 'image', src: rawSrc },
      start: timeAccum,
      length: clip.duration,
      fit: 'cover',
      effect: 'zoomIn',
    };
    timeAccum += clip.duration;
    return shotstackClip;
  });

  const textClips = (plan.textOverlays || []).map(t => ({
    asset: {
      type: 'title',
      text: t.text || 'TEXT',
      style: 'minimal',
      color: t.style === 'blue' ? '#4D7BFF' : '#FFFFFF',
      size: 'x-large',
      position: t.position === 'top' ? 'top' : t.position === 'bottom' ? 'bottom' : 'center',
    },
    start: t.startTime || 0,
    length: t.duration || 2,
  }));

  const watermark = {
    asset: { type: 'title', text: 'firstsample.co', style: 'minimal', color: '#333333', size: 'x-small', position: 'bottom' },
    start: 0,
    length: timeAccum,
  };

  const payload = {
    timeline: {
      background: '#080808',
      tracks: [
        { clips: [...textClips, watermark] },
        { clips },
      ],
    },
    output: {
      format: 'mp4',
      resolution: 'hd',
      aspectRatio: '9:16',
      fps: 30,
    },
  };

  console.log('Shotstack FULL payload:', JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.shotstack.io',
      path: '/stage/render',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': shotstackKey,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.response?.id) resolve(parsed.response.id);
          else reject(new Error('Shotstack error: ' + JSON.stringify(parsed)));
        } catch (e) { reject(new Error('Shotstack parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pollShotstack(renderId, shotstackKey) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = https.request({
        hostname: 'api.shotstack.io',
        path: `/stage/render/${renderId}`,
        method: 'GET',
        headers: { 'x-api-key': shotstackKey },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const status = parsed.response?.status;
            const url = parsed.response?.url;
            console.log(`Shotstack status: ${status}, full response: ${JSON.stringify(parsed.response).substring(0, 500)}`);
            if (status === 'done' && url) resolve(url);
            else if (status === 'failed') reject(new Error('Shotstack render failed: ' + JSON.stringify(parsed.response?.error || parsed.response)));
            else setTimeout(check, 5000);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    };
    check();
  });
}

// ── ROUTES ──
app.post('/api/generate', upload.array('files', 20), async (req, res) => {
  const { prompt, vibe, format, length, groqKey, shotstackKey } = req.body;
  if (!groqKey) return res.status(400).json({ error: 'Groq API key required' });
  if (!shotstackKey) return res.status(400).json({ error: 'Shotstack API key required' });
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const jobId = uuidv4();
  res.json({ jobId, status: 'processing' });

  try {
    console.log(`[${jobId}] Generating AI plan...`);
    const plan = await generatePlan(prompt, vibe, format, length, req.files || [], groqKey);
    fs.writeFileSync(path.join(outputsDir, `${jobId}.json`), JSON.stringify(plan, null, 2));

    console.log(`[${jobId}] Uploading ${req.files?.length || 0} files to Uploadcare...`);
    const mediaUrls = [];
    for (const file of (req.files || [])) {
      const url = await uploadToUploadcare(file.path, file.originalname);
      mediaUrls.push(url);
      console.log(`[${jobId}] Uploaded: ${url}`);
    }

    console.log(`[${jobId}] MediaUrls: ${JSON.stringify(mediaUrls)}`);
    console.log(`[${jobId}] Submitting to Shotstack...`);
    const renderId = await renderWithShotstack(plan, mediaUrls, shotstackKey);

    console.log(`[${jobId}] Polling render ${renderId}...`);
    const videoUrl = await pollShotstack(renderId, shotstackKey);

    fs.writeFileSync(path.join(outputsDir, `${jobId}.status`), 'done');
    fs.writeFileSync(path.join(outputsDir, `${jobId}.url`), videoUrl);
    console.log(`[${jobId}] Done! ${videoUrl}`);
  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    fs.writeFileSync(path.join(outputsDir, `${jobId}.status`), 'error: ' + err.message);
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const statusFile = path.join(outputsDir, `${jobId}.status`);
  const planFile = path.join(outputsDir, `${jobId}.json`);
  const urlFile = path.join(outputsDir, `${jobId}.url`);

  if (!fs.existsSync(statusFile)) return res.json({ status: 'processing' });
  const status = fs.readFileSync(statusFile, 'utf8').trim();
  if (status === 'done') {
    const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null;
    const videoUrl = fs.existsSync(urlFile) ? fs.readFileSync(urlFile, 'utf8').trim() : null;
    return res.json({ status: 'done', videoUrl, plan });
  }
  return res.json({ status: 'error', message: status });
});

app.listen(PORT, () => console.log(`First Sample Video Server running on port ${PORT}`));
