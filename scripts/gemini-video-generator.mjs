#!/usr/bin/env node
/**
 * gemini-video-generator.mjs
 * Generates short video clips via Google's Veo model (Gemini API).
 * Saves the output mp4 locally for use by the Facebook poster.
 *
 * Usage:
 *   node gemini-video-generator.mjs --prompt "text" --output /path/to/output.mp4 [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import process from 'node:process';

// Load .env from project root
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Veo 3.0 (veo-3.0-generate-001) is deprecated and returns 404. Default to the
// current Veo 3.1 preview. Override with GEMINI_VEO_MODEL if needed.
const VEO_MODEL = process.env.GEMINI_VEO_MODEL || 'veo-3.1-generate-preview';
const POLL_INTERVAL_MS = 8000;
// Veo 3 can take 10-12 minutes for some prompts. 90 polls × 8s = 720s (12 min)
// so generation doesn't time out prematurely and fall back to a static image.
// NOTE: any process that spawns this script must allow >720s (see facebook-poster.mjs
// VIDEO_GEN_TIMEOUT_MS and mav-bridge.mjs facebook phase timeout).
const MAX_POLL_ATTEMPTS = 90; // ~12 minutes max

function parseArgs(argv) {
  const args = { prompt: '', output: '', dryRun: false, aspectRatio: '9:16', durationSeconds: 8 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt') args.prompt = argv[++i] || '';
    else if (argv[i] === '--output') args.output = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--aspect-ratio') args.aspectRatio = argv[++i] || '9:16';
    else if (argv[i] === '--duration') args.durationSeconds = parseInt(argv[++i] || '8');
  }
  return args;
}

function httpsRequest(url, options, body, _redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      // Follow redirects (max 5)
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && _redirects < 5) {
        res.resume();
        const redirectUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        resolve(httpsRequest(redirectUrl, { ...options, method: 'GET' }, null, _redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (options._binary) return resolve(raw);
        try { resolve(JSON.parse(raw.toString())); }
        catch { resolve(raw.toString()); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function generateVideo(prompt, aspectRatio, durationSeconds) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in environment or .env');

  // Veo models use predictLongRunning (Vertex AI-style endpoint via Gemini API)
  const submitUrl = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning`);
  submitUrl.searchParams.set('key', GEMINI_API_KEY);

  const body = {
    instances: [{ prompt }],
    parameters: {
      aspectRatio,
      sampleCount: 1,
      durationSeconds,
    },
  };

  const bodyStr = JSON.stringify(body);
  console.error(`Submitting video generation job (${VEO_MODEL})...`);
  const submitRes = await httpsRequest(submitUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  }, bodyStr);

  if (submitRes.error) throw new Error(`Gemini API error: ${submitRes.error.message || JSON.stringify(submitRes.error)}`);
  if (!submitRes.name) throw new Error(`Unexpected response: ${JSON.stringify(submitRes).slice(0, 400)}`);

  const operationName = submitRes.name;
  console.error(`Operation started: ${operationName}`);

  // Poll until done
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const pollUrl = new URL(`https://generativelanguage.googleapis.com/v1beta/${operationName}`);
    pollUrl.searchParams.set('key', GEMINI_API_KEY);

    const pollRes = await httpsRequest(pollUrl.toString(), { method: 'GET' });

    if (pollRes.error) throw new Error(`Poll error: ${pollRes.error.message || JSON.stringify(pollRes.error)}`);

    if (pollRes.done) {
      if (pollRes.error) throw new Error(`Generation failed: ${JSON.stringify(pollRes.error)}`);
      // predictLongRunning response: { response: { predictions: [{ bytesBase64Encoded, mimeType }] } }
      // or { response: { videos: [...] } }
      const preds = (
        pollRes.response?.generateVideoResponse?.generatedSamples ||
        pollRes.response?.predictions ||
        pollRes.response?.generatedSamples ||
        pollRes.response?.videos ||
        []
      );
      if (!preds.length) throw new Error(`No video in response: ${JSON.stringify(pollRes.response).slice(0, 200)}`);
      return preds[0];
    }

    const pct = pollRes.metadata?.progressPercent || 0;
    console.error(`  Generating... ${pct}% (attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS})`);
  }

  throw new Error('Video generation timed out after max poll attempts');
}

async function downloadVideo(videoObj, outputPath) {
  // predictLongRunning: { bytesBase64Encoded, mimeType }
  if (videoObj.bytesBase64Encoded) {
    const buf = Buffer.from(videoObj.bytesBase64Encoded, 'base64');
    fs.writeFileSync(outputPath, buf);
  // Older generateVideo format: { video: { uri } } or { video: { videoBytes } }
  } else if (videoObj.video?.uri) {
    const uri = videoObj.video.uri;
    console.error(`Downloading from: ${uri.slice(0, 80)}...`);
    // Files API requires x-goog-api-key header, not query param
    const parsedUri = new URL(uri);
    const data = await httpsRequest(parsedUri.toString(), {
      method: 'GET',
      headers: { 'x-goog-api-key': GEMINI_API_KEY },
      _binary: true,
    });
    fs.writeFileSync(outputPath, data);
  } else if (videoObj.video?.videoBytes) {
    const buf = Buffer.from(videoObj.video.videoBytes, 'base64');
    fs.writeFileSync(outputPath, buf);
  } else {
    throw new Error(`Unknown video format in response: ${JSON.stringify(videoObj).slice(0, 200)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.prompt) {
    console.error(JSON.stringify({ status: 'error', message: 'Missing --prompt' }));
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration_seconds: args.durationSeconds,
      output: args.output || '(not set)',
      message: 'Dry run — no API call made',
    }));
    return;
  }

  if (!args.output) {
    console.error(JSON.stringify({ status: 'error', message: 'Missing --output path' }));
    process.exit(2);
  }

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });

  try {
    const videoObj = await generateVideo(args.prompt, args.aspectRatio, args.durationSeconds);
    await downloadVideo(videoObj, args.output);

    const stats = fs.statSync(args.output);
    console.log(JSON.stringify({
      status: 'success',
      output: args.output,
      size_bytes: stats.size,
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration_seconds: args.durationSeconds,
    }));
  } catch (e) {
    console.error(JSON.stringify({ status: 'error', message: e.message || String(e) }));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  process.exit(1);
});
