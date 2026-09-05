# Shopping Agent 🛍️
> **AI-Powered Conversational E-Commerce Platform & Merchant Management Portal**

An intelligent e-commerce platform that eliminates low conversion rates and customer churn by creating intelligent, personalized retail experiences. Key features include a conversational Gemini shopping assistant, vector-based product discovery, dynamic customer segmentation with automatic discounts, real-time cart upselling, and Razorpay payments.

To optimize margins, merchants can fetch live competitive market prices directly within the catalog. Additionally, the system features smart communication orchestration that prevents customer annoyance by automatically pausing outreach campaigns if a user does not engage or respond to emails.

---

## 🌟 Key Features

1. **Conversational AI Shopping Assistant (Gemini)**
   - Natural language search and multi-turn product exploration.
   - Agentic cart actions (e.g., *"Show me formal shirts"*, *"Give product in green"*, *"Add product 1 to cart"*).

2. **Vector-Based Product Search (Pinecone)**
   - Semantic product catalog retrieval matching colors, styles, materials, and occasion descriptions.

3. **Dynamic Customer Segmentation & Automatic Discounts**
   - RFM (Recency, Frequency, Monetary) customer segmentation engine.
   - Automatic personalized discount tiering (5% to 20% OFF) based on customer lifecycle:
     - *Dormant Customers (20% OFF)*
     - *At-Risk / Browsers (15% OFF)*
     - *High-Value Customers (10% OFF)*
     - *Active / Loyal Customers (5% OFF)*

4. **Real-Time Cart Upselling & Next-Best Recommendations**
   - Suggests higher-tier material/fabric upgrades with precise incremental price differences.
   - Markov transition correlation model predicting next-likely purchases.

5. **Competitive Market Price Fetching (Flipkart Rome API)**
   - Live market pricing lookup and MRP tracking directly inside the Merchant Catalog Portal.

6. **Fatigue-Controlled Email Campaign Orchestration**
   - Automated personalized email generation (Active, Loyal, High-Value, At-Risk, Dormant win-back).
   - Smart cadence protection: automatically stops outreach if recipients remain unresponsive to prevent spam and customer fatigue.

7. **Merchant Management Portal & Audit Trail**
   - Real-time gross revenue tracking, transaction log, and Razorpay checkout reconciliation.
   - Catalog price editing with instant CSV persistence.

---

## 🏗️ Architecture & Tech Stack

- **Frontend**: React 18, Lucide Icons, Vanilla CSS Design System
- **API Server**: Node.js, Express, Google GenAI SDK (`@google/genai`), Pinecone Client
- **ML & Recommendation Service**: Python, FastAPI, Uvicorn, Pandas, Scikit-learn
- **Segmentation & Email Engine**: Python, SQLite3, SMTPLib
- **Payment Processing**: Razorpay Checkout API

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js (v18+)
- Python (3.9+)
- Razorpay Test Account
- Google Gemini API Key
- Pinecone Account & Index

---

### 2. Environment Configuration

Copy the sample environment file in `backend/`:
```bash
cp backend/.env.example backend/.env
```

Configure your credentials inside `backend/.env`:
```env
GEMINI_API_KEY=your_gemini_api_key
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_ENVIRONMENT=us-east-1
PINECONE_INDEX_NAME=razorpay
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
GMAIL_ADDRESS=your_email@gmail.com
GMAIL_APP_PASSWORD=your_gmail_app_password
```

---

### 3. Installation

#### Backend Dependencies
```bash
cd backend
npm install
pip install fastapi uvicorn pandas scikit-learn python-dotenv
```

#### Frontend Dependencies
```bash
cd ../frontend
npm install
```

---

### 4. Running the Platform

Run each service in separate terminal windows:

1. **Node.js Gateway Server** (Port `5000`):
   ```bash
   cd backend
   node server.js
   ```

2. **ML Recommendation Engine** (Port `8000`):
   ```bash
   cd backend
   uvicorn model:app --port 8000
   ```

3. **Customer Segmentation Service** (Port `8001`):
   ```bash
   cd backend
   uvicorn segmentation:app --port 8001
   ```

4. **React Frontend Application** (Port `3000`):
   ```bash
   cd frontend
   npm start
   ```

---

## 🖥️ Portals & Endpoints

- **Customer Shopping Store**: [http://localhost:3000](http://localhost:3000)
- **Merchant Management Portal**: [http://localhost:3000/merchant](http://localhost:3000/merchant)
- **ML Recommendation Docs**: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- **Customer Segmentation Docs**: [http://127.0.0.1:8001/docs](http://127.0.0.1:8001/docs)

---

## 📄 License
MIT License
