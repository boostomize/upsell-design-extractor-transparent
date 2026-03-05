// index.js 
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Shopify CDN mag Browser-User-Agent
const SHOPIFY_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/png,image/*,*/*",
};

// Mockups (aktualisiert wie im zweiten Backend)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1902.jpg?v=1765218360";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1901.jpg?v=1765218358";

// NEU: T-Shirt Mockups
const TEE_WHITE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1926.jpg?v=1765367168";

const TEE_BLACK_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1924.jpg?v=1765367167";

// NEU: Overlays für T-Shirts (PNG oben drauf)
const TEE_WHITE_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_wei_e_Shirt.png?v=1765367191";

const TEE_BLACK_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_schwarze_Shirt.png?v=1765367224";

// Cache: artworkUrl + type -> fertiges PNG
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (Diff-Extraction + Tasche + Tasse + Shirts) läuft.");
});



// ============================================================================
// ======================= DEBUG: NUR DESIGN-EXTRAKTION =======================
// Dieser Endpoint gibt AUSSCHLIESSLICH das extrahierte Design als PNG zurück.
// Kein Placement, kein Mockup, kein Overlay.
// URL-Beispiel:
// /debug-design?url=COMPOSITE_URL&mockup_url=BASE_MOCKUP_URL
// ============================================================================

app.get("/debug-design", async (req, res) => {
  const artworkUrl = req.query.url;          // Composite (Mockup + Design)
  const baseMockupUrl = req.query.mockup_url; // Leeres Mockup

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  try {
    // Beide Bilder laden
    const compositeBuffer = await loadImage(artworkUrl);
    const baseBuffer = await loadImage(baseMockupUrl);

    // NUR Design extrahieren (keine weitere Verarbeitung!)
    const designBuffer = await extractDesign(baseBuffer, compositeBuffer, 10);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(designBuffer);

  } catch (err) {
    console.error("Fehler in /debug-design:", err);
    res.status(500).json({
      error: "Interner Fehler in /debug-design",
      detail: err.message || String(err),
    });
  }
});

// ===================== ENDE DEBUG DESIGN-EXTRAKTION =========================
// ============================================================================



// --------------------- Hilfsfunktionen ---------------------

async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}




function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function brightness(c) {
  return (c[0] + c[1] + c[2]) / 3;
}


// --------------------- NEU: DEIN DESIGN-EXTRACTOR (1:1) ---------------------

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Extrahiert das Design durch Pixel-Diff zwischen Base-Mockup und Composite.
 * Ersetzt die alte removeGridBackgroundAdvanced-Funktion.
 *
 * @param {Buffer} baseBuffer  - Leeres Mockup (ohne Design)
 * @param {Buffer} compositeBuffer - Mockup MIT Design drauf
 * @param {number} tolerance - Farbtoleranz (Standard: 30)
 * @returns {Promise<Buffer>} - PNG mit transparentem Hintergrund
 */
async function extractDesign(baseBuffer, compositeBuffer, tolerance = 10) {
  // Beide Bilder laden und auf gleiche Größe bringen und in JPG konvertieren

  
  // ===== PHASE 0: JPG-Konvertierung (Transparenz entfernen) =====
  // Konvertiert beide Bilder zu JPG, damit transparente PNG/WebP-Hintergründe
  // durch einen weißen Hintergrund ersetzt werden.
  baseBuffer = await sharp(baseBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 100 })
    .toBuffer();

  compositeBuffer = await sharp(compositeBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 100 })
    .toBuffer();



  
  const baseMeta = await sharp(baseBuffer).metadata();
  const compMeta = await sharp(compositeBuffer).metadata();

  const width = baseMeta.width;
  const height = baseMeta.height;

  // Base als Raw RGBA
  const baseRaw = await sharp(baseBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Composite auf Base-Größe skalieren falls nötig, dann Raw RGBA
  let compSharp = sharp(compositeBuffer).ensureAlpha();
  if (compMeta.width !== width || compMeta.height !== height) {
    compSharp = compSharp.resize(width, height);
  }
  const compRaw = await compSharp.raw().toBuffer();

  const totalPixels = width * height;

  // Output-Buffer (RGBA)
  const outRaw = Buffer.alloc(totalPixels * 4);

  // Phase 1: Diff-Map berechnen
  const diffMap = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    diffMap[i] = colorDistance(
      baseRaw[idx], baseRaw[idx + 1], baseRaw[idx + 2],
      compRaw[idx], compRaw[idx + 1], compRaw[idx + 2]
    );
  }

  // Phase 2: Alpha und Farbe rekonstruieren
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const dist = diffMap[i];

    if (dist <= tolerance) {
      // Gleicher Pixel → transparent
      outRaw[idx] = 0;
      outRaw[idx + 1] = 0;
      outRaw[idx + 2] = 0;
      outRaw[idx + 3] = 0;
    } else {
      // Design-Pixel → Alpha-Matting
      const alpha = Math.min(1, (dist - tolerance) / (255 - tolerance));

      const bR = baseRaw[idx];
      const bG = baseRaw[idx + 1];
      const bB = baseRaw[idx + 2];
      const cR = compRaw[idx];
      const cG = compRaw[idx + 1];
      const cB = compRaw[idx + 2];

      let fR, fG, fB;
      if (alpha > 0.01) {
        fR = Math.round(Math.min(255, Math.max(0, (cR - (1 - alpha) * bR) / alpha)));
        fG = Math.round(Math.min(255, Math.max(0, (cG - (1 - alpha) * bG) / alpha)));
        fB = Math.round(Math.min(255, Math.max(0, (cB - (1 - alpha) * bB) / alpha)));
      } else {
        fR = cR;
        fG = cG;
        fB = cB;
      }

      outRaw[idx] = fR;
      outRaw[idx + 1] = fG;
      outRaw[idx + 2] = fB;
      outRaw[idx + 3] = Math.round(alpha * 255);
    }
  }

  // Phase 3: Isolierte Rausch-Pixel entfernen
  const alphaChannel = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaChannel[i] = outRaw[i * 4 + 3];
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (alphaChannel[i] === 0) continue;

      let opaqueNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = (y + dy) * width + (x + dx);
          if (alphaChannel[ni] > 0) opaqueNeighbors++;
        }
      }

      if (opaqueNeighbors <= 1 && alphaChannel[i] < 128) {
        outRaw[i * 4 + 3] = 0;
      }
    }
  }

  // Phase 4: Connected-Component-Filter (dünne Linien entfernen)
  const visited = new Uint8Array(totalPixels);
  const components = [];

  for (let i = 0; i < totalPixels; i++) {
    if (visited[i] || outRaw[i * 4 + 3] === 0) continue;

    const queue = [i];
    const pixels = [];
    visited[i] = 1;

    while (queue.length > 0) {
      const cur = queue.pop();
      pixels.push(cur);

      const cx = cur % width;
      const cy = (cur - cx) / width;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || outRaw[ni * 4 + 3] === 0) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    components.push({ pixels });
  }

  // Größte Komponente finden
  let largestIdx = 0;
  for (let c = 1; c < components.length; c++) {
    if (components[c].pixels.length > components[largestIdx].pixels.length) {
      largestIdx = c;
    }
  }

  // Kleine, dünne Komponenten entfernen (1.40% Schwelle + Dicke < 6px)
  const mainSize = components.length > 0 ? components[largestIdx].pixels.length : 0;
  const sizeThreshold = Math.max(240, mainSize * 0.40);

  for (let c = 0; c < components.length; c++) {
    const comp = components[c];
    if (comp.pixels.length >= sizeThreshold) continue;

    let cMinX = width, cMaxX = 0, cMinY = height, cMaxY = 0;
    for (const pi of comp.pixels) {
      const px = pi % width;
      const py = (pi - px) / width;
      if (px < cMinX) cMinX = px;
      if (px > cMaxX) cMaxX = px;
      if (py < cMinY) cMinY = py;
      if (py > cMaxY) cMaxY = py;
    }
    const bboxW = cMaxX - cMinX + 1;
    const bboxH = cMaxY - cMinY + 1;
    const maxDim = Math.max(bboxW, bboxH);
    const avgThickness = comp.pixels.length / Math.max(1, maxDim);

    // Nur dünne Strukturen entfernen (< 4px), Text bleibt erhalten
    if (avgThickness < 6) {
      for (const pi of comp.pixels) {
        outRaw[pi * 4] = 0;
        outRaw[pi * 4 + 1] = 0;
        outRaw[pi * 4 + 2] = 0;
        outRaw[pi * 4 + 3] = 0;
      }
    }
  }



// Phase 4.1: Proximity-Filter — entferne Komponenten die zu weit vom Hauptdesign entfernt sind
// Erstelle eine Distanz-Maske von der größten Komponente
const mainPixelSet = new Set();
if (components.length > 0) {
  for (const pi of components[largestIdx].pixels) {
    mainPixelSet.add(pi);
  }
}

const proximityRadius = 90; // Pixel-Abstand zum Hauptdesign

for (let c = 0; c < components.length; c++) {
  if (c === largestIdx) continue;
  const comp = components[c];
  
  // Prüfe ob IRGENDEIN Pixel dieser Komponente nah am Hauptdesign ist
  let isNearMain = false;
  for (const pi of comp.pixels) {
    if (isNearMain) break;
    const px = pi % width;
    const py = (pi - px) / width;
    
    for (let dy = -proximityRadius; dy <= proximityRadius && !isNearMain; dy++) {
      for (let dx = -proximityRadius; dx <= proximityRadius && !isNearMain; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (mainPixelSet.has(ny * width + nx)) {
          isNearMain = true;
        }
      }
    }
  }
  
  // Nicht in der Nähe des Hauptdesigns → Artefakt → entfernen
  if (!isNearMain) {
    for (const pi of comp.pixels) {
      outRaw[pi * 4] = 0;
      outRaw[pi * 4 + 1] = 0;
      outRaw[pi * 4 + 2] = 0;
      outRaw[pi * 4 + 3] = 0;
    }
  }
}

  


  // Phase 4.5: Restaurierungs-Pass — dunkle Design-Pixel wiederherstellen,
  // die fälschlich halbtransparent gemacht wurden weil sie dem Mockup ähneln.
  const survivingMask = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (outRaw[i * 4 + 3] > 0) survivingMask[i] = 1;
  }

  // Maske um 0px erweitern um angrenzende entfernte Pixel einzuschließen
  const dilatedMask = new Uint8Array(survivingMask);
  const dilateRadius = 0;
  for (let y = dilateRadius; y < height - dilateRadius; y++) {
    for (let x = dilateRadius; x < width - dilateRadius; x++) {
      if (survivingMask[y * width + x]) continue;
      let found = false;
      for (let dy = -dilateRadius; dy <= dilateRadius && !found; dy++) {
        for (let dx = -dilateRadius; dx <= dilateRadius && !found; dx++) {
          if (survivingMask[(y + dy) * width + (x + dx)]) {
            found = true;
          }
        }
      }
      if (found) dilatedMask[y * width + x] = 1;
    }
  }

  // Pixel wiederherstellen: innerhalb der Design-Region halbtransparente
  // oder entfernte Pixel mit Originaldaten aus dem Composite ersetzen
  const restoreAlphaThreshold = 230;
  for (let i = 0; i < totalPixels; i++) {
    if (!dilatedMask[i]) continue;
    const idx = i * 4;
    const currentAlpha = outRaw[idx + 3];

    if (currentAlpha >= restoreAlphaThreshold) continue;

    const dist = diffMap[i];
    if (dist <= tolerance * 0.5) continue;

    outRaw[idx] = compRaw[idx];
    outRaw[idx + 1] = compRaw[idx + 1];
    outRaw[idx + 2] = compRaw[idx + 2];
    outRaw[idx + 3] = 255;
  }

  

  // Phase 5: Auto-Crop
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (outRaw[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Als PNG ausgeben (mit Auto-Crop)
  let result = sharp(outRaw, { raw: { width, height, channels: 4 } });

  if (maxX >= minX && maxY >= minY) {
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    result = result.extract({ left: minX, top: minY, width: cropW, height: cropH });
  }

  return result.png().toBuffer();
}

// ========== MAIN FUNCTION (Name bleibt gleich) ==========
// Änderung: erwartet jetzt zusätzlich baseMockupBuffer und nutzt extractDesign statt Grid-Removal
async function removeGridBackgroundAdvanced(compositeBuffer, baseMockupBuffer) {
  return extractDesign(baseMockupBuffer, compositeBuffer, 10);
}

// --------------------- Preview-Erstellung ---------------------

async function makePreviewWithBgRemoval({
  artworkUrl,       // composite: mockup+design (vom Frontend)
  baseMockupUrl,    // base: mockup ohne design (vom Frontend)
  mockupUrl,        // ZIEL-Mockup (unsere festen Upsell-Mockups)
  scale,
  offsetX,
  offsetY,
  overlayUrl, // optional
}) {
  // Composite laden (Mockup + Design)
  const artBuf = await loadImage(artworkUrl);

  // Base Mockup laden (gleiches Mockup ohne Design)
  const baseBuf = await loadImage(baseMockupUrl);

  // NEU: Design extrahieren statt Hintergrund entfernen
  let artTransparent;
  try {
    artTransparent = await removeGridBackgroundAdvanced(artBuf, baseBuf);
  } catch (err) {
    console.error("Design-Extraction Fehler, verwende Fallback:", err);
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  // ZIEL-Mockup laden (für Upsell-Preview)
  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Konnte Mockup-Größe nicht lesen.");
  }

  // Artwork skalieren
  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale), null, {
      fit: "inside",
      fastShrinkOnLoad: true,
    })
    .png()
    .toBuffer();

  const left = Math.round(meta.width * offsetX);
  const top = Math.round(meta.height * offsetY);

  const composites = [{ input: scaled, left, top }];

  // Falls Overlay gesetzt: PNG über alles legen
  if (overlayUrl) {
    const overlayBuf = await loadImage(overlayUrl);
    const overlayPng = await sharp(overlayBuf).ensureAlpha().png().toBuffer();
    composites.push({
      input: overlayPng,
      left: 0,
      top: 0,
    });
  }

  // Design (und ggf. Overlay) auf ZIEL-Mockup compositen
  const finalBuf = await mockSharp.composite(composites).png().toBuffer();

  return finalBuf;
}

// --------------------- Tote Endpoint ---------------------

app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TOTE_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: TOTE_MOCKUP_URL,
      scale: 0.33,
      offsetX: 0.32,
      offsetY: 0.42,
      overlayUrl: undefined,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- Mug Endpoint ---------------------

app.get("/mug-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "MUG_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: MUG_MOCKUP_URL,
      scale: 0.325,
      offsetX: 0.35,
      offsetY: 0.39,
      overlayUrl: undefined,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /mug-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /mug-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- NEU: Tee weiß Endpoint ---------------------

app.get("/tee-white-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_WHITE_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: TEE_WHITE_MOCKUP_URL,
      scale: 0.38,
      offsetX: 0.30,
      offsetY: 0.28,
      overlayUrl: TEE_WHITE_OVERLAY_URL,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tee-white-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tee-white-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- NEU: Tee schwarz Endpoint ---------------------

app.get("/tee-black-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_BLACK_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: TEE_BLACK_MOCKUP_URL,
      scale: 0.38,
      offsetX: 0.30,
      offsetY: 0.28,
      overlayUrl: TEE_BLACK_OVERLAY_URL,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tee-black-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tee-black-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- Serverstart ---------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
