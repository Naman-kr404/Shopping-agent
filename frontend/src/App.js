import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import Merchant from './Merchant';
import './App.css';

// ============================================================
// CONSTANTS & CONFIG
// ============================================================

const VIRTUAL_USERS = [
  { id: 'user_1', name: 'CUST_00001' },
  { id: 'user_2', name: 'CUST_00002' },
  { id: 'user_3', name: 'CUST_00003' },
  { id: 'user_4', name: 'CUST_00004' },
  { id: 'user_5', name: 'CUST_00005' },
  { id: 'user_6', name: 'CUST_00006' },
  { id: 'user_7', name: 'CUST_00007' },
  { id: 'user_8', name: 'CUST_00008' },
  { id: 'user_9', name: 'CUST_00009' },
  { id: 'user_10', name: 'CUST_00010' },
];

const VIRTUAL_USER_FALLBACKS = {
  CUST_00001: { segment: 'Dormant Customers', discount_percent: 20, campaign_goal: 'Win-back / reactivation' },
  CUST_00002: { segment: 'Active Customers', discount_percent: 5, campaign_goal: 'Cross-sell and upsell' },
  CUST_00003: { segment: 'Loyal Customers', discount_percent: 5, campaign_goal: 'Retention and loyalty' },
  CUST_00004: { segment: 'Loyal Customers', discount_percent: 5, campaign_goal: 'Retention and loyalty' },
  CUST_00005: { segment: 'Browsers/Prospects', discount_percent: 15, campaign_goal: 'Encourage first purchase' },
  CUST_00006: { segment: 'Dormant Customers', discount_percent: 20, campaign_goal: 'Win-back / reactivation' },
  CUST_00007: { segment: 'High-Value Customers', discount_percent: 10, campaign_goal: 'Premium upsell / VIP treatment' },
  CUST_00008: { segment: 'Active Customers', discount_percent: 5, campaign_goal: 'Cross-sell and upsell' },
  CUST_00009: { segment: 'Browsers/Prospects', discount_percent: 15, campaign_goal: 'Encourage first purchase' },
  CUST_00010: { segment: 'Browsers/Prospects', discount_percent: 15, campaign_goal: 'Encourage first purchase' },
};

const DEFAULT_RECOMMENDATIONS = [
  { rank: 1, recommended_category: 'Pants & Jeans', recommended_subcategory: 'Cargo Pants', customers_also_bought: 43, percentage_of_customers: 9.84 },
  { rank: 2, recommended_category: 'Pants & Jeans', recommended_subcategory: 'Bootcut Jeans', customers_also_bought: 43, percentage_of_customers: 9.84 },
  { rank: 3, recommended_category: 'Pants & Jeans', recommended_subcategory: 'Slim Fit Jeans', customers_also_bought: 43, percentage_of_customers: 9.84 },
  { rank: 4, recommended_category: 'Pants & Jeans', recommended_subcategory: 'Jogger Pants', customers_also_bought: 42, percentage_of_customers: 9.61 },
];

const RAZORPAY_KEY_ID = 'rzp_test_TUBLrZ1EOkSU5j';

// ============================================================
// CUSTOMER STORE
// ============================================================

function CustomerStore() {
  const [selectedUser, setSelectedUser] = useState(VIRTUAL_USERS[0].id);
  const [inputMessage, setInputMessage] = useState('');
  const [messages, setMessages] = useState([
    {
      id: 'msg_welcome',
      sender: 'assistant',
      text: "👋 Hi! I'm your AI Shopping Assistant. Ask me for any products (e.g., \"Show me formal shirts\"), refine colors (\"give product in green color\"), or tell me \"add product 1 to cart\" and \"buy now\"!",
      products: [],
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [lastProducts, setLastProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [recommendations, setRecommendations] = useState(DEFAULT_RECOMMENDATIONS);
  const [userCarts, setUserCarts] = useState({});
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [customerDiscount, setCustomerDiscount] = useState(0);
  const [customerSegment, setCustomerSegment] = useState('');
  const [campaignGoal, setCampaignGoal] = useState('');
  const [cartUpsells, setCartUpsells] = useState({});
  const [loadingUpsells, setLoadingUpsells] = useState(false);

  const messagesEndRef = useRef(null);

  const currentCart = useMemo(() => userCarts[selectedUser] || [], [userCarts, selectedUser]);

  // Auto-scroll chat timeline to latest message
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  // Fetch intelligent Cart Upsell recommendations for items in current cart
  useEffect(() => {
    if (!currentCart || currentCart.length === 0) {
      setCartUpsells({});
      return;
    }

    const fetchCartUpsells = async () => {
      setLoadingUpsells(true);
      try {
        const payload = currentCart.map((item) => ({
          id: item.id,
          title: item.title || item.name || '',
          category: item.category || '',
          subcategory: item.subcategory || item.title || item.name || '',
          price: item.price,
        }));

        const res = await fetch('http://localhost:5000/api/cart-upsell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: payload }),
        });

        if (res.ok) {
          const data = await res.json();
          setCartUpsells(data.upsells || {});
        }
      } catch (err) {
        console.error('Error fetching cart upsells:', err);
      } finally {
        setLoadingUpsells(false);
      }
    };

    const timeoutId = setTimeout(fetchCartUpsells, 250);
    return () => clearTimeout(timeoutId);
  }, [currentCart]);

  // Load Razorpay Script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // Fetch Customer Segment & Discount
  useEffect(() => {
    const fetchCustomerSegment = async () => {
      try {
        const activeUser = VIRTUAL_USERS.find((user) => user.id === selectedUser);
        if (!activeUser) {
          setCustomerDiscount(0);
          setCustomerSegment('');
          setCampaignGoal('');
          return;
        }

        console.log(`🎯 Fetching segmentation for ${activeUser.name}`);
        let response = null;
        let data = null;

        // Try Port 8001 first (segmentation:app)
        try {
          response = await fetch(`http://127.0.0.1:8001/customer/${activeUser.name}`);
          if (response && response.ok) {
            data = await response.json();
            console.log('✅ Fetched segmentation from port 8001:', data);
          }
        } catch (err8001) {
          console.warn('Port 8001 segmentation fetch failed, trying port 8000 fallback...');
        }

        // Try Port 8000 fallback (in case segmentation is on 8000)
        if (!data) {
          try {
            response = await fetch(`http://127.0.0.1:8000/customer/${activeUser.name}`);
            if (response && response.ok) {
              data = await response.json();
              console.log('✅ Fetched segmentation from port 8000:', data);
            }
          } catch (err8000) {
            console.warn('Port 8000 segmentation fetch failed:', err8000.message);
          }
        }

        // Offline / server fallback for seamless UI demonstration
        if (!data && VIRTUAL_USER_FALLBACKS[activeUser.name]) {
          console.log(`ℹ️ Using localized segmentation fallback for ${activeUser.name}`);
          data = VIRTUAL_USER_FALLBACKS[activeUser.name];
        }

        if (!data) {
          console.error('❌ Could not resolve customer segmentation for:', activeUser.name);
          setCustomerDiscount(0);
          setCustomerSegment('');
          setCampaignGoal('');
          return;
        }

        const segmentDiscounts = {
          "New Customers": 15,
          "Loyal Customers": 5,
          "High-Value Customers": 10,
          "Active Customers": 5,
          "At-Risk Customers": 15,
          "Dormant Customers": 20,
          "Cart/Intent Customers": 10,
          "Browsers/Prospects": 15,
        };

        const segment = data.segment || '';
        const goal = data.campaign_goal || '';
        const discount = Number(data.discount_percent) || segmentDiscounts[segment] || 0;

        setCustomerSegment(segment);
        setCampaignGoal(goal);
        setCustomerDiscount(discount);

        console.log(`👤 Customer: ${activeUser.name} | Segment: ${segment} | Discount: ${discount}% | Campaign: ${goal}`);
      } catch (error) {
        console.error('❌ Error fetching customer segmentation:', error);
        const fallback = VIRTUAL_USER_FALLBACKS[selectedUser];
        if (fallback) {
          setCustomerSegment(fallback.segment);
          setCampaignGoal(fallback.campaign_goal);
          setCustomerDiscount(fallback.discount_percent);
        } else {
          setCustomerDiscount(0);
          setCustomerSegment('');
          setCampaignGoal('');
        }
      }
    };

    fetchCustomerSegment();
  }, [selectedUser]);

  // Parse Intent
  const parseIntentFromQueryAndResponse = (query, chatData) => {
    console.group('🔍 [STEP 2] Parsing Intent for Recommendations');
    console.log('User Raw Query:', query);
    console.log('Received chatData Object from Express:', chatData);

    let category = '';
    let subcategory = '';

    if (chatData) {
      if (chatData.category) category = chatData.category;
      if (chatData.subcategory) subcategory = chatData.subcategory;
    }

    if (category || subcategory) {
      console.log('✅ Extracted Category/Subcategory directly from Gemini:', { category, subcategory });
    } else {
      console.warn('⚠️ Gemini response missing explicit category/subcategory. Triggering keyword fallback logic...');
    }

    const lowerQuery = query.toLowerCase();

    if (!subcategory) {
      if (lowerQuery.includes('kurta')) {
        subcategory = 'Kurta';
      } else if (lowerQuery.includes('lehenga')) {
        subcategory = 'Lehenga';
      } else if (lowerQuery.includes('sherwani')) {
        subcategory = 'Sherwani';
      } else if (lowerQuery.includes('cargo')) {
        subcategory = 'Cargo Pants';
      } else if (lowerQuery.includes('jogger')) {
        subcategory = 'Jogger Pants';
      } else if (lowerQuery.includes('jean')) {
        subcategory = 'Slim Fit Jeans';
      } else if (lowerQuery.includes('shirt')) {
        subcategory = "Women's Shirts";
      } else {
        subcategory = query.trim();
      }
    }

    if (!category) {
      if (lowerQuery.includes('kurta') || lowerQuery.includes('lehenga') || lowerQuery.includes('sherwani') || lowerQuery.includes('traditional')) {
        category = 'Traditional Wear';
      } else if (lowerQuery.includes('jean') || lowerQuery.includes('pant') || lowerQuery.includes('cargo') || lowerQuery.includes('jogger')) {
        category = 'Pants & Jeans';
      } else if (lowerQuery.includes('shirt')) {
        category = 'Shirts';
      } else {
        category = 'Clothing';
      }
    }

    console.log('📌 Final Extracted Result:', { category, subcategory });
    console.groupEnd();

    return { category, subcategory };
  };

  // Agentic Chat & Recommendations Pipeline
  const handleSendMessage = async (queryText) => {
    const cleanQuery = (queryText || '').trim();
    if (!cleanQuery || loading) return;

    const userMsg = {
      id: `user_${Date.now()}`,
      sender: 'user',
      text: cleanQuery,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputMessage('');
    setLoading(true);

    console.log(`\n🚀 ================= NEW CHAT TURN =================`);
    console.log(`User Query: "${cleanQuery}" | Selected User: ${selectedUser}`);

    try {
      const activeUser = VIRTUAL_USERS.find((u) => u.id === selectedUser);

      // STEP 1: Call Express Agentic Chat API
      const chatRes = await fetch('http://localhost:5000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: cleanQuery,
          user: activeUser,
          history: messages.slice(-8).map((m) => ({ sender: m.sender, text: m.text })),
          lastProducts: lastProducts,
          currentCart: currentCart,
        }),
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        throw new Error(`Chat API error (${chatRes.status}): ${errText}`);
      }

      const chatData = await chatRes.json();
      console.log('🤖 Express /api/chat response:', chatData);

      // Conversational Add to Cart handling
      if (chatData.action === 'add_to_cart' && chatData.product_to_add) {
        handleAddToCart(chatData.product_to_add);
      }

      // Conversational Cart Upgrade handling
      if (chatData.action === 'upgrade_cart_item' && chatData.old_item_id && chatData.upgraded_product) {
        handleUpgradeCartItem(chatData.old_item_id, chatData.upgraded_product);
      }

      // Store any upsell recommendations returned by Express
      if (chatData.upsells && typeof chatData.upsells === 'object') {
        setCartUpsells((prev) => ({ ...prev, ...chatData.upsells }));
      }

      // Update lastProducts if new search results came in
      if (Array.isArray(chatData.products) && chatData.products.length > 0) {
        setLastProducts(chatData.products);
      }

      // Append assistant message on the left side of the screen
      const assistantMsg = {
        id: `assistant_${Date.now()}`,
        sender: 'assistant',
        text:
          chatData.reply ||
          (chatData.products && chatData.products.length > 0
            ? 'Here are the matching products from our catalog:'
            : "I couldn't find any direct matches. Feel free to try another style or category!"),
        products: chatData.products || [],
        action: chatData.action,
        product_to_add: chatData.product_to_add,
        upsells: chatData.upsells || null,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // STEP 2: Extract Intent and Keep Bottom Recommendations Synchronized
      const { category, subcategory } = parseIntentFromQueryAndResponse(cleanQuery, chatData);

      try {
        const recommendPayload = { category, subcategory, top_k: 4 };
        let recommendRes = await fetch('http://127.0.0.1:8000/recommend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(recommendPayload),
        }).catch(() => null);

        if (!recommendRes || !recommendRes.ok) {
          recommendRes = await fetch('http://127.0.0.1:8001/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(recommendPayload),
          }).catch(() => null);
        }

        if (recommendRes && recommendRes.ok) {
          const recommendData = await recommendRes.json();
          if (recommendData && Array.isArray(recommendData.recommendations) && recommendData.recommendations.length > 0) {
            const freshCards = recommendData.recommendations.map((item, index) => ({
              rank: item.rank || index + 1,
              recommended_category: item.recommended_category || category || 'Clothing',
              recommended_subcategory: item.recommended_subcategory || subcategory || 'Item',
              customers_also_bought: item.customers_also_bought || 0,
              percentage_of_customers: item.percentage_of_customers || 0,
              _timestampKey: `rec_${Date.now()}_${index}_${Math.random()}`,
            }));
            setRecommendations(freshCards);
          }
        }
      } catch (fastApiErr) {
        console.warn('FastAPI recommendation sync skipped/failed:', fastApiErr);
      }
    } catch (error) {
      console.error('❌ Error handling chat message:', error);
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_err_${Date.now()}`,
          sender: 'assistant',
          text: 'Sorry, I ran into an issue connecting to the AI assistant. Please try again in a moment.',
          products: [],
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleBrowseCollection = (collectionQuery) => {
    console.log(`🖱️ User clicked "Browse" card button for: "${collectionQuery}"`);
    handleSendMessage(`Show me ${collectionQuery}`);
  };

  const handleAddToCart = (product) => {
    const actualProductId = String(product.product_id || product.id || '').trim().replace(/^prod_/, '');
    const cleanProduct = {
      ...product,
      id: actualProductId,
      product_id: actualProductId,
    };
    console.log(`🛒 Added Product to Cart for ${selectedUser}:`, cleanProduct);
    setUserCarts((prevCarts) => {
      const activeCart = prevCarts[selectedUser] || [];
      const existingIndex = activeCart.findIndex(
        (item) => item.id === actualProductId || item.product_id === actualProductId
      );

      let updatedCart;
      if (existingIndex > -1) {
        updatedCart = [...activeCart];
        updatedCart[existingIndex] = {
          ...updatedCart[existingIndex],
          quantity: updatedCart[existingIndex].quantity + 1,
        };
      } else {
        updatedCart = [...activeCart, { ...cleanProduct, quantity: 1 }];
      }

      return { ...prevCarts, [selectedUser]: updatedCart };
    });
  };

  const handleUpgradeCartItem = (oldItemId, upgradedProduct) => {
    console.log(`✨ Upgrading cart item ${oldItemId} to:`, upgradedProduct);
    setUserCarts((prevCarts) => {
      const activeCart = prevCarts[selectedUser] || [];
      const oldClean = String(oldItemId || '').replace(/^prod_/, '');
      const oldItem = activeCart.find(
        (it) => it.id === oldItemId || String(it.id || '').replace(/^prod_/, '') === oldClean
      );
      const qty = oldItem ? oldItem.quantity : 1;

      // Filter out old item and insert upgraded product with same quantity
      const remainingCart = activeCart.filter(
        (it) => it.id !== oldItemId && String(it.id || '').replace(/^prod_/, '') !== oldClean
      );
      const updatedCart = [
        ...remainingCart,
        {
          id: upgradedProduct.product_id,
          title: upgradedProduct.title,
          name: upgradedProduct.title,
          price: upgradedProduct.price ? String(upgradedProduct.price) : '50.00',
          category: upgradedProduct.category,
          subcategory: upgradedProduct.subcategory,
          color: upgradedProduct.color,
          material: upgradedProduct.material,
          quantity: qty,
        },
      ];

      return { ...prevCarts, [selectedUser]: updatedCart };
    });
  };

  const handleRemoveFromCart = (productId) => {
    setUserCarts((prevCarts) => {
      const activeCart = prevCarts[selectedUser] || [];
      const updatedCart = activeCart.filter((item) => item.id !== productId);
      return { ...prevCarts, [selectedUser]: updatedCart };
    });
  };

  const clearCurrentCart = () => {
    setUserCarts((prevCarts) => ({
      ...prevCarts,
      [selectedUser]: [],
    }));
  };

  const getSubtotal = () => {
    return currentCart.reduce((total, item) => {
      const rawPrice = item.price ? String(item.price).replace(/[^0-9.]/g, '') : '50.00';
      const numericPrice = parseFloat(rawPrice) || 50.0;
      return total + numericPrice * item.quantity;
    }, 0);
  };

  const getDiscount = () => {
    const subtotal = getSubtotal();
    if (customerDiscount <= 0 || subtotal <= 0) return 0;
    return subtotal * (customerDiscount / 100);
  };

  const getCartTotal = () => {
    return getSubtotal() - getDiscount();
  };

  const handleCheckoutCart = async () => {
    const totalAmount = getCartTotal();
    if (totalAmount <= 0) return;

    const activeUser = VIRTUAL_USERS.find((user) => user.id === selectedUser);
    const customerId = activeUser ? activeUser.name : 'CUST_00001';
    const sampleEmail = `${customerId.toLowerCase()}@example.com`;

    try {
      const orderRes = await fetch('http://localhost:5000/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: totalAmount,
          currency: 'INR',
          receipt: `cart_receipt_${Date.now()}`,
        }),
      });

      const orderData = await orderRes.json();
      if (!orderData.id) {
        alert('Failed to create Razorpay order.');
        return;
      }

      const options = {
        key: RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Shopping Assistant Store',
        description: `Cart Checkout (${currentCart.length} unique item(s))`,
        order_id: orderData.id,
        handler: async function (response) {
          alert(`Payment Successful!\nPayment ID: ${response.razorpay_payment_id}`);

          // Record customer purchase in database (segmentation service on port 8001)
          try {
            const purchaseBody = JSON.stringify({
              customer_id: customerId,
              customer_name: customerId,
              email: sampleEmail,
              segment: customerSegment,
              discount_percent: customerDiscount,
              amount: totalAmount,
              payment_id: response.razorpay_payment_id,
              items: currentCart,
            });

            let purchaseRes = await fetch('http://127.0.0.1:8001/purchase', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: purchaseBody,
            }).catch(() => null);

            if (!purchaseRes || !purchaseRes.ok) {
              await fetch('http://127.0.0.1:8000/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: purchaseBody,
              }).catch(() => null);
            }
            console.log(`✅ Purchase details recorded in database for ${customerId} (${sampleEmail})`);
          } catch (recordErr) {
            console.error('❌ Failed to record purchase in database:', recordErr);
          }

          clearCurrentCart();
          setIsCartOpen(false);
        },
        prefill: {
          name: customerId,
          email: sampleEmail,
          contact: '9999999999',
        },
        theme: { color: '#28a745' },
      };

      const razorpayWindow = new window.Razorpay(options);
      razorpayWindow.open();
    } catch (error) {
      console.error('Payment Error:', error);
      alert('Error initiating Razorpay checkout.');
    }
  };

  const totalCartCount = currentCart.reduce((count, item) => count + item.quantity, 0);

  return (
    <div className="app-container">
      {/* Top Header */}
      <div className="top-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <label className="profile-label">Profile:</label>
          <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
            {VIRTUAL_USERS.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
          {customerSegment && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              backgroundColor: '#ecfdf5',
              color: '#065f46',
              border: '1px solid #a7f3d0',
              padding: '3px 10px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: '700'
            }}>
              🏷️ {customerSegment} • <span style={{ color: '#047857' }}>{customerDiscount}% OFF</span>
            </span>
          )}
        </div>

        <button onClick={() => setIsCartOpen(!isCartOpen)} className="cart-toggle-btn">
          🛒 Cart ({totalCartCount})
          {customerDiscount > 0 && (
            <span style={{
              marginLeft: '6px',
              backgroundColor: '#10b981',
              color: '#ffffff',
              padding: '2px 6px',
              borderRadius: '10px',
              fontSize: '11px',
              fontWeight: '800'
            }}>
              {customerDiscount}% OFF
            </span>
          )}
        </button>
      </div>

      {/* Cart Drawer */}
      {isCartOpen && (
        <div className="cart-drawer">
          <div className="cart-header">
            <h3 className="cart-title">
              Shopping Cart {loadingUpsells && <span className="upsell-loading-indicator" title="Finding best upgrades...">✨</span>}
            </h3>
            <button onClick={() => setIsCartOpen(false)} className="cart-close-btn">✖</button>
          </div>

          {currentCart.length === 0 ? (
            <div className="cart-empty-message">
              <p style={{ margin: 0, fontWeight: '600', color: '#475569' }}>Your cart is empty.</p>
              {customerDiscount > 0 && (
                <div style={{ marginTop: '10px', padding: '10px 14px', backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', color: '#166534', fontSize: '13px', lineHeight: '1.4' }}>
                  🏷️ <strong>{customerSegment}:</strong> Your <strong>{customerDiscount}% discount</strong> will automatically apply to any items you add!
                </div>
              )}
            </div>
          ) : (
            <div>
              {currentCart.map((item) => {
                const cleanId = String(item.id || '').replace(/^prod_/, '');
                const upsell = cartUpsells[item.id] || cartUpsells[cleanId] || cartUpsells[`prod_${cleanId}`];
                const rawPrice = item.price ? String(item.price).replace(/[^0-9.]/g, '') : '0';
                const numericPrice = parseFloat(rawPrice) || 0;
                const priceDiff = upsell ? (upsell.price_difference ?? +(upsell.price - numericPrice).toFixed(2)) : 0;

                return (
                  <div key={item.id} className="cart-item-container">
                    <div className="cart-item">
                      <div>
                        <strong className="cart-item-title">{item.title || item.name}</strong>
                        <div className="cart-item-details">
                          {customerDiscount > 0 ? (
                            <span>
                              Price: <span style={{ textDecoration: 'line-through', color: '#94a3b8', marginRight: '4px' }}>₹{numericPrice.toFixed(2)}</span>
                              <strong style={{ color: '#16a34a' }}>₹{(numericPrice * (1 - customerDiscount / 100)).toFixed(2)}</strong>
                              <span style={{ fontSize: '11px', backgroundColor: '#dcfce7', color: '#15803d', padding: '1px 5px', borderRadius: '4px', marginLeft: '6px', fontWeight: '700' }}>
                                {customerDiscount}% OFF
                              </span>
                              {' '}| Qty: {item.quantity}
                            </span>
                          ) : (
                            <span>Price: ₹{numericPrice.toFixed(2)} | Qty: {item.quantity}</span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => handleRemoveFromCart(item.id)} className="cart-remove-btn">
                        Remove
                      </button>
                    </div>

                    {/* Upselling Recommendation Card */}
                    {upsell && (
                      <div className="cart-upsell-card">
                        <div className="cart-upsell-header">
                          <span className="cart-upsell-badge">✨ Recommended Upgrade</span>
                          <span className="cart-upsell-diff">+₹{priceDiff.toFixed(2)}</span>
                        </div>
                        <div className="cart-upsell-title">{upsell.title}</div>
                        <div className="cart-upsell-meta">
                          {upsell.material && <span className="upsell-tag">{upsell.material}</span>}
                          {upsell.color && <span className="upsell-tag">{upsell.color}</span>}
                          <span className="upsell-new-price">₹{upsell.price.toFixed(2)}</span>
                        </div>
                        {upsell.upsell_reason && (
                          <p className="cart-upsell-reason">
                            💡 {upsell.upsell_reason}
                          </p>
                        )}
                        <div className="cart-upsell-actions">
                          <button
                            onClick={() => handleUpgradeCartItem(item.id, upsell)}
                            className="cart-upsell-btn"
                          >
                            Upgrade to this (+₹{priceDiff.toFixed(2)})
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="cart-summary">
                <p className="cart-subtotal">Subtotal: ₹{getSubtotal().toFixed(2)}</p>
                {customerSegment && (
                  <p className="cart-info-row">
                    Customer Segment: <strong>{customerSegment}</strong>
                  </p>
                )}
                {campaignGoal && (
                  <p className="cart-info-row">
                    Campaign: <strong>{campaignGoal}</strong>
                  </p>
                )}
                {customerDiscount > 0 && (
                  <p className="cart-discount-row">
                    🎉 Discount ({customerDiscount}% off): -₹{getDiscount().toFixed(2)}
                  </p>
                )}
                <p className="cart-total-row">Total: ₹{getCartTotal().toFixed(2)}</p>
                <button onClick={handleCheckoutCart} className="cart-checkout-btn">
                  Checkout (₹{getCartTotal().toFixed(2)})
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Content: Shopping Assistant Chat Application */}
      <div className="main-content chat-app-mode">
        <div className="chat-window-card">
          {/* Chat Header */}
          <div className="chat-header-bar">
            <div className="chat-header-info">
              <div className="chat-avatar-badge">🛍️</div>
              <div>
                <h2 className="chat-title">Shopping Assistant</h2>
                <div className="chat-subtitle">
                  <span className="online-indicator"></span>
                  Gemini AI Shopping Assistant • Natural Language & Agentic Checkout
                </div>
              </div>
            </div>
            {customerSegment && (
              <div className="chat-segment-badge">
                <span className="segment-name">{customerSegment}</span>
                <span className="segment-discount">{customerDiscount}% OFF</span>
                {campaignGoal && <span className="campaign-name">• {campaignGoal}</span>}
              </div>
            )}
          </div>

          {/* Messages Timeline */}
          <div className="chat-messages-timeline">
            {messages.map((msg) => {
              const isUser = msg.sender === 'user';
              return (
                <div
                  key={msg.id}
                  className={`chat-message-row ${isUser ? 'user-message-row' : 'assistant-message-row'}`}
                >
                  {!isUser && (
                    <div className="chat-avatar assistant-avatar" title="Gemini Assistant">
                      🤖
                    </div>
                  )}

                  <div className={`chat-bubble ${isUser ? 'user-bubble' : 'assistant-bubble'}`}>
                    <div className="chat-bubble-header">
                      <span className="chat-author">{isUser ? 'You' : 'Gemini AI'}</span>
                      <span className="chat-time">{msg.timestamp}</span>
                    </div>

                    <div className="chat-text-content">{msg.text}</div>

                    {/* In-Chat Add to Cart Success Callout */}
                    {msg.action === 'add_to_cart' && msg.product_to_add && (
                      <div className="chat-action-callout add-to-cart-callout">
                        <div className="callout-icon">✓</div>
                        <div className="callout-body">
                          <strong>Added to your cart:</strong>
                          <div className="callout-item-name">
                            {msg.product_to_add.title || msg.product_to_add.name} (₹{msg.product_to_add.price})
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setIsCartOpen(true)}
                          className="callout-cart-btn"
                        >
                          View Cart 🛒
                        </button>
                      </div>
                    )}

                    {/* In-Chat Checkout Action Box with Upselling Recommendations */}
                    {msg.action === 'checkout' && (
                      <div className="chat-action-callout checkout-callout">
                        <div className="checkout-callout-header">
                          <span className="checkout-callout-title">
                            🛒 Cart Review ({totalCartCount} item{totalCartCount !== 1 ? 's' : ''})
                          </span>
                          <span className="checkout-callout-total">
                            Total: ₹{getCartTotal().toFixed(2)}
                          </span>
                        </div>

                        {currentCart.length === 0 ? (
                          <div className="chat-checkout-empty">
                            Your cart is currently empty. Ask for any product (e.g. "Show me formal shirts") or click "Add to Cart" to start!
                          </div>
                        ) : (
                          <div className="chat-checkout-items-list">
                            {currentCart.map((item) => {
                              const cleanId = String(item.id || '').replace(/^prod_/, '');
                              const upsell =
                                (msg.upsells && (msg.upsells[item.id] || msg.upsells[cleanId] || msg.upsells[`prod_${cleanId}`])) ||
                                cartUpsells[item.id] ||
                                cartUpsells[cleanId] ||
                                cartUpsells[`prod_${cleanId}`];
                              const rawPrice = item.price ? String(item.price).replace(/[^0-9.]/g, '') : '0';
                              const numericPrice = parseFloat(rawPrice) || 0;
                              const priceDiff = upsell ? (upsell.price_difference ?? +(upsell.price - numericPrice).toFixed(2)) : 0;

                              return (
                                <div key={item.id} className="chat-checkout-item-block">
                                  <div className="chat-checkout-item-header">
                                    <div className="chat-checkout-item-info">
                                      <strong className="chat-checkout-item-name">{item.title || item.name}</strong>
                                      <div className="chat-checkout-item-sub">
                                        {customerDiscount > 0 ? (
                                          <span>
                                            <span style={{ textDecoration: 'line-through', color: '#94a3b8', marginRight: '4px' }}>₹{numericPrice.toFixed(2)}</span>
                                            <strong style={{ color: '#16a34a' }}>₹{(numericPrice * (1 - customerDiscount / 100)).toFixed(2)}</strong> × {item.quantity} = <strong style={{ color: '#16a34a' }}>₹{((numericPrice * (1 - customerDiscount / 100)) * item.quantity).toFixed(2)}</strong>
                                            <span style={{ fontSize: '11px', backgroundColor: '#dcfce7', color: '#15803d', padding: '1px 5px', borderRadius: '4px', marginLeft: '6px', fontWeight: '700' }}>
                                              {customerDiscount}% OFF
                                            </span>
                                          </span>
                                        ) : (
                                          <span>₹{numericPrice.toFixed(2)} × {item.quantity} = <strong>₹{(numericPrice * item.quantity).toFixed(2)}</strong></span>
                                        )}
                                        {item.material && <span className="upsell-tag">{item.material}</span>}
                                        {item.color && <span className="upsell-tag">{item.color}</span>}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveFromCart(item.id)}
                                      className="cart-remove-btn"
                                    >
                                      Remove
                                    </button>
                                  </div>

                                  {/* Upselling Recommendation Card (identical to Cart Drawer) */}
                                  {upsell && (
                                    <div className="cart-upsell-card chat-upsell-card">
                                      <div className="cart-upsell-header">
                                        <span className="cart-upsell-badge">✨ Recommended Upgrade</span>
                                        <span className="cart-upsell-diff">+₹{priceDiff.toFixed(2)}</span>
                                      </div>
                                      <div className="cart-upsell-title">{upsell.title}</div>
                                      <div className="cart-upsell-meta">
                                        {upsell.material && <span className="upsell-tag">{upsell.material}</span>}
                                        {upsell.color && <span className="upsell-tag">{upsell.color}</span>}
                                        <span className="upsell-new-price">₹{upsell.price.toFixed(2)}</span>
                                      </div>
                                      {upsell.upsell_reason && (
                                        <p className="cart-upsell-reason">
                                          💡 {upsell.upsell_reason}
                                        </p>
                                      )}
                                      <div className="cart-upsell-actions">
                                        <button
                                          type="button"
                                          onClick={() => handleUpgradeCartItem(item.id, upsell)}
                                          className="cart-upsell-btn"
                                        >
                                          Upgrade to this (+₹{priceDiff.toFixed(2)})
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            <div className="chat-checkout-summary-box">
                              <div className="chat-summary-row">
                                <span>Subtotal:</span>
                                <span>₹{getSubtotal().toFixed(2)}</span>
                              </div>
                              {customerDiscount > 0 && (
                                <div className="chat-summary-row discount-row">
                                  <span>🎉 Customer Discount ({customerDiscount}% off):</span>
                                  <span>-₹{getDiscount().toFixed(2)}</span>
                                </div>
                              )}
                              <div className="chat-summary-row total-row">
                                <strong>Total:</strong>
                                <strong className="chat-total-highlight">₹{getCartTotal().toFixed(2)}</strong>
                              </div>
                            </div>

                            <div className="chat-checkout-actions-row">
                              <button
                                type="button"
                                onClick={handleCheckoutCart}
                                disabled={currentCart.length === 0}
                                className="chat-checkout-pay-btn"
                              >
                                💳 Proceed to Pay via Razorpay (₹{getCartTotal().toFixed(2)})
                              </button>
                              <button
                                type="button"
                                onClick={() => setIsCartOpen(true)}
                                className="chat-review-drawer-btn"
                              >
                                Open Cart Drawer ↗
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Product Cards Inside Assistant Message */}
                    {msg.products && msg.products.length > 0 && (
                      <div className="chat-products-container">
                        <div className="chat-products-grid">
                          {msg.products.map((item, idx) => {
                            const cleanPid = String(item.product_id || item.id || '').replace(/^prod_/, '');
                            const rawPrice = item.price ? String(item.price).replace(/[^0-9.]/g, '') : '50.00';
                            const numPrice = parseFloat(rawPrice) || 50.0;

                            return (
                              <div key={item.id || cleanPid || idx} className="chat-product-card">
                                <div className="chat-product-header">
                                  <span className="product-index-badge">Product #{idx + 1}</span>
                                  <span className="product-id-badge">ID: {cleanPid}</span>
                                </div>

                                <h4 className="chat-product-title">{item.title || item.name}</h4>

                                <div className="chat-product-price-sku">
                                  <span className="chat-product-price">₹{numPrice.toFixed(2)}</span>
                                  {item.sku && <span className="chat-product-sku">SKU: {item.sku}</span>}
                                </div>

                                <div className="chat-product-meta-tags">
                                  {item.category && <span className="meta-tag cat">{item.category}</span>}
                                  {item.material && <span className="meta-tag">{item.material}</span>}
                                  {item.color && <span className="meta-tag">{item.color}</span>}
                                  {item.sizes && <span className="meta-tag">{item.sizes}</span>}
                                </div>

                                {item.description && (
                                  <p className="chat-product-description">{item.description}</p>
                                )}

                                <div className="chat-product-actions">
                                  <button
                                    type="button"
                                    onClick={() => handleAddToCart(item)}
                                    className="chat-card-add-btn"
                                  >
                                    ➕ Add to Cart
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {isUser && (
                    <div className="chat-avatar user-avatar" title="You">
                      👤
                    </div>
                  )}
                </div>
              );
            })}

            {/* Live Typing / Searching Indicator */}
            {loading && (
              <div className="chat-message-row assistant-message-row">
                <div className="chat-avatar assistant-avatar">🤖</div>
                <div className="chat-bubble assistant-bubble typing-bubble">
                  <div className="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                  <span className="typing-label">Gemini Assistant is searching & thinking...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Interactive Chips */}
          <div className="chat-quick-suggestions">
            <span className="suggestions-label">Try asking:</span>
            <button
              type="button"
              className="chat-suggestion-chip"
              onClick={() => handleSendMessage('Show me formal shirts')}
            >
              👔 "Show me formal shirts"
            </button>
            <button
              type="button"
              className="chat-suggestion-chip"
              onClick={() => handleSendMessage('Give product in green color')}
            >
              🎨 "Give product in green color"
            </button>
            <button
              type="button"
              className="chat-suggestion-chip"
              onClick={() => handleSendMessage('Add product 1 to cart')}
            >
              🛒 "Add product 1 to cart"
            </button>
            <button
              type="button"
              className="chat-suggestion-chip"
              onClick={() => handleSendMessage('Buy now')}
            >
              ⚡ "Buy now"
            </button>
          </div>

          {/* Message Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage(inputMessage);
            }}
            className="chat-input-bar"
          >
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="Type your message (e.g., 'Show me formal shirts', 'Add product 1 to cart', 'Buy now')..."
              className="chat-input-field"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !inputMessage.trim()}
              className="chat-send-button"
            >
              {loading ? 'Thinking...' : 'Send ➤'}
            </button>
          </form>
        </div>
      </div>

      {/* Bottom Recommendations */}
      <div className="bottom-recommendations-bar">
        <div className="recommendations-grid">
          {recommendations.slice(0, 4).map((rec, index) => (
            <div key={rec._timestampKey || `rec_card_${index}`} className="recommendation-card">
              <div>
                <h4 className="recommendation-title">
                  #{rec.rank || index + 1} {rec.recommended_subcategory}
                </h4>
                <p className="recommendation-category">{rec.recommended_category}</p>
                <p className="recommendation-stats">
                  {rec.customers_also_bought} bought ({rec.percentage_of_customers}%)
                </p>
              </div>
              <button
                onClick={() => handleBrowseCollection(rec.recommended_subcategory)}
                disabled={loading}
                className="browse-btn"
              >
                {loading ? 'Loading...' : 'Browse'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// APP ROUTES
// ============================================================

function App() {
  return (
    <Routes>
      <Route path="/" element={<CustomerStore />} />
      <Route path="/merchant" element={<Merchant />} />
    </Routes>
  );
}

export default App;