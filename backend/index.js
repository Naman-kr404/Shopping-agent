import * as dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { Pinecone } from '@pinecone-database/pinecone';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to your CSV Catalog
const CSV_PATH = path.join(__dirname, '../frontend/public/product_catalog_for_realistic_sales.csv');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GEMINI_API_KEY,
  modelName: 'gemini-embedding-001',
  outputDimensionality: 768,
  dimensions: 768,
});

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);

/**
 * Helper to split CSV lines while correctly respecting quoted values
 */
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

/**
 * Embed single text with rate-limit (429) retry logic
 */
async function embedSingleWithRetry(text, retries = 5, delay = 15000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await embeddings.embedQuery(text);
    } catch (error) {
      const isRateLimit = error?.status === 429 || error?.message?.includes('429');
      if (isRateLimit && attempt < retries) {
        console.warn(`Rate limit hit (429). Waiting ${delay / 1000}s before retry ${attempt}/${retries}...`);
        await sleep(delay);
        delay *= 1.5;
      } else {
        throw error;
      }
    }
  }
}

/**
 * Helper to generate vector embedding and upsert a single product into Pinecone immediately
 * Uses exact CSV columns: product_id, category, subcategory, color, material, price
 */
export async function indexSingleProduct(product) {
  const productId = product.product_id || product.id;
  const subcat = product.subcategory || '';
  const cat = product.category || '';
  const color = product.color || '';
  const mat = product.material || '';
  const desc = product.description || '';
  const price = product.price || '';

  const formattedText = `Product ID: ${productId} | Category: ${cat} | Subcategory: ${subcat} | Color: ${color} | Material: ${mat} | Description: ${desc} | Price: Rs. ${price}`;

  let vector = await embedSingleWithRetry(formattedText);
  if (vector && vector.length > 768) {
    vector = vector.slice(0, 768);
  }

  const record = {
    id: `prod_${productId}`,
    values: vector,
    metadata: {
      product_id: productId,
      id: productId,
      category: cat,
      subcategory: subcat,
      color: color,
      material: mat,
      description: desc,
      price: String(price),
      text: formattedText,
    },
  };

  await pineconeIndex.upsert({ records: [record] });
  console.log(`Product ID ${productId} (${subcat}) indexed to Pinecone successfully.`);
}

/**
 * Bulk index entire 400-product catalog CSV file into Pinecone
 */
async function indexDocuments() {
  // Check fallback path if primary path does not exist
  let targetCsvPath = CSV_PATH;
  if (!fs.existsSync(targetCsvPath)) {
    targetCsvPath = path.join(__dirname, './product_catalog_for_realistic_sales.csv');
  }

  if (!fs.existsSync(targetCsvPath)) {
    console.error(`CSV File not found at ${targetCsvPath}`);
    return;
  }

  const fileText = fs.readFileSync(targetCsvPath, 'utf8');
  const lines = fileText.trim().split(/\r?\n/);
  if (lines.length < 2) return;

  const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());

  const records = [];
  const BATCH_SIZE = 5; // Embedded in small batches to respect Gemini rate limits

  const products = lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] || '';
    });
    return row;
  });

  console.log(`Loaded ${products.length} product rows from CSV catalog.`);

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);

    for (const item of batch) {
      const productId = item.product_id || item.id;
      const formattedText = `Product ID: ${productId} | Category: ${item.category} | Subcategory: ${item.subcategory} | Color: ${item.color} | Material: ${item.material} | Description: ${item.description || ''} | Price: Rs. ${item.price}`;

      let vector = await embedSingleWithRetry(formattedText);
      if (vector && vector.length > 0) {
        if (vector.length > 768) {
          vector = vector.slice(0, 768);
        }

        records.push({
          id: `prod_${productId}`,
          values: vector,
          metadata: {
            product_id: productId,
            id: productId,
            category: item.category,
            subcategory: item.subcategory,
            color: item.color,
            material: item.material,
            description: item.description || '',
            price: String(item.price),
            text: formattedText,
          },
        });
      }
    }

    console.log(`Embedded ${records.length} of ${products.length} products...`);
    await sleep(1500);
  }

  console.log(`Generated ${records.length} vector embeddings. Upserting to Pinecone index...`);

  // Upsert all 400 vector records in batches of 100
  const UPSERT_BATCH_SIZE = 100;
  for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
    const batchRecords = records.slice(i, i + UPSERT_BATCH_SIZE);
    if (batchRecords.length > 0) {
      await pineconeIndex.upsert({ records: batchRecords });
      console.log(`Upserted batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1} (${batchRecords.length} records) to Pinecone.`);
    }
  }

  console.log('🎉 Successfully indexed all 400 catalog products into Pinecone!');
}

// Execute indexing if run directly via Node CLI
if (process.argv[1]?.includes('index.js')) {
  indexDocuments();
}