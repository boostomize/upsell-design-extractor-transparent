// index.js — Generisches Upsell-Preview-Backend
// Kein hardcoded Produkt mehr. Alles kommt per Query-Parameter.
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const SHOPIFY_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/png,image/*,*/*",
};

// Cache: artworkUrl + target -> fertiges PNG
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("upsell-preview-backend (generisch) läuft.");
});

// ============================================================================
// DEBUG: Nur Design-Extraktion (ohne Placement)
// /debug-design?url=COMPOSITE_URL&mockup_url=BASE_MOCKUP_URL
// ============================================================================
app.get("/debug-design", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt." });
  }

  try {
    const compositeBuffer = await loadImage(artworkUrl);
    const baseBuffer = await loadImage(baseMockupUrl);
    const designBuffer = await extractDesign(baseBuffer, compositeBuffer, 10);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(designBuffer);
  } catch (err) {
    console.error("Fehler in /debug-design:", err);
    res.status(500).json({ error: "Interner Fehler", detail: err.message });
  }
});

// ============================================================================
// GENERISCHER PREVIEW-ENDPOINT
// Ersetzt alle alten /tote-preview, /tee-white-preview, etc.
//
// Query-Parameter:
//   url              = Composite-Bild (Mockup + Design) vom Ursprungsprodukt
//   mockup_url       = Base-Mockup des Ursprungsprodukts (leer, ohne Design)
//   target_mockup_url = Ziel-Mockup aus der Mockup-Bibliothek (worauf das Design gelegt wird)
//   print_x          = X-Position der Druckfläche (0-1, default 0.30)
//   print_y          = Y-Position der Druckfläche (0-1, default 0.28)
//   print_w          = Breite der Druckfläche (0-1, default 0.35)
//   print_h          = Höhe der Druckfläche (0-1, default 0.40)
// ============================================================================
app.get("/generic-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;
  const targetMockupUrl = req.query.target_mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt." });
  }
  if (!targetMockupUrl || typeof targetMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'target_mockup_url' fehlt." });
  }

  // Druckfläche aus Query-Parametern (vom Druckflächen-Editor in der App)
  const printX = parseFloat(req.query.print_x) || 0.30;
  const printY = parseFloat(req.query.print_y) || 0.28;
  const printW = parseFloat(req.query.print_w) || 0.35;
  const printH = parseFloat(req.query.print_h) || 0.40;

  const cacheKey = `GENERIC_${artworkUrl}_${baseMockupUrl}_${targetMockupUrl}_${printX}_${printY}_${printW}_${printH}`;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreview({
      artworkUrl,
      baseMockupUrl,
      targetMockupUrl,
      printX,
      printY,
      printW,
      printH,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /generic-preview:", err);
    res.status(500).json({ error: "Interner Fehler", detail: err.message });
  }
});

// ============================================================================
// ALTE ENDPOINTS (Rückwärtskompatibilität, falls noch gebraucht)
// Leiten intern auf die gleiche Logik weiter mit festen Werten.
// Können später entfernt werden.
// ============================================================================

const LEGACY_CONFIGS = {
  "/tote-preview": {
    targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1902.jpg?v=1765218360",
    printX: 0.32, printY: 0.42, printW: 0.33, printH: 0.33,
  },
  "/mug-preview": {
    targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1901.jpg?v=1765218358",
    printX: 0.35, printY: 0.39, printW: 0.325, printH: 0.325,
  },
  "/tee-white-preview": {
    targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1926.jpg?v=1765367168",
    printX: 0.30, printY: 0.28, printW: 0.38, printH: 0.38,
  },
  "/tee-black-preview": {
    targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1924.jpg?v=1765367167",
    printX: 0.30, printY: 0.28, printW: 0.38, printH: 0.38,
  },
};

for (const [path, cfg] of Object.entries(LEGACY_CONFIGS)) {
  app.get(path, async (req, res) => {
    const artworkUrl = req.query.url;
    const baseMockupUrl = req.query.mockup_url;

    if (!artworkUrl || typeof artworkUrl !== "string") {
      return res.status(400).json({ error: "Parameter 'url' fehlt." });
    }
    if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
      return res.status(400).json({ error: "Parameter 'mockup_url' fehlt." });
    }

    const cacheKey = `LEGACY_${path}_${artworkUrl}_${baseMockupUrl}`;
    if (previewCache.has(cacheKey)) {
      res.setHeader("Content-Type", "image/png");
      return res.send(previewCache.get(cacheKey));
    }

    try {
      const finalBuffer = await makePreview({
        artworkUrl,
        baseMockupUrl,
        targetMockupUrl: cfg.targetMockupUrl,
        printX: cfg.printX,
        printY: cfg.printY,
        printW: cfg.printW,
        printH: cfg.printH,
      });

      previewCache.set(cacheKey, finalBuffer);
      res.setHeader("Content-Type", "image/png");
      res.send(finalBuffer);
    } catch (err) {
      console.error(`Fehler in ${path}:`, err);
      res.status(500).json({ error: "Interner Fehler", detail: err.message });
    }
  });
}

// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================

async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ============================================================================
// DESIGN-EXTRAKTION (Pixel-Diff zwischen leerem Mockup und Composite)
// ============================================================================

async function extractDesign(baseBuffer, compositeBuffer, tolerance = 10) {
  // Phase 0: JPG-Konvertierung (Transparenz entfernen)
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

  const baseRaw = await sharp(baseBuffer).ensureAlpha().raw().toBuffer();

  let compSharp = sharp(compositeBuffer).ensureAlpha();
  if (compMeta.width !== width || compMeta.height !== height) {
    compSharp = compSharp.resize(width, height);
  }
  const compRaw = await compSharp.raw().toBuffer();

  const totalPixels = width * height;
  const outRaw = Buffer.alloc(totalPixels * 4);

  // Phase 1: Diff-Map
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
      outRaw[idx] = 0; outRaw[idx+1] = 0; outRaw[idx+2] = 0; outRaw[idx+3] = 0;
    } else {
      const alpha = Math.min(1, (dist - tolerance) / (255 - tolerance));
      const bR = baseRaw[idx], bG = baseRaw[idx+1], bB = baseRaw[idx+2];
      const cR = compRaw[idx], cG = compRaw[idx+1], cB = compRaw[idx+2];

      let fR, fG, fB;
      if (alpha > 0.01) {
        fR = Math.round(Math.min(255, Math.max(0, (cR - (1-alpha)*bR) / alpha)));
        fG = Math.round(Math.min(255, Math.max(0, (cG - (1-alpha)*bG) / alpha)));
        fB = Math.round(Math.min(255, Math.max(0, (cB - (1-alpha)*bB) / alpha)));
      } else {
        fR = cR; fG = cG; fB = cB;
      }

      outRaw[idx] = fR; outRaw[idx+1] = fG; outRaw[idx+2] = fB;
      outRaw[idx+3] = Math.round(alpha * 255);
    }
  }

  // Phase 3: Isolierte Rausch-Pixel entfernen
  const alphaChannel = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) alphaChannel[i] = outRaw[i*4+3];

  for (let y = 1; y < height-1; y++) {
    for (let x = 1; x < width-1; x++) {
      const i = y*width+x;
      if (alphaChannel[i] === 0) continue;
      let opaqueNeighbors = 0;
      for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
        if (dx===0 && dy===0) continue;
        if (alphaChannel[(y+dy)*width+(x+dx)] > 0) opaqueNeighbors++;
      }
      if (opaqueNeighbors <= 1 && alphaChannel[i] < 128) outRaw[i*4+3] = 0;
    }
  }

  // Phase 4: Connected-Component-Filter
  const visited = new Uint8Array(totalPixels);
  const components = [];

  for (let i = 0; i < totalPixels; i++) {
    if (visited[i] || outRaw[i*4+3] === 0) continue;
    const queue = [i]; const pixels = []; visited[i] = 1;
    while (queue.length > 0) {
      const cur = queue.pop(); pixels.push(cur);
      const cx = cur % width, cy = (cur-cx) / width;
      for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
        if (dx===0 && dy===0) continue;
        const nx=cx+dx, ny=cy+dy;
        if (nx<0||nx>=width||ny<0||ny>=height) continue;
        const ni = ny*width+nx;
        if (visited[ni] || outRaw[ni*4+3]===0) continue;
        visited[ni]=1; queue.push(ni);
      }
    }
    components.push({ pixels });
  }

  let largestIdx = 0;
  for (let c=1; c<components.length; c++) {
    if (components[c].pixels.length > components[largestIdx].pixels.length) largestIdx=c;
  }

  const mainSize = components.length > 0 ? components[largestIdx].pixels.length : 0;
  const sizeThreshold = Math.max(240, mainSize * 0.40);

  for (let c=0; c<components.length; c++) {
    const comp = components[c];
    if (comp.pixels.length >= sizeThreshold) continue;
    let cMinX=width, cMaxX=0, cMinY=height, cMaxY=0;
    for (const pi of comp.pixels) {
      const px=pi%width, py=(pi-px)/width;
      if(px<cMinX) cMinX=px; if(px>cMaxX) cMaxX=px;
      if(py<cMinY) cMinY=py; if(py>cMaxY) cMaxY=py;
    }
    const maxDim = Math.max(cMaxX-cMinX+1, cMaxY-cMinY+1);
    const avgThickness = comp.pixels.length / Math.max(1, maxDim);
    if (avgThickness < 6) {
      for (const pi of comp.pixels) { outRaw[pi*4]=0; outRaw[pi*4+1]=0; outRaw[pi*4+2]=0; outRaw[pi*4+3]=0; }
    }
  }

  // Phase 4.1: Proximity-Filter
  const mainPixelSet = new Set();
  if (components.length > 0) for (const pi of components[largestIdx].pixels) mainPixelSet.add(pi);
  const proximityRadius = 90;

  for (let c=0; c<components.length; c++) {
    if (c===largestIdx) continue;
    const comp = components[c];
    let isNearMain = false;
    for (const pi of comp.pixels) {
      if (isNearMain) break;
      const px=pi%width, py=(pi-px)/width;
      for (let dy=-proximityRadius; dy<=proximityRadius && !isNearMain; dy++) {
        for (let dx=-proximityRadius; dx<=proximityRadius && !isNearMain; dx++) {
          const nx=px+dx, ny=py+dy;
          if (nx<0||nx>=width||ny<0||ny>=height) continue;
          if (mainPixelSet.has(ny*width+nx)) isNearMain=true;
        }
      }
    }
    if (!isNearMain) {
      for (const pi of comp.pixels) { outRaw[pi*4]=0; outRaw[pi*4+1]=0; outRaw[pi*4+2]=0; outRaw[pi*4+3]=0; }
    }
  }

  // Phase 4.5: Restaurierungs-Pass
  const survivingMask = new Uint8Array(totalPixels);
  for (let i=0; i<totalPixels; i++) if (outRaw[i*4+3]>0) survivingMask[i]=1;

  const restoreAlphaThreshold = 230;
  for (let i=0; i<totalPixels; i++) {
    if (!survivingMask[i]) continue;
    const idx = i*4;
    if (outRaw[idx+3] >= restoreAlphaThreshold) continue;
    if (diffMap[i] <= tolerance*0.5) continue;
    outRaw[idx]=compRaw[idx]; outRaw[idx+1]=compRaw[idx+1]; outRaw[idx+2]=compRaw[idx+2]; outRaw[idx+3]=255;
  }

  // Phase 5: Auto-Crop
  let minX=width, minY=height, maxX=0, maxY=0;
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    if (outRaw[(y*width+x)*4+3]>0) {
      if(x<minX) minX=x; if(x>maxX) maxX=x;
      if(y<minY) minY=y; if(y>maxY) maxY=y;
    }
  }

  let result = sharp(outRaw, { raw: { width, height, channels: 4 } });
  if (maxX>=minX && maxY>=minY) {
    result = result.extract({ left:minX, top:minY, width:maxX-minX+1, height:maxY-minY+1 });
  }
  return result.png().toBuffer();
}

// ============================================================================
// PREVIEW-ERSTELLUNG (generisch)
// ============================================================================

async function makePreview({
  artworkUrl,        // Composite: Ursprungs-Mockup + Design
  baseMockupUrl,     // Base: Ursprungs-Mockup ohne Design
  targetMockupUrl,   // Ziel-Mockup aus der Mockup-Bibliothek
  printX,            // Druckfläche X (0-1)
  printY,            // Druckfläche Y (0-1)
  printW,            // Druckfläche Breite (0-1)
  printH,            // Druckfläche Höhe (0-1)
}) {
  // 1. Bilder laden
  const artBuf = await loadImage(artworkUrl);
  const baseBuf = await loadImage(baseMockupUrl);
  const targetBuf = await loadImage(targetMockupUrl);

  // 2. Design extrahieren (Diff zwischen Base und Composite)
  let designTransparent;
  try {
    designTransparent = await extractDesign(baseBuf, artBuf, 10);
  } catch (err) {
    console.error("Design-Extraction Fehler, verwende Fallback:", err);
    designTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  // 3. Ziel-Mockup Dimensionen lesen
  const targetSharp = sharp(targetBuf);
  const meta = await targetSharp.metadata();
  if (!meta.width || !meta.height) throw new Error("Konnte Ziel-Mockup-Größe nicht lesen.");

  // 4. Design in die Druckfläche einpassen
  const areaPixelW = Math.round(meta.width * printW);
  const areaPixelH = Math.round(meta.height * printH);
  const areaLeft = Math.round(meta.width * printX);
  const areaTop = Math.round(meta.height * printY);

  // Design so skalieren, dass es in die Druckfläche passt (Aspect Ratio beibehalten)
  const scaled = await sharp(designTransparent)
    .resize(areaPixelW, areaPixelH, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  // Skaliertes Design zentriert in der Druckfläche positionieren
  const scaledMeta = await sharp(scaled).metadata();
  const centeredLeft = areaLeft + Math.round((areaPixelW - scaledMeta.width) / 2);
  const centeredTop = areaTop + Math.round((areaPixelH - scaledMeta.height) / 2);

  // 5. Design auf Ziel-Mockup compositen
  const finalBuf = await targetSharp
    .composite([{ input: scaled, left: centeredLeft, top: centeredTop }])
    .png()
    .toBuffer();

  return finalBuf;
}

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
