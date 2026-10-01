# Pdf Bapu — Free Online PDF & Image Editor

Pdf Bapu is a fast, free, in-browser tool for editing and replacing text in PDFs and images with zero quality degradation, crisp 300 DPI exports, and layout-aware OCR. Developed by Abhay Singh.

## Features
- Upload PNG/JPG/WEBP or PDF
- Add and drag text layers
- Change text, size, color and bold
- OCR text detection with Tesseract.js
- Multi-page PDF preview
- Export edited image as PNG
- Export edited PDF
- Mobile-friendly responsive UI

## Run
Serve this folder with any static web server, for example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Note
This version edits image/PDF text as browser-rendered overlays. PDF export covers the original text area with a light rectangle before drawing replacement text; complex backgrounds may need a more advanced content-aware cleanup pipeline.
