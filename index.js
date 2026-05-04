// Kein hardcoded Produkt mehr. Alles kommt per Query-Parameter.
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

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

// ============================================================================
// R2 CLIENT
// ============================================================================

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET;
const IMG_BASE_URL = "https://img.boostomize.de";

async function buildImageHash(artworkUrl, baseMockupUrl, targetMockupUrl, extraLayerUrls = []) {
  const raw = `${artworkUrl}|${baseMockupUrl}|${targetMockupUrl}|${extraLayerUrls.join(",")}`;
  const data = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function existsInR2(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToR2(buffer, key) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "image/jpeg",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return `${IMG_BASE_URL}/${key}`;
}

const previewCache = new Map();
const designCache = new Map();

app.get("/", (req, res) => {
  res.send("upsell-preview-backend (generisch) läuft.");
});

// ============================================================================
// DEBUG: Nur Design-Extraktion (ohne Placement)
// ============================================================================
app.get("/debug-design", async (req, res) => {
  const artworkUrl    = req.query.url;
  const baseMockupUrl = req.query.mockup_url;
  const extraLayerUrls = req.query.extra_layer_urls
    ? req.query.extra_layer_urls.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  if (!artworkUrl    || typeof artworkUrl    !== "string") return res.status(400).json({ error: "Parameter 'url' fehlt." });
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") return res.status(400).json({ error: "Parameter 'mockup_url' fehlt." });

  try {
    const [compositeBuffer, baseBuffer] = await Promise.all([
      loadImage(artworkUrl),
      loadImage(baseMockupUrl),
    ]);
    const baseWithLayers = await compositeLayersOntoBase(baseBuffer, extraLayerUrls, compositeBuffer);
    const designBuffer   = await extractDesign(baseWithLayers, compositeBuffer, 10);
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
// ============================================================================
app.get("/generic-preview", async (req, res) => {
  const artworkUrl      = req.query.url;
  const baseMockupUrl   = req.query.mockup_url;
  const targetMockupUrl = req.query.target_mockup_url;
  const extraLayerUrls  = req.query.extra_layer_urls
    ? req.query.extra_layer_urls.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  if (!artworkUrl      || typeof artworkUrl      !== "string") return res.status(400).json({ error: "Parameter 'url' fehlt." });
  if (!baseMockupUrl   || typeof baseMockupUrl   !== "string") return res.status(400).json({ error: "Parameter 'mockup_url' fehlt." });
  if (!targetMockupUrl || typeof targetMockupUrl !== "string") return res.status(400).json({ error: "Parameter 'target_mockup_url' fehlt." });

  const printX = parseFloat(req.query.print_x) || 0.30;
  const printY = parseFloat(req.query.print_y) || 0.28;
  const printW = parseFloat(req.query.print_w) || 0.35;
  const printH = parseFloat(req.query.print_h) || 0.40;

  try {
    const hash      = await buildImageHash(artworkUrl, baseMockupUrl, targetMockupUrl, extraLayerUrls);
    const r2Key     = `upsell/${hash}.jpg`;
    const publicUrl = `${IMG_BASE_URL}/${r2Key}`;

    if (previewCache.has(hash)) return res.json({ ok: true, url: previewCache.get(hash) });
    if (await existsInR2(r2Key)) { previewCache.set(hash, publicUrl); return res.json({ ok: true, url: publicUrl }); }

    const finalBuffer = await makePreview({ artworkUrl, baseMockupUrl, targetMockupUrl, extraLayerUrls, printX, printY, printW, printH });
    await uploadToR2(finalBuffer, r2Key);
    previewCache.set(hash, publicUrl);
    return res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error("Fehler in /generic-preview:", err);
    res.status(500).json({ error: "Interner Fehler", detail: err.message });
  }
});

// ============================================================================
// ALTE ENDPOINTS (Rückwärtskompatibilität)
// ============================================================================
const LEGACY_CONFIGS = {
  "/tote-preview":     { targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1902.jpg?v=1765218360", printX: 0.32, printY: 0.42, printW: 0.33, printH: 0.33 },
  "/mug-preview":      { targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1901.jpg?v=1765218358", printX: 0.35, printY: 0.39, printW: 0.325, printH: 0.325 },
  "/tee-white-preview":{ targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1926.jpg?v=1765367168", printX: 0.30, printY: 0.28, printW: 0.38, printH: 0.38 },
  "/tee-black-preview":{ targetMockupUrl: "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1924.jpg?v=1765367167", printX: 0.30, printY: 0.28, printW: 0.38, printH: 0.38 },
};

for (const [path, cfg] of Object.entries(LEGACY_CONFIGS)) {
  app.get(path, async (req, res) => {
    const artworkUrl    = req.query.url;
    const baseMockupUrl = req.query.mockup_url;
    const extraLayerUrls = req.query.extra_layer_urls
      ? req.query.extra_layer_urls.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    if (!artworkUrl    || typeof artworkUrl    !== "string") return res.status(400).json({ error: "Parameter 'url' fehlt." });
    if (!baseMockupUrl || typeof baseMockupUrl !== "string") return res.status(400).json({ error: "Parameter 'mockup_url' fehlt." });

    try {
      const hash      = await buildImageHash(artworkUrl, baseMockupUrl, cfg.targetMockupUrl, extraLayerUrls);
      const r2Key     = `upsell/${hash}.jpg`;
      const publicUrl = `${IMG_BASE_URL}/${r2Key}`;

      if (previewCache.has(hash)) return res.json({ ok: true, url: previewCache.get(hash) });
      if (await existsInR2(r2Key)) { previewCache.set(hash, publicUrl); return res.json({ ok: true, url: publicUrl }); }

      const finalBuffer = await makePreview({ artworkUrl, baseMockupUrl, targetMockupUrl: cfg.targetMockupUrl, extraLayerUrls, printX: cfg.printX, printY: cfg.printY, printW: cfg.printW, printH: cfg.printH });
      await uploadToR2(finalBuffer, r2Key);
      previewCache.set(hash, publicUrl);
      return res.json({ ok: true, url: publicUrl });
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
  if (!resp.ok) throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1-r2, dg = g1-g2, db = b1-b2;
  return Math.sqrt(dr*dr + dg*dg + db*db);
}

// ============================================================================
// AUTO-OFFSET-ERKENNUNG (Cross-Correlation)
//
// Problem: Das Layer-File hat den Banner z.B. bei y=667, im finalen Composite
// erscheint er aber bei y=840. Einfaches Drüberlegen an Position (0,0) schlägt
// daher fehl — die Layer-Subtraktion entfernt den Banner NICHT.
//
// Lösung: Für jeden möglichen vertikalen Versatz (offset) berechnen wir, wie
// gut (Base + Layer_versetzt) mit dem Composite übereinstimmt.
// Minimaler Diff = korrekter Offset. Zwei-Phasen-Suche: grob (Schritt 5),
// dann fein (Schritt 1) im ±10px-Bereich um das Grob-Optimum.
// ============================================================================

async function findBestLayerOffset(baseRaw, layerRaw, compRaw, w, h) {
  // Opaken Zeilenbereich des Layers bestimmen
  let layerMinY = h, layerMaxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x += 4) {
      if (layerRaw[(y * w + x) * 4 + 3] > 50) {
        if (y < layerMinY) layerMinY = y;
        if (y > layerMaxY) layerMaxY = y;
        break;
      }
    }
  }
  if (layerMinY >= layerMaxY) {
    console.log("[findBestLayerOffset] Kein opaker Bereich gefunden, Offset=0");
    return 0;
  }

  const layerH = layerMaxY - layerMinY + 1;
  console.log(`[findBestLayerOffset] Layer opak: y=${layerMinY}..${layerMaxY} (${layerH}px), suche besten Offset...`);

  function scoreOffset(offset, xStep, yStep) {
    const dstStart = layerMinY + offset;
    if (dstStart < 0 || dstStart + layerH > h) return Infinity;
    let totalDiff = 0, count = 0;
    for (let dy = 0; dy < layerH; dy += yStep) {
      const srcY = layerMinY + dy;
      const dstY = dstStart + dy;
      for (let x = 0; x < w; x += xStep) {
        const li = (srcY * w + x) * 4;
        const layerAlpha = layerRaw[li + 3] / 255;
        if (layerAlpha < 0.2) continue;
        const bi = (dstY * w + x) * 4;
        const ci = bi; // compRaw ist gleich indiziert
        const blR = layerRaw[li]   * layerAlpha + baseRaw[bi]   * (1 - layerAlpha);
        const blG = layerRaw[li+1] * layerAlpha + baseRaw[bi+1] * (1 - layerAlpha);
        const blB = layerRaw[li+2] * layerAlpha + baseRaw[bi+2] * (1 - layerAlpha);
        const dr = compRaw[ci] - blR, dg = compRaw[ci+1] - blG, db = compRaw[ci+2] - blB;
        totalDiff += Math.sqrt(dr*dr + dg*dg + db*db);
        count++;
      }
    }
    return count > 0 ? totalDiff / count : Infinity;
  }

  // Phase 1: Grob-Suche (Schritt 5, jeden 2. Pixel vertikal, jeden 4. horizontal)
  let bestOffset = 0, bestScore = Infinity;
  for (let offset = -(h - layerH); offset <= (h - layerH); offset += 5) {
    const score = scoreOffset(offset, 4, 2);
    if (score < bestScore) { bestScore = score; bestOffset = offset; }
  }

  // Phase 2: Fein-Suche ±10px um Grob-Optimum (Schritt 1, jeden Pixel)
  const coarse = bestOffset;
  for (let offset = coarse - 10; offset <= coarse + 10; offset++) {
    const score = scoreOffset(offset, 2, 1);
    if (score < bestScore) { bestScore = score; bestOffset = offset; }
  }

  console.log(`[findBestLayerOffset] Bester Offset: ${bestOffset > 0 ? "+" : ""}${bestOffset}px (Score: ${bestScore.toFixed(2)})`);
  return bestOffset;
}

// ============================================================================
// EXTRA-LAYER AUF BASIS COMPOSITEN (mit Auto-Offset)
// ============================================================================

async function compositeLayersOntoBase(baseBuffer, layerUrls = [], compositeBuffer = null) {
  if (!layerUrls.length) return baseBuffer;

  // Zielgröße = Composite-Größe (damit Diff pixelgenau stimmt)
  let targetW, targetH;
  if (compositeBuffer) {
    const m = await sharp(compositeBuffer).metadata();
    targetW = m.width; targetH = m.height;
  } else {
    const m = await sharp(baseBuffer).metadata();
    targetW = m.width; targetH = m.height;
  }

  // Base auf Zielgröße skalieren
  let scaledBase = await sharp(baseBuffer)
    .resize(targetW, targetH, { fit: "fill" })
    .jpeg({ quality: 100 })
    .toBuffer();

  // Raw-Puffer für Offset-Erkennung (einmalig)
  const baseRaw = await sharp(scaledBase).ensureAlpha().raw().toBuffer();
  const compRaw = compositeBuffer
    ? await sharp(compositeBuffer).resize(targetW, targetH, { fit: "fill" }).ensureAlpha().raw().toBuffer()
    : null;

  const composites = [];

  for (const url of layerUrls) {
    let layerBuf;
    try { layerBuf = await loadImage(url); }
    catch (e) {
      console.warn(`[compositeLayersOntoBase] Layer konnte nicht geladen werden: ${url} — ${e.message}`);
      continue;
    }

    try {
      // Layer auf Zielgröße bringen falls nötig
      const lm = await sharp(layerBuf).metadata();
      if (lm.width !== targetW || lm.height !== targetH) {
        layerBuf = await sharp(layerBuf).resize(targetW, targetH, { fit: "fill" }).png().toBuffer();
      }

      const layerRaw = await sharp(layerBuf).ensureAlpha().raw().toBuffer();

      // Korrekten vertikalen Offset automatisch ermitteln
      const offsetY = compRaw ? await findBestLayerOffset(baseRaw, layerRaw, compRaw, targetW, targetH) : 0;

      if (offsetY === 0) {
        // Kein Versatz — direkt verwenden
        composites.push({ input: await sharp(layerBuf).ensureAlpha().png().toBuffer(), blend: "over" });
      } else {
        // Layer in leeres Canvas mit korrektem Versatz einbauen
        const shifted = Buffer.alloc(targetW * targetH * 4, 0);

        let layerMinY = targetH, layerMaxY = 0;
        for (let y = 0; y < targetH; y++)
          for (let x = 0; x < targetW; x += 4)
            if (layerRaw[(y * targetW + x) * 4 + 3] > 50) {
              if (y < layerMinY) layerMinY = y;
              if (y > layerMaxY) layerMaxY = y;
              break;
            }

        const dstStart = layerMinY + offsetY;
        const copyH    = Math.min(layerMaxY - layerMinY + 1, targetH - Math.max(0, dstStart));
        if (dstStart >= 0 && copyH > 0) {
          for (let dy = 0; dy < copyH; dy++) {
            const srcOff = (layerMinY + dy) * targetW * 4;
            const dstOff = (dstStart  + dy) * targetW * 4;
            layerRaw.copy(shifted, dstOff, srcOff, srcOff + targetW * 4);
          }
        }

        const png = await sharp(shifted, { raw: { width: targetW, height: targetH, channels: 4 } }).png().toBuffer();
        composites.push({ input: png, blend: "over" });
        console.log(`[compositeLayersOntoBase] Layer mit Offset ${offsetY > 0 ? "+" : ""}${offsetY}px platziert.`);
      }
    } catch (e) {
      console.warn(`[compositeLayersOntoBase] Layer-Verarbeitung fehlgeschlagen — ${e.message}`);
    }
  }

  if (!composites.length) return scaledBase;

  const result = await sharp(scaledBase).composite(composites).jpeg({ quality: 100 }).toBuffer();
  console.log(`[compositeLayersOntoBase] ${composites.length} Extra-Layer auf ${targetW}x${targetH} Base gerendert.`);
  return result;
}

// ============================================================================
// DESIGN-EXTRAKTION
// ============================================================================

async function extractDesign(baseBuffer, compositeBuffer, tolerance = 10) {
  const t0 = Date.now();

  [baseBuffer, compositeBuffer] = await Promise.all([
    sharp(baseBuffer).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 100 }).toBuffer(),
    sharp(compositeBuffer).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 100 }).toBuffer(),
  ]);

  const baseMeta = await sharp(baseBuffer).metadata();
  const compMeta = await sharp(compositeBuffer).metadata();
  const width = baseMeta.width, height = baseMeta.height;

  const [baseRaw, compRaw] = await Promise.all([
    sharp(baseBuffer).ensureAlpha().raw().toBuffer(),
    (async () => {
      let s = sharp(compositeBuffer).ensureAlpha();
      if (compMeta.width !== width || compMeta.height !== height) s = s.resize(width, height);
      return s.raw().toBuffer();
    })(),
  ]);

  console.log(`[Timing] Phase 0 (Laden + Flatten): ${Date.now() - t0}ms`);
  const t1 = Date.now();

  const totalPixels = width * height;
  const outRaw = Buffer.alloc(totalPixels * 4);

  const diffMap = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    diffMap[i] = colorDistance(baseRaw[idx], baseRaw[idx+1], baseRaw[idx+2], compRaw[idx], compRaw[idx+1], compRaw[idx+2]);
  }

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
      } else { fR = cR; fG = cG; fB = cB; }
      outRaw[idx] = fR; outRaw[idx+1] = fG; outRaw[idx+2] = fB;
      outRaw[idx+3] = Math.round(alpha * 255);
    }
  }

  console.log(`[Timing] Phase 1+2 (Diff + Alpha): ${Date.now() - t1}ms`);
  const t2 = Date.now();

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

  console.log(`[Timing] Phase 3 (Rausch-Filter): ${Date.now() - t2}ms`);
  const t3 = Date.now();

  const visited = new Uint8Array(totalPixels);
  const components = [];

  for (let i = 0; i < totalPixels; i++) {
    if (visited[i] || outRaw[i*4+3] === 0) continue;
    const queue = [i]; const pixels = []; visited[i] = 1;
    while (queue.length > 0) {
      const cur = queue.pop(); pixels.push(cur);
      const cx = cur % width, cy = Math.floor(cur / width);
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
      const px=pi%width, py=Math.floor(pi/width);
      if(px<cMinX) cMinX=px; if(px>cMaxX) cMaxX=px;
      if(py<cMinY) cMinY=py; if(py>cMaxY) cMaxY=py;
    }
    const maxDim = Math.max(cMaxX-cMinX+1, cMaxY-cMinY+1);
    const avgThickness = comp.pixels.length / Math.max(1, maxDim);
    if (avgThickness < 6) {
      for (const pi of comp.pixels) { outRaw[pi*4]=0; outRaw[pi*4+1]=0; outRaw[pi*4+2]=0; outRaw[pi*4+3]=0; }
    }
  }

  console.log(`[Timing] Phase 4 (Connected Components): ${Date.now() - t3}ms`);
  const t4 = Date.now();

  const proximityRadius = 90;
  const mainMask = new Uint8Array(totalPixels);
  if (components.length > 0) for (const pi of components[largestIdx].pixels) mainMask[pi] = 1;

  const hDilated = new Uint8Array(totalPixels);
  const rowPrefix = new Int32Array(width + 1);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    rowPrefix[0] = 0;
    for (let x = 0; x < width; x++) rowPrefix[x+1] = rowPrefix[x] + mainMask[rowBase+x];
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - proximityRadius);
      const hi = Math.min(width-1, x + proximityRadius);
      if (rowPrefix[hi+1] - rowPrefix[lo] > 0) hDilated[rowBase+x] = 1;
    }
  }

  const dilationMask = new Uint8Array(totalPixels);
  const colPrefix = new Int32Array(height + 1);
  for (let x = 0; x < width; x++) {
    colPrefix[0] = 0;
    for (let y = 0; y < height; y++) colPrefix[y+1] = colPrefix[y] + hDilated[y*width+x];
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - proximityRadius);
      const hi = Math.min(height-1, y + proximityRadius);
      if (colPrefix[hi+1] - colPrefix[lo] > 0) dilationMask[y*width+x] = 1;
    }
  }

  for (let c=0; c<components.length; c++) {
    if (c === largestIdx) continue;
    const comp = components[c];
    const isNearMain = comp.pixels.some(pi => dilationMask[pi] === 1);
    if (!isNearMain) {
      for (const pi of comp.pixels) { outRaw[pi*4]=0; outRaw[pi*4+1]=0; outRaw[pi*4+2]=0; outRaw[pi*4+3]=0; }
    }
  }

  console.log(`[Timing] Phase 4.1 (Proximity Dilation Mask): ${Date.now() - t4}ms`);
  const t5 = Date.now();

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

  let minX=width, minY=height, maxX=0, maxY=0;
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    if (outRaw[(y*width+x)*4+3]>0) {
      if(x<minX) minX=x; if(x>maxX) maxX=x;
      if(y<minY) minY=y; if(y>maxY) maxY=y;
    }
  }

  let result = sharp(outRaw, { raw: { width, height, channels: 4 } });
  if (maxX>=minX && maxY>=minY) result = result.extract({ left:minX, top:minY, width:maxX-minX+1, height:maxY-minY+1 });

  const output = await result.png().toBuffer();
  console.log(`[Timing] Phase 4.5+5 (Restore + Crop): ${Date.now() - t5}ms`);
  console.log(`[Timing] GESAMT Extraktion: ${Date.now() - t0}ms`);
  return output;
}

// ============================================================================
// PREVIEW-ERSTELLUNG (generisch)
// ============================================================================

async function makePreview({ artworkUrl, baseMockupUrl, targetMockupUrl, extraLayerUrls = [], printX, printY, printW, printH }) {
  const t0 = Date.now();

  const [artBuf, baseBuf, targetBuf] = await Promise.all([
    loadImage(artworkUrl),
    loadImage(baseMockupUrl),
    loadImage(targetMockupUrl),
  ]);
  console.log(`[Timing] Bildladung (parallel): ${Date.now() - t0}ms`);

  // artBuf (Composite) als Referenz → Auto-Offset erkennt korrekte Layer-Position
  const baseWithLayers = await compositeLayersOntoBase(baseBuf, extraLayerUrls, artBuf);

  const designCacheKey = `${artworkUrl}__${baseMockupUrl}__${extraLayerUrls.join(",")}`;
  let designTransparent;

  if (designCache.has(designCacheKey)) {
    console.log(`[Timing] Design aus Cache geladen`);
    designTransparent = designCache.get(designCacheKey);
  } else {
    try {
      designTransparent = await extractDesign(baseWithLayers, artBuf, 10);
    } catch (err) {
      console.error("Design-Extraction Fehler, verwende Fallback:", err);
      designTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
    }
    designCache.set(designCacheKey, designTransparent);
  }

  const t1 = Date.now();
  const targetSharp = sharp(targetBuf);
  const meta = await targetSharp.metadata();
  if (!meta.width || !meta.height) throw new Error("Konnte Ziel-Mockup-Größe nicht lesen.");

  const areaPixelW = Math.round(meta.width  * printW);
  const areaPixelH = Math.round(meta.height * printH);
  const areaLeft   = Math.round(meta.width  * printX);
  const areaTop    = Math.round(meta.height * printY);

  const scaled = await sharp(designTransparent)
    .resize(areaPixelW, areaPixelH, { fit: "inside", withoutEnlargement: false })
    .png().toBuffer();

  const scaledMeta   = await sharp(scaled).metadata();
  const centeredLeft = areaLeft + Math.round((areaPixelW - scaledMeta.width) / 2);
  const freeSpaceV   = areaPixelH - scaledMeta.height;
  const centeredTop  = freeSpaceV > 20 ? areaTop + Math.round(freeSpaceV * 0.3) : areaTop + Math.round(freeSpaceV / 2);

  const finalBuf = await targetSharp
    .composite([{ input: scaled, left: centeredLeft, top: centeredTop }])
    .jpeg({ quality: 90 })
    .toBuffer();

  console.log(`[Timing] Placement + Composite: ${Date.now() - t1}ms`);
  console.log(`[Timing] GESAMT makePreview: ${Date.now() - t0}ms`);
  return finalBuf;
}

// ============================================================================
// SERVER START
// ============================================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log("Server läuft auf Port " + PORT); });
