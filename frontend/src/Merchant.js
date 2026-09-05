import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';

function Merchant() {
  // Navigation tabs: 'audit_trail' | 'inventory'
  const [activeTab, setActiveTab] = useState('audit_trail');

  // Inventory Catalog State
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Flipkart pageUri state mapped by product_id (in-memory, not in CSV)
  const [pageUris, setPageUris] = useState({});
  const [loadingUris, setLoadingUris] = useState({});

  // Flipkart live selling price state mapped by product_id (in-memory, not in CSV)
  const [flipkartPrices, setFlipkartPrices] = useState({});
  const [loadingPrices, setLoadingPrices] = useState({});

  // Price editing state mapped by product_id
  const [editedPrices, setEditedPrices] = useState({});
  const [savingPrice, setSavingPrice] = useState({});
  const [savedSuccess, setSavedSuccess] = useState({});

  // Form State aligned with CSV schema
  const [newProduct, setNewProduct] = useState({
    product_id: '',
    category: '',
    subcategory: '',
    color: '',
    material: '',
    description: '',
    price: ''
  });

  // Audit Trail State (Weekly filtering enforced)
  const [auditData, setAuditData] = useState(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState(null);
  const [auditFilter, setAuditFilter] = useState('current_week'); // 'current_week' | 'last_7_days'
  const [auditSearch, setAuditSearch] = useState('');
  const [selectedSegment, setSelectedSegment] = useState('all');
  const [selectedTxModal, setSelectedTxModal] = useState(null);
  const [copiedTxId, setCopiedTxId] = useState(null);

  // Fetch product catalog CSV
  useEffect(() => {
    const fetchCSV = async () => {
      try {
        const response = await fetch('/product_catalog_for_realistic_sales.csv');
        const text = await response.text();

        const parseCSVLine = (line) => {
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

        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) {
          setLoading(false);
          return;
        }

        const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());

        const parsedData = lines.slice(1).map((line) => {
          const values = parseCSVLine(line);
          const row = {};
          headers.forEach((header, index) => {
            row[header] = values[index] || '';
          });
          return row;
        });

        setProducts(parsedData);
      } catch (err) {
        console.error('Error fetching catalog CSV:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchCSV();
  }, []);

  // Fetch cached pageUri and Flipkart live prices from backend on initial mount
  useEffect(() => {
    const fetchCachedData = async () => {
      try {
        const [uriRes, priceRes] = await Promise.allSettled([
          fetch('http://localhost:5000/api/cached-page-uris'),
          fetch('http://localhost:5000/api/cached-flipkart-prices')
        ]);

        if (uriRes.status === 'fulfilled' && uriRes.value.ok) {
          const data = await uriRes.value.json();
          if (data.cache) {
            setPageUris((prev) => ({ ...data.cache, ...prev }));
          }
        }

        if (priceRes.status === 'fulfilled' && priceRes.value.ok) {
          const data = await priceRes.value.json();
          if (data.cache) {
            setFlipkartPrices((prev) => ({ ...data.cache, ...prev }));
          }
        }
      } catch (e) {
        console.warn('Could not load cached Flipkart data:', e.message);
      }
    };
    fetchCachedData();
  }, []);

  // Fetch Weekly Audit Trail Data
  const fetchAuditTrail = async (filterType = auditFilter) => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await fetch(`http://localhost:5000/api/audit-trail?filter=${filterType}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch audit trail (HTTP ${res.status})`);
      }
      const data = await res.json();
      setAuditData(data);
    } catch (err) {
      console.error('Error fetching audit trail:', err);
      setAuditError(err.message || 'Error loading audit data');
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditTrail(auditFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditFilter]);

  // Performs search on Flipkart by clicking the button to get the product pageUri and real-time price
  const fetchPageUriForProduct = async (item, force = false) => {
    const pid = item.product_id;
    if (!pid) return;

    setLoadingUris((prev) => ({ ...prev, [pid]: true }));
    try {
      const response = await fetch('http://localhost:5000/api/get-page-uri', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...item, force })
      });

      if (response.ok) {
        const data = await response.json();
        const uri = data.pageUri || 'none';
        setPageUris((prev) => ({ ...prev, [pid]: uri }));
        if (data.priceData) {
          setFlipkartPrices((prev) => ({ ...prev, [pid]: data.priceData }));
        }
      } else {
        setPageUris((prev) => ({ ...prev, [pid]: 'none' }));
      }
    } catch (err) {
      console.error('Error fetching Flipkart pageUri for', pid, err);
      setPageUris((prev) => ({ ...prev, [pid]: 'none' }));
    } finally {
      setLoadingUris((prev) => ({ ...prev, [pid]: false }));
    }
  };

  // Fetches the real-time Flipkart selling price using the Rome API directly
  const fetchPriceForProduct = async (pid, uri, force = false) => {
    if (!pid || !uri || uri === 'none') return;

    setLoadingPrices((prev) => ({ ...prev, [pid]: true }));
    try {
      const res = await fetch('http://localhost:5000/api/get-flipkart-price', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ product_id: pid, pageUri: uri, force })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.priceData) {
          setFlipkartPrices((prev) => ({ ...prev, [pid]: data.priceData }));
        }
      }
    } catch (err) {
      console.error('Error fetching Flipkart price for', pid, err);
    } finally {
      setLoadingPrices((prev) => ({ ...prev, [pid]: false }));
    }
  };

  const handlePriceChange = (pid, val) => {
    setEditedPrices((prev) => ({ ...prev, [pid]: val }));
  };

  const handleSavePrice = async (pid) => {
    const currentItem = products.find((p) => p.product_id === pid);
    const newPrice = editedPrices[pid] !== undefined ? editedPrices[pid] : currentItem?.price;

    if (newPrice === undefined || newPrice === null || String(newPrice).trim() === '') {
      alert('Price cannot be empty.');
      return;
    }

    const num = parseFloat(newPrice);
    if (isNaN(num) || num < 0) {
      alert('Please enter a valid positive price.');
      return;
    }

    setSavingPrice((prev) => ({ ...prev, [pid]: true }));
    try {
      const response = await fetch('http://localhost:5000/api/update-product-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: pid, price: num })
      });

      if (response.ok) {
        const data = await response.json();
        const formatted = data.price || num.toFixed(2);
        setProducts((prev) =>
          prev.map((p) => (p.product_id === pid ? { ...p, price: formatted } : p))
        );
        setEditedPrices((prev) => {
          const updated = { ...prev };
          delete updated[pid];
          return updated;
        });
        setSavedSuccess((prev) => ({ ...prev, [pid]: true }));
        setTimeout(() => {
          setSavedSuccess((prev) => ({ ...prev, [pid]: false }));
        }, 2000);
      } else {
        const errData = await response.json();
        alert(`Failed to update price: ${errData.error || 'Server error'}`);
      }
    } catch (err) {
      console.error('Error saving price:', err);
      alert('Error updating price: ' + err.message);
    } finally {
      setSavingPrice((prev) => ({ ...prev, [pid]: false }));
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setNewProduct((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddProduct = async (e) => {
    e.preventDefault();
    if (!newProduct.category || !newProduct.price) {
      alert('Please fill in at least the Category and Price.');
      return;
    }

    const nextIdNumber = products.length + 1;
    const autoGeneratedId = `P${String(nextIdNumber).padStart(5, '0')}`;

    const productToAdd = {
      ...newProduct,
      product_id: newProduct.product_id || autoGeneratedId
    };

    try {
      const response = await fetch('http://localhost:5000/api/add-product', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(productToAdd)
      });

      if (!response.ok) {
        throw new Error('Failed to save product to catalog');
      }

      setProducts((prev) => [productToAdd, ...prev]);

      setNewProduct({
        product_id: '',
        category: '',
        subcategory: '',
        color: '',
        material: '',
        description: '',
        price: ''
      });
      setShowModal(false);
    } catch (err) {
      console.error('Error saving product:', err);
      alert('Failed to add product to catalog. Verify backend server is running on port 5000.');
    }
  };

  // Helper to copy text to clipboard
  const copyToClipboard = (text) => {
    navigator.clipboard?.writeText(text);
    setCopiedTxId(text);
    setTimeout(() => setCopiedTxId(null), 2000);
  };

  // Helper to format currency
  const formatCurrency = (amount) => {
    const num = parseFloat(amount) || 0;
    return `Rs. ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Helper to format Date and Time
  const formatDateTime = (isoString) => {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    } catch {
      return isoString;
    }
  };

  // Helper to format Date Window Header
  const formatDateRange = (startIso, endIso) => {
    if (!startIso || !endIso) return 'Current Week';
    try {
      const s = new Date(startIso);
      const e = new Date(endIso);
      const sStr = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const eStr = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `${sStr} – ${eStr}`;
    } catch {
      return 'Current Week';
    }
  };

  // Helper to clean item title from raw text or product id
  const getCleanItemTitle = (item) => {
    if (!item) return 'Product';
    if (item.title) {
      if (item.title.startsWith('Product ID:')) {
        // Extract subcategory or category if embedded
        const subMatch = item.title.match(/Subcategory:\s*([^|]+)/i);
        if (subMatch && subMatch[1]) return subMatch[1].trim();
        const catMatch = item.title.match(/Category:\s*([^|]+)/i);
        if (catMatch && catMatch[1]) return catMatch[1].trim();
      } else {
        return item.title;
      }
    }
    if (item.subcategory) return item.subcategory;
    if (item.category) return item.category;
    return item.product_id ? `Product ${item.product_id}` : 'Product';
  };

  // Filtered transactions for the audit trail
  const filteredTransactions = useMemo(() => {
    if (!auditData || !Array.isArray(auditData.transactions)) return [];
    return auditData.transactions.filter((tx) => {
      // Segment filter
      if (selectedSegment !== 'all') {
        const seg = (tx.segment || 'Customer').toLowerCase();
        if (seg !== selectedSegment.toLowerCase()) return false;
      }
      // Search filter
      if (!auditSearch.trim()) return true;
      const q = auditSearch.toLowerCase().trim();
      const idMatch = (tx.transaction_id || '').toLowerCase().includes(q) || (tx.payment_id || '').toLowerCase().includes(q);
      const custMatch = (tx.customer_id || '').toLowerCase().includes(q) || (tx.customer_email || '').toLowerCase().includes(q) || (tx.customer_name || '').toLowerCase().includes(q);
      const itemMatch = Array.isArray(tx.items) && tx.items.some((item) =>
        (item.product_id || '').toLowerCase().includes(q) ||
        (item.title || '').toLowerCase().includes(q) ||
        (item.category || '').toLowerCase().includes(q) ||
        (item.subcategory || '').toLowerCase().includes(q) ||
        (item.material || '').toLowerCase().includes(q) ||
        (item.color || '').toLowerCase().includes(q)
      );
      return idMatch || custMatch || itemMatch;
    });
  }, [auditData, auditSearch, selectedSegment]);

  // Unique segments from weekly data
  const availableSegments = useMemo(() => {
    if (!auditData || !Array.isArray(auditData.transactions)) return [];
    const segs = new Set();
    auditData.transactions.forEach((tx) => {
      if (tx.segment) segs.add(tx.segment);
    });
    return Array.from(segs);
  }, [auditData]);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f8fafc', color: '#1e293b', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <style>{`
        @keyframes uriSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes pulseGlow {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.15); }
        }
        .merchant-tab {
          transition: all 0.2s ease;
        }
        .merchant-tab:hover {
          color: #0284c7 !important;
        }
        .tx-row:hover {
          background-color: #f1f5f9 !important;
        }
      `}</style>

      {/* Top Header Navigation */}
      <header style={{ backgroundColor: '#ffffff', borderBottom: '1px solid #e2e8f0', padding: '16px 36px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '24px' }}>🏢</span>
              <h1 style={{ margin: 0, fontSize: '22px', fontWeight: '800', color: '#0f172a', letterSpacing: '-0.5px' }}>
                Merchant Management Portal
              </h1>
              <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '12px', backgroundColor: '#e0f2fe', color: '#0369a1', textTransform: 'uppercase' }}>
                Store Admin
              </span>
            </div>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#64748b' }}>
              Real-time weekly transaction audit trail, financial metrics & product inventory
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Link
              to="/"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 16px',
                borderRadius: '6px',
                backgroundColor: '#f1f5f9',
                color: '#334155',
                textDecoration: 'none',
                fontSize: '13px',
                fontWeight: '600',
                border: '1px solid #cbd5e1',
                transition: 'all 0.2s'
              }}
            >
              <span>🛍️</span>
              <span>Customer Store (Shopping Assistant)</span>
            </Link>

            {activeTab === 'inventory' && (
              <button
                onClick={() => setShowModal(true)}
                style={{
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '9px 18px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  fontWeight: '700',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 2px 4px rgba(37,99,235,0.2)'
                }}
              >
                <span>+</span>
                <span>Add Product</span>
              </button>
            )}
          </div>
        </div>

        {/* Portal Tabs */}
        <div style={{ maxWidth: '1400px', margin: '20px auto 0 auto', display: 'flex', gap: '8px', borderBottom: '1px solid #e2e8f0' }}>
          <button
            onClick={() => setActiveTab('audit_trail')}
            className="merchant-tab"
            style={{
              padding: '12px 20px',
              border: 'none',
              background: 'none',
              fontSize: '14px',
              fontWeight: activeTab === 'audit_trail' ? '700' : '500',
              color: activeTab === 'audit_trail' ? '#0f172a' : '#64748b',
              borderBottom: activeTab === 'audit_trail' ? '3px solid #0284c7' : '3px solid transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <span>🧾</span>
            <span>Transaction Audit Trail</span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: '700',
                padding: '2px 8px',
                borderRadius: '10px',
                backgroundColor: activeTab === 'audit_trail' ? '#ecfdf5' : '#f1f5f9',
                color: activeTab === 'audit_trail' ? '#059669' : '#475569',
                border: activeTab === 'audit_trail' ? '1px solid #a7f3d0' : '1px solid #e2e8f0'
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: '#10b981',
                  animation: 'pulseGlow 1.5s infinite'
                }}
              />
              {auditData ? `${auditData.total_transactions} this week` : 'Loading...'}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('inventory')}
            className="merchant-tab"
            style={{
              padding: '12px 20px',
              border: 'none',
              background: 'none',
              fontSize: '14px',
              fontWeight: activeTab === 'inventory' ? '700' : '500',
              color: activeTab === 'inventory' ? '#0f172a' : '#64748b',
              borderBottom: activeTab === 'inventory' ? '3px solid #0284c7' : '3px solid transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <span>📦</span>
            <span>Inventory Catalog</span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: '700',
                padding: '2px 8px',
                borderRadius: '10px',
                backgroundColor: '#f1f5f9',
                color: '#475569'
              }}
            >
              {products.length} Products
            </span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ maxWidth: '1400px', margin: '24px auto', padding: '0 36px 60px 36px' }}>

        {/* ============================================================ */}
        {/* TAB 1: WEEKLY TRANSACTION AUDIT TRAIL                        */}
        {/* ============================================================ */}
        {activeTab === 'audit_trail' && (
          <div>
            {/* Weekly Isolation Banner & Controls */}
            <div
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '12px',
                padding: '20px 24px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '16px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                marginBottom: '24px'
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '18px' }}>📅</span>
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                    Audited Window: {auditData ? formatDateRange(auditData.start_date, auditData.end_date) : 'Current Week'}
                  </h2>
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '3px 10px',
                      borderRadius: '20px',
                      backgroundColor: '#f0fdf4',
                      color: '#16a34a',
                      border: '1px solid #bbf7d0'
                    }}
                  >
                    ✓ Strict Weekly Filter Active
                  </span>
                </div>
                <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: '#64748b' }}>
                  Auditing all customer checkouts conducted during this week. Older historical records (e.g. 80,000+ past training sales) are excluded as requested.
                </p>
              </div>

              {/* Timeframe selector & refresh */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ display: 'flex', backgroundColor: '#f1f5f9', padding: '3px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <button
                    onClick={() => setAuditFilter('current_week')}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '12px',
                      fontWeight: auditFilter === 'current_week' ? '700' : '500',
                      backgroundColor: auditFilter === 'current_week' ? '#ffffff' : 'transparent',
                      color: auditFilter === 'current_week' ? '#0f172a' : '#64748b',
                      cursor: 'pointer',
                      boxShadow: auditFilter === 'current_week' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                      transition: 'all 0.15s'
                    }}
                  >
                    Current Calendar Week (Mon–Sun)
                  </button>
                  <button
                    onClick={() => setAuditFilter('last_7_days')}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '12px',
                      fontWeight: auditFilter === 'last_7_days' ? '700' : '500',
                      backgroundColor: auditFilter === 'last_7_days' ? '#ffffff' : 'transparent',
                      color: auditFilter === 'last_7_days' ? '#0f172a' : '#64748b',
                      cursor: 'pointer',
                      boxShadow: auditFilter === 'last_7_days' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                      transition: 'all 0.15s'
                    }}
                  >
                    Rolling 7 Days
                  </button>
                </div>

                <button
                  onClick={() => fetchAuditTrail(auditFilter)}
                  disabled={auditLoading}
                  style={{
                    backgroundColor: '#ffffff',
                    border: '1px solid #cbd5e1',
                    borderRadius: '8px',
                    padding: '7px 14px',
                    fontSize: '12px',
                    fontWeight: '600',
                    color: '#334155',
                    cursor: auditLoading ? 'not-allowed' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  title="Reload audit data from database"
                >
                  <span style={{ display: 'inline-block', transform: auditLoading ? 'rotate(360deg)' : 'none', transition: 'transform 0.8s ease' }}>
                    🔄
                  </span>
                  <span>{auditLoading ? 'Auditing...' : 'Refresh'}</span>
                </button>
              </div>
            </div>

            {/* 4 Weekly KPI Metric Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '24px' }}>
              {/* Card 1: Revenue */}
              <div
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '20px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  position: 'relative',
                  overflow: 'hidden'
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '4px', backgroundColor: '#10b981' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.5px' }}>
                    Weekly Revenue
                  </span>
                  <span style={{ fontSize: '20px' }}>💰</span>
                </div>
                <div style={{ margin: '12px 0 4px 0', fontSize: '28px', fontWeight: '800', color: '#047857', letterSpacing: '-0.5px' }}>
                  {auditData ? formatCurrency(auditData.total_revenue) : 'Rs. 0.00'}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Gross sales across all checkouts this week
                </div>
              </div>

              {/* Card 2: Transactions */}
              <div
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '20px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  position: 'relative',
                  overflow: 'hidden'
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '4px', backgroundColor: '#0284c7' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.5px' }}>
                    Weekly Transactions
                  </span>
                  <span style={{ fontSize: '20px' }}>🧾</span>
                </div>
                <div style={{ margin: '12px 0 4px 0', fontSize: '28px', fontWeight: '800', color: '#0369a1', letterSpacing: '-0.5px' }}>
                  {auditData ? auditData.total_transactions : 0}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Completed customer orders this week
                </div>
              </div>

              {/* Card 3: Units Sold */}
              <div
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '20px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  position: 'relative',
                  overflow: 'hidden'
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '4px', backgroundColor: '#8b5cf6' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.5px' }}>
                    Units Purchased
                  </span>
                  <span style={{ fontSize: '20px' }}>📦</span>
                </div>
                <div style={{ margin: '12px 0 4px 0', fontSize: '28px', fontWeight: '800', color: '#6d28d9', letterSpacing: '-0.5px' }}>
                  {auditData ? auditData.total_units : 0}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Physical inventory units sold this week
                </div>
              </div>

              {/* Card 4: Unique Customers */}
              <div
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '20px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  position: 'relative',
                  overflow: 'hidden'
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '4px', backgroundColor: '#f59e0b' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.5px' }}>
                    Active Buyers
                  </span>
                  <span style={{ fontSize: '20px' }}>👥</span>
                </div>
                <div style={{ margin: '12px 0 4px 0', fontSize: '28px', fontWeight: '800', color: '#b45309', letterSpacing: '-0.5px' }}>
                  {auditData ? auditData.unique_customers : 0}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  Distinct customers with transactions
                </div>
              </div>
            </div>

            {/* Audit Trail Table Container */}
            <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              {/* Search & Filter Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#0f172a' }}>
                    Customer Transactions Ledger
                  </h3>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>
                    Showing {filteredTransactions.length} of {auditData ? auditData.total_transactions : 0} weekly transactions
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  {/* Segment Filter */}
                  {availableSegments.length > 0 && (
                    <select
                      value={selectedSegment}
                      onChange={(e) => setSelectedSegment(e.target.value)}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #cbd5e1',
                        fontSize: '13px',
                        backgroundColor: '#ffffff',
                        color: '#334155',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="all">All Customer Segments</option>
                      {availableSegments.map((seg) => (
                        <option key={seg} value={seg}>{seg}</option>
                      ))}
                    </select>
                  )}

                  {/* Search Input */}
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text"
                      placeholder="Search Customer, ID, Payment..."
                      value={auditSearch}
                      onChange={(e) => setAuditSearch(e.target.value)}
                      style={{
                        padding: '8px 32px 8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #cbd5e1',
                        fontSize: '13px',
                        width: '260px',
                        outline: 'none',
                        color: '#0f172a'
                      }}
                    />
                    {auditSearch && (
                      <button
                        onClick={() => setAuditSearch('')}
                        style={{
                          position: 'absolute',
                          right: '8px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          border: 'none',
                          background: 'none',
                          color: '#94a3b8',
                          cursor: 'pointer',
                          fontSize: '14px'
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Transactions Table */}
              {auditLoading ? (
                <div style={{ textAlign: 'center', padding: '48px 0', color: '#64748b' }}>
                  <div
                    style={{
                      display: 'inline-block',
                      width: '32px',
                      height: '32px',
                      border: '3px solid #e2e8f0',
                      borderTopColor: '#0284c7',
                      borderRadius: '50%',
                      animation: 'uriSpin 0.8s linear infinite',
                      marginBottom: '12px'
                    }}
                  />
                  <div style={{ fontSize: '14px', fontWeight: '600' }}>Auditing weekly transactions...</div>
                </div>
              ) : auditError ? (
                <div style={{ padding: '24px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#991b1b', textAlign: 'center' }}>
                  <strong>Error loading audit trail:</strong> {auditError}
                  <div style={{ marginTop: '10px' }}>
                    <button
                      onClick={() => fetchAuditTrail(auditFilter)}
                      style={{ padding: '6px 14px', borderRadius: '4px', backgroundColor: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer' }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ) : filteredTransactions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 0', color: '#64748b' }}>
                  <div style={{ fontSize: '36px', marginBottom: '8px' }}>🔍</div>
                  <div style={{ fontSize: '15px', fontWeight: '600', color: '#334155' }}>
                    {auditSearch ? 'No transactions match your search filter' : 'No transactions recorded during this week'}
                  </div>
                  <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px' }}>
                    {auditSearch ? 'Try adjusting your search query or clear the filter.' : 'Completed checkouts will appear here in real time.'}
                  </div>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        <th style={{ padding: '12px 10px', minWidth: '150px' }}>Timestamp</th>
                        <th style={{ padding: '12px 10px', minWidth: '190px' }}>Transaction ID</th>
                        <th style={{ padding: '12px 10px', minWidth: '180px' }}>Customer</th>
                        <th style={{ padding: '12px 10px', minWidth: '280px' }}>Purchased Items</th>
                        <th style={{ padding: '12px 10px', minWidth: '110px' }}>Total Paid</th>
                        <th style={{ padding: '12px 10px', minWidth: '90px' }}>Status</th>
                        <th style={{ padding: '12px 10px', minWidth: '100px', textAlign: 'right' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTransactions.map((tx, idx) => {
                        const items = Array.isArray(tx.items) ? tx.items : [];
                        const itemsCount = tx.items_count || items.length || 1;
                        const isCopied = copiedTxId === tx.transaction_id;

                        return (
                          <tr
                            key={tx.transaction_id || tx.event_id || idx}
                            className="tx-row"
                            style={{ borderBottom: '1px solid #f1f5f9', transition: 'background-color 0.15s' }}
                          >
                            {/* Date & Time */}
                            <td style={{ padding: '12px 10px', color: '#1e293b' }}>
                              <div style={{ fontWeight: '600' }}>{formatDateTime(tx.timestamp)}</div>
                              <div style={{ fontSize: '11px', color: '#94a3b8' }}>UTC Standard</div>
                            </td>

                            {/* Payment / Transaction ID */}
                            <td style={{ padding: '12px 10px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span
                                  style={{
                                    fontFamily: 'monospace',
                                    fontWeight: '600',
                                    color: '#0f172a',
                                    backgroundColor: '#f1f5f9',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    fontSize: '12px'
                                  }}
                                  title={tx.transaction_id}
                                >
                                  {tx.transaction_id?.length > 18
                                    ? `${tx.transaction_id.slice(0, 16)}...`
                                    : tx.transaction_id || '—'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(tx.transaction_id)}
                                  title="Copy transaction ID"
                                  style={{
                                    border: 'none',
                                    background: 'none',
                                    cursor: 'pointer',
                                    color: isCopied ? '#16a34a' : '#94a3b8',
                                    fontSize: '12px',
                                    padding: '2px'
                                  }}
                                >
                                  {isCopied ? '✓' : '📋'}
                                </button>
                              </div>
                              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                                Gateway: <span style={{ fontWeight: '600', color: '#2563eb' }}>{tx.payment_gateway || 'Razorpay'}</span>
                              </div>
                            </td>

                            {/* Customer Information */}
                            <td style={{ padding: '12px 10px' }}>
                              <div style={{ fontWeight: '700', color: '#0f172a' }}>
                                {tx.customer_id || tx.customer_name || 'Customer'}
                              </div>
                              <div style={{ fontSize: '11px', color: '#64748b' }}>
                                {tx.customer_email || '—'}
                              </div>
                              {tx.segment && (
                                <span
                                  style={{
                                    display: 'inline-block',
                                    marginTop: '4px',
                                    fontSize: '10px',
                                    fontWeight: '700',
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    backgroundColor:
                                      tx.segment.toLowerCase().includes('loyal')
                                        ? '#dcfce7'
                                        : tx.segment.toLowerCase().includes('high')
                                        ? '#fef3c7'
                                        : tx.segment.toLowerCase().includes('risk')
                                        ? '#fee2e2'
                                        : '#e0e7ff',
                                    color:
                                      tx.segment.toLowerCase().includes('loyal')
                                        ? '#15803d'
                                        : tx.segment.toLowerCase().includes('high')
                                        ? '#b45309'
                                        : tx.segment.toLowerCase().includes('risk')
                                        ? '#b91c1c'
                                        : '#4338ca'
                                  }}
                                >
                                  {tx.segment}
                                </span>
                              )}
                            </td>

                            {/* Purchased Items */}
                            <td style={{ padding: '12px 10px' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {items.length > 0 ? (
                                  items.slice(0, 2).map((item, iIdx) => (
                                    <div
                                      key={iIdx}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                        backgroundColor: '#f8fafc',
                                        border: '1px solid #e2e8f0',
                                        padding: '3px 8px',
                                        borderRadius: '6px',
                                        fontSize: '12px'
                                      }}
                                    >
                                      <span style={{ fontWeight: '700', color: '#2563eb', fontFamily: 'monospace' }}>
                                        {item.product_id}
                                      </span>
                                      <span style={{ color: '#334155', fontWeight: '500' }}>
                                        {getCleanItemTitle(item)}
                                      </span>
                                      {(item.color || item.material) && (
                                        <span style={{ color: '#64748b', fontSize: '11px' }}>
                                          ({[item.color, item.material].filter(Boolean).join(' ')})
                                        </span>
                                      )}
                                      <span style={{ fontWeight: '700', color: '#047857' }}>
                                        ×{item.quantity || 1}
                                      </span>
                                    </div>
                                  ))
                                ) : (
                                  <span style={{ color: '#64748b' }}>{itemsCount} item(s)</span>
                                )}
                                {items.length > 2 && (
                                  <span style={{ fontSize: '11px', color: '#0284c7', fontWeight: '600' }}>
                                    +{items.length - 2} more item(s)...
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Total Paid */}
                            <td style={{ padding: '12px 10px' }}>
                              <div style={{ fontSize: '15px', fontWeight: '800', color: '#059669' }}>
                                {formatCurrency(tx.amount)}
                              </div>
                              {tx.discount_percent > 0 && (
                                <div style={{ fontSize: '11px', color: '#dc2626' }}>
                                  ({tx.discount_percent}% off)
                                </div>
                              )}
                            </td>

                            {/* Status */}
                            <td style={{ padding: '12px 10px' }}>
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  padding: '3px 8px',
                                  borderRadius: '12px',
                                  fontSize: '11px',
                                  fontWeight: '700',
                                  backgroundColor: '#dcfce7',
                                  color: '#15803d',
                                  border: '1px solid #bbf7d0'
                                }}
                              >
                                <span>✓</span>
                                <span>PAID</span>
                              </span>
                            </td>

                            {/* Action: Receipt Modal */}
                            <td style={{ padding: '12px 10px', textAlign: 'right' }}>
                              <button
                                type="button"
                                onClick={() => setSelectedTxModal(tx)}
                                style={{
                                  padding: '5px 12px',
                                  borderRadius: '6px',
                                  border: '1px solid #cbd5e1',
                                  backgroundColor: '#ffffff',
                                  color: '#0284c7',
                                  fontSize: '12px',
                                  fontWeight: '600',
                                  cursor: 'pointer',
                                  transition: 'all 0.15s'
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.backgroundColor = '#f0f9ff';
                                  e.currentTarget.style.borderColor = '#0284c7';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.backgroundColor = '#ffffff';
                                  e.currentTarget.style.borderColor = '#cbd5e1';
                                }}
                              >
                                View Receipt
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 2: INVENTORY CATALOG & FLIPKART PRICING                  */}
        {/* ============================================================ */}
        {activeTab === 'inventory' && (
          <div>
            <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                    Available Store Inventory ({products.length} Products)
                  </h3>
                  <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#64748b' }}>
                    Manage store catalog items, live prices, and Flipkart Rome API pageUri lookups.
                  </p>
                </div>
                <button
                  onClick={() => setShowModal(true)}
                  style={{
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    fontWeight: '700',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <span>+</span>
                  <span>Add Product</span>
                </button>
              </div>

              {loading ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                  <div
                    style={{
                      display: 'inline-block',
                      width: '28px',
                      height: '28px',
                      border: '3px solid #e2e8f0',
                      borderTopColor: '#2563eb',
                      borderRadius: '50%',
                      animation: 'uriSpin 0.8s linear infinite',
                      marginBottom: '8px'
                    }}
                  />
                  <div>Loading catalog items...</div>
                </div>
              ) : products.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569', fontSize: '12px', textTransform: 'uppercase' }}>
                        <th style={{ padding: '10px 8px', minWidth: '90px' }}>Product ID</th>
                        <th style={{ padding: '10px 8px', minWidth: '110px' }}>Category</th>
                        <th style={{ padding: '10px 8px', minWidth: '120px' }}>Subcategory</th>
                        <th style={{ padding: '10px 8px', minWidth: '90px' }}>Color</th>
                        <th style={{ padding: '10px 8px', minWidth: '110px' }}>Material</th>
                        <th style={{ padding: '10px 8px', minWidth: '240px' }}>Description</th>
                        <th style={{ padding: '10px 8px', minWidth: '150px' }}>Price (Rs.)</th>
                        <th style={{ padding: '10px 8px', minWidth: '150px' }}>Current Selling Price</th>
                        <th style={{ padding: '10px 8px', minWidth: '260px' }}>Flipkart pageUri</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((item, idx) => {
                        const currentUri = pageUris[item.product_id];

                        return (
                          <tr key={item.product_id || idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '10px 8px' }}>
                              <strong style={{ color: '#0f172a', fontFamily: 'monospace' }}>{item.product_id}</strong>
                            </td>
                            <td style={{ padding: '10px 8px' }}>{item.category}</td>
                            <td style={{ padding: '10px 8px' }}>{item.subcategory}</td>
                            <td style={{ padding: '10px 8px' }}>{item.color}</td>
                            <td style={{ padding: '10px 8px' }}>{item.material}</td>
                            <td style={{ padding: '10px 8px', color: '#555', fontSize: '12px', lineHeight: '1.4' }}>
                              {item.description}
                            </td>
                            <td style={{ padding: '10px 8px', minWidth: '150px' }}>
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{ color: '#555', fontWeight: '600', fontSize: '13px' }}>Rs.</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={editedPrices[item.product_id] !== undefined ? editedPrices[item.product_id] : item.price}
                                  onChange={(e) => handlePriceChange(item.product_id, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      handleSavePrice(item.product_id);
                                    }
                                  }}
                                  style={{
                                    width: '74px',
                                    padding: '4px 6px',
                                    border: savedSuccess[item.product_id] ? '1px solid #16a34a' : '1px solid #cbd5e1',
                                    borderRadius: '4px',
                                    fontSize: '13px',
                                    fontWeight: '500',
                                    backgroundColor: savedSuccess[item.product_id] ? '#f0fdf4' : '#fff',
                                    transition: 'all 0.2s',
                                    outline: 'none'
                                  }}
                                  title="Edit price and press Enter or Save to write to CSV"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSavePrice(item.product_id)}
                                  disabled={savingPrice[item.product_id]}
                                  style={{
                                    backgroundColor: savedSuccess[item.product_id] ? '#16a34a' : '#2563eb',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '5px 8px',
                                    fontSize: '11px',
                                    fontWeight: '600',
                                    cursor: savingPrice[item.product_id] ? 'not-allowed' : 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                    transition: 'all 0.2s'
                                  }}
                                  title="Save price to CSV file"
                                >
                                  {savingPrice[item.product_id] ? (
                                    '...'
                                  ) : savedSuccess[item.product_id] ? (
                                    '✓'
                                  ) : (
                                    'Save'
                                  )}
                                </button>
                              </div>
                            </td>
                            <td style={{ padding: '10px 8px', fontSize: '13px' }}>
                              {loadingPrices[item.product_id] ? (
                                <span style={{ color: '#0284c7', fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px' }}>
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: '10px',
                                      height: '10px',
                                      border: '2px solid #0284c7',
                                      borderTopColor: 'transparent',
                                      borderRadius: '50%',
                                      animation: 'uriSpin 0.8s linear infinite'
                                    }}
                                  />
                                  Fetching price...
                                </span>
                              ) : flipkartPrices[item.product_id] && flipkartPrices[item.product_id].sellingPrice !== null ? (
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ color: '#16a34a', fontWeight: '700', fontSize: '14px' }}>
                                    {flipkartPrices[item.product_id].formatted || `₹${flipkartPrices[item.product_id].sellingPrice}`}
                                  </span>
                                  {flipkartPrices[item.product_id].formattedMrp && (
                                    <span style={{ color: '#878787', textDecoration: 'line-through', fontSize: '11px' }}>
                                      {flipkartPrices[item.product_id].formattedMrp}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => fetchPriceForProduct(item.product_id, currentUri, true)}
                                    title="Refresh live price from Flipkart API"
                                    style={{
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      padding: '2px',
                                      color: '#888',
                                      display: 'inline-flex',
                                      alignItems: 'center'
                                    }}
                                  >
                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                      <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                                      <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
                                    </svg>
                                  </button>
                                </div>
                              ) : currentUri && currentUri !== 'none' ? (
                                <button
                                  type="button"
                                  onClick={() => fetchPriceForProduct(item.product_id, currentUri)}
                                  style={{
                                    background: '#f1f5f9',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: '4px',
                                    padding: '3px 8px',
                                    fontSize: '11px',
                                    fontWeight: '600',
                                    cursor: 'pointer',
                                    color: '#0284c7'
                                  }}
                                >
                                  Get Price
                                </button>
                              ) : (
                                <span style={{ color: '#aaa', fontStyle: 'italic', fontSize: '12px' }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: '10px 8px', fontSize: '12px', wordBreak: 'break-all', minWidth: '220px', maxWidth: '340px' }}>
                              {loadingUris[item.product_id] ? (
                                <span style={{ color: '#0284c7', fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: '12px',
                                      height: '12px',
                                      border: '2px solid #0284c7',
                                      borderTopColor: 'transparent',
                                      borderRadius: '50%',
                                      animation: 'uriSpin 0.8s linear infinite'
                                    }}
                                  />
                                  Searching Flipkart...
                                </span>
                              ) : currentUri ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                  <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                                    {currentUri === 'none' ? (
                                      <span style={{ color: '#888', fontStyle: 'italic', background: '#f5f5f5', padding: '2px 8px', borderRadius: '4px' }}>
                                        none
                                      </span>
                                    ) : (
                                      <a
                                        href={currentUri.startsWith('http') ? currentUri : `https://www.flipkart.com${currentUri.startsWith('/') ? '' : '/'}${currentUri}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{
                                          color: '#0284c7',
                                          textDecoration: 'underline',
                                          fontWeight: '500',
                                          wordBreak: 'break-all'
                                        }}
                                        title={`Open product on Flipkart: ${currentUri}`}
                                      >
                                        {currentUri}
                                      </a>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => fetchPageUriForProduct(item, true)}
                                    title="Try again (Re-fetch from Gemini API)"
                                    style={{
                                      background: '#fff',
                                      border: '1px solid #cbd5e1',
                                      borderRadius: '4px',
                                      padding: '3px 8px',
                                      cursor: 'pointer',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      color: '#555',
                                      fontSize: '11px',
                                      fontWeight: '600',
                                      flexShrink: 0,
                                      gap: '4px'
                                    }}
                                  >
                                    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                                      <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                                      <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
                                    </svg>
                                    Try again
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => fetchPageUriForProduct(item)}
                                  style={{
                                    background: '#2874f0',
                                    color: '#ffffff',
                                    border: 'none',
                                    padding: '6px 14px',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    fontWeight: '600',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    boxShadow: '0 1px 3px rgba(40,116,240,0.3)'
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                                  </svg>
                                  Find pageUri
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p style={{ color: '#666', fontStyle: 'italic' }}>No products found in catalog.</p>
              )}
            </div>
          </div>
        )}

      </main>

      {/* ============================================================ */}
      {/* RECEIPT / AUDIT DETAIL MODAL                                 */}
      {/* ============================================================ */}
      {selectedTxModal && (
        <div style={modalOverlayStyle} onClick={() => setSelectedTxModal(null)}>
          <div style={{ ...modalContentStyle, width: '650px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '14px', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#0f172a' }}>
                  Transaction Receipt & Audit Details
                </h3>
                <span style={{ fontSize: '12px', color: '#64748b' }}>
                  Order verified in current weekly settlement
                </span>
              </div>
              <button
                onClick={() => setSelectedTxModal(null)}
                style={{ border: 'none', background: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}
              >
                ✕
              </button>
            </div>

            {/* Receipt Summary Details */}
            <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '13px', marginBottom: '16px' }}>
              <div>
                <span style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', fontWeight: '700' }}>Payment ID:</span>
                <div style={{ fontFamily: 'monospace', fontWeight: '700', color: '#0f172a', wordBreak: 'break-all' }}>
                  {selectedTxModal.payment_id || selectedTxModal.transaction_id}
                </div>
              </div>
              <div>
                <span style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', fontWeight: '700' }}>Gateway:</span>
                <div style={{ fontWeight: '600', color: '#2563eb' }}>
                  {selectedTxModal.payment_gateway || 'Razorpay'}
                </div>
              </div>
              <div>
                <span style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', fontWeight: '700' }}>Customer Account:</span>
                <div style={{ fontWeight: '600', color: '#0f172a' }}>
                  {selectedTxModal.customer_id} ({selectedTxModal.customer_email || 'No email'})
                </div>
              </div>
              <div>
                <span style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', fontWeight: '700' }}>Customer Segment:</span>
                <div>
                  <span style={{ fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '4px', backgroundColor: '#e0e7ff', color: '#4338ca' }}>
                    {selectedTxModal.segment || 'Customer'}
                  </span>
                </div>
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <span style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', fontWeight: '700' }}>Recorded Timestamp:</span>
                <div style={{ fontWeight: '600', color: '#0f172a' }}>
                  {selectedTxModal.timestamp} ({formatDateTime(selectedTxModal.timestamp)})
                </div>
              </div>
            </div>

            {/* Itemized Table */}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#334155', marginBottom: '8px' }}>
                Itemized Purchase Breakdown ({Array.isArray(selectedTxModal.items) ? selectedTxModal.items.length : 0} items)
              </div>
              <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '1px solid #cbd5e1', textAlign: 'left', color: '#475569' }}>
                      <th style={{ padding: '8px 10px' }}>Product</th>
                      <th style={{ padding: '8px 10px' }}>Details</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right' }}>Price</th>
                      <th style={{ padding: '8px 10px', textAlign: 'center' }}>Qty</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right' }}>Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.isArray(selectedTxModal.items) && selectedTxModal.items.length > 0 ? (
                      selectedTxModal.items.map((item, idx) => {
                        const unitPrice = parseFloat(item.price) || 0;
                        const qty = item.quantity || 1;
                        const sub = unitPrice * qty;
                        return (
                          <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px 10px' }}>
                              <div style={{ fontWeight: '700', color: '#0f172a' }}>{getCleanItemTitle(item)}</div>
                              <div style={{ fontFamily: 'monospace', color: '#2563eb', fontSize: '11px' }}>{item.product_id}</div>
                            </td>
                            <td style={{ padding: '8px 10px', color: '#64748b' }}>
                              <div>{[item.category, item.subcategory].filter(Boolean).join(' • ') || '—'}</div>
                              <div>{[item.color, item.material].filter(Boolean).join(', ') || ''}</div>
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: '600' }}>
                              {formatCurrency(unitPrice)}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: '700' }}>
                              {qty}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: '700', color: '#047857' }}>
                              {formatCurrency(sub)}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="5" style={{ padding: '16px', textAlign: 'center', color: '#64748b' }}>
                          Standard Order ({selectedTxModal.items_count || 1} item)
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Total Paid & Discount Summary */}
            <div style={{ borderTop: '2px solid #e2e8f0', paddingTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '3px 10px',
                    borderRadius: '12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    backgroundColor: '#dcfce7',
                    color: '#15803d'
                  }}
                >
                  ✓ Payment Settled & Verified
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                {selectedTxModal.discount_percent > 0 && (
                  <div style={{ fontSize: '12px', color: '#dc2626', marginBottom: '2px' }}>
                    Applied Discount: {selectedTxModal.discount_percent}%
                  </div>
                )}
                <div style={{ fontSize: '18px', fontWeight: '800', color: '#059669' }}>
                  Total Paid: {formatCurrency(selectedTxModal.amount)}
                </div>
              </div>
            </div>

            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setSelectedTxModal(null)}
                style={{
                  padding: '8px 18px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#f1f5f9',
                  color: '#334155',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* ADD PRODUCT MODAL                                            */}
      {/* ============================================================ */}
      {showModal && (
        <div style={modalOverlayStyle}>
          <div style={modalContentStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                Add New Product to Catalog
              </h3>
              <button
                onClick={() => setShowModal(false)}
                style={{ border: 'none', background: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddProduct} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <input
                type="text"
                name="product_id"
                placeholder="Product ID (e.g. P00379 - auto if empty)"
                value={newProduct.product_id}
                onChange={handleInputChange}
                style={inputStyle}
              />
              <input
                type="text"
                name="category"
                placeholder="Category (e.g. Shirts) *"
                value={newProduct.category}
                onChange={handleInputChange}
                required
                style={inputStyle}
              />
              <input
                type="text"
                name="subcategory"
                placeholder="Subcategory (e.g. Formal Shirt)"
                value={newProduct.subcategory}
                onChange={handleInputChange}
                style={inputStyle}
              />
              <input
                type="text"
                name="color"
                placeholder="Color (e.g. Charcoal)"
                value={newProduct.color}
                onChange={handleInputChange}
                style={inputStyle}
              />
              <input
                type="text"
                name="material"
                placeholder="Material (e.g. Linen)"
                value={newProduct.material}
                onChange={handleInputChange}
                style={inputStyle}
              />
              <input
                type="number"
                step="0.01"
                name="price"
                placeholder="Price (Rs.) *"
                value={newProduct.price}
                onChange={handleInputChange}
                required
                style={inputStyle}
              />
              <textarea
                name="description"
                placeholder="Description (e.g. A classic white formal shirt made from premium cotton blend fabric.)"
                value={newProduct.description}
                onChange={handleInputChange}
                rows={3}
                style={{
                  ...inputStyle,
                  gridColumn: 'span 2',
                  resize: 'vertical',
                  fontFamily: 'inherit'
                }}
              />

              <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontWeight: '600' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ padding: '8px 18px', borderRadius: '6px', border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: '700' }}
                >
                  Save Product
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const modalOverlayStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  backgroundColor: 'rgba(15, 23, 42, 0.65)',
  backdropFilter: 'blur(2px)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 1000
};

const modalContentStyle = {
  backgroundColor: '#ffffff',
  padding: '24px',
  borderRadius: '12px',
  width: '540px',
  maxWidth: '92%',
  boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  border: '1px solid #e2e8f0'
};

const inputStyle = {
  padding: '8px 12px',
  borderRadius: '6px',
  border: '1px solid #cbd5e1',
  fontSize: '13px',
  outline: 'none'
};

export default Merchant;