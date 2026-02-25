const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const OUTFIT_REFERENCE_URL =
  'https://d29hudvzbgrxww.cloudfront.net/public/product/2023011516445-a757c3d3-68e9-4d61-9cd3-be926ff4c87a.jpg';

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function getFileContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 12 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function extractResponseText(responseJson) {
  if (!responseJson || !Array.isArray(responseJson.output)) return '';
  const texts = [];
  for (const item of responseJson.output) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (!c) continue;
        if (typeof c.text === 'string') texts.push(c.text);
        if (typeof c.output_text === 'string') texts.push(c.output_text);
      }
    }
  }
  return texts.join('\n').trim();
}

function extractGeneratedImageData(responseJson) {
  if (!responseJson || !Array.isArray(responseJson.output)) return '';
  for (const item of responseJson.output) {
    if (!item) continue;
    if (item.type === 'image_generation_call') {
      if (typeof item.result === 'string' && item.result.length > 0) return item.result;
      if (typeof item.b64_json === 'string' && item.b64_json.length > 0) return item.b64_json;
      if (typeof item.image_base64 === 'string' && item.image_base64.length > 0) return item.image_base64;
    }
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (!c) continue;
        if (typeof c.image_base64 === 'string' && c.image_base64.length > 0) return c.image_base64;
        if (typeof c.b64_json === 'string' && c.b64_json.length > 0) return c.b64_json;
      }
    }
  }
  return '';
}

async function generateLookalikeWithOpenAI({ imageDataUrl, lang, reroll }) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing');
  }

  const languageName = lang === 'en' ? 'English' : 'Korean';
  const rerollLine = reroll
    ? 'Create a clearly different variation from the previous result.'
    : 'Create the first high-quality result.';

  const systemPrompt =
    'You are a senior portrait artist and facial analysis specialist. ' +
    'You analyze facial expression, eye shape, color tone, contrast, mood, and distinguishing traits. ' +
    'Then you generate one highly detailed, realistic anime-style portrait of the same person in a look-alike animal hoodie costume. ' +
    'Do not copy logos or text from references. Keep identity resemblance strong and natural.';

  const userPrompt =
    `Task:\n` +
    `1) Analyze the person's face and expression from the first image.\n` +
    `2) Use the second image as visual reference only for clothing vibe and costume structure.\n` +
    `3) Generate one final image: anime-style but realistic skin/eyes/light, highly detailed, not cartoon-flat.\n` +
    `4) Make sure the result still looks like the person.\n` +
    `5) Output a short analysis note in ${languageName} (1-2 lines) describing what traits were reflected.\n` +
    `${rerollLine}`;

  const payload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt }]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: userPrompt },
          { type: 'input_image', image_url: imageDataUrl },
          { type: 'input_image', image_url: OUTFIT_REFERENCE_URL }
        ]
      }
    ],
    tools: [{ type: 'image_generation', size: '1024x1024', quality: 'high' }]
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json();
  if (!response.ok) {
    const detail = json && json.error && json.error.message ? json.error.message : JSON.stringify(json);
    throw new Error(`OpenAI API error: ${detail}`);
  }

  const imageBase64 = extractGeneratedImageData(json);
  if (!imageBase64) {
    throw new Error('No generated image found in OpenAI response');
  }

  return {
    imageDataUrl: `data:image/png;base64,${imageBase64}`,
    analysisText: extractResponseText(json)
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/lookalike') {
      const bodyText = await readRequestBody(req);
      let body = {};
      try {
        body = JSON.parse(bodyText);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
      const lang = body.lang === 'en' ? 'en' : 'ko';
      const reroll = Boolean(body.reroll);

      if (!imageDataUrl.startsWith('data:image/')) {
        sendJson(res, 400, { error: 'imageDataUrl is required and must be a data:image URL' });
        return;
      }

      const result = await generateLookalikeWithOpenAI({ imageDataUrl, lang, reroll });
      sendJson(res, 200, result);
      return;
    }

    const requested = req.url === '/' ? '/index.html' : req.url;
    const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(process.cwd(), safePath);

    if (!filePath.startsWith(process.cwd())) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': getFileContentType(filePath) });
    res.end(content);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
