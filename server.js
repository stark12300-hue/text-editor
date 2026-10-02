import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '60mb' }));

// Serve crawler files before the generic static middleware so they cannot
// be replaced by the SPA/static fallback response.
app.get('/robots.txt', (req, res) => {
  res.status(200);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile('robots.txt', { root: __dirname });
});

app.get('/sitemap.xml', (req, res) => {
  res.status(200);
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile('sitemap.xml', { root: __dirname });
});

app.use(express.static(__dirname));

let ocrWorker = null;

async function getOcrWorker() {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      langPath: __dirname,
      cachePath: __dirname,
    });
  }
  return ocrWorker;
}

// Pre-warm the Tesseract OCR engine on server startup for instantaneous responses
getOcrWorker()
  .then(() => console.log('Tesseract OCR engine pre-warmed and ready!'))
  .catch(err => console.warn('Pre-warm notice:', err));

// Gemini client initialization (if API key available)
let geminiAi = null;
if (process.env.GEMINI_API_KEY) {
  try {
    geminiAi = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    console.log('Gemini Vision OCR client initialized!');
  } catch (err) {
    console.warn('Gemini client init notice:', err);
  }
}

// Image Preprocessing: Orientation, contrast, noise removal, brightness normalization, and smart scaling
async function preprocessImageForOcr(imgBuffer, isFallback = false) {
  const meta = await sharp(imgBuffer).metadata();
  const origWidth = meta.width || 1200;
  const origHeight = meta.height || 900;

  let targetWidth = origWidth;
  let targetHeight = origHeight;

  // Scale intelligently: upscale small diagram labels (if < 800px) or downscale ultra-large images (> 3200px)
  const maxDim = Math.max(origWidth, origHeight);
  if (maxDim < 800) {
    const scale = Math.min(2.0, 1200 / maxDim);
    targetWidth = Math.round(origWidth * scale);
    targetHeight = Math.round(origHeight * scale);
  } else if (maxDim > 3200) {
    const scale = 2600 / maxDim;
    targetWidth = Math.round(origWidth * scale);
    targetHeight = Math.round(origHeight * scale);
  }

  let pipeline = sharp(imgBuffer).rotate(); // auto-rotate based on EXIF

  if (targetWidth !== origWidth || targetHeight !== origHeight) {
    pipeline = pipeline.resize(targetWidth, targetHeight, { kernel: 'lanczos3' });
  }

  if (isFallback) {
    // Fallback pass: high-contrast grayscale normalization for faint/low-contrast diagrams
    pipeline = pipeline
      .grayscale()
      .normalize();
  }

  const processedBuffer = await pipeline.png().toBuffer();
  const scaleX = origWidth / targetWidth;
  const scaleY = origHeight / targetHeight;

  return {
    processedBuffer,
    origWidth,
    origHeight,
    targetWidth,
    targetHeight,
    scaleX,
    scaleY
  };
}

// Word-level clustering algorithm: Merges words into cohesive lines/blocks while strictly preserving
// separate boxes, ignoring arrows and connector lines, and eliminating garbled repetitive text.
function clusterWordsIntoBlocks(words, scaleX, scaleY, origWidth, origHeight) {
  // 1. Filter out garbage, non-text, connector lines, and arrow symbols
  const validWords = [];
  for (const w of words) {
    const rawText = (w.text || '').trim();
    if (!rawText) continue;

    // Clean leading/trailing stray quote or backtick marks
    const text = rawText.replace(/^['"`\s]+|['"`\s]+$/g, '').trim();
    if (!text || text.length === 0) continue;

    // Reject pure symbols without letters or numbers (arrows, connector lines: -->, <--, ---, ===, |||, ___, ...)
    if (!/[a-zA-Z0-9]/.test(text)) continue;

    // Reject extremely low-confidence garbage
    if (w.confidence !== undefined && w.confidence < 35) continue;

    const wW = w.bbox.x1 - w.bbox.x0;
    const wH = w.bbox.y1 - w.bbox.y0;
    // Reject extreme line-like slivers (arrows/borders interpreted as words)
    if (wW <= 3 || wH <= 3) continue;
    if (wW > 60 && wH <= 4) continue;
    if (wH > 60 && wW <= 4) continue;

    validWords.push({
      ...w,
      text
    });
  }

  if (!validWords.length) return [];

  // Sort words top-to-bottom, then left-to-right
  validWords.sort((a, b) => {
    const aMidY = (a.bbox.y0 + a.bbox.y1) / 2;
    const bMidY = (b.bbox.y0 + b.bbox.y1) / 2;
    const minH = Math.min(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0);
    if (Math.abs(aMidY - bMidY) > minH * 0.45) {
      return aMidY - bMidY;
    }
    return a.bbox.x0 - b.bbox.x0;
  });

  const lines = [];
  let currentLine = [];

  for (const word of validWords) {
    if (currentLine.length === 0) {
      currentLine.push(word);
      continue;
    }

    const prevWord = currentLine[currentLine.length - 1];
    const prevH = prevWord.bbox.y1 - prevWord.bbox.y0;
    const currH = word.bbox.y1 - word.bbox.y0;
    const minH = Math.min(prevH, currH);

    // Vertical alignment check: do they share the same text line?
    const prevMidY = (prevWord.bbox.y0 + prevWord.bbox.y1) / 2;
    const currMidY = (word.bbox.y0 + word.bbox.y1) / 2;
    const yOverlap = Math.min(prevWord.bbox.y1, word.bbox.y1) - Math.max(prevWord.bbox.y0, word.bbox.y0);
    const isSameRow = (Math.abs(prevMidY - currMidY) <= minH * 0.5) || (yOverlap > minH * 0.4);

    // Horizontal distance check: keep separate boxes/labels separate even when on the same row!
    // If the horizontal gap between words is larger than a normal word space (1.35 * minH or ~26px),
    // they belong to DIFFERENT boxes or separate flowchart labels!
    const horizontalGap = word.bbox.x0 - prevWord.bbox.x1;
    const maxWordGap = Math.max(8, Math.min(18, minH * 0.85));

    if (isSameRow && horizontalGap >= -4 && horizontalGap <= maxWordGap) {
      // Check for repeated identical word loops (e.g. "dispatches dispatches dispatches...")
      const isRepeated = word.text.toLowerCase() === prevWord.text.toLowerCase();
      if (isRepeated && horizontalGap <= 4) {
        // Skip duplicate repeated word
        continue;
      }
      currentLine.push(word);
    } else {
      lines.push(currentLine);
      currentLine = [word];
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  // Convert lines into final blocks and map back to original image coordinates
  const blocks = lines.map((wordGroup, index) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let confSum = 0;
    const textParts = [];

    for (let i = 0; i < wordGroup.length; i++) {
      const w = wordGroup[i];
      // Deduplicate consecutive identical words
      if (i > 0 && w.text.toLowerCase() === wordGroup[i - 1].text.toLowerCase() && w.bbox.x0 - wordGroup[i - 1].bbox.x1 < 6) {
        continue;
      }
      textParts.push(w.text);
      confSum += (w.confidence || 80);
      x0 = Math.min(x0, w.bbox.x0);
      y0 = Math.min(y0, w.bbox.y0);
      x1 = Math.max(x1, w.bbox.x1);
      y1 = Math.max(y1, w.bbox.y1);
    }

    const text = textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    // Map back to original image coordinate space
    const origX0 = Math.max(0, Math.round(x0 * scaleX));
    const origY0 = Math.max(0, Math.round(y0 * scaleY));
    const origX1 = Math.min(origWidth, Math.round(x1 * scaleX));
    const origY1 = Math.min(origHeight, Math.round(y1 * scaleY));

    const width = Math.max(10, origX1 - origX0);
    const height = Math.max(8, origY1 - origY0);

    return {
      text,
      x: origX0,
      y: origY0,
      width,
      height,
      confidence: Math.round(confSum / wordGroup.length),
      blockId: `block_${index + 1}`
    };
  }).filter(b => b && b.text.length > 0 && b.width >= 6 && b.height >= 6);

  // Eliminate any duplicate overlapping blocks that may have been detected multiple times
  const uniqueBlocks = [];
  for (const b of blocks) {
    const isDuplicate = uniqueBlocks.some(existing => {
      const xOverlap = Math.max(0, Math.min(b.x + b.width, existing.x + existing.width) - Math.max(b.x, existing.x));
      const yOverlap = Math.max(0, Math.min(b.y + b.height, existing.y + existing.height) - Math.max(b.y, existing.y));
      const overlapArea = xOverlap * yOverlap;
      const bArea = b.width * b.height;
      return (overlapArea / bArea > 0.75) && (b.text.toLowerCase() === existing.text.toLowerCase());
    });
    if (!isDuplicate) {
      uniqueBlocks.push(b);
    }
  }

  return uniqueBlocks;
}

// Extract text using line-preserving word clustering pipeline
async function runTesseractOcrPipeline(imgBuffer, isFallback = false) {
  const { processedBuffer, scaleX, scaleY, origWidth, origHeight } = await preprocessImageForOcr(imgBuffer, isFallback);
  const worker = await getOcrWorker();
  // Sparse-text mode is better for diagrams/flowcharts because it treats labels independently.
  await worker.setParameters({
    tessedit_pageseg_mode: '11',
    preserve_interword_spaces: '1'
  });
  const ocrResult = await worker.recognize(processedBuffer, {}, { blocks: true });

  const rawBlocks = [];
  if (ocrResult.data?.blocks) {
    for (const block of ocrResult.data.blocks) {
      if (!block.paragraphs) continue;
      for (const para of block.paragraphs) {
        if (!para.lines) continue;
        for (const line of para.lines) {
          if (!line.words || !line.words.length) continue;

          // Filter out garbage, pure symbols, arrows, low confidence
          const validWords = [];
          for (const w of line.words) {
            const text = (w.text || '').replace(/^['"`\s]+|['"`\s]+$/g, '').trim();
            if (!text || !/[a-zA-Z0-9]/.test(text)) continue;
            if (w.confidence !== undefined && w.confidence < 35) continue;
            validWords.push({ ...w, text });
          }
          if (!validWords.length) continue;

          // Sort words strictly left-to-right within this line
          validWords.sort((a, b) => a.bbox.x0 - b.bbox.x0);

          let curBlock = [];
          for (const w of validWords) {
            if (!curBlock.length) {
              curBlock.push(w);
              continue;
            }
            const prev = curBlock[curBlock.length - 1];
            const minH = Math.min(prev.bbox.y1 - prev.bbox.y0, w.bbox.y1 - w.bbox.y0);
            const gap = w.bbox.x0 - prev.bbox.x1;
            const maxGap = Math.max(10, Math.round(minH * 0.85));

            if (gap >= -4 && gap <= maxGap) {
              // Deduplicate consecutive repeated words ("dispatches dispatches...")
              if (w.text.toLowerCase() === prev.text.toLowerCase() && gap <= 3) continue;
              curBlock.push(w);
            } else {
              rawBlocks.push(curBlock);
              curBlock = [w];
            }
          }
          if (curBlock.length) rawBlocks.push(curBlock);
        }
      }
    }
  }

  // Map to original image coordinates and format items
  let blockIndex = 1;
  const items = [];
  for (const g of rawBlocks) {
    const text = g.map(w => w.text).join(' ');
    const x0 = Math.min(...g.map(w => w.bbox.x0));
    const y0 = Math.min(...g.map(w => w.bbox.y0));
    const x1 = Math.max(...g.map(w => w.bbox.x1));
    const y1 = Math.max(...g.map(w => w.bbox.y1));

    const origX0 = Math.max(0, Math.round(x0 * scaleX));
    const origY0 = Math.max(0, Math.round(y0 * scaleY));
    const origX1 = Math.min(origWidth, Math.round(x1 * scaleX));
    const origY1 = Math.min(origHeight, Math.round(y1 * scaleY));

    const width = Math.max(10, origX1 - origX0);
    const height = Math.max(8, origY1 - origY0);
    const confidence = Math.round(g.reduce((acc, w) => acc + (w.confidence || 80), 0) / g.length);

    items.push({
      text,
      x: origX0,
      y: origY0,
      width,
      height,
      confidence,
      blockId: `block_${blockIndex++}`
    });
  }

  // Deduplicate overlapping duplicate blocks
  const uniqueItems = [];
  for (const it of items) {
    const isDup = uniqueItems.some(existing => {
      const xOverlap = Math.max(0, Math.min(it.x + it.width, existing.x + existing.width) - Math.max(it.x, existing.x));
      const yOverlap = Math.max(0, Math.min(it.y + it.height, existing.y + existing.height) - Math.max(it.y, existing.y));
      const overlapArea = xOverlap * yOverlap;
      const itArea = it.width * it.height;
      return (overlapArea / itArea > 0.75) && (it.text.toLowerCase() === existing.text.toLowerCase());
    });
    if (!isDup) uniqueItems.push(it);
  }

  return uniqueItems;
}

// Extract text using Gemini Vision AI (if available and responsive)
async function tryGeminiOcr(imgBuffer) {
  if (!geminiAi) return null;

  try {
    const meta = await sharp(imgBuffer).metadata();
    const origWidth = meta.width || 1200;
    const origHeight = meta.height || 900;

    // Prepare optimized PNG for Gemini
    const geminiBuffer = await sharp(imgBuffer)
      .rotate()
      .resize(Math.min(origWidth, 1800), Math.min(origHeight, 1800), { fit: 'inside' })
      .png()
      .toBuffer();

    const base64Data = geminiBuffer.toString('base64');

    // Call Gemini with a 10s timeout promise
    const geminiPromise = geminiAi.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: base64Data
            }
          },
          {
            text: 'Analyze this image (diagram / flowchart / architecture / screenshot / document). Extract every separate text label, box title, small label, and text block individually. Do NOT merge text from different boxes or across arrows. Ignore arrows, connector lines, and diagram borders. Output each text item with its text, bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000, confidence (0-100), and blockId.'
          }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  box_2d: {
                    type: Type.ARRAY,
                    items: { type: Type.INTEGER },
                    description: '[ymin, xmin, ymax, xmax] in 0-1000 range'
                  },
                  confidence: { type: Type.INTEGER },
                  blockId: { type: Type.STRING }
                },
                required: ['text', 'box_2d']
              }
            }
          },
          required: ['items']
        }
      }
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini OCR timed out')), 10000)
    );

    const res = await Promise.race([geminiPromise, timeoutPromise]);
    const json = JSON.parse(res.text);

    if (json.items && json.items.length > 0) {
      return json.items.map((item, idx) => {
        const [ymin, xmin, ymax, xmax] = item.box_2d;
        const x = Math.max(0, Math.round((xmin / 1000) * origWidth));
        const y = Math.max(0, Math.round((ymin / 1000) * origHeight));
        const width = Math.max(10, Math.round(((xmax - xmin) / 1000) * origWidth));
        const height = Math.max(8, Math.round(((ymax - ymin) / 1000) * origHeight));
        return {
          text: item.text.trim(),
          x,
          y,
          width,
          height,
          confidence: item.confidence || 95,
          blockId: item.blockId || `gemini_${idx + 1}`
        };
      }).filter(b => b.text.length > 0);
    }
  } catch (err) {
    console.warn('Gemini OCR skipped/unavailable (falling back to preprocessed Tesseract engine):', err.message);
  }
  return null;
}

// Endpoint: High-Accuracy Layout-Aware OCR extraction
app.post('/api/extract-text', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64', items: [] });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(cleanBase64, 'base64');

    // Use Tesseract first for editable diagrams. Its OCR boxes are based on
    // the actual pixels; Gemini can return oversized approximate boxes.
    let items = await runTesseractOcrPipeline(imgBuffer, false);
    console.log('[OCR] Tesseract primary result:', items.length, 'items');

    const avgConfidence = items.length
      ? items.reduce((sum, it) => sum + (it.confidence || 0), 0) / items.length
      : 0;

    if (items.length === 0 || avgConfidence < 45) {
      console.log('[OCR] Running normalized fallback OCR strategy…');
      const fallbackItems = await runTesseractOcrPipeline(imgBuffer, true);
      if (fallbackItems.length >= items.length) {
        items = fallbackItems;
        console.log('[OCR] Fallback produced:', items.length, 'items');
      }
    }

    // Gemini is only a last resort when precise OCR finds nothing.
    if (items.length === 0) {
      items = await tryGeminiOcr(imgBuffer);
      console.log('[OCR] Gemini last-resort result:', items ? String(items.length) + ' items' : 'null');
    }

    res.json({ success: true, items: items || [] });
  } catch (err) {
    console.error('OCR Extraction error:', err);
    res.status(500).json({ error: err.message || 'OCR failed', items: [] });
  }
});

app.get(['/logo.svg', '/favicon.ico'], (req, res) => {
  res.type('image/svg+xml');
  res.sendFile('logo.svg', { root: __dirname });
});

app.get('*', (req, res) => {
  res.sendFile('index.html', { root: __dirname });
});

// Vercel runs this Express app as a serverless function.
// Export the app so Vercel can manage the function lifecycle.
// Keep the local listener only for normal Node.js development.
export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`Pdf Bapu running at http://${HOST}:${PORT}`);
  });
}
