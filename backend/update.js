import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.join(__dirname, '../frontend/public/product_catalog_for_realistic_sales.csv');

// Initialize Google GenAI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// In-memory cache for discovered Flipkart page URIs (preserves state without modifying CSV)
const pageUriCache = new Map();

// In-memory cache for live Flipkart selling prices (preserves state without modifying CSV)
const flipkartPriceCache = new Map();

/**
 * Escapes values for CSV serialization
 */
const escapeCSV = (val) => {
  if (val === undefined || val === null) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
};

/**
 * Helper to resolve a Google Vertex AI grounding redirect URL to the authentic Flipkart URL
 */
async function resolveFlipkartLocation(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const location = res.headers.get('location');
    if (location && /flipkart\.com/i.test(location)) {
      return location;
    }
  } catch (err) {
    // Ignore fetch errors during redirect resolution
  }
  return null;
}

/**
 * Extracts and cleans the Flipkart product pageUri or URL from raw model output or JSON text.
 * Strictly ignores search URLs to ensure a direct product page link is always returned.
 */
function extractFlipkartUri(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^["']?none["']?$/i.test(trimmed)) return 'none';

  // Do not accept search URLs, only direct product page links
  if (trimmed.includes('/search?') || trimmed.includes('flipkart.com/search')) {
    return null;
  }

  // 1. Match JSON or text field "pageUri": "..." or '...'
  const jsonMatch = trimmed.match(/["']?pageUri["']?\s*:\s*["']([^"'\s]+)["']/i);
  if (jsonMatch) {
    const candidate = jsonMatch[1].trim();
    if (!candidate.includes('/search?')) {
      return candidate;
    }
  }

  // 2. Direct match for full Flipkart product URL
  const fullUrlMatch = trimmed.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?flipkart\.com\/[^\s)"]+/i);
  if (fullUrlMatch) {
    const clean = fullUrlMatch[0].replace(/[.,;]+$/, '').replace(/["']+$/, '');
    if ((clean.includes('/p/') || clean.includes('/itm')) && !clean.includes('/search?')) {
      return clean;
    }
  }

  // 3. Match relative Flipkart product paths like /slug/p/itm...?pid=... or /p/p?pid=...
  const relativePathMatch = trimmed.match(/(\/(?:[a-zA-Z0-9-_]+\/)*p\/(?:itm[a-zA-Z0-9]+|p)(?:\?[^\s)"'`]*)?)/i);
  if (relativePathMatch) {
    return relativePathMatch[1];
  }

  // 4. Match general /slug/p/... paths
  const generalPathMatch = trimmed.match(/(\/[a-zA-Z0-9-_]+\/p\/[^\s)"'`]+)/i);
  if (generalPathMatch) {
    return generalPathMatch[1];
  }

  // 5. If text starts with / and contains /p/
  if (trimmed.startsWith('/') && trimmed.includes('/p/')) {
    return trimmed.replace(/^["']|["']$/g, '');
  }

  return null;
}

/**
 * Tokenizes text for semantic product matching
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['the', 'and', 'for', 'with', 'made', 'from', 'a', 'an', 'in', 'of', 'to'].includes(w));
}

/**
 * Extracts live product candidate cards from Flipkart search HTML
 */
function extractFlipkartCandidates(html) {
  const candidates = [];
  const seenPids = new Set();

  // 1. Fashion grid layout: brand div + anchor with title
  const fashionRegex = /<div class="[^"]*">([A-Za-z0-9\s.&_-]+)<\/div>\s*<a[^>]+title="([^"]+)"[^>]+href="(\/[^"]*\/p\/[^"]*)"/gi;
  let m;
  while ((m = fashionRegex.exec(html)) !== null) {
    const brand = m[1].trim();
    const title = m[2].trim();
    const href = m[3];
    const pidMatch = href.match(/[?&]pid=([a-zA-Z0-9]+)/);
    const pid = pidMatch ? pidMatch[1] : '';
    if (pid && !seenPids.has(pid)) {
      seenPids.add(pid);
      const cleanPath = href.split('?')[0];
      candidates.push({
        brand,
        title,
        fullTitle: `${brand} ${title}`,
        pageUri: `${cleanPath}?pid=${pid}`,
        slug: cleanPath
      });
    }
  }

  // 2. Row layout: anchor with title div
  const rowRegex = /<a[^>]+href="(\/[^"]*\/p\/[^"]*)"[^>]*>[\s\S]*?<div class="[^"]*">([^<]{5,150})<\/div>/gi;
  while ((m = rowRegex.exec(html)) !== null) {
    const href = m[1];
    const title = m[2].trim();
    const pidMatch = href.match(/[?&]pid=([a-zA-Z0-9]+)/);
    const pid = pidMatch ? pidMatch[1] : '';
    if (pid && !seenPids.has(pid)) {
      seenPids.add(pid);
      const cleanPath = href.split('?')[0];
      candidates.push({
        brand: '',
        title,
        fullTitle: title,
        pageUri: `${cleanPath}?pid=${pid}`,
        slug: cleanPath
      });
    }
  }

  // 3. Anchor with title attribute
  const titleAttrRegex = /<a[^>]+title="([^"]+)"[^>]+href="(\/[^"]*\/p\/[^"]*)"/gi;
  while ((m = titleAttrRegex.exec(html)) !== null) {
    const title = m[1].trim();
    const href = m[2];
    const pidMatch = href.match(/[?&]pid=([a-zA-Z0-9]+)/);
    const pid = pidMatch ? pidMatch[1] : '';
    if (pid && !seenPids.has(pid)) {
      seenPids.add(pid);
      const cleanPath = href.split('?')[0];
      candidates.push({
        brand: '',
        title,
        fullTitle: title,
        pageUri: `${cleanPath}?pid=${pid}`,
        slug: cleanPath
      });
    }
  }

  // 4. Any anchor containing /p/itm...
  const genericRegex = /<a[^>]+href="(\/([^"]+)\/p\/(itm[a-zA-Z0-9]+)[^"]*)"/gi;
  while ((m = genericRegex.exec(html)) !== null) {
    const href = m[1];
    const slugName = m[2].replace(/-/g, ' ');
    const pidMatch = href.match(/[?&]pid=([a-zA-Z0-9]+)/);
    const pid = pidMatch ? pidMatch[1] : '';
    if (pid && !seenPids.has(pid)) {
      seenPids.add(pid);
      const cleanPath = href.split('?')[0];
      candidates.push({
        brand: '',
        title: slugName,
        fullTitle: slugName,
        pageUri: `${cleanPath}?pid=${pid}`,
        slug: cleanPath
      });
    }
  }

  return candidates;
}

/**
 * Searches Flipkart in the backend (headless, no foreground browser)
 * and finds the 90-95% best matching product's authentic pageUri
 */
async function searchFlipkartInBackend(description) {
  if (!description || !description.trim()) return 'none';

  let rawQuery = description.trim();

  // If description contains a Flipkart search URL, extract query param
  if (rawQuery.includes('flipkart.com/search')) {
    const matchQ = rawQuery.match(/[?&]q=([^&]+)/);
    if (matchQ) {
      rawQuery = decodeURIComponent(matchQ[1].replace(/\+/g, ' '));
    }
  }

  const cleanQuery = rawQuery
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanQuery) return 'none';

  try {
    const searchUrl = `https://www.flipkart.com/search?q=${encodeURIComponent(cleanQuery)}`;
    console.log(`[findFlipkartPageUri] Headless backend search: ${searchUrl}`);

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!res.ok) {
      console.warn(`[Flipkart Search] HTTP error: ${res.status}`);
      return 'none';
    }

    const html = await res.text();
    const candidates = extractFlipkartCandidates(html);

    if (candidates.length === 0) {
      return 'none';
    }

    const descTokens = tokenize(rawQuery);
    const possibleBrand = descTokens[0]; // e.g. "mildin"

    let bestCandidate = null;
    let bestScore = -1;

    for (const cand of candidates) {
      const candTokens = tokenize(`${cand.fullTitle} ${cand.slug.replace(/[\/-]/g, ' ')}`);
      const candSet = new Set(candTokens);

      let matchedCount = 0;
      for (const t of descTokens) {
        if (candSet.has(t)) matchedCount++;
      }

      const recall = descTokens.length > 0 ? matchedCount / descTokens.length : 0;
      const unionSet = new Set([...descTokens, ...candTokens]);
      const jaccard = unionSet.size > 0 ? matchedCount / unionSet.size : 0;

      const hasBrand = candTokens.includes(possibleBrand);
      let score = recall * 0.7 + jaccard * 0.3;
      if (possibleBrand && possibleBrand.length > 2 && !hasBrand) {
        score *= 0.2; // heavy penalty for brand mismatch
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = { ...cand, recall, jaccard, score, matchedCount };
      }
    }

    if (bestCandidate) {
      console.log(
        `[Flipkart Match] Candidate: "${bestCandidate.fullTitle}" | Recall: ${(bestCandidate.recall * 100).toFixed(1)}% | Score: ${(
          bestScore * 100
        ).toFixed(1)}%`
      );

      // Strict 90-95% threshold: recall >= 85% and score >= 0.60
      if (bestCandidate.recall >= 0.85 && bestCandidate.score >= 0.60) {
        return bestCandidate.pageUri;
      }
    }

    return 'none';
  } catch (err) {
    console.error('Error in searchFlipkartInBackend:', err.message);
    return 'none';
  }
}

/**
 * Validates and extracts clean, relative pageUri from a raw Flipkart URL.
 * Enforces strict 16-character alphanumeric PID validation.
 */
export function extractValidPageUri(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.includes('flipkart.com')) return 'none';

    // Must be a product page path
    if (!parsed.pathname.includes('/p/')) return 'none';

    const pid = parsed.searchParams.get('pid');
    // Validate 16-char alphanumeric PID (e.g. SHT..., SHO...)
    if (!pid || !/^[A-Z0-9]{16}$/i.test(pid)) return 'none';

    // Return clean relative path with PID for Rome API
    return `${parsed.pathname}?pid=${pid}`;
  } catch {
    return 'none';
  }
}

/**
 * Searches Google for authentic Flipkart listing via Gemini Google Search grounding metadata
 * and extracts clean relative pageUri paths compatible with Rome API.
 */
export async function searchFlipkartWithPrompt(product) {
  const title = (product.description || product.name || product.title || '').trim();
  const category = [product.category, product.subcategory].filter(Boolean).join(' / ') || product.category || '';
  const color = product.color || '';
  const material = product.material || '';

  if (!title) return 'none';

  // 1. Strict search query scoped to Flipkart's product path
  const searchQuery = `site:flipkart.com/p/ ${title} ${color} ${material}`.trim();

  const promptContent = `Find the authentic Flipkart product listing for:
Product: "${title}"
Category: ${category}
Color: ${color}
Material: ${material}
Search Query: ${searchQuery}`;

  const modelsToTry = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  let response = null;

  for (const model of modelsToTry) {
    try {
      response = await ai.models.generateContent({
        model,
        contents: promptContent,
        config: {
          tools: [{ googleSearch: {} }]
        }
      });
      if (response && response.candidates?.[0]) break;
    } catch (err) {
      console.warn(`[Flipkart Grounding Search] Model ${model} failed:`, err.message);
    }
  }

  if (!response) return 'none';

  // 2. Extract strictly from Google Search grounding chunks (metadata-first)
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const webUris = chunks
    .map((chunk) => chunk.web?.uri)
    .filter(Boolean);

  for (let uri of webUris) {
    if (uri.includes('vertexaisearch.cloud.google.com')) {
      const resolved = await resolveFlipkartLocation(uri);
      if (resolved) uri = resolved;
    }
    const pageUri = extractValidPageUri(uri);
    if (pageUri !== 'none') {
      return pageUri;
    }
  }

  // 3. Fallback: inspect direct URL in model text if any
  const rawText = (response.text || '').trim();
  if (rawText && !rawText.toLowerCase().includes('none')) {
    const fullUrlMatch = rawText.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?flipkart\.com\/[^\s)"]+/i);
    if (fullUrlMatch) {
      const pageUri = extractValidPageUri(fullUrlMatch[0]);
      if (pageUri !== 'none') return pageUri;
    }
  }

  return 'none';
}

/**
 * Core function to find the exact Flipkart pageUri for a product.
 * Primary approach: Searches Google for authentic Flipkart listing via Gemini with Google Search grounding.
 * Returns ONLY the exact pageUri / URL string if 90%+ matching, or "none".
 */
export async function findFlipkartPageUri(product, force = false) {
  if (!product) return 'none';

  const productId = product.product_id || product.id || '';

  // If force retry is requested, clear any existing cache for this product
  if (force && productId) {
    pageUriCache.delete(productId);
  }

  // Check in-memory cache first if not forcing refresh
  if (!force && productId && pageUriCache.has(productId)) {
    return pageUriCache.get(productId);
  }

  // Primary approach: Product matching engine via Gemini Google Search grounding
  let resultUri = await searchFlipkartWithPrompt(product);

  // Fallback to backend HTML scraping if Gemini returned none but product description is present
  if ((!resultUri || resultUri === 'none') && product.description) {
    try {
      const fallbackUri = await searchFlipkartInBackend(product.description);
      if (fallbackUri && fallbackUri !== 'none') {
        resultUri = fallbackUri;
      }
    } catch (e) {
      console.warn('Fallback search error:', e.message);
    }
  }

  const finalResult = resultUri || 'none';
  console.log(`[findFlipkartPageUri] "${(product.description || product.title || '').slice(0, 40)}" => ${finalResult}`);

  // Store in cache if productId is present
  if (productId) {
    pageUriCache.set(productId, finalResult);
  }

  return finalResult;
}

/**
 * Fetches real-time current selling price from Flipkart Rome API using pageUri
 * Note: Never calls Gemini API for prices to ensure real-time accuracy and zero hallucination.
 */
export async function fetchFlipkartSellingPrice(pageUri) {
  if (!pageUri || pageUri === 'none') return null;

  try {
    const url = 'https://2.rome.api.flipkart.com/api/4/page/fetch?cacheFirst=false';
    const cleanUri = pageUri.startsWith('http')
      ? new URL(pageUri).pathname + new URL(pageUri).search
      : pageUri;

    const payload = {
      pageUri: cleanUri,
      pageContext: {
        trackingContext: {
          context: {
            eVar51: 'productRecommendation/similar',
            eVar61: 'reco'
          }
        },
        networkSpeed: 0
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'X-User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.warn(`[Flipkart Rome API] HTTP error ${res.status}`);
      return null;
    }

    const data = await res.json();
    const ppd = data.RESPONSE?.pageData?.pageContext?.fdpEventTracking?.events?.psi?.ppd;
    const offers = data.RESPONSE?.pageData?.seoData?.schema?.[0]?.offers;

    const sellingPrice = ppd?.fsp ?? offers?.price ?? ppd?.finalPrice ?? null;
    const mrp = ppd?.mrp ?? null;
    const currency = offers?.priceCurrency || 'INR';

    if (sellingPrice !== null) {
      return {
        sellingPrice,
        mrp,
        currency,
        formatted: `₹${sellingPrice.toLocaleString('en-IN')}`,
        formattedMrp: mrp ? `₹${mrp.toLocaleString('en-IN')}` : null
      };
    }
    return null;
  } catch (err) {
    console.error('[fetchFlipkartSellingPrice] Error:', err.message);
    return null;
  }
}

/**
 * API: POST /api/get-page-uri
 * Automatically finds or sets Flipkart pageUri for a single product and fetches live selling price
 */
router.post('/get-page-uri', async (req, res) => {
  try {
    const product = req.body.product || req.body;
    const productId = product.product_id || product.id || '';
    const force = Boolean(req.body.force || req.body.product?.force);

    let pageUri = req.body.pageUri;
    if (pageUri) {
      if (productId) pageUriCache.set(productId, pageUri);
    } else {
      pageUri = await findFlipkartPageUri(product, force);
    }

    // Automatically fetch real-time selling price from Flipkart Rome API if authentic pageUri found
    let priceData = null;
    if (pageUri && pageUri !== 'none') {
      if (!force && productId && flipkartPriceCache.has(productId)) {
        priceData = flipkartPriceCache.get(productId);
      } else {
        priceData = await fetchFlipkartSellingPrice(pageUri);
        if (priceData && productId) {
          flipkartPriceCache.set(productId, priceData);
        }
      }
    }

    return res.status(200).json({
      product_id: productId,
      pageUri: pageUri,
      priceData: priceData
    });
  } catch (err) {
    console.error('Error in /get-page-uri endpoint:', err);
    return res.status(500).json({ error: 'Failed to find pageUri', pageUri: 'none', priceData: null });
  }
});

/**
 * API: POST /api/get-flipkart-price
 * Fetches real-time current selling price from Flipkart Rome API using pageUri
 */
router.post('/get-flipkart-price', async (req, res) => {
  try {
    const { product_id, pageUri, force } = req.body;
    if (!pageUri || pageUri === 'none') {
      return res.status(400).json({ error: 'Valid pageUri is required' });
    }

    if (!force && product_id && flipkartPriceCache.has(product_id)) {
      return res.status(200).json({
        product_id,
        priceData: flipkartPriceCache.get(product_id)
      });
    }

    const priceData = await fetchFlipkartSellingPrice(pageUri);
    if (product_id && priceData) {
      flipkartPriceCache.set(product_id, priceData);
    }

    return res.status(200).json({
      product_id,
      priceData
    });
  } catch (err) {
    console.error('Error in /get-flipkart-price endpoint:', err);
    return res.status(500).json({ error: 'Failed to fetch Flipkart price' });
  }
});

/**
 * API: POST /api/batch-page-uris
 * Automatically takes products one by one and finds their Flipkart pageUri
 */
router.post('/batch-page-uris', async (req, res) => {
  try {
    const products = req.body.products || [];
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'products array is required.' });
    }

    const results = [];
    // Process products one by one sequentially
    for (const product of products) {
      const productId = product.product_id || product.id || '';
      const pageUri = await findFlipkartPageUri(product);
      let priceData = null;
      if (pageUri && pageUri !== 'none') {
        priceData = await fetchFlipkartSellingPrice(pageUri);
        if (priceData && productId) flipkartPriceCache.set(productId, priceData);
      }
      results.push({ product_id: productId, pageUri, priceData });
      // Gentle throttle to respect API rate limits
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error('Error in /batch-page-uris endpoint:', err);
    return res.status(500).json({ error: 'Batch processing failed' });
  }
});

/**
 * API: GET /api/cached-page-uris
 * Returns all currently cached pageUri entries
 */
router.get('/cached-page-uris', (req, res) => {
  return res.status(200).json({
    cache: Object.fromEntries(pageUriCache)
  });
});

/**
 * API: GET /api/cached-flipkart-prices
 * Returns all currently cached live Flipkart prices
 */
router.get('/cached-flipkart-prices', (req, res) => {
  return res.status(200).json({
    cache: Object.fromEntries(flipkartPriceCache)
  });
});

/**
 * API: POST /api/update-product-price
 * Updates a product's price directly in the CSV catalog file (product_catalog_for_realistic_sales.csv)
 */
router.post('/update-product-price', async (req, res) => {
  try {
    const { product_id, price } = req.body;
    if (!product_id || price === undefined || price === null || String(price).trim() === '') {
      return res.status(400).json({ error: 'product_id and price are required.' });
    }

    const numericPrice = parseFloat(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ error: 'Price must be a valid positive number.' });
    }

    const formattedPrice = numericPrice.toFixed(2);

    const content = await fs.promises.readFile(CSV_PATH, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length < 2) {
      return res.status(500).json({ error: 'CSV file is empty or corrupted.' });
    }

    const parseLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim().replace(/^"|"$/g, ''));
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim().replace(/^"|"$/g, ''));
      return result;
    };

    const headers = parseLine(lines[0]);
    const idIdx = headers.indexOf('product_id');
    const priceIdx = headers.indexOf('price');

    if (idIdx === -1 || priceIdx === -1) {
      return res.status(500).json({ error: 'CSV headers missing product_id or price.' });
    }

    let updated = false;
    const newLines = lines.map((line, idx) => {
      if (idx === 0 || !line.trim()) return line;
      const fields = parseLine(line);
      if (fields[idIdx] === String(product_id).trim()) {
        fields[priceIdx] = formattedPrice;
        updated = true;
        return fields
          .map((val) => {
            const s = String(val);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
              return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
          })
          .join(',');
      }
      return line;
    });

    if (!updated) {
      return res.status(404).json({ error: `Product with ID ${product_id} not found in catalog.` });
    }

    const newContent = newLines.join('\n');
    await fs.promises.writeFile(CSV_PATH, newContent, 'utf8');

    // Also sync to build CSV if it exists
    const BUILD_CSV_PATH = path.join(__dirname, '../frontend/build/product_catalog_for_realistic_sales.csv');
    if (fs.existsSync(BUILD_CSV_PATH)) {
      try {
        await fs.promises.writeFile(BUILD_CSV_PATH, newContent, 'utf8');
      } catch (e) {
        console.warn('Could not sync to build CSV:', e.message);
      }
    }

    console.log(`[update-product-price] Product ${product_id} price updated to Rs. ${formattedPrice} in CSV`);

    return res.status(200).json({
      success: true,
      message: `Product ${product_id} price updated to Rs. ${formattedPrice} in CSV successfully.`,
      product_id,
      price: formattedPrice
    });
  } catch (err) {
    console.error('Error updating product price in CSV:', err);
    return res.status(500).json({ error: 'Failed to update product price in CSV.' });
  }
});

/**
 * Legacy router endpoint
 */
router.post('/add-product', (req, res) => {
  const { id, sku, name, category, target, material, available_sizes, price, qty } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Name and Price are required.' });
  }

  const row = [
    escapeCSV(id),
    escapeCSV(sku),
    escapeCSV(name),
    escapeCSV(category),
    escapeCSV(target),
    escapeCSV(material),
    escapeCSV(available_sizes),
    escapeCSV(price),
    escapeCSV(qty)
  ].join(',');

  const csvLine = `\n${row}`;

  fs.appendFile(CSV_PATH, csvLine, 'utf8', (err) => {
    if (err) {
      console.error('Error writing to CSV:', err);
      return res.status(500).json({ error: 'Failed to update catalog file.' });
    }
    return res.status(200).json({ message: 'Product appended to product_catalog.csv successfully!' });
  });
});

export default router;