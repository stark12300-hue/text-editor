import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Tesseract from 'tesseract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '50mb' }));
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

// Endpoint: High-Speed OCR text & bounding box extraction
app.post('/api/extract-text', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64', items: [] });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(cleanBase64, 'base64');

    const worker = await getOcrWorker();
    const ocrResult = await worker.recognize(imgBuffer, {}, { blocks: true });

    const items = [];

    if (ocrResult.data?.blocks) {
      for (const block of ocrResult.data.blocks) {
        if (!block.paragraphs) continue;
        for (const para of block.paragraphs) {
          if (!para.lines) continue;
          for (const line of para.lines) {
            const rawText = line.text ? line.text.trim() : '';
            const bbox = line.bbox;
            if (!rawText || !bbox) continue;

            const width = bbox.x1 - bbox.x0;
            const height = bbox.y1 - bbox.y0;
            if (width <= 6 || height <= 5) continue;

            items.push({
              text: rawText,
              x: bbox.x0,
              y: bbox.y0,
              width: width,
              height: height,
              confidence: line.confidence || 90
            });
          }
        }
      }
    }

    res.json({ success: true, items });
  } catch (err) {
    console.error('OCR Extraction error:', err);
    res.status(500).json({ error: err.message || 'OCR failed', items: [] });
  }
});

app.get('*', (req, res) => {
  res.sendFile('index.html', { root: __dirname });
});

app.listen(PORT, HOST, () => {
  console.log(`Pdf Bapu running at http://${HOST}:${PORT}`);
});
