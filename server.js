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

app.use('/uploads', express.static(uploadsDir));
app.use('/outputs', express.static(outputsDir));

// ── GROQ AI PLAN ──
async function generatePlan(prompt, vibe, format, length, files, groqKey) {
  const lengthMap = { short: '10-15', medium: '15-25', long: '25-40' };
  const targetSecs = lengthMap[length] || '15-25';
  const clipCount = length === 'short' ? '4-6' : length === 'medium' ? '5-8' : '8-12';

  const fileContext = files.length > 0
    ? `User uploaded ${files.length} files: ${files.map(f => f.originalname).join(', ')}. Match fileName to uploaded files.`
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
        } catch (e) {
          reject(new Error('Failed to parse AI response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SHOTSTACK RENDER ──
async function renderWithShotstack(plan, uploadedFiles, shotstackKey) {
  const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  const fps = 30;

  // Build clips array for Shotstack timeline
  let timeAccum = 0;
  const clips = plan.clips.map((clip, i) => {
    const matchedFile = uploadedFiles.find(f =>
      clip.fileName && f.originalname.toLowerCase().includes(
        clip.fileName.toLowerCase().replace(/\.[^.]+$/, '')
      )
    ) || (uploadedFiles.length > 0 ? uploadedFiles[i % uploadedFiles.length] : null);

    const src = matchedFile
      ? `${baseUrl}/uploads/${matchedFile.filename}`
      : 'https://shotstack-assets.s3.amazonaws.com/footage/black.mp4';

    const isVideo = matchedFile && /\.(mp4|mov|webm|avi)$/i.test(matchedFile.originalname);

    const shotstackClip = {
      asset: isVideo
        ? { type: 'video', src, volume: 0 }
        : { type: 'image', src },
      start: timeAccum,
      length: clip.duration,
      fit: 'cover',
      effect: isVideo ? undefined : 'zoomIn',
    };

    timeAccum += clip.duration;
    return shotstackClip;
  });

  // Build text overlays
  const textClips = (plan.textOverlays || []).map(t => {
    const posMap = { top: 'top', center: 'center', bottom: 'bottom' };
    const colorMap = { filled: '#FFFFFF', outline: '#FFFFFF', blue: '#4D7BFF' };

    return {
      asset: {
        type: 'title',
        text: t.text,
        style: 'minimal',
        color: colorMap[t.style] || '#FFFFFF',
        size: 'x-large',
        background: 'none',
        position: posMap[t.position] || 'center',
      },
      start: t.startTime,
      length: t.duration,
    };
  });

  // Accent line at top
  const accentClip = {
    asset: {
      type: 'shape',
      shape: 'rectangle',
      color: '#2d5fff',
      width: 1.0,
      height: 0.003,
      opacity: 1,
      position: 'topCenter',
    },
    start: 0,
    length: timeAccum,
  };

  // Watermark
  const watermarkClip = {
    asset: {
      type: 'title',
      text: 'firstsample.co',
      style: 'minimal',
      color: '#ffffff',
      size: 'x-small',
      opacity: 0.15,
      position: 'bottomCenter',
    },
    start: 0,
    length: timeAccum,
  };

  const tracks = [
    { clips: [...textClips, accentClip, watermarkClip] },
    { clips },
  ];

  const fmtMap = { '9:16': { w: 1080, h: 1920 }, '1:1': { w: 1080, h: 1080 }, '16:9': { w: 1920, h: 1080 } };
  const fmt = fmtMap['9:16'];

  const payload = {
    timeline: {
      background: '#080808',
      tracks,
    },
    output: {
      format: 'mp4',
      resolution: 'hd',
      aspectRatio: '9:16',
      fps: 30,
      size: { width: fmt.w, height: fmt.h },
    },
  };

  // Submit to Shotstack
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
          if (parsed.response?.id) {
            resolve(parsed.response.id);
          } else {
            reject(new Error('Shotstack error: ' + JSON.stringify(parsed)));
          }
        } catch (e) {
          reject(new Error('Shotstack parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Poll Shotstack for render status
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
            if (status === 'done' && url) {
              resolve(url);
            } else if (status === 'failed') {
              reject(new Error('Shotstack render failed'));
            } else {
              setTimeout(check, 5000);
            }
          } catch (e) {
            reject(e);
          }
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

    console.log(`[${jobId}] Submitting to Shotstack...`);
    const renderId = await renderWithShotstack(plan, req.files || [], shotstackKey);
    fs.writeFileSync(path.join(outputsDir, `${jobId}.renderid`), renderId);

    console.log(`[${jobId}] Polling Shotstack render ${renderId}...`);
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
