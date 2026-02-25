const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const POLLINATIONS_BASE = 'https://gen.pollinations.ai';
const POLLINATIONS_MODEL = process.env.POLLINATIONS_MODEL || 'flux';
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || '';

const OUTFIT_REFERENCE_URL =
  'https://d29hudvzbgrxww.cloudfront.net/public/product/2023011516445-a757c3d3-be926ff4c87a.jpg';

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

function buildPrompt({ lang, animalType, traitsText, reroll }) {
  const isEn = lang === 'en';
  const variation = reroll
    ? (isEn
      ? 'Create a clearly different variation from previous output while keeping identity cues.'
      : '이전 결과와 확실히 다른 변형으로 생성하되 인물 정체성 힌트는 유지.')
    : '';

  if (isEn) {
    return (
      `Ultra-detailed anime portrait of a real person wearing ${animalType} animal hoodie costume, ` +
      `cinematic lighting, realistic eyes and skin texture, high detail face rendering, natural asymmetry, ` +
      `expression fidelity, premium illustration quality, no text, no watermark. ` +
      `Use this outfit vibe reference: ${OUTFIT_REFERENCE_URL}. ` +
      `Face traits: ${traitsText}. ${variation}`.trim()
    );
  }

  return (
    `${animalType} 동물 후드 의상을 입은 실사형 애니 초상화, 시네마틱 조명, ` +
    `눈빛/피부 질감의 사실적 표현, 얼굴 디테일 고해상도, 자연스러운 좌우 비대칭, ` +
    `표정 재현도 강화, 고급 일러스트 퀄리티, 텍스트/워터마크 없음. ` +
    `의상 분위기 참고: ${OUTFIT_REFERENCE_URL}. ` +
    `얼굴 특징: ${traitsText}. ${variation}`.trim()
  );
}

async function generateLookalikeWithPollinations({ lang, reroll, animalType, traitsText }) {
  const prompt = buildPrompt({ lang, animalType, traitsText, reroll });
  const seed = reroll ? Math.floor(Math.random() * 1000000) : 424242;

  const query = new URLSearchParams({
    model: POLLINATIONS_MODEL,
    width: '1024',
    height: '1024',
    seed: String(seed),
    nologo: 'true',
    safe: 'true',
    enhance: 'true'
  });
  if (POLLINATIONS_API_KEY) query.set('key', POLLINATIONS_API_KEY);

  const url = `${POLLINATIONS_BASE}/image/${encodeURIComponent(prompt)}?${query.toString()}`;

  const response = await fetch(url, {
    headers: POLLINATIONS_API_KEY ? { Authorization: `Bearer ${POLLINATIONS_API_KEY}` } : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    const detail = errorText.slice(0, 260);
    if (response.status === 401) {
      throw new Error(
        'Pollinations authentication failed. Set POLLINATIONS_API_KEY and restart server. ' +
        `Provider response: ${detail}`
      );
    }
    throw new Error(`Pollinations API error (${response.status}): ${detail}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const binary = await response.arrayBuffer();
  const base64 = Buffer.from(binary).toString('base64');

  const analysisText =
    lang === 'en'
      ? `Applied traits: ${traitsText}. Animal style: ${animalType}.`
      : `적용된 특징: ${traitsText}. 동물 스타일: ${animalType}.`;

  return {
    imageDataUrl: `data:${contentType};base64,${base64}`,
    analysisText
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
      const animalType = typeof body.animalType === 'string' && body.animalType.trim()
        ? body.animalType.trim()
        : (lang === 'en' ? 'cat' : '고양이');
      const traitsText = typeof body.traitsText === 'string' && body.traitsText.trim()
        ? body.traitsText.trim()
        : (lang === 'en'
          ? 'balanced expression, clear eyes, natural skin tone, medium contrast, calm mood'
          : '균형 잡힌 표정, 또렷한 눈매, 자연스러운 피부톤, 중간 대비, 차분한 분위기');

      if (!imageDataUrl.startsWith('data:image/')) {
        sendJson(res, 400, { error: 'imageDataUrl is required and must be a data:image URL' });
        return;
      }

      const result = await generateLookalikeWithPollinations({
        lang,
        reroll,
        animalType,
        traitsText
      });

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
