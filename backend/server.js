import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { indexSingleProduct } from './index.js';
import updateRouter from './update.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'campaign.db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/api', updateRouter);

// Path to CSV Catalog
const CSV_PATH = path.join(__dirname, '../frontend/public/product_catalog_for_realistic_sales.csv');

// Utility to escape quotes in CSV entries
const escapeCSV = (val) => {
  if (val === undefined || val === null) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
};

// Credentials
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_ID';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'YOUR_KEY_SECRET';

// Initialize AI & Vector Search
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper to safely extract 768-dimensional embeddings
async function get768Embedding(text) {
  try {
    const res = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
      config: {
        outputDimensionality: 768,
      },
    });

    const vector = res.embedding?.values || res.embeddings?.[0]?.values;
    if (vector) return vector;

    throw new Error('Embedding values missing in response');
  } catch (err) {
    // Fallback: request without dimensional config and slice down to 768 manually
    const res = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
    });

    const vector = res.embedding?.values || res.embeddings?.[0]?.values;
    if (!vector) {
      throw new Error(`Failed to generate embedding: ${err.message}`);
    }
    return vector.slice(0, 768);
  }
}

// Helper to handle API 503 high-demand and 429 rate limit errors gracefully with automatic model fallback
async function generateContentWithFallback(params) {
  const preferredModel = params.model || 'gemini-3.1-flash-lite';
  const modelsToTry = [
    preferredModel,
    'gemini-3.1-flash-lite',
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-1.5-flash',
  ];
  const uniqueModels = [...new Set(modelsToTry.filter(Boolean))];
  
  let lastError = null;
  for (const modelName of uniqueModels) {
    try {
      return await ai.models.generateContent({
        ...params,
        model: modelName,
      });
    } catch (error) {
      lastError = error;
      if (error.status === 503 || error.code === 503 || error.status === 429 || error.code === 429) {
        console.warn(`[API Warning] Model ${modelName} returned ${error.status || error.code}. Retrying with next fallback model...`);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('All model fallbacks failed.');
}

// 1. Health Check Route
app.get('/', (req, res) => {
  res.send('Server is up and running!');
});

// 2. Add Product to CSV & Auto-Index to Pinecone Route
app.post('/api/add-product', async (req, res) => {
  const { product_id, category, subcategory, color, material, description, price } = req.body;

  if (!product_id || !price) {
    return res.status(400).json({ error: 'product_id and price are required.' });
  }

  const newProduct = { product_id, category, subcategory, color, material, description: description || '', price };

  const row = [
    escapeCSV(product_id),
    escapeCSV(category),
    escapeCSV(subcategory),
    escapeCSV(color),
    escapeCSV(material),
    escapeCSV(description || ''),
    escapeCSV(price),
  ].join(',');

  const csvLine = `\n${row}`;

  // Step A: Append row to local CSV file
  fs.appendFile(CSV_PATH, csvLine, 'utf8', async (err) => {
    if (err) {
      console.error('Error writing to CSV file:', err);
      return res.status(500).json({ error: 'Failed to update catalog file.' });
    }

    // Step B: Automatically generate embedding & upsert to Pinecone
    try {
      await indexSingleProduct(newProduct);
      return res.status(200).json({
        message: 'Product appended to CSV catalog and indexed to Pinecone successfully!'
      });
    } catch (indexErr) {
      console.error('Error indexing product to Pinecone:', indexErr);
      return res.status(200).json({
        message: 'Product appended to CSV, but auto-indexing to Pinecone failed.'
      });
    }
  });
});

// 3. Robust Chat API Route
// 3. Robust Chat API Route with Agentic Intent Detection & Multi-Turn Conversation
app.post('/api/chat', async (req, res) => {
  try {
    const { question, user, history = [], lastProducts = [], currentCart = [] } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const cleanQuestion = question.trim();
    const lowerQuestion = cleanQuestion.toLowerCase();
    const catalogMap = await getCatalogMap();

    // 1. Check for Agentic Add to Cart Intent
    const isAddToCart =
      /(add\s+(to\s+cart|to\s+my\s+cart|it|this|product|item)|buy\s+product\s+\d+|add\s+\d+)/i.test(lowerQuestion) ||
      (lowerQuestion.startsWith('add') && !lowerQuestion.includes('what'));

    if (isAddToCart) {
      let targetProduct = null;
      let targetIndex = null;

      // Check for index mention e.g. "product 1", "product 2", "item 1", "first", "second", "1"
      const numMatch = lowerQuestion.match(/(?:product|item|#)?\s*(\d+)/i);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1; // 1-indexed to 0-indexed
        if (Array.isArray(lastProducts) && lastProducts[idx]) {
          targetProduct = lastProducts[idx];
          targetIndex = idx + 1;
        }
      } else if (lowerQuestion.includes('first') || lowerQuestion.includes('1st')) {
        if (Array.isArray(lastProducts) && lastProducts[0]) {
          targetProduct = lastProducts[0];
          targetIndex = 1;
        }
      } else if (lowerQuestion.includes('second') || lowerQuestion.includes('2nd')) {
        if (Array.isArray(lastProducts) && lastProducts[1]) {
          targetProduct = lastProducts[1];
          targetIndex = 2;
        }
      } else if (lowerQuestion.includes('third') || lowerQuestion.includes('3rd')) {
        if (Array.isArray(lastProducts) && lastProducts[2]) {
          targetProduct = lastProducts[2];
          targetIndex = 3;
        }
      }

      // Check for Product ID mention e.g. "P00001", "P00009"
      const pidMatch = lowerQuestion.match(/\b(p\d{5})\b/i);
      if (!targetProduct && pidMatch) {
        const foundPid = pidMatch[1].toUpperCase();
        targetProduct = (lastProducts || []).find(
          (p) => String(p.product_id || p.id).toUpperCase() === foundPid
        );
        if (!targetProduct && catalogMap.has(foundPid)) {
          const entry = catalogMap.get(foundPid);
          targetProduct = {
            product_id: entry.product_id,
            id: entry.product_id,
            title: entry.description || `${entry.color} ${entry.subcategory}`,
            price: entry.price.toFixed(2),
            category: entry.category,
            subcategory: entry.subcategory,
            color: entry.color,
            material: entry.material,
          };
        }
      }

      // Fallback: If no specific product found but lastProducts exists, select first product
      if (!targetProduct && Array.isArray(lastProducts) && lastProducts.length > 0) {
        targetProduct = lastProducts[0];
        targetIndex = 1;
      }

      if (targetProduct) {
        const cleanPid = String(targetProduct.product_id || targetProduct.id || '').replace(/^prod_/, '');
        const pTitle = targetProduct.title || targetProduct.name || `Product ${cleanPid}`;
        const reply = `✅ Added **${pTitle}**${targetIndex ? ` (Product #${targetIndex})` : ''} to your cart! 🛍️ Would you like to keep browsing or checkout now?`;

        return res.json({
          action: 'add_to_cart',
          product_to_add: {
            ...targetProduct,
            id: cleanPid,
            product_id: cleanPid,
            title: pTitle,
            price: targetProduct.price ? String(targetProduct.price) : '50.00',
          },
          reply,
          category: targetProduct.category || '',
          subcategory: targetProduct.subcategory || '',
          products: [],
        });
      } else {
        return res.json({
          action: 'add_to_cart_failed',
          product_to_add: null,
          reply: `I couldn't identify which product you'd like to add to your cart. Please ask for a product first (e.g., "Show me formal shirts") or click the "Add to Cart" button directly on the product card!`,
          category: '',
          subcategory: '',
          products: [],
        });
      }
    }

    // 2. Check for Agentic Checkout Intent
    const isCheckout =
      /^(buy\s+now|checkout|proceed\s+to\s+checkout|place\s+order|pay\s+now|order\s+now)$/i.test(lowerQuestion) ||
      /\b(buy\s+now|checkout\s+cart|proceed\s+to\s+payment)\b/i.test(lowerQuestion);

    if (isCheckout) {
      let checkoutUpsells = {};
      try {
        if (Array.isArray(currentCart) && currentCart.length > 0) {
          checkoutUpsells = await generateCartUpsells(currentCart);
        }
      } catch (upErr) {
        console.error('Error generating checkout upsells in /api/chat:', upErr);
      }

      const hasUpsell = Object.values(checkoutUpsells).some((u) => u !== null && u !== undefined);
      const reply = hasUpsell
        ? `🛒 Ready to checkout! Here is your cart summary. Review your items and recommended product upgrades below:`
        : `🛒 Ready to checkout! Click the button below to review your items and complete payment securely via Razorpay.`;

      return res.json({
        action: 'checkout',
        reply,
        upsells: checkoutUpsells,
        category: '',
        subcategory: '',
        products: [],
      });
    }

    // 2b. Check for Agentic Cart Upgrade Intent (e.g. "upgrade", "upgrade product", "upgrade to recommended")
    const isUpgrade =
      /^(upgrade|upgrade\s+product|upgrade\s+to\s+recommended|upgrade\s+cart|upgrade\s+item)/i.test(lowerQuestion);
    if (isUpgrade && Array.isArray(currentCart) && currentCart.length > 0) {
      try {
        const checkoutUpsells = await generateCartUpsells(currentCart);
        for (const cItem of currentCart) {
          const cleanId = String(cItem.id || cItem.product_id || '').replace(/^prod_/, '');
          const up = checkoutUpsells[cItem.id] || checkoutUpsells[cleanId] || checkoutUpsells[`prod_${cleanId}`];
          if (up) {
            return res.json({
              action: 'upgrade_cart_item',
              old_item_id: cItem.id,
              upgraded_product: up,
              reply: `✨ Upgraded **${cItem.title || cItem.name}** to **${up.title}** (+₹${up.price_difference.toFixed(2)})! 🛍️ Click below to complete checkout.`,
              category: up.category || '',
              subcategory: up.subcategory || '',
              products: [],
            });
          }
        }
      } catch (upErr) {
        console.error('Error processing upgrade intent in /api/chat:', upErr);
      }
    }

    // 3. Search / Recommendation with Multi-Turn Refinement
    let searchQuery = cleanQuestion;
    if (Array.isArray(history) && history.length > 0) {
      const lastUserMsg = [...history].reverse().find((m) => m.sender === 'user');
      if (
        lastUserMsg &&
        /(in\s+|with\s+|give\s+|show\s+|only\s+)?(green|blue|red|white|black|corduroy|linen|cotton|silk|cheaper|expensive|formal|casual|olive)/i.test(
          lowerQuestion
        )
      ) {
        if (
          !lowerQuestion.includes('shirt') &&
          !lowerQuestion.includes('pant') &&
          !lowerQuestion.includes('jeans') &&
          !lowerQuestion.includes('kurta') &&
          !lowerQuestion.includes('t-shirt')
        ) {
          searchQuery = `${lastUserMsg.text} ${cleanQuestion}`;
        }
      }
    }

    const queryVector = await get768Embedding(searchQuery);

    const searchResults = await pineconeIndex.query({
      topK: 10,
      vector: queryVector,
      includeMetadata: true,
    });

    const context = searchResults.matches
      .map((match) => {
        const actualProductId = match.metadata?.product_id || String(match.id).replace(/^prod_/, '');
        const meta = { ...match.metadata, product_id: actualProductId };
        return `Product ID: ${actualProductId} | Metadata: ${JSON.stringify(meta)}`;
      })
      .join('\n\n---\n\n');

    const userProfile = user ? `User Profile: ${user.name}` : '';

    const recentHistoryText = (history || [])
      .slice(-4)
      .map((m) => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n');

    const systemPrompt = `You are a friendly, expert shopping assistant.
Analyze the user's question, conversation history, and the catalog Context below to recommend matching products.

CONVERSATION HISTORY:
${recentHistoryText || 'None'}

INSTRUCTIONS:
1. Provide a warm, helpful 1-2 sentence conversational "reply" addressing the user's request (e.g., "Here are our top formal shirts crafted from premium cotton and linen fabrics for you:").
2. Select up to 4 of the most relevant products from the Context below.
3. Extract the exact catalog "category" and "subcategory" from the Context metadata.
4. For each product, "product_id" and "id" MUST strictly be the authentic catalog product ID (e.g. "P00001", "P00009") without any "prod_" prefix.

Return a JSON object matching this exact schema:
{
  "reply": "Conversational assistant response string",
  "category": "String matching catalog metadata category",
  "subcategory": "String matching catalog metadata subcategory",
  "products": [
    {
      "product_id": "string (e.g. P00001)",
      "id": "string (e.g. P00001)",
      "title": "string",
      "price": "string",
      "sku": "string",
      "description": "string",
      "material": "string",
      "color": "string",
      "sizes": "string"
    }
  ]
}

${userProfile}

Context:
${context}`;

    const response = await generateContentWithFallback({
      model: 'gemini-3.1-flash-lite',
      contents: `${systemPrompt}\n\nUser Question: ${cleanQuestion}`,
      config: {
        responseMimeType: 'application/json',
      },
    });

    let responseData = { reply: '', category: '', subcategory: '', products: [] };
    try {
      responseData = JSON.parse(response.text.trim());
    } catch (e) {
      console.error('JSON Parse error in /api/chat:', response.text);
    }

    // Direct Metadata Fallback
    if (searchResults.matches && searchResults.matches.length > 0) {
      const topMeta = searchResults.matches[0].metadata || {};
      const fallbackCat = topMeta.category || topMeta.Category || '';
      const fallbackSubcat = topMeta.subcategory || topMeta.Subcategory || topMeta.target || fallbackCat;

      if (!responseData.category) responseData.category = fallbackCat;
      if (!responseData.subcategory) responseData.subcategory = fallbackSubcat;
    }

    console.log('\n--- Gemini Classification Output ---');
    console.log(`Question: "${cleanQuestion}"`);
    console.log(`Category: "${responseData.category}"`);
    console.log(`Subcategory: "${responseData.subcategory}"`);
    console.log(`Matched Items Count: ${responseData.products ? responseData.products.length : 0}`);
    console.log('-------------------------------------\n');

    const enrichedProducts = (Array.isArray(responseData.products) ? responseData.products : []).map((p) => {
      const cleanProductId = String(p.product_id || p.id || '').trim().replace(/^prod_/, '');
      const catItem = catalogMap.get(cleanProductId);
      return {
        ...p,
        id: cleanProductId,
        product_id: cleanProductId,
        title: p.title || catItem?.description || `${catItem?.color || ''} ${catItem?.subcategory || ''}`.trim(),
        price: p.price || (catItem ? catItem.price.toFixed(2) : '50.00'),
        color: p.color || catItem?.color || '',
        material: p.material || catItem?.material || '',
        category: p.category || responseData.category || catItem?.category || '',
        subcategory: p.subcategory || responseData.subcategory || catItem?.subcategory || '',
      };
    });

    const reply =
      responseData.reply ||
      (enrichedProducts.length > 0
        ? `Here are some recommendations I found for "${cleanQuestion}":`
        : `I couldn't find any direct matches in that style, but feel free to ask for other styles like formal shirts, jeans, or traditional wear!`);

    return res.json({
      action: 'search',
      reply,
      category: responseData.category || '',
      subcategory: responseData.subcategory || '',
      products: enrichedProducts,
    });
  } catch (error) {
    console.error('Error handling chat request:', error);
    return res.status(500).json({ error: 'Failed to generate response' });
  }
});

// 4. Razorpay Order Creation Route
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt = 'receipt_1' } = req.body;

    const authHeader =
      'Basic ' +
      Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({
        amount: Math.round(parseFloat(amount) * 100),
        currency,
        receipt,
      }),
    });

    const orderData = await response.json();

    if (!response.ok) {
      console.error('Razorpay API Error:', orderData);
      return res.status(response.status).json(orderData);
    }

    return res.json(orderData);
  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// 5. Demanded Category Extraction Route
app.post('/api/get-demanded-category', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const queryVector = await get768Embedding(question);

    const searchResults = await pineconeIndex.query({
      topK: 5,
      vector: queryVector,
      includeMetadata: true,
    });

    const matchedMetadata = searchResults.matches
      .map((match) => JSON.stringify(match.metadata))
      .join('\n');

    const prompt = `You are analyzing a customer query for a clothing merchant.
Customer Query: "${question}"

Retrieved Pinecone Catalog Items (Metadata):
${matchedMetadata}

Based ONLY on the retrieved catalog items above, determine the exact "category" and "subcategory" of the product the customer is asking for.

Return a JSON object matching this structure:
{
  "category": "Exact category string from metadata",
  "subcategory": "Exact subcategory string from metadata"
}`;

    const response = await generateContentWithFallback({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    let result = { category: null, subcategory: null };
    try {
      result = JSON.parse(response.text.trim());
    } catch (e) {
      console.error('Pinecone Category JSON parse error:', response.text);
    }

    if ((!result.category || !result.subcategory) && searchResults.matches.length > 0) {
      const topMeta = searchResults.matches[0].metadata || {};
      result.category = result.category || topMeta.category || topMeta.Category || '';
      result.subcategory = result.subcategory || topMeta.subcategory || topMeta.Subcategory || topMeta.category || '';
    }

    console.log('\n--- DEMANDED PRODUCT IDENTIFIED ---');
    console.log(`Question: "${question}"`);
    console.log(`Category: ${result.category}`);
    console.log(`Subcategory: ${result.subcategory}`);
    console.log('-----------------------------------\n');

    return res.json(result);
  } catch (error) {
    console.error('Error in get-demanded-category endpoint:', error);
    return res.status(500).json({ error: 'Failed to extract category from Pinecone vectors.' });
  }
});

// Helper to parse CSV lines
function parseCSVLine(line) {
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
}

// Load CSV catalog lookup map
async function getCatalogMap() {
  try {
    const content = await fs.promises.readFile(CSV_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return new Map();
    const headers = parseCSVLine(lines[0]);
    const idIdx = headers.indexOf('product_id');
    const catIdx = headers.indexOf('category');
    const subcatIdx = headers.indexOf('subcategory');
    const colIdx = headers.indexOf('color');
    const matIdx = headers.indexOf('material');
    const descIdx = headers.indexOf('description');
    const priceIdx = headers.indexOf('price');

    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const rawId = cols[idIdx];
      if (rawId) {
        const cleanId = String(rawId).trim().replace(/^prod_/, '');
        const entry = {
          product_id: cleanId,
          category: cols[catIdx] || '',
          subcategory: cols[subcatIdx] || '',
          color: cols[colIdx] || '',
          material: cols[matIdx] || '',
          description: cols[descIdx] || '',
          price: parseFloat(cols[priceIdx]) || 0,
        };
        map.set(cleanId, entry);
        map.set(`prod_${cleanId}`, entry);
        map.set(String(rawId).trim(), entry);
      }
    }
    return map;
  } catch (err) {
    console.error('Error reading catalog map from CSV:', err);
    return new Map();
  }
}

// Helper to generate intelligent cart upsell recommendations
async function generateCartUpsells(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {};
  }

  const catalogMap = await getCatalogMap();
  const upsells = {};

  for (const item of items) {
    const itemId = String(item.id || item.product_id || '').trim();
    if (!itemId) continue;

    const cleanId = itemId.replace(/^prod_/, '');
    let catalogEntry = catalogMap.get(itemId) || catalogMap.get(cleanId) || catalogMap.get(`prod_${cleanId}`);

    // Fallback matching by title / description if direct ID not found
    if (!catalogEntry && (item.title || item.name)) {
      const searchTitle = (item.title || item.name || '').trim().toLowerCase();
      for (const [_, entry] of catalogMap.entries()) {
        if (
          entry.description.toLowerCase().includes(searchTitle) ||
          searchTitle.includes(entry.subcategory.toLowerCase()) ||
          searchTitle.includes(entry.description.toLowerCase())
        ) {
          catalogEntry = entry;
          break;
        }
      }
    }

    const category = catalogEntry?.category || item.category || '';
    const subcategory = catalogEntry?.subcategory || item.subcategory || '';
    const color = catalogEntry?.color || item.color || '';
    const material = catalogEntry?.material || item.material || '';
    const description = catalogEntry?.description || item.description || item.title || item.name || '';

    const rawPrice = catalogEntry?.price ?? item.price;
    const currentPrice = typeof rawPrice === 'number'
      ? rawPrice
      : parseFloat(String(rawPrice || '0').replace(/[^0-9.]/g, '')) || 0;

    let resolvedCategory = category;
    let resolvedSubcategory = subcategory;
    let resolvedMaterial = material;
    let resolvedColor = color;
    let resolvedTitle = description;

    // If category or subcategory is missing, try Pinecone fetch by ID to discover metadata
    if (!resolvedCategory || !resolvedSubcategory) {
      try {
        const fetchRes = await pineconeIndex.fetch({ ids: [itemId, cleanId, `prod_${cleanId}`] });
        const record = fetchRes.records?.[itemId] || fetchRes.records?.[`prod_${cleanId}`] || fetchRes.records?.[cleanId];
        if (record?.metadata) {
          resolvedCategory = resolvedCategory || record.metadata.category || '';
          resolvedSubcategory = resolvedSubcategory || record.metadata.subcategory || '';
          resolvedColor = resolvedColor || record.metadata.color || '';
          resolvedMaterial = resolvedMaterial || record.metadata.material || '';
          resolvedTitle = resolvedTitle || record.metadata.description || '';
        }
      } catch (fetchErr) {
        console.warn(`Pinecone fetch error for item ${itemId}:`, fetchErr.message);
      }
    }

    // If subcategory is known (e.g. "Casual Shirt") but category is missing, resolve category from catalog
    if (!resolvedCategory && resolvedSubcategory) {
      for (const [_, entry] of catalogMap.entries()) {
        if (entry.subcategory.toLowerCase() === resolvedSubcategory.toLowerCase()) {
          resolvedCategory = entry.category;
          break;
        }
      }
    }

    const setUpsell = (val) => {
      upsells[itemId] = val;
      if (cleanId) {
        upsells[cleanId] = val;
        upsells[`prod_${cleanId}`] = val;
      }
    };

    if (!resolvedCategory || !resolvedSubcategory) {
      console.warn(`[Upsell] Could not resolve category/subcategory for item ${itemId}`);
      setUpsell(null);
      continue;
    }

    // Query Pinecone for similar products in the exact same category and subcategory
    const queryText = `${resolvedTitle} ${resolvedSubcategory} ${resolvedCategory} ${resolvedMaterial} ${resolvedColor}`.trim();
    let candidates = [];

    try {
      const queryVector = await get768Embedding(queryText);
      const pineconeRes = await pineconeIndex.query({
        vector: queryVector,
        topK: 25,
        includeMetadata: true,
        filter: {
          category: { $eq: resolvedCategory },
          subcategory: { $eq: resolvedSubcategory },
        },
      });

      if (pineconeRes.matches && pineconeRes.matches.length > 0) {
        candidates = pineconeRes.matches
          .filter((m) => {
            const rawPid = m.metadata?.product_id || m.id || '';
            const cPid = rawPid.replace(/^prod_/, '');
            return cPid !== cleanId && m.id !== itemId;
          })
          .map((m) => {
            const rawPid = m.metadata?.product_id || m.id || '';
            const cPid = rawPid.replace(/^prod_/, '');
            const catItem = catalogMap.get(cPid) || catalogMap.get(rawPid);
            const pPrice = catItem?.price ?? parseFloat(m.metadata?.price || 0);
            return {
              product_id: cPid,
              title: catItem?.description || m.metadata?.description || `${m.metadata?.color || ''} ${m.metadata?.subcategory || ''}`.trim(),
              category: m.metadata?.category || resolvedCategory,
              subcategory: m.metadata?.subcategory || resolvedSubcategory,
              color: m.metadata?.color || catItem?.color || '',
              material: m.metadata?.material || catItem?.material || '',
              price: pPrice,
            };
          });
      }
    } catch (vectorErr) {
      console.error(`Pinecone query failed for item ${itemId}:`, vectorErr);
    }

    // If Pinecone returned no candidates, also check CSV catalog directly
    if (candidates.length === 0) {
      for (const [cId, cData] of catalogMap.entries()) {
        const cClean = cId.replace(/^prod_/, '');
        if (cClean !== cleanId && cData.category === resolvedCategory && cData.subcategory === resolvedSubcategory) {
          candidates.push({
            product_id: cClean,
            title: cData.description || `${cData.color} ${cData.subcategory}`,
            category: cData.category,
            subcategory: cData.subcategory,
            color: cData.color,
            material: cData.material,
            price: cData.price,
          });
        }
      }
    }

    // Deduplicate candidates by product_id
    const uniqueCandidateMap = new Map();
    for (const c of candidates) {
      const cKey = c.product_id.replace(/^prod_/, '');
      if (!uniqueCandidateMap.has(cKey)) {
        uniqueCandidateMap.set(cKey, { ...c, product_id: cKey });
      }
    }
    const uniqueCandidates = Array.from(uniqueCandidateMap.values());

    // Filter candidates with strictly higher price
    const higherCandidates = uniqueCandidates
      .filter((c) => c.category === resolvedCategory && c.subcategory === resolvedSubcategory && c.price > currentPrice)
      .sort((a, b) => a.price - b.price);

    // If current product is already the highest priced or no higher candidates exist
    if (higherCandidates.length === 0) {
      console.log(`[Upsell] Item ${itemId} (Rs. ${currentPrice.toFixed(2)}) is already highest priced or has no higher candidates in ${resolvedSubcategory}. Returning null.`);
      setUpsell(null);
      continue;
    }

    // Prepared fallback recommendation in case of Gemini quota issues
    const bestFallbackCandidate = higherCandidates[0];
    const deterministicFallback = {
      product_id: bestFallbackCandidate.product_id,
      title: bestFallbackCandidate.title,
      category: bestFallbackCandidate.category,
      subcategory: bestFallbackCandidate.subcategory,
      color: bestFallbackCandidate.color,
      material: bestFallbackCandidate.material,
      price: bestFallbackCandidate.price,
      price_difference: +(bestFallbackCandidate.price - currentPrice).toFixed(2),
      upsell_reason: `Premium ${bestFallbackCandidate.material ? bestFallbackCandidate.material + ' fabric' : 'upgrade'} offering enhanced comfort and quality.`,
    };

    // Prompt Gemini to select the ideal next-tier upsell and explain why
    const prompt = `You are an expert e-commerce upselling recommendation engine.
Customer currently has this product in their cart:
- ID: ${cleanId}
- Description: ${resolvedTitle}
- Category: ${resolvedCategory}
- Subcategory: ${resolvedSubcategory}
- Current Cart Price: Rs. ${currentPrice.toFixed(2)}
- Color: ${resolvedColor}
- Material: ${resolvedMaterial}

Candidate Products from Pinecone (Vector Catalog):
${JSON.stringify(uniqueCandidates, null, 2)}

UPSELLING RULES:
1. The recommended product MUST have the EXACT SAME category ("${resolvedCategory}") and subcategory ("${resolvedSubcategory}").
2. The recommended product MUST have a price strictly HIGHER than the cart product's price (Rs. ${currentPrice.toFixed(2)}).
3. The recommended product MUST be the NEXT HIGHER priced product (closest incremental upgrade, not an absurdly huge price jump) among the candidates.
4. If the cart product is ALREADY the highest-priced item in this subcategory, or if NO candidate product has a higher price, return null for "recommended_product" and false for "has_upsell".
5. If recommending a product, provide a concise, compelling "upsell_reason" (1 sentence) explaining why this upgrade is worth it (e.g. better fabric/material, superior finish, enhanced durability).

Return a JSON object matching this schema:
{
  "has_upsell": true | false,
  "recommended_product": {
    "product_id": "string",
    "title": "string",
    "category": "string",
    "subcategory": "string",
    "color": "string",
    "material": "string",
    "price": number,
    "price_difference": number,
    "upsell_reason": "string"
  } | null
}`;

    try {
      const aiResponse = await generateContentWithFallback({
        model: 'gemini-3.1-flash-lite',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = JSON.parse(aiResponse.text.trim());
      if (parsed.has_upsell && parsed.recommended_product && parsed.recommended_product.price > currentPrice) {
        const rec = parsed.recommended_product;
        rec.price_difference = +(rec.price - currentPrice).toFixed(2);
        setUpsell(rec);
      } else if (parsed.has_upsell === false || !parsed.recommended_product) {
        setUpsell(null);
      } else {
        setUpsell(deterministicFallback);
      }
    } catch (geminiErr) {
      console.warn(`[Upsell] Gemini call failed for item ${itemId}, using deterministic fallback:`, geminiErr.message);
      setUpsell(deterministicFallback);
    }
  }

  return upsells;
}

// 6. Cart Upselling Recommendation Route
app.post('/api/cart-upsell', async (req, res) => {
  try {
    const { items } = req.body;
    const upsells = await generateCartUpsells(items);
    return res.json({ upsells });
  } catch (error) {
    console.error('Error in /api/cart-upsell:', error);
    return res.status(500).json({ error: 'Failed to generate cart upsell recommendations' });
  }
});

// 7. Merchant Weekly Transaction Audit Trail Route
app.get('/api/audit-trail', async (req, res) => {
  try {
    const filter = req.query.filter || 'current_week';
    const now = new Date();

    let startDate;
    let endDate;

    if (filter === 'last_7_days') {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startDate = d.toISOString();
      endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    } else {
      // Current calendar week (Monday to Sunday)
      const dayOfWeek = now.getUTCDay();
      const diffToMonday = (dayOfWeek + 6) % 7;
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() - diffToMonday);
      monday.setUTCHours(0, 0, 0, 0);
      startDate = monday.toISOString();

      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      sunday.setUTCHours(23, 59, 59, 999);
      endDate = sunday.toISOString();
    }

    if (req.query.start_date) startDate = req.query.start_date;
    if (req.query.end_date) endDate = req.query.end_date;

    const safeStart = startDate.replace(/['"\\]/g, '');
    const safeEnd = endDate.replace(/['"\\]/g, '');

    const query = `
      SELECT ce.event_id, ce.customer_id, ce.event_time, ce.metadata, c.email as customer_email
      FROM campaign_events ce
      LEFT JOIN customers c ON ce.customer_id = c.customer_id
      WHERE ce.event_type = 'purchase'
        AND ce.event_time >= '${safeStart}'
        AND ce.event_time <= '${safeEnd}'
      ORDER BY ce.event_time DESC;
    `;

    const { stdout } = await execFileAsync('sqlite3', ['-json', DB_PATH, query]);
    const rawRows = stdout ? JSON.parse(stdout) : [];

    let totalRevenue = 0;
    let totalUnits = 0;
    const customerSet = new Set();

    const transactions = rawRows.map((row) => {
      let meta = {};
      try {
        meta = row.metadata ? JSON.parse(row.metadata) : {};
      } catch (e) {}

      const amount = typeof meta.amount === 'number' ? meta.amount : parseFloat(meta.amount || 0) || 0;
      totalRevenue += amount;
      customerSet.add(row.customer_id);

      const items = Array.isArray(meta.items) ? meta.items : [];
      const itemCount = items.reduce((acc, it) => acc + (parseInt(it.quantity, 10) || 1), 0);
      totalUnits += itemCount;

      return {
        event_id: row.event_id,
        transaction_id: meta.payment_id || `TXN_${row.event_id}`,
        payment_id: meta.payment_id || 'N/A',
        customer_id: row.customer_id,
        customer_email: meta.email || row.customer_email || `${row.customer_id.toLowerCase()}@example.com`,
        customer_name: meta.customer_name || row.customer_id,
        segment: meta.segment || 'Customer',
        discount_percent: meta.discount_percent || 0,
        amount: +amount.toFixed(2),
        items_count: itemCount,
        items: items.map((it) => ({
          product_id: String(it.product_id || it.id || ''),
          title: it.title || it.name || it.description || 'Product',
          price: it.price || 0,
          quantity: it.quantity || 1,
          color: it.color || '',
          material: it.material || '',
          category: it.category || '',
          subcategory: it.subcategory || '',
        })),
        timestamp: row.event_time,
        status: 'PAID',
        payment_gateway: 'Razorpay',
      };
    });

    return res.json({
      timeframe: filter,
      start_date: startDate,
      end_date: endDate,
      total_transactions: transactions.length,
      total_revenue: +totalRevenue.toFixed(2),
      total_units: totalUnits,
      unique_customers: customerSet.size,
      transactions,
    });
  } catch (error) {
    console.error('Error in /api/audit-trail:', error);
    return res.status(500).json({ error: 'Failed to fetch audit trail transactions' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});