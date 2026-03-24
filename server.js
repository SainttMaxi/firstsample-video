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
        try {
          const parsed = JSON.parse(data);
          if (parsed.file) resolve(`https://ucarecdn.com/${parsed.file}/-/format/jpeg/image.jpg`);
          else reject(new Error('Uploadcare error: ' + JSON.stringify(parsed)));
        } catch (e) { reject(e); }
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

// ── CREATOMATE RENDER ──
async function renderWithCreatomate(plan, mediaUrls, creatomateKey) {
  let timeAccum = 0;

  // Build Creatomate elements
  const elements = [];

  // Background
  elements.push({
    type: 'rectangle',
    width: '100%',
    height: '100%',
    x_anchor: '0%',
    y_anchor: '0%',
    color: '#080808',
    time: 0,
    duration: plan.totalDuration || 20,
  });

  // Video/image clips
  plan.clips.forEach((clip, i) => {
    const src = mediaUrls.length > 0 ? mediaUrls[i % mediaUrls.length] : null;
    if (!src) { timeAccum += clip.duration; return; }

    elements.push({
      type: 'image',
      source: src,
      width: '100%',
      height: '100%',
      x_anchor: '0%',
      y_anchor: '0%',
      fit: 'cover',
      time: timeAccum,
      duration: clip.duration,
      animations: [
        { time: 'start', duration: 0.3, easing: 'linear', type: 'fade', fade: 0 },
        { time: 'end', duration: 0.3, easing: 'linear', type: 'fade', fade: 0 },
      ],
    });
    timeAccum += clip.duration;
  });

  // Text overlays
  (plan.textOverlays || []).forEach(t => {
    const colorMap = { filled: '#FFFFFF', outline: '#FFFFFF', blue: '#4D7BFF' };
    const yMap = { top: '15%', center: '50%', bottom: '80%' };

    elements.push({
      type: 'text',
      text: t.text,
      font_family: 'Montserrat',
      font_weight: '900',
      font_size: '14 vmin',
      color: colorMap[t.style] || '#FFFFFF',
      x_alignment: '50%',
      y_alignment: yMap[t.position] || '50%',
      x: '50%',
      y: yMap[t.position] || '50%',
      time: t.startTime,
      duration: t.duration,
      animations: [
        { time: 'start', duration: 0.2, easing: 'quadratic-out', type: 'slide', direction: '270°', distance: '8 vmin' },
        { time: 'end', duration: 0.2, easing: 'quadratic-in', type: 'fade', fade: 0 },
      ],
    });
  });

  // Watermark
  elements.push({
    type: 'text',
    text: 'firstsample.co',
    font_family: 'Montserrat',
    font_weight: '400',
    font_size: '3 vmin',
    color: 'rgba(255,255,255,0.2)',
    x_alignment: '50%',
    y_alignment: '95%',
    x: '50%',
    y: '95%',
    time: 0,
    duration: plan.totalDuration || 20,
  });

  // Accent line at top
  elements.push({
    type: 'rectangle',
    width: '100%',
    height: '0.5%',
    x_anchor: '0%',
    y_anchor: '0%',
    x: '0%',
    y: '0%',
    color: '#2d5fff',
    time: 0,
    duration: plan.totalDuration || 20,
  });

  const payload = {
    output_format: 'mp4',
    width: 1080,
    height: 1920,
    frame_rate: 30,
    duration: plan.totalDuration || 20,
    elements,
  };

  console.log('Creatomate payload elements count:', elements.length);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ source: payload });
    const req = https.request({
      hostname: 'api.creatomate.com',
      path: '/v1/renders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creatomateKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Creatomate response:', data.substring(0, 300));
        try {
          const parsed = JSON.parse(data);
          const renders = Array.isArray(parsed) ? parsed : [parsed];
          const id = renders[0]?.id;
          if (id) resolve(id);
          else reject(new Error('Creatomate error: ' + JSON.stringify(parsed)));
        } catch (e) { reject(new Error('Creatomate parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pollCreatomate(renderId, creatomateKey) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = https.request({
        hostname: 'api.creatomate.com',
        path: `/v1/renders/${renderId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${creatomateKey}` },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const status = parsed.status;
            console.log(`Creatomate status: ${status}`);
            if (status === 'succeeded' && parsed.url) resolve(parsed.url);
            else if (status === 'failed') reject(new Error('Creatomate render failed: ' + JSON.stringify(parsed.error_message)));
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
  const { prompt, vibe, format, length, groqKey, creatomateKey } = req.body;
  if (!groqKey) return res.status(400).json({ error: 'Groq API key required' });
  if (!creatomateKey) return res.status(400).json({ error: 'Creatomate API key required' });
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

    console.log(`[${jobId}] Submitting to Creatomate...`);
    const renderId = await renderWithCreatomate(plan, mediaUrls, creatomateKey);

    console.log(`[${jobId}] Polling render ${renderId}...`);
    const videoUrl = await pollCreatomate(renderId, creatomateKey);

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
