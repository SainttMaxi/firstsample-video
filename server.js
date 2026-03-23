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

// ── STORAGE ──
const uploadsDir = path.join(__dirname, 'uploads');
const outputsDir = path.join(__dirname, 'outputs');
[uploadsDir, outputsDir].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));
app.use('/outputs', express.static(outputsDir));

// ── AI PLAN GENERATION ──
async function generatePlan(prompt, vibe, format, length, files, groqKey) {
  const lengthMap = { short: '10-15', medium: '15-25', long: '25-40' };
  const targetSecs = lengthMap[length] || '15-25';
  const clipCount = length === 'short' ? '4-6' : length === 'medium' ? '5-8' : '8-12';

  const fileContext = files.length > 0
    ? `User uploaded ${files.length} files: ${files.map(f => f.originalname).join(', ')}. Assign fileName to match uploaded files.`
    : 'No files uploaded — describe ideal clip types.';

  const systemPrompt = `You are an expert TikTok video director for streetwear brands. Respond ONLY with valid JSON, no markdown, no backticks.

JSON structure:
{
  "projectName": "string",
  "totalDuration": number,
  "vibe": "string",
  "song": { "title": "string", "artist": "string", "startTime": number, "bpm": number, "tiktokSearch": "string", "reason": "string" },
  "clips": [{ "order": number, "description": "string", "fileName": "string|null", "duration": number, "trimStart": 0 }],
  "textOverlays": [{ "text": "string", "startTime": number, "duration": number, "position": "center|top|bottom", "style": "filled|outline|blue" }],
  "caption": "string",
  "directorNotes": "string"
}`;

  const userPrompt = `Video concept: "${prompt}"
Vibe: ${vibe}, Format: ${format}, Length: ${targetSecs}s, Clips: ${clipCount}
${fileContext}
Rules: Text max 3 words ALL CAPS. Song must be real TikTok-available track. Beat-sync cuts.`;

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

// ── REMOTION RENDER ──
async function renderVideo(plan, uploadedFiles, jobId) {
  // Map uploaded files to clips
  const clips = plan.clips.map((clip, i) => {
    const matchedFile = uploadedFiles.find(f =>
      clip.fileName && f.originalname.toLowerCase().includes(clip.fileName.toLowerCase().replace(/\.[^.]+$/, ''))
    ) || uploadedFiles[i % uploadedFiles.length];

    const src = matchedFile
      ? `http://localhost:${PORT}/uploads/${matchedFile.filename}`
      : null;

    const isVideo = matchedFile && /\.(mp4|mov|webm|avi)$/i.test(matchedFile.originalname);

    return {
      src,
      type: isVideo ? 'video' : 'image',
      duration: clip.duration,
      trimStart: clip.trimStart || 0,
      description: clip.description,
    };
  });

  const totalDuration = clips.reduce((a, c) => a + c.duration, 0);
  const durationInFrames = Math.round(totalDuration * 30);

  const props = {
    clips,
    textOverlays: plan.textOverlays || [],
    musicTrack: 'dark',
    musicStartTime: plan.song?.startTime || 0,
    bgColor: '#080808',
  };

  const outputPath = path.join(outputsDir, `${jobId}.mp4`);

  // Dynamic import for ESM remotion modules
  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, selectComposition } = await import('@remotion/renderer');

  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, 'src/index.jsx'),
    webpackOverride: (config) => config,
  });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'FirstSampleVideo',
    inputProps: props,
  });

  const chromePath = process.env.REMOTION_CHROME_EXECUTABLE || undefined;

  await renderMedia({
    composition: { ...composition, durationInFrames, width: 1080, height: 1920 },
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: props,
    browserExecutable: chromePath,
    chromiumOptions: { disableWebSecurity: true, gl: 'swiftshader' },
    concurrency: 1,
  });

  return outputPath;
}

// ── ROUTES ──

// Upload files
app.post('/api/upload', upload.array('files', 20), (req, res) => {
  res.json({ files: req.files.map(f => ({ filename: f.filename, originalname: f.originalname, size: f.size })) });
});

// Generate plan + render
app.post('/api/generate', upload.array('files', 20), async (req, res) => {
  const { prompt, vibe, format, length, groqKey } = req.body;

  if (!groqKey) return res.status(400).json({ error: 'Groq API key required' });
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const jobId = uuidv4();

  // Send job ID immediately, render async
  res.json({ jobId, status: 'processing' });

  try {
    console.log(`[${jobId}] Generating AI plan...`);
    const plan = await generatePlan(prompt, vibe, format, length, req.files || [], groqKey);

    // Save plan
    fs.writeFileSync(path.join(outputsDir, `${jobId}.json`), JSON.stringify(plan, null, 2));

    console.log(`[${jobId}] Rendering video...`);
    await renderVideo(plan, req.files || [], jobId);

    console.log(`[${jobId}] Done!`);
    fs.writeFileSync(path.join(outputsDir, `${jobId}.status`), 'done');
  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    fs.writeFileSync(path.join(outputsDir, `${jobId}.status`), 'error: ' + err.message);
  }
});

// Check job status
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const statusFile = path.join(outputsDir, `${jobId}.status`);
  const planFile = path.join(outputsDir, `${jobId}.json`);
  const videoFile = path.join(outputsDir, `${jobId}.mp4`);

  if (!fs.existsSync(statusFile)) {
    return res.json({ status: 'processing' });
  }

  const status = fs.readFileSync(statusFile, 'utf8').trim();

  if (status === 'done') {
    const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null;
    return res.json({
      status: 'done',
      videoUrl: `/outputs/${jobId}.mp4`,
      plan,
    });
  }

  return res.json({ status: 'error', message: status });
});

app.listen(PORT, () => console.log(`First Sample Video Server running on port ${PORT}`));
