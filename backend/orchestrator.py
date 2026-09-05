import os
import sys
import csv
import time
import smtplib
import threading
import urllib.parse
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta
from pathlib import Path
from dotenv import load_dotenv

# Database and environment setup
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.append(str(BASE_DIR))

load_dotenv(BASE_DIR / ".env")

# Tracking server configuration
TRACKING_PORT = int(os.getenv("TRACKING_PORT", "8005"))
TRACKING_BASE_URL = os.getenv("TRACKING_BASE_URL", f"http://localhost:{TRACKING_PORT}")
REDIRECT_TARGET_URL = os.getenv("REDIRECT_TARGET_URL", "http://localhost:3000")

# Product Catalog path
CATALOG_PATH = BASE_DIR.parent / "frontend" / "public" / "product_catalog_for_realistic_sales.csv"

# Indian Standard Time (IST = UTC + 5:30)
try:
    from zoneinfo import ZoneInfo
    IST = ZoneInfo("Asia/Kolkata")
except Exception:
    IST = timezone(timedelta(hours=5, minutes=30), name="IST")

from database import get_connection
from model import recommend_next_products


# ==============================================================================
# PRODUCT CATALOG IN-MEMORY CACHE
# ==============================================================================

CATALOG_BY_ID = {}
CATALOG_BY_CAT = {}

def load_product_catalog():
    """Loads product catalog from frontend/public CSV for quick item lookups."""
    global CATALOG_BY_ID, CATALOG_BY_CAT
    if CATALOG_BY_ID and CATALOG_BY_CAT:
        return

    if not CATALOG_PATH.exists():
        print(f"⚠️ [Catalog Warning] Catalog file not found at {CATALOG_PATH}")
        return

    with open(CATALOG_PATH, mode="r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            pid = r.get("product_id")
            category = r.get("category", "")
            subcategory = r.get("subcategory", "")
            try:
                price = float(r.get("price", 0.0))
            except ValueError:
                price = 0.0

            item = {
                "product_id": pid,
                "category": category,
                "subcategory": subcategory,
                "color": r.get("color", ""),
                "material": r.get("material", ""),
                "description": r.get("description", ""),
                "price": price,
            }
            CATALOG_BY_ID[pid] = item

            cat_key = (category.strip().lower(), subcategory.strip().lower())
            if cat_key not in CATALOG_BY_CAT:
                CATALOG_BY_CAT[cat_key] = []
            CATALOG_BY_CAT[cat_key].append(item)


def get_catalog_product(product_id: str):
    """Retrieves product details by product ID."""
    load_product_catalog()
    return CATALOG_BY_ID.get(product_id, {
        "product_id": product_id,
        "category": "Shirts",
        "subcategory": "Formal Shirt",
        "color": "Classic",
        "material": "Cotton",
        "price": 69.99
    })


def find_catalog_product_for_recommendation(category: str, subcategory: str):
    """Finds a matching product in catalog for the recommended category and subcategory."""
    load_product_catalog()
    cat_key = (category.strip().lower(), subcategory.strip().lower())
    matches = CATALOG_BY_CAT.get(cat_key, [])
    if matches:
        return matches[0]

    # Fallback to general category match
    for (c, s), items in CATALOG_BY_CAT.items():
        if c == category.strip().lower() and items:
            return items[0]

    # Default fallback item
    return {
        "product_id": "P00001",
        "category": category,
        "subcategory": subcategory,
        "color": "Classic Blue",
        "material": "Premium Cotton",
        "price": 79.99
    }


# ==============================================================================
# DATABASE SCHEMA MIGRATION
# ==============================================================================

def ensure_campaigns_columns():
    """Ensures opened, open_link, purchased, and email_number columns exist in campaigns table."""
    conn = get_connection()
    cursor = conn.cursor()
    existing = [c[1] for c in cursor.execute("PRAGMA table_info(campaigns)").fetchall()]
    if "opened" not in existing:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN opened TEXT DEFAULT 'no'")
    if "open_link" not in existing:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN open_link TEXT DEFAULT 'no'")
    if "purchased" not in existing:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN purchased TEXT DEFAULT 'no'")
    if "email_number" not in existing:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN email_number INTEGER DEFAULT 1")
    conn.commit()
    conn.close()


# ==============================================================================
# TRACKING SERVER & REDIRECT HANDLER
# ==============================================================================

def record_link_open(customer_id: str, campaign_id: int = None, product_id: str = None):
    """
    Updates open_link and opened columns to 'yes' for the specified customer and campaign.
    Redirects to the storefront with recommended product highlighted.
    """
    ensure_campaigns_columns()
    cid = customer_id.strip().upper()
    conn = get_connection()
    cursor = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()

    if campaign_id is not None:
        cursor.execute("""
            UPDATE campaigns
            SET open_link = 'yes',
                opened = 'yes'
            WHERE campaign_id = ?
        """, (campaign_id,))
    else:
        cursor.execute("""
            SELECT campaign_id FROM campaigns
            WHERE customer_id = ?
            ORDER BY campaign_id DESC LIMIT 1
        """, (cid,))
        existing = cursor.fetchone()
        if existing:
            campaign_id = existing["campaign_id"]
            cursor.execute("""
                UPDATE campaigns
                SET open_link = 'yes',
                    opened = 'yes'
                WHERE campaign_id = ?
            """, (campaign_id,))
        else:
            cursor.execute("""
                INSERT INTO campaigns (
                    customer_id, campaign_type, sent_at, status, opened, open_link, purchased, email_number
                ) VALUES (?, 'campaign_offer_1', ?, 'sent', 'yes', 'yes', 'no', 1)
            """, (cid, now))
            campaign_id = cursor.lastrowid

    conn.commit()
    conn.close()
    print(f"🎯 [Tracking Event] Customer '{cid}' (Campaign #{campaign_id}, Product: {product_id}): 'open_link' set to 'yes'.")
    return campaign_id


class TrackingRedirectHandler(BaseHTTPRequestHandler):
    """
    HTTP Request Handler that records campaign link clicks
    and redirects the user to http://localhost:3000.
    """
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path in ("/click", "/track", "/open", "/"):
            params = urllib.parse.parse_qs(parsed.query)
            customer_ids = params.get("customer_id") or params.get("cid") or []
            campaign_ids = params.get("campaign_id") or params.get("camp_id") or []
            product_ids = params.get("product_id") or params.get("pid") or []
            types = params.get("type") or []

            target_cid = customer_ids[0] if customer_ids else ""
            target_campaign_id = int(campaign_ids[0]) if campaign_ids and campaign_ids[0].isdigit() else None
            target_pid = product_ids[0] if product_ids else ""
            target_type = types[0] if types else ""

            if target_cid:
                record_link_open(target_cid, campaign_id=target_campaign_id, product_id=target_pid)
            else:
                print("⚠️ [Tracking Event] Click received with no customer_id parameter.")

            # Segment-specific discounts:
            # Dormant: 20% | At-Risk: 15% | High-Value: 10% | Active & Loyal: 5%
            if target_type == "dormant":
                discount_val = 20
            elif target_type == "at_risk":
                discount_val = 15
            elif target_type == "high_value":
                discount_val = 10
            else:
                discount_val = 5

            redirect_url = REDIRECT_TARGET_URL
            if target_pid:
                redirect_url += f"?product_id={urllib.parse.quote(target_pid)}&discount={discount_val}"

            self.send_response(302)
            self.send_header("Location", redirect_url)
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        print(f"🌐 [Redirect Server] {self.address_string()} - {format % args}")


def start_tracking_server(port: int = TRACKING_PORT):
    """Starts the redirect tracking HTTP server in a background daemon thread."""
    server = HTTPServer(("0.0.0.0", port), TrackingRedirectHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"🚀 [Tracking Server Active] Listening at http://localhost:{port}/click?customer_id=<ID>&campaign_id=<ID>&product_id=<PID>")
    print(f"🔗 [Redirect Target] When clicked, redirects to {REDIRECT_TARGET_URL} & sets open_link='yes'")
    return server


# ==============================================================================
# PURE SQLITE CUSTOMER SEGMENTATION (WITHOUT segmentation.py)
# ==============================================================================

def get_active_customers_from_db():
    """Identifies 'Active Customers' directly using SQLite commands on campaign.db past_sales."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    WITH customer_rfm AS (
        SELECT 
            s.customer_id,
            COUNT(*) AS orders,
            SUM(s.unit_price * s.quantity) AS total_spend,
            MAX(s.transaction_date) AS last_purchase_date,
            MIN(s.transaction_date) AS first_purchase_date,
            CAST(julianday((SELECT MAX(transaction_date) FROM past_sales)) - julianday(MAX(s.transaction_date)) AS INTEGER) AS recency,
            CAST(julianday((SELECT MAX(transaction_date) FROM past_sales)) - julianday(MIN(s.transaction_date)) AS INTEGER) AS tenure
        FROM past_sales s
        GROUP BY s.customer_id
    ),
    scored AS (
        SELECT 
            customer_id, orders, total_spend, last_purchase_date, recency, tenure,
            PERCENT_RANK() OVER (ORDER BY orders) AS orders_pct,
            PERCENT_RANK() OVER (ORDER BY total_spend) AS spend_pct
        FROM customer_rfm
    ),
    classified AS (
        SELECT customer_id, orders, recency, last_purchase_date,
            CASE
                WHEN tenure <= 60 THEN 'New Customers'
                WHEN recency > 120 THEN 'Dormant Customers'
                WHEN recency > 60 AND recency <= 120 THEN 'At-Risk Customers'
                WHEN spend_pct >= 0.85 THEN 'High-Value Customers'
                WHEN orders >= 20 OR (orders_pct >= 0.75 AND spend_pct >= 0.65) THEN 'Loyal Customers'
                WHEN recency <= 14 AND orders >= 12 THEN 'Cart/Intent Customers'
                WHEN orders <= 10 OR spend_pct <= 0.30 THEN 'Browsers/Prospects'
                ELSE 'Active Customers'
            END AS segment
        FROM scored
    )
    SELECT 
        c.customer_id,
        COALESCE(cust.email, lower(c.customer_id) || '@gmail.com') AS email,
        c.orders,
        c.recency,
        c.last_purchase_date
    FROM classified c
    LEFT JOIN customers cust ON c.customer_id = cust.customer_id
    WHERE c.segment = 'Active Customers'
       OR c.customer_id IN (SELECT DISTINCT customer_id FROM campaigns WHERE campaign_type LIKE 'active_cross_sell_%')
    ORDER BY c.recency ASC, c.customer_id ASC
    """

    cursor.execute(query)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_loyal_customers_from_db():
    """Identifies 'Loyal Customers' directly using SQLite commands on campaign.db past_sales."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    WITH customer_rfm AS (
        SELECT 
            s.customer_id,
            COUNT(*) AS orders,
            SUM(s.unit_price * s.quantity) AS total_spend,
            MAX(s.transaction_date) AS last_purchase_date,
            MIN(s.transaction_date) AS first_purchase_date,
            CAST(julianday((SELECT MAX(transaction_date) FROM past_sales)) - julianday(MAX(s.transaction_date)) AS INTEGER) AS recency,
            CAST(julianday((SELECT MAX(transaction_date) FROM past_sales)) - julianday(MIN(s.transaction_date)) AS INTEGER) AS tenure
        FROM past_sales s
        GROUP BY s.customer_id
    ),
    scored AS (
        SELECT 
            customer_id, orders, total_spend, last_purchase_date, recency, tenure,
            PERCENT_RANK() OVER (ORDER BY orders) AS orders_pct,
            PERCENT_RANK() OVER (ORDER BY total_spend) AS spend_pct
        FROM customer_rfm
    ),
    classified AS (
        SELECT customer_id, orders, total_spend, recency, tenure, last_purchase_date,
            CASE
                WHEN tenure <= 60 THEN 'New Customers'
                WHEN recency > 120 THEN 'Dormant Customers'
                WHEN recency > 60 AND recency <= 120 THEN 'At-Risk Customers'
                WHEN spend_pct >= 0.85 THEN 'High-Value Customers'
                WHEN orders >= 20 OR (orders_pct >= 0.75 AND spend_pct >= 0.65) THEN 'Loyal Customers'
                WHEN recency <= 14 AND orders >= 12 THEN 'Cart/Intent Customers'
                WHEN orders <= 10 OR spend_pct <= 0.30 THEN 'Browsers/Prospects'
                ELSE 'Active Customers'
            END AS segment
        FROM scored
    )
    SELECT 
        c.customer_id,
        COALESCE(cust.email, lower(c.customer_id) || '@gmail.com') AS email,
        c.orders,
        c.total_spend,
        c.recency,
        c.last_purchase_date
    FROM classified c
    LEFT JOIN customers cust ON c.customer_id = cust.customer_id
    WHERE c.segment = 'Loyal Customers'
       OR c.customer_id IN (SELECT DISTINCT customer_id FROM campaigns WHERE campaign_type LIKE 'loyal_upsell_%')
    ORDER BY c.orders DESC, c.total_spend DESC
    """

    cursor.execute(query)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_high_value_customers_from_db():
    """Identifies 'High-Value Customers' directly using SQLite commands on campaign.db past_sales."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    WITH customer_rfm AS (
        SELECT 
            s.customer_id,
            COUNT(*) AS orders,
            SUM(s.unit_price * s.quantity) AS total_spend,
            MAX(s.transaction_date) AS last_purchase_date,
            MIN(s.transaction_date) AS first_purchase_date,
            CAST(julianday((SELECT MAX(transaction_date) FROM past_sales)) - julianday(MAX(s.transaction_date)) AS INTEGER) AS recency,
            CAST(julianday((SELECT MAX(transaction_date) FROM past_sales)) - julianday(MIN(s.transaction_date)) AS INTEGER) AS tenure
        FROM past_sales s
        GROUP BY s.customer_id
    ),
    scored AS (
        SELECT 
            customer_id, orders, total_spend, last_purchase_date, recency, tenure,
            PERCENT_RANK() OVER (ORDER BY orders) AS orders_pct,
            PERCENT_RANK() OVER (ORDER BY total_spend) AS spend_pct
        FROM customer_rfm
    ),
    classified AS (
        SELECT customer_id, orders, total_spend, recency, tenure, last_purchase_date,
            CASE
                WHEN tenure <= 60 THEN 'New Customers'
                WHEN recency > 120 THEN 'Dormant Customers'
                WHEN recency > 60 AND recency <= 120 THEN 'At-Risk Customers'
                WHEN spend_pct >= 0.85 THEN 'High-Value Customers'
                WHEN orders >= 20 OR (orders_pct >= 0.75 AND spend_pct >= 0.65) THEN 'Loyal Customers'
                WHEN recency <= 14 AND orders >= 12 THEN 'Cart/Intent Customers'
                WHEN orders <= 10 OR spend_pct <= 0.30 THEN 'Browsers/Prospects'
                ELSE 'Active Customers'
            END AS segment
        FROM scored
    )
    SELECT 
        c.customer_id,
        COALESCE(cust.email, lower(c.customer_id) || '@gmail.com') AS email,
        c.orders,
        c.total_spend,
        c.recency,
        c.last_purchase_date
    FROM classified c
    LEFT JOIN customers cust ON c.customer_id = cust.customer_id
    WHERE c.segment = 'High-Value Customers'
       OR c.customer_id IN (SELECT DISTINCT customer_id FROM campaigns WHERE campaign_type LIKE 'high_value_upsell_%')
    ORDER BY c.total_spend DESC, c.orders DESC
    """

    cursor.execute(query)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_at_risk_customers_from_db():
    """
    Identifies 'At-Risk Customers' directly using SQLite commands on campaign.db past_sales.
    Condition: recency > 60 days AND recency <= 120 days.
    """
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    WITH customer_rfm AS (
        SELECT
            s.customer_id,
            COUNT(*) AS orders,
            SUM(s.unit_price * s.quantity) AS total_spend,
            MAX(s.transaction_date) AS last_purchase_date,
            MIN(s.transaction_date) AS first_purchase_date,
            CAST(
                julianday((SELECT MAX(transaction_date) FROM past_sales))
                - julianday(MAX(s.transaction_date))
                AS INTEGER
            ) AS recency,
            CAST(
                julianday((SELECT MAX(transaction_date) FROM past_sales))
                - julianday(MIN(s.transaction_date))
                AS INTEGER
            ) AS tenure
        FROM past_sales s
        GROUP BY s.customer_id
    ),
    scored AS (
        SELECT
            customer_id, orders, total_spend, last_purchase_date, recency, tenure,
            PERCENT_RANK() OVER (ORDER BY orders) AS orders_pct,
            PERCENT_RANK() OVER (ORDER BY total_spend) AS spend_pct
        FROM customer_rfm
    ),
    classified AS (
        SELECT
            customer_id, orders, total_spend, recency, last_purchase_date,
            CASE
                WHEN tenure <= 60 THEN 'New Customers'
                WHEN recency > 120 THEN 'Dormant Customers'
                WHEN recency > 60 AND recency <= 120 THEN 'At-Risk Customers'
                WHEN spend_pct >= 0.85 THEN 'High-Value Customers'
                WHEN orders >= 20 OR (orders_pct >= 0.75 AND spend_pct >= 0.65) THEN 'Loyal Customers'
                ELSE 'Active Customers'
            END AS segment
        FROM scored
    )
    SELECT
        c.customer_id,
        COALESCE(cust.email, lower(c.customer_id) || '@gmail.com') AS email,
        c.orders,
        c.total_spend,
        c.recency,
        c.last_purchase_date
    FROM classified c
    LEFT JOIN customers cust ON c.customer_id = cust.customer_id
    WHERE c.segment = 'At-Risk Customers'
       OR c.customer_id IN (SELECT DISTINCT customer_id FROM campaigns WHERE campaign_type LIKE 'at_risk_reengage_%')
    ORDER BY c.recency DESC
    """

    cursor.execute(query)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_dormant_customers_from_db():
    """
    Identifies 'Dormant Customers' directly using SQLite commands on campaign.db past_sales.
    Condition: recency > 120 days.
    """
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    query = """
    WITH customer_rfm AS (
        SELECT
            s.customer_id,
            COUNT(*) AS orders,
            SUM(s.unit_price * s.quantity) AS total_spend,
            MAX(s.transaction_date) AS last_purchase_date,
            MIN(s.transaction_date) AS first_purchase_date,
            CAST(
                julianday((SELECT MAX(transaction_date) FROM past_sales))
                - julianday(MAX(s.transaction_date))
                AS INTEGER
            ) AS recency,
            CAST(
                julianday((SELECT MAX(transaction_date) FROM past_sales))
                - julianday(MIN(s.transaction_date))
                AS INTEGER
            ) AS tenure
        FROM past_sales s
        GROUP BY s.customer_id
    ),
    scored AS (
        SELECT
            customer_id, orders, total_spend, last_purchase_date, recency, tenure,
            PERCENT_RANK() OVER (ORDER BY orders) AS orders_pct,
            PERCENT_RANK() OVER (ORDER BY total_spend) AS spend_pct
        FROM customer_rfm
    ),
    classified AS (
        SELECT
            customer_id, orders, total_spend, recency, last_purchase_date,
            CASE
                WHEN tenure <= 60 THEN 'New Customers'
                WHEN recency > 120 THEN 'Dormant Customers'
                WHEN recency > 60 AND recency <= 120 THEN 'At-Risk Customers'
                WHEN spend_pct >= 0.85 THEN 'High-Value Customers'
                WHEN orders >= 20 OR (orders_pct >= 0.75 AND spend_pct >= 0.65) THEN 'Loyal Customers'
                ELSE 'Active Customers'
            END AS segment
        FROM scored
    )
    SELECT
        c.customer_id,
        COALESCE(cust.email, lower(c.customer_id) || '@gmail.com') AS email,
        c.orders,
        c.total_spend,
        c.recency,
        c.last_purchase_date
    FROM classified c
    LEFT JOIN customers cust ON c.customer_id = cust.customer_id
    WHERE c.segment = 'Dormant Customers'
       OR c.customer_id IN (SELECT DISTINCT customer_id FROM campaigns WHERE campaign_type LIKE 'dormant_winback_%')
    ORDER BY c.recency DESC
    """

    cursor.execute(query)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_customer_latest_purchase(customer_id: str):
    """Retrieves customer's latest purchase (product_id, category, subcategory) from SQLite past_sales."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT product_id, transaction_date
        FROM past_sales
        WHERE customer_id = ?
        ORDER BY transaction_date DESC, transaction_id DESC
        LIMIT 1
    """, (customer_id.strip().upper(),))
    row = cursor.fetchone()
    conn.close()

    if row:
        pid = row["product_id"]
        return get_catalog_product(pid)

    return get_catalog_product("P00001")


# ==============================================================================
# CAMPAIGN 1: ACTIVE CUSTOMERS — CROSS-SELL & UPSELL EVALUATOR (MAX 3)
# ==============================================================================

def evaluate_active_customer_eligibility(cid: str):
    """Evaluates whether an Active Customer is eligible for their next campaign email."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT campaign_id, email_number, open_link, opened, sent_at, purchased
        FROM campaigns
        WHERE customer_id = ? AND campaign_type LIKE 'active_cross_sell_%'
        ORDER BY email_number ASC, campaign_id ASC
    """, (cid,))
    history = [dict(r) for r in cursor.fetchall()]

    cursor.execute("""
        SELECT count(*) FROM campaigns
        WHERE customer_id = ? AND purchased = 'yes'
    """, (cid,))
    purchased_campaign_count = cursor.fetchone()[0]
    conn.close()

    if purchased_campaign_count > 0:
        return {
            "eligible": False,
            "status": "TERMINATED_PURCHASED",
            "reason": "Terminated (Rule 1): Customer purchased a product during the campaign",
            "next_email_number": None,
            "history": history
        }

    k = len(history)
    if k >= 3:
        return {
            "eligible": False,
            "status": "CAMPAIGN_COMPLETED_MAX_REACHED",
            "reason": "Completed: Maximum 3 emails reached for Active Customer campaign",
            "next_email_number": None,
            "history": history
        }

    if k > 0:
        last_email = history[-1]
        try:
            last_sent_at = datetime.fromisoformat(last_email["sent_at"])
            if last_sent_at.tzinfo is None:
                last_sent_at = last_sent_at.replace(tzinfo=timezone.utc)
            elapsed_days = (datetime.now(timezone.utc) - last_sent_at).total_seconds() / 86400.0
            if elapsed_days < 4.0:
                remaining_days = 4.0 - elapsed_days
                return {
                    "eligible": False,
                    "status": "COOLDOWN",
                    "reason": f"In 4-day cooldown: Email #{k} sent {elapsed_days:.1f} days ago (next check in {remaining_days:.1f} days)",
                    "next_email_number": None,
                    "history": history
                }
        except Exception:
            pass

    if k == 0:
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #1 (ML-Based Cross-sell)", "next_email_number": 1, "history": history}
    if k == 1:
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #2 (ML-Based Complementary)", "next_email_number": 2, "history": history}
    if k == 2:
        clicked = (history[0].get("open_link") == "yes" or history[0].get("opened") == "yes" or history[1].get("open_link") == "yes" or history[1].get("opened") == "yes")
        if not clicked:
            return {"eligible": False, "status": "TERMINATED_UNENGAGED", "reason": "Terminated (Rule 2): Both Email #1 and Email #2 links were unclicked", "next_email_number": None, "history": history}
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #3 (Engagement verified)", "next_email_number": 3, "history": history}


# ==============================================================================
# CAMPAIGN 2: LOYAL CUSTOMERS — LOYALTY & PREMIUM UPSELL EVALUATOR (MAX 3)
# ==============================================================================

def evaluate_loyal_customer_eligibility(cid: str):
    """Evaluates whether a Loyal Customer is eligible for their next campaign email."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT campaign_id, email_number, open_link, opened, sent_at, purchased
        FROM campaigns
        WHERE customer_id = ? AND campaign_type LIKE 'loyal_upsell_%'
        ORDER BY email_number ASC, campaign_id ASC
    """, (cid,))
    history = [dict(r) for r in cursor.fetchall()]

    cursor.execute("""
        SELECT count(*) FROM campaigns
        WHERE customer_id = ? AND purchased = 'yes'
    """, (cid,))
    purchased_campaign_count = cursor.fetchone()[0]
    conn.close()

    if purchased_campaign_count > 0:
        return {
            "eligible": False,
            "status": "TERMINATED_PURCHASED",
            "reason": "Terminated (Rule 1): Customer purchased a product during the campaign",
            "next_email_number": None,
            "history": history
        }

    k = len(history)
    if k >= 3:
        return {
            "eligible": False,
            "status": "CAMPAIGN_COMPLETED_MAX_REACHED",
            "reason": "Completed: Maximum 3 emails reached for Loyal Customer campaign",
            "next_email_number": None,
            "history": history
        }

    if k > 0:
        last_email = history[-1]
        try:
            last_sent_at = datetime.fromisoformat(last_email["sent_at"])
            if last_sent_at.tzinfo is None:
                last_sent_at = last_sent_at.replace(tzinfo=timezone.utc)
            elapsed_days = (datetime.now(timezone.utc) - last_sent_at).total_seconds() / 86400.0
            if elapsed_days < 4.0:
                remaining_days = 4.0 - elapsed_days
                return {
                    "eligible": False,
                    "status": "COOLDOWN",
                    "reason": f"In 4-day cooldown: Email #{k} sent {elapsed_days:.1f} days ago (next check in {remaining_days:.1f} days)",
                    "next_email_number": None,
                    "history": history
                }
        except Exception:
            pass

    if k == 0:
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #1 (Personalized Loyalty Recommendation)", "next_email_number": 1, "history": history}
    if k == 1:
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #2 (Complementary / Premium Recommendation)", "next_email_number": 2, "history": history}
    if k == 2:
        clicked = (history[0].get("open_link") == "yes" or history[0].get("opened") == "yes" or history[1].get("open_link") == "yes" or history[1].get("opened") == "yes")
        if not clicked:
            return {"eligible": False, "status": "TERMINATED_UNENGAGED", "reason": "Terminated (Rule 2): Both Email #1 and Email #2 links were unclicked", "next_email_number": None, "history": history}
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #3 (Engagement verified)", "next_email_number": 3, "history": history}


# ==============================================================================
# CAMPAIGN 3: HIGH-VALUE CUSTOMERS — PREMIUM UPSELL & RETENTION EVALUATOR (MAX 3)
# ==============================================================================

def evaluate_high_value_customer_eligibility(cid: str):
    """Evaluates whether a High-Value Customer is eligible for their next campaign email."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT campaign_id, email_number, open_link, opened, sent_at, purchased
        FROM campaigns
        WHERE customer_id = ? AND campaign_type LIKE 'high_value_upsell_%'
        ORDER BY email_number ASC, campaign_id ASC
    """, (cid,))
    history = [dict(r) for r in cursor.fetchall()]

    cursor.execute("""
        SELECT count(*) FROM campaigns
        WHERE customer_id = ? AND purchased = 'yes'
    """, (cid,))
    purchased_campaign_count = cursor.fetchone()[0]
    conn.close()

    if purchased_campaign_count > 0:
        return {
            "eligible": False,
            "status": "TERMINATED_PURCHASED",
            "reason": "Terminated (Rule 1): Customer purchased a product during the campaign",
            "next_email_number": None,
            "history": history
        }

    k = len(history)
    if k >= 3:
        return {
            "eligible": False,
            "status": "CAMPAIGN_COMPLETED_MAX_REACHED",
            "reason": "Completed: Maximum 3 emails reached for High-Value Customer campaign",
            "next_email_number": None,
            "history": history
        }

    if k > 0:
        last_email = history[-1]
        try:
            last_sent_at = datetime.fromisoformat(last_email["sent_at"])
            if last_sent_at.tzinfo is None:
                last_sent_at = last_sent_at.replace(tzinfo=timezone.utc)
            elapsed_days = (datetime.now(timezone.utc) - last_sent_at).total_seconds() / 86400.0
            if elapsed_days < 4.0:
                remaining_days = 4.0 - elapsed_days
                return {
                    "eligible": False,
                    "status": "COOLDOWN",
                    "reason": f"In 4-day cooldown: Email #{k} sent {elapsed_days:.1f} days ago (next check in {remaining_days:.1f} days)",
                    "next_email_number": None,
                    "history": history
                }
        except Exception:
            pass

    if k == 0:
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #1 (Personalized Premium Recommendation)", "next_email_number": 1, "history": history}
    if k == 1:
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #2 (Complementary Premium Product)", "next_email_number": 2, "history": history}
    if k == 2:
        clicked = (history[0].get("open_link") == "yes" or history[0].get("opened") == "yes" or history[1].get("open_link") == "yes" or history[1].get("opened") == "yes")
        if not clicked:
            return {"eligible": False, "status": "TERMINATED_UNENGAGED", "reason": "Terminated (Rule 2): Both Email #1 and Email #2 links were unclicked", "next_email_number": None, "history": history}
        return {"eligible": True, "status": "ACTIVE", "reason": "Eligible for Email #3 (Engagement verified)", "next_email_number": 3, "history": history}


# ==============================================================================
# CAMPAIGN 4: AT-RISK CUSTOMERS — RE-ENGAGEMENT & RETENTION (MAX 5 EMAILS)
# ==============================================================================

def evaluate_at_risk_customer_eligibility(cid: str):
    """Evaluates whether an At-Risk Customer is eligible for their next campaign email (max 5 emails)."""
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT campaign_id, email_number, open_link, opened, sent_at, purchased
        FROM campaigns
        WHERE customer_id = ? AND campaign_type LIKE 'at_risk_reengage_%'
        ORDER BY email_number ASC, campaign_id ASC
    """, (cid,))
    history = [dict(r) for r in cursor.fetchall()]

    cursor.execute("""
        SELECT count(*) FROM campaigns
        WHERE customer_id = ? AND purchased = 'yes'
    """, (cid,))
    purchased_campaign_count = cursor.fetchone()[0]
    conn.close()

    if purchased_campaign_count > 0:
        return {
            "eligible": False,
            "status": "TERMINATED_PURCHASED",
            "reason": "Terminated (Rule 1): Customer purchased a product during the campaign",
            "next_email_number": None,
            "history": history
        }

    k = len(history)
    if k >= 5:
        return {
            "eligible": False,
            "status": "CAMPAIGN_COMPLETED_MAX_REACHED",
            "reason": "Completed: Maximum 5 emails reached for At-Risk Customer campaign",
            "next_email_number": None,
            "history": history
        }

    if k > 0:
        last_email = history[-1]
        try:
            last_sent_at = datetime.fromisoformat(last_email["sent_at"])
            if last_sent_at.tzinfo is None:
                last_sent_at = last_sent_at.replace(tzinfo=timezone.utc)
            elapsed_days = (datetime.now(timezone.utc) - last_sent_at).total_seconds() / 86400.0
            if elapsed_days < 4.0:
                remaining_days = 4.0 - elapsed_days
                return {
                    "eligible": False,
                    "status": "COOLDOWN",
                    "reason": f"In 4-day cooldown: Email #{k} sent {elapsed_days:.1f} days ago (next check in {remaining_days:.1f} days)",
                    "next_email_number": None,
                    "history": history
                }
        except Exception:
            pass

    if k >= 2:
        last_two = history[-2:]
        clicked_any = any(h.get("open_link") == "yes" or h.get("opened") == "yes" for h in last_two)
        if not clicked_any:
            prev_num1 = last_two[0].get("email_number", k - 1)
            prev_num2 = last_two[1].get("email_number", k)
            return {
                "eligible": False,
                "status": "TERMINATED_UNENGAGED",
                "reason": f"Terminated (Rule 2): Last two emails (Email #{prev_num1} & #{prev_num2}) links were not clicked by the customer",
                "next_email_number": None,
                "history": history
            }

    next_step = k + 1
    return {
        "eligible": True,
        "status": "ACTIVE",
        "reason": f"Eligible for Email #{next_step}",
        "next_email_number": next_step,
        "history": history
    }


# ==============================================================================
# CAMPAIGN 5: DORMANT CUSTOMERS — WIN-BACK & RE-ENGAGEMENT (MAX 10 EMAILS)
# ==============================================================================

def evaluate_dormant_customer_eligibility(cid: str):
    """
    Evaluates whether a Dormant Customer is eligible for their next campaign email:
    
    1. Maximum Cap:
       - Strictly capped at MAXIMUM 10 EMAILS for Dormant Customers.
       - Once Email #10 is sent, sequence is completed.
       
    2. 4-Day Cadence Spacing:
       - Actual emails spaced by at least 4 days from previous email.
       
    3. Termination Rule 1 (Purchase):
       - If customer purchases at ANY point: Immediately terminate campaign.
       
    4. Block-of-3 Engagement Checks:
       - Emails are sent in blocks of 3:
         Block 1: Emails 1, 2, 3
         Block 2: Emails 4, 5, 6
         Block 3: Emails 7, 8, 9
         Final: Email 10
       - After every 3 emails (at k=3, k=6, k=9):
         Check whether at least ONE of the preceding 3 emails was clicked or opened.
         If YES -> Continue with the next block.
         If NONE -> Terminate the campaign (TERMINATED_UNENGAGED).
    """
    ensure_campaigns_columns()
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT campaign_id, email_number, open_link, opened, sent_at, purchased
        FROM campaigns
        WHERE customer_id = ? AND campaign_type LIKE 'dormant_winback_%'
        ORDER BY email_number ASC, campaign_id ASC
    """, (cid,))
    history = [dict(r) for r in cursor.fetchall()]

    cursor.execute("""
        SELECT count(*) FROM campaigns
        WHERE customer_id = ? AND purchased = 'yes'
    """, (cid,))
    purchased_campaign_count = cursor.fetchone()[0]
    conn.close()

    # Priority 1: Purchase Termination
    if purchased_campaign_count > 0:
        return {
            "eligible": False,
            "status": "TERMINATED_PURCHASED",
            "reason": "Terminated (Rule 1): Customer purchased a product during the campaign",
            "next_email_number": None,
            "history": history
        }

    k = len(history)

    # Maximum 10 emails reached
    if k >= 10:
        return {
            "eligible": False,
            "status": "CAMPAIGN_COMPLETED_MAX_REACHED",
            "reason": "Completed: Maximum 10 emails reached for Dormant Customer campaign",
            "next_email_number": None,
            "history": history
        }

    # 4-Day Cadence Spacing Check
    if k > 0:
        last_email = history[-1]
        try:
            last_sent_at = datetime.fromisoformat(last_email["sent_at"])
            if last_sent_at.tzinfo is None:
                last_sent_at = last_sent_at.replace(tzinfo=timezone.utc)
            elapsed_days = (datetime.now(timezone.utc) - last_sent_at).total_seconds() / 86400.0

            if elapsed_days < 4.0:
                remaining_days = 4.0 - elapsed_days
                return {
                    "eligible": False,
                    "status": "COOLDOWN",
                    "reason": f"In 4-day cooldown: Email #{k} sent {elapsed_days:.1f} days ago (next check in {remaining_days:.1f} days)",
                    "next_email_number": None,
                    "history": history
                }
        except Exception:
            pass

    # Block-of-3 Engagement Evaluations:
    # Check #1: After Email #3 (evaluates Block 1: Emails 1, 2, 3)
    if k == 3:
        block_1 = history[0:3]
        clicked_or_opened = any(h.get("open_link") == "yes" or h.get("opened") == "yes" for h in block_1)
        if not clicked_or_opened:
            return {
                "eligible": False,
                "status": "TERMINATED_UNENGAGED",
                "reason": "Terminated (Block 1 Check): None of Emails #1, #2, or #3 were clicked or opened by the customer",
                "next_email_number": None,
                "history": history
            }

    # Check #2: After Email #6 (evaluates Block 2: Emails 4, 5, 6)
    if k == 6:
        block_2 = history[3:6]
        clicked_or_opened = any(h.get("open_link") == "yes" or h.get("opened") == "yes" for h in block_2)
        if not clicked_or_opened:
            return {
                "eligible": False,
                "status": "TERMINATED_UNENGAGED",
                "reason": "Terminated (Block 2 Check): None of Emails #4, #5, or #6 were clicked or opened by the customer",
                "next_email_number": None,
                "history": history
            }

    # Check #3: After Email #9 (evaluates Block 3: Emails 7, 8, 9)
    if k == 9:
        block_3 = history[6:9]
        clicked_or_opened = any(h.get("open_link") == "yes" or h.get("opened") == "yes" for h in block_3)
        if not clicked_or_opened:
            return {
                "eligible": False,
                "status": "TERMINATED_UNENGAGED",
                "reason": "Terminated (Block 3 Check): None of Emails #7, #8, or #9 were clicked or opened by the customer",
                "next_email_number": None,
                "history": history
            }

    next_step = k + 1
    return {
        "eligible": True,
        "status": "ACTIVE",
        "reason": f"Eligible for Email #{next_step}",
        "next_email_number": next_step,
        "history": history
    }


# ==============================================================================
# EMAIL TEMPLATES: ACTIVE, LOYAL, HIGH-VALUE, AT-RISK & DORMANT
# ==============================================================================

def get_active_customer_email_content(step: int, cid: str, prev_item: dict, rec_item: dict, catalog_product: dict, tracking_url: str):
    """Builds email copy for Active Customers (5% discount)."""
    prev_name = f"{prev_item.get('subcategory', '')} ({prev_item.get('category', '')})".strip()
    rec_name = f"{catalog_product.get('subcategory', '')} - {catalog_product.get('color', '')} {catalog_product.get('material', '')}".strip()
    original_price = catalog_product.get("price", 79.99)
    discounted_price = round(original_price * 0.95, 2)

    templates = {
        1: {"subject": f"🌟 Perfect Match For Your {prev_item.get('subcategory', 'Purchase')}! (5% Member Discount)", "header_badge": "Active Member • Cross-Sell", "headline": f"We Found the Perfect Match for Your {prev_item.get('subcategory', 'Purchase')}! 🌟", "intro": f"Thank you for your recent purchase of the <strong>{prev_name}</strong>! Our styling model identified the next best match for you.", "cta": f"👉 View Matching Item (Rs. {discounted_price:.2f})"},
        2: {"subject": f"✨ Complete Your Look: Complementary {catalog_product.get('subcategory', 'Style')} Inside", "header_badge": "Active Member • Complementary", "headline": "Elevate Your Style with a Complementary Piece ✨", "intro": f"Our styling engine selected this complementary <strong>{catalog_product.get('subcategory')}</strong> to pair with your collection.", "cta": f"👉 Claim 5% OFF (Rs. {discounted_price:.2f})"},
        3: {"subject": f"🔥 VIP Upgrade: Premium Bundle & Upsell Just For You", "header_badge": "Active Member • VIP Upsell", "headline": "Exclusive Upgrade: Premium Style Bundle 🔥", "intro": f"We've unlocked our top-tier signature piece: <strong>{rec_name}</strong> with a 5% privilege.", "cta": f"👉 Grab VIP Upsell (Rs. {discounted_price:.2f})"}
    }
    t = templates.get(step, templates[1])
    plain_text = f"Hi {cid},\n\n{t['headline']}\n\n{t['intro'].replace('<strong>', '').replace('</strong>', '')}\n\nRecommended: {rec_name}\nPrice: Rs. {discounted_price:.2f} (5% OFF with code ACTIVE5)\n\nLink: {tracking_url}"
    html_content = f"""<html><body style="font-family: sans-serif; line-height: 1.6; color: #1e293b; background: #f8fafc; padding: 20px;"><div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px;"><div style="display: inline-block; background: #eff6ff; color: #2563eb; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; margin-bottom: 12px;">{t['header_badge']}</div><h2>{t['headline']}</h2><p>Hi <strong>{cid}</strong>,</p><p>{t['intro']}</p><div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 24px 0;"><div style="font-size: 18px; font-weight: 700;">{rec_name}</div><div style="font-size: 13px; color: #64748b;">{catalog_product.get('category')} > {catalog_product.get('subcategory')}</div><div style="margin-top: 10px;"><span style="text-decoration: line-through; color: #94a3b8;">Rs. {original_price:.2f}</span><span style="font-size: 20px; font-weight: 800; color: #16a34a; margin-left: 8px;">Rs. {discounted_price:.2f}</span><span style="background: #dcfce7; color: #15803d; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">5% OFF (ACTIVE5)</span></div></div><div style="text-align: center; margin: 24px 0;"><a href="{tracking_url}" style="background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">{t['cta']}</a></div></div></body></html>"""
    return t["subject"], plain_text, html_content


def get_loyal_customer_email_content(step: int, cid: str, prev_item: dict, rec_item: dict, catalog_product: dict, tracking_url: str):
    """Builds email copy for Loyal Customers (5% discount)."""
    prev_name = f"{prev_item.get('subcategory', '')} ({prev_item.get('category', '')})".strip()
    rec_name = f"{catalog_product.get('subcategory', '')} - {catalog_product.get('color', '')} {catalog_product.get('material', '')}".strip()
    original_price = catalog_product.get("price", 89.99)
    discounted_price = round(original_price * 0.95, 2)

    templates = {
        1: {"subject": f"👑 VIP Loyalty Reward: Handpicked For Your Collection (5% Privilege)", "header_badge": "Loyal Patron • Personalized", "headline": "A Special Loyalty Curation Just For You 👑", "intro": f"Based on your established shopping preferences, our styling model selected this signature piece for your collection.", "cta": f"👉 Claim 5% Privilege (Rs. {discounted_price:.2f})"},
        2: {"subject": f"✨ Premium Styling: Complementary Designer Piece Just For You", "header_badge": "Loyal Patron • Complementary", "headline": "Complementary Designer Piece for Your Wardrobe ✨", "intro": f"To expand your look, our model recommends this premium complementary <strong>{catalog_product.get('subcategory')}</strong>.", "cta": f"👉 Explore Premium Piece (Rs. {discounted_price:.2f})"},
        3: {"subject": f"💎 Exclusive Member Bundle & Upsell: Complete Signature Set", "header_badge": "Loyal Patron • VIP Bundle", "headline": "Exclusive Signature Bundle & Premium Upsell 💎", "intro": f"As a gesture of our appreciation, we have unlocked our signature recommendation: <strong>{rec_name}</strong>.", "cta": f"👉 Claim Signature Upsell (Rs. {discounted_price:.2f})"}
    }
    t = templates.get(step, templates[1])
    plain_text = f"Dear {cid},\n\n{t['headline']}\n\n{t['intro'].replace('<strong>', '').replace('</strong>', '')}\n\nRecommended: {rec_name}\nPrice: Rs. {discounted_price:.2f} (5% OFF with code LOYAL5)\n\nLink: {tracking_url}"
    html_content = f"""<html><body style="font-family: sans-serif; line-height: 1.6; color: #0f172a; background: #f1f5f9; padding: 24px;"><div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 14px; border: 1px solid #cbd5e1; padding: 34px;"><div style="display: inline-block; background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 800; padding: 5px 12px; border-radius: 9999px; margin-bottom: 14px;">{t['header_badge']}</div><h2>{t['headline']}</h2><p>Dear <strong>{cid}</strong>,</p><p>{t['intro']}</p><div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 22px; margin: 24px 0; border-left: 4px solid #f59e0b;"><div style="font-size: 19px; font-weight: 800;">{rec_name}</div><div style="font-size: 13px; color: #64748b;">{catalog_product.get('category')} > {catalog_product.get('subcategory')}</div><div style="margin-top: 10px;"><span style="text-decoration: line-through; color: #94a3b8;">Rs. {original_price:.2f}</span><span style="font-size: 22px; font-weight: 900; color: #b45309; margin-left: 10px;">Rs. {discounted_price:.2f}</span><span style="background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; margin-left: 8px;">5% OFF (LOYAL5)</span></div></div><div style="text-align: center; margin: 30px 0;"><a href="{tracking_url}" style="background: #d97706; color: #ffffff; padding: 15px 32px; text-decoration: none; border-radius: 8px; font-weight: 800; display: inline-block;">{t['cta']}</a></div></div></body></html>"""
    return t["subject"], plain_text, html_content


def get_high_value_customer_email_content(step: int, cid: str, prev_item: dict, rec_item: dict, catalog_product: dict, tracking_url: str):
    """Builds email copy for High-Value Customers (10% discount)."""
    prev_name = f"{prev_item.get('subcategory', '')} ({prev_item.get('category', '')})".strip()
    rec_name = f"{catalog_product.get('subcategory', '')} - {catalog_product.get('color', '')} {catalog_product.get('material', '')}".strip()
    original_price = catalog_product.get("price", 119.99)
    discounted_price = round(original_price * 0.90, 2)

    templates = {
        1: {"subject": f"✨ Curated Private Selection: Premium Tailoring Just For You (10% Privilege)", "header_badge": "Private Client • Premium", "headline": "Curated Private Selection: Handpicked Luxury ✨", "intro": f"Drawing from your recent appreciation of the <strong>{prev_name}</strong>, our concierge curated this premium piece for you.", "cta": f"👉 Reserve Private Selection (Rs. {discounted_price:.2f})"},
        2: {"subject": f"🌟 Exclusive Complementary Collection: Designer Piece Inside (10% OFF)", "header_badge": "Private Client • Complementary", "headline": "A Harmonious Complement to Your Premier Collection 🌟", "intro": f"Handcrafted in <strong>{catalog_product.get('material', 'pure luxury')}</strong>, this <strong>{catalog_product.get('subcategory')}</strong> seamlessly pairs with your collection.", "cta": f"👉 Explore Designer Piece (Rs. {discounted_price:.2f})"},
        3: {"subject": f"💎 Pinnacle Luxury: Signature Bundle & Complete Ensemble (10% Exclusive)", "header_badge": "Private Client • Signature Bundle", "headline": "The Pinnacle Collection: Signature Luxury Bundle 💎", "intro": f"We unveil our finest ensemble pairing: <strong>{rec_name}</strong> with an exclusive 10% concierge courtesy.", "cta": f"👉 Acquire Luxury Ensemble (Rs. {discounted_price:.2f})"}
    }
    t = templates.get(step, templates[1])
    plain_text = f"Dear {cid},\n\n{t['headline']}\n\n{t['intro'].replace('<strong>', '').replace('</strong>', '')}\n\nCurated Selection: {rec_name}\nPrice: Rs. {discounted_price:.2f} (10% Privilege with code HIGHVAL10)\n\nLink: {tracking_url}"
    html_content = f"""<html><body style="font-family: sans-serif; line-height: 1.6; color: #fafafa; background: #09090b; padding: 24px;"><div style="max-width: 580px; margin: 0 auto; background: #18181b; border-radius: 16px; border: 1px solid #27272a; padding: 36px;"><div style="display: inline-block; background: #fbbf24; color: #000; font-size: 11px; font-weight: 900; padding: 5px 14px; border-radius: 9999px; margin-bottom: 16px;">{t['header_badge']}</div><h2>{t['headline']}</h2><p style="color: #a1a1aa;">Dear <strong>{cid}</strong>,</p><p style="color: #d4d4d8;">{t['intro']}</p><div style="background: #27272a; border: 1px solid #3f3f46; border-radius: 12px; padding: 24px; margin: 26px 0; border-left: 4px solid #f59e0b;"><div style="font-size: 20px; font-weight: 800;">{rec_name}</div><div style="font-size: 13px; color: #a1a1aa;">{catalog_product.get('category')} > {catalog_product.get('subcategory')}</div><div style="margin-top: 10px;"><span style="text-decoration: line-through; color: #71717a;">Rs. {original_price:.2f}</span><span style="font-size: 23px; font-weight: 900; color: #fbbf24; margin-left: 12px;">Rs. {discounted_price:.2f}</span><span style="background: rgba(245,158,11,0.2); color: #fcd34d; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; margin-left: 8px;">10% OFF (HIGHVAL10)</span></div></div><div style="text-align: center; margin: 32px 0;"><a href="{tracking_url}" style="background: #f59e0b; color: #000; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 900; display: inline-block;">{t['cta']}</a></div></div></body></html>"""
    return t["subject"], plain_text, html_content


def get_at_risk_customer_email_content(step: int, cid: str, prev_item: dict, rec_item: dict, catalog_product: dict, tracking_url: str):
    """Builds email copy for At-Risk Customers (15% discount)."""
    prev_name = f"{prev_item.get('subcategory', '')} ({prev_item.get('category', '')})".strip()
    rec_name = f"{catalog_product.get('subcategory', '')} - {catalog_product.get('color', '')} {catalog_product.get('material', '')}".strip()
    original_price = catalog_product.get("price", 84.99)
    discounted_price = round(original_price * 0.85, 2)

    templates = {
        1: {"subject": f"👋 We Miss You, {cid}! Here's 15% OFF a Special Style Match", "header_badge": "Welcome Back • 15% OFF", "headline": "It's Been a While — We Saved Something Special for You! 👋", "intro": f"Remembering how much you loved the <strong>{prev_name}</strong>, our styling engine hand-picked this matching <strong>{catalog_product.get('subcategory')}</strong>.", "cta": f"👉 Claim 15% Welcome-Back Discount (Rs. {discounted_price:.2f})"},
        2: {"subject": f"✨ Fresh Perspectives: Alternative Style Match (15% Re-engagement Inside)", "header_badge": "Curated Comeback • 15% OFF", "headline": "Fresh Ideas Curated Specifically for You ✨", "intro": f"Our styling model generated this complementary <strong>{catalog_product.get('subcategory')}</strong> with an instant 15% re-engagement offer.", "cta": f"👉 Explore Complementary Match (Rs. {discounted_price:.2f})"},
        3: {"subject": f"🎁 Exclusive Re-engagement Bundle: Handpicked Style Set (15% OFF)", "header_badge": "Curated Bundle • 15% Privilege", "headline": "Complete Your Ensemble with an Exclusive Bundle 🎁", "intro": f"Our team bundled this signature recommendation: <strong>{rec_name}</strong> with an instant 15% discount.", "cta": f"👉 Unlock Re-engagement Bundle (Rs. {discounted_price:.2f})"},
        4: {"subject": f"🌟 Special Comeback Showcase: Top Trending Item Picked For You (15% OFF)", "header_badge": "Trending Comeback • 15% OFF", "headline": "Trending Now: A Fresh Style Pick Just For You 🌟", "intro": f"We've unlocked another top-rated favorite from our latest collection: <strong>{rec_name}</strong>.", "cta": f"👉 View Trending Favorite (Rs. {discounted_price:.2f})"},
        5: {"subject": f"⏳ Final Re-engagement Courtesy: 15% OFF Signature Selection", "header_badge": "Final Call • 15% OFF", "headline": "Final Call: Your 15% Courtesy on Our Signature Selection ⏳", "intro": f"This is our final invitation for this re-engagement showcase: <strong>{rec_name}</strong> with your full 15% courtesy.", "cta": f"👉 Claim Final 15% Privilege (Rs. {discounted_price:.2f})"}
    }
    t = templates.get(step, templates[1])
    plain_text = f"Hi {cid},\n\n{t['headline']}\n\n{t['intro'].replace('<strong>', '').replace('</strong>', '')}\n\nRecommended: {rec_name}\nPrice: Rs. {discounted_price:.2f} (15% OFF with code ATRISK15)\n\nLink: {tracking_url}"
    html_content = f"""<html><body style="font-family: sans-serif; line-height: 1.6; color: #1e293b; background: #f8fafc; padding: 20px;"><div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px;"><div style="display: inline-block; background: #fee2e2; color: #b91c1c; font-size: 12px; font-weight: 800; padding: 4px 12px; border-radius: 9999px; margin-bottom: 12px;">{t['header_badge']}</div><h2>{t['headline']}</h2><p>Hi <strong>{cid}</strong>,</p><p>{t['intro']}</p><div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 22px; margin: 24px 0; border-left: 4px solid #ef4444;"><div style="font-size: 19px; font-weight: 700;">{rec_name}</div><div style="font-size: 13px; color: #64748b;">{catalog_product.get('category')} > {catalog_product.get('subcategory')}</div><div style="margin-top: 10px;"><span style="text-decoration: line-through; color: #94a3b8;">Rs. {original_price:.2f}</span><span style="font-size: 22px; font-weight: 800; color: #dc2626; margin-left: 10px;">Rs. {discounted_price:.2f}</span><span style="background: #fee2e2; color: #b91c1c; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; margin-left: 8px;">15% OFF (ATRISK15)</span></div></div><div style="text-align: center; margin: 28px 0;"><a href="{tracking_url}" style="background: #dc2626; color: #ffffff; padding: 15px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">{t['cta']}</a></div></div></body></html>"""
    return t["subject"], plain_text, html_content


def get_dormant_customer_email_content(step: int, cid: str, prev_item: dict, rec_item: dict, catalog_product: dict, tracking_url: str):
    """
    Builds progressive win-back email copy for Dormant Customers (20% Win-Back Discount).
    Supports steps 1 through 10.
    """
    prev_name = f"{prev_item.get('subcategory', '')} ({prev_item.get('category', '')})".strip()
    rec_name = f"{catalog_product.get('subcategory', '')} - {catalog_product.get('color', '')} {catalog_product.get('material', '')}".strip()
    original_price = catalog_product.get("price", 89.99)
    discounted_price = round(original_price * 0.80, 2)  # 20% Win-Back discount

    block_num = 1 if step <= 3 else (2 if step <= 6 else (3 if step <= 9 else 4))

    templates = {
        1: {"subject": f"🎁 A Long-Awaited Welcome Back Gift for {cid}: 20% OFF Inside!", "badge": "Win-Back Special • 20% OFF", "headline": "We've Missed You! A Special 20% Gift Awaits You 🎁", "intro": f"It has been quite some time since we last connected! As someone who appreciated our <strong>{prev_name}</strong>, we've hand-picked this matching <strong>{catalog_product.get('subcategory')}</strong> with an instant 20% win-back courtesy.", "cta": f"👉 Claim 20% Win-Back Privilege (Rs. {discounted_price:.2f})"},
        2: {"subject": f"✨ Rediscover Your Wardrobe: Curated {catalog_product.get('subcategory')} (20% OFF)", "badge": "Rediscover Style • 20% OFF", "headline": "Rediscover Quality Crafted Just For You ✨", "intro": f"Our AI styling engine curated this complementary <strong>{catalog_product.get('subcategory')}</strong> in {catalog_product.get('material', 'premium fabric')} to bring you back to our family.", "cta": f"👉 Explore 20% Discounted Style (Rs. {discounted_price:.2f})"},
        3: {"subject": f"🔥 Final Days of Block 1 Courtesy: 20% OFF Signature Match", "badge": "Curated Match • 20% OFF", "headline": "Exclusive Pairing to Reignite Your Collection 🔥", "intro": f"Before we wrap up our opening win-back showcase, enjoy 20% savings on this signature piece: <strong>{rec_name}</strong>.", "cta": f"👉 Unlock Signature Piece (Rs. {discounted_price:.2f})"},
        4: {"subject": f"🌟 Block 2 Premiere: Handcrafted Luxury Selection (20% OFF)", "badge": "New Curations • 20% OFF", "headline": "Welcome to Our Second Showcase of Curations 🌟", "intro": f"We're glad to have you exploring again! Here is our next featured piece: <strong>{rec_name}</strong> with your full 20% win-back courtesy.", "cta": f"👉 View New Curation (Rs. {discounted_price:.2f})"},
        5: {"subject": f"💫 Elevate Your Everyday Style: Complementary Designer Item (20% OFF)", "badge": "Designer Companion • 20% OFF", "headline": "Designed to Complement Your Unique Taste 💫", "intro": f"Crafted with meticulous attention to detail, discover how well this <strong>{catalog_product.get('subcategory')}</strong> pairs with your established aesthetic.", "cta": f"👉 Claim 20% Designer Savings (Rs. {discounted_price:.2f})"},
        6: {"subject": f"🎯 Mid-Season Win-Back Special: Curated Match Just For You", "badge": "Mid-Season Special • 20% OFF", "headline": "A Fresh Look at Our Most Popular Collection 🎯", "intro": f"Take advantage of this special 20% courtesy on our best-selling <strong>{rec_name}</strong>.", "cta": f"👉 Shop Popular Selection (Rs. {discounted_price:.2f})"},
        7: {"subject": f"💎 Block 3 VIP Showcase: Premium Collection Preview (20% OFF)", "badge": "VIP Win-Back • 20% OFF", "headline": "Exclusive VIP Win-Back Selection 💎", "intro": f"Our styling engine has unlocked our premier tier of recommendations: <strong>{rec_name}</strong> with an immediate 20% courtesy.", "cta": f"👉 Access VIP Win-Back Preview (Rs. {discounted_price:.2f})"},
        8: {"subject": f"✨ Tailored Luxury: Exclusive Pairing for {cid} (20% OFF)", "badge": "Tailored Luxury • 20% OFF", "headline": "A Tailored Luxury Experience Crafted for You ✨", "intro": f"Rediscover the comfort and distinction of our top-tier items: <strong>{rec_name}</strong>.", "cta": f"👉 Explore Tailored Luxury (Rs. {discounted_price:.2f})"},
        9: {"subject": f"⚡ Limited Allocation: Signature Curated Bundle (20% OFF)", "badge": "Curated Bundle • 20% OFF", "headline": "Signature Bundle Curated for Your Return ⚡", "intro": f"This signature combination is reserved for returning patrons: <strong>{rec_name}</strong> with 20% privilege.", "cta": f"👉 Acquire Signature Bundle (Rs. {discounted_price:.2f})"},
        10: {"subject": f"🏁 Pinnacle Finale: Final Win-Back Courtesy for {cid} (20% OFF)", "badge": "Grand Finale • 20% OFF", "headline": "Our Grand Finale Win-Back Courtesy 🏁", "intro": f"This is our tenth and final personalized showcase. We have reserved our pinnacle selection: <strong>{rec_name}</strong> with our highest 20% courtesy.", "cta": f"👉 Claim Grand Finale 20% Privilege (Rs. {discounted_price:.2f})"}
    }

    t = templates.get(step, templates[1])
    plain_text = (
        f"Hi {cid},\n\n"
        f"{t['headline']}\n\n"
        f"{t['intro'].replace('<strong>', '').replace('</strong>', '')}\n\n"
        f"Recommended: {rec_name}\n"
        f"Category: {catalog_product.get('category')} > {catalog_product.get('subcategory')}\n"
        f"Win-Back Price: Rs. {discounted_price:.2f} (20% OFF with code WINBACK20)\n\n"
        f"Access your offer:\n"
        f"{tracking_url}\n\n"
        f"Warm regards,\n"
        f"Store VIP Win-Back Team"
    )

    html_content = f"""
    <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1e1b4b; background-color: #f5f3ff; padding: 22px;">
            <div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 14px; border: 1px solid #ddd6fe; padding: 34px; box-shadow: 0 8px 24px -4px rgba(109, 40, 217, 0.08);">
                <div style="display: inline-block; background: #ede9fe; color: #6d28d9; font-size: 11px; font-weight: 800; padding: 5px 14px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px; border: 1px solid #c4b5fd;">
                    {t['badge']} (Block #{block_num} • Email #{step} of 10)
                </div>
                <h2 style="color: #2e1065; margin-top: 0; font-size: 22px;">{t['headline']}</h2>
                <p>Hi <strong>{cid}</strong>,</p>
                <p style="color: #4338ca; font-size: 15px;">{t['intro']}</p>

                <!-- Recommendation Card -->
                <div style="background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 12px; padding: 22px; margin: 24px 0; border-left: 4px solid #7c3aed;">
                    <div style="font-size: 11px; color: #7c3aed; text-transform: uppercase; font-weight: 800;">
                        AI Win-Back Recommendation • Rank #{rec_item.get('rank', step)}
                    </div>
                    <div style="font-size: 19px; font-weight: 800; color: #1e1b4b; margin: 6px 0;">
                        {rec_name}
                    </div>
                    <div style="font-size: 13px; color: #6b7280; margin-bottom: 12px;">
                        Category: <strong>{catalog_product.get('category')}</strong> • Subcategory: <strong>{catalog_product.get('subcategory')}</strong>
                    </div>
                    <div style="font-size: 15px;">
                        <span style="text-decoration: line-through; color: #9ca3af; font-size: 16px;">Rs. {original_price:.2f}</span>
                        <span style="font-size: 22px; font-weight: 900; color: #6d28d9; margin-left: 10px;">Rs. {discounted_price:.2f}</span>
                        <span style="background: #ede9fe; color: #6d28d9; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; margin-left: 8px; border: 1px solid #c4b5fd;">20% OFF (WINBACK20)</span>
                    </div>
                    <div style="font-size: 12px; color: #6b7280; margin-top: 8px;">
                        🎯 <em>Curated to celebrate your return based on your appreciation of {prev_item.get('subcategory', 'our collection')}.</em>
                    </div>
                </div>

                <div style="margin: 30px 0; text-align: center;">
                    <a href="{tracking_url}" 
                       style="background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%); color: #ffffff; padding: 15px 34px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block; box-shadow: 0 4px 16px rgba(124, 58, 237, 0.35);">
                        {t['cta']}
                    </a>
                </div>

                <p style="font-size: 12px; color: #9ca3af; line-height: 1.4;">
                    If the button above does not work, copy and paste this link into your browser:<br/>
                    <a href="{tracking_url}" style="color: #6d28d9; word-break: break-all;">{tracking_url}</a>
                </p>
                <hr style="border: 0; border-top: 1px solid #e9d5ff; margin: 24px 0;" />
                <p style="font-size: 13px; color: #6b7280; margin: 0;">Warm regards,<br/><strong>Store VIP Win-Back Team</strong></p>
            </div>
        </body>
    </html>
    """

    return t["subject"], plain_text, html_content


# ==============================================================================
# DISPATCHERS FOR CAMPAIGNS
# ==============================================================================

def send_active_customer_email(cid: str, recipient_email: str, step: int, tracking_base_url: str = TRACKING_BASE_URL):
    ensure_campaigns_columns()
    load_dotenv(BASE_DIR / ".env")
    gmail_address = os.getenv("GMAIL_ADDRESS", "spjnaman@gmail.com")
    gmail_password = os.getenv("GMAIL_APP_PASSWORD")
    if not gmail_password:
        return False

    prev_item = get_customer_latest_purchase(cid)
    recs = recommend_next_products(prev_item.get("category", "Shirts"), prev_item.get("subcategory", "Formal Shirt"), top_k=3)
    rec_index = min(step - 1, len(recs) - 1) if recs else 0
    rec_item = recs[rec_index] if recs else {"rank": step, "recommended_category": "Pants & Jeans", "recommended_subcategory": "Straight Leg Jeans", "percentage_of_customers": 18.5}
    catalog_product = find_catalog_product_for_recommendation(rec_item["recommended_category"], rec_item["recommended_subcategory"])
    product_id = catalog_product["product_id"]

    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO campaigns (customer_id, campaign_type, email_number, discount_percent, sent_at, status, opened, open_link, purchased) VALUES (?, ?, ?, 5, ?, 'sent', 'no', 'no', 'no')", (cid, f"active_cross_sell_{step}", step, now))
    campaign_id = cursor.lastrowid
    conn.commit()
    conn.close()

    tracking_url = f"{tracking_base_url}/click?customer_id={cid}&campaign_id={campaign_id}&product_id={product_id}"
    subject, plain_text, html_content = get_active_customer_email_content(step, cid, prev_item, rec_item, catalog_product, tracking_url)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"], msg["Cc"] = subject, gmail_address, recipient_email, "spjnaman@gmail.com"
    msg.set_content(plain_text)
    msg.add_alternative(html_content, subtype="html")

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(gmail_address, gmail_password)
            smtp.send_message(msg)
        print(f"  ✅ [Active Email #{step}] To: {cid} ({recipient_email}) | Product: {product_id} | Link: {tracking_url}")
        return True
    except Exception as e:
        print(f"  ❌ [Send Failed Active Email #{step}] To: {cid}: {e}")
        return False


def send_loyal_customer_email(cid: str, recipient_email: str, step: int, tracking_base_url: str = TRACKING_BASE_URL):
    ensure_campaigns_columns()
    load_dotenv(BASE_DIR / ".env")
    gmail_address = os.getenv("GMAIL_ADDRESS", "spjnaman@gmail.com")
    gmail_password = os.getenv("GMAIL_APP_PASSWORD")
    if not gmail_password:
        return False

    prev_item = get_customer_latest_purchase(cid)
    recs = recommend_next_products(prev_item.get("category", "Shirts"), prev_item.get("subcategory", "Formal Shirt"), top_k=3)
    rec_index = min(step - 1, len(recs) - 1) if recs else 0
    rec_item = recs[rec_index] if recs else {"rank": step, "recommended_category": "Blazers & Suits", "recommended_subcategory": "Tailored Blazer", "percentage_of_customers": 24.0}
    catalog_product = find_catalog_product_for_recommendation(rec_item["recommended_category"], rec_item["recommended_subcategory"])
    product_id = catalog_product["product_id"]

    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO campaigns (customer_id, campaign_type, email_number, discount_percent, sent_at, status, opened, open_link, purchased) VALUES (?, ?, ?, 5, ?, 'sent', 'no', 'no', 'no')", (cid, f"loyal_upsell_{step}", step, now))
    campaign_id = cursor.lastrowid
    conn.commit()
    conn.close()

    tracking_url = f"{tracking_base_url}/click?customer_id={cid}&campaign_id={campaign_id}&product_id={product_id}&type=loyal"
    subject, plain_text, html_content = get_loyal_customer_email_content(step, cid, prev_item, rec_item, catalog_product, tracking_url)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"], msg["Cc"] = subject, gmail_address, recipient_email, "spjnaman@gmail.com"
    msg.set_content(plain_text)
    msg.add_alternative(html_content, subtype="html")

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(gmail_address, gmail_password)
            smtp.send_message(msg)
        print(f"  ✅ [Loyal Email #{step}] To: {cid} ({recipient_email}) | Product: {product_id} | Link: {tracking_url}")
        return True
    except Exception as e:
        print(f"  ❌ [Send Failed Loyal Email #{step}] To: {cid}: {e}")
        return False


def send_high_value_customer_email(cid: str, recipient_email: str, step: int, tracking_base_url: str = TRACKING_BASE_URL):
    ensure_campaigns_columns()
    load_dotenv(BASE_DIR / ".env")
    gmail_address = os.getenv("GMAIL_ADDRESS", "spjnaman@gmail.com")
    gmail_password = os.getenv("GMAIL_APP_PASSWORD")
    if not gmail_password:
        return False

    prev_item = get_customer_latest_purchase(cid)
    recs = recommend_next_products(prev_item.get("category", "Shirts"), prev_item.get("subcategory", "Formal Shirt"), top_k=3)
    rec_index = min(step - 1, len(recs) - 1) if recs else 0
    rec_item = recs[rec_index] if recs else {"rank": step, "recommended_category": "Blazers & Suits", "recommended_subcategory": "Tailored Blazer", "percentage_of_customers": 26.0}
    catalog_product = find_catalog_product_for_recommendation(rec_item["recommended_category"], rec_item["recommended_subcategory"])
    product_id = catalog_product["product_id"]

    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO campaigns (customer_id, campaign_type, email_number, discount_percent, sent_at, status, opened, open_link, purchased) VALUES (?, ?, ?, 10, ?, 'sent', 'no', 'no', 'no')", (cid, f"high_value_upsell_{step}", step, now))
    campaign_id = cursor.lastrowid
    conn.commit()
    conn.close()

    tracking_url = f"{tracking_base_url}/click?customer_id={cid}&campaign_id={campaign_id}&product_id={product_id}&type=high_value"
    subject, plain_text, html_content = get_high_value_customer_email_content(step, cid, prev_item, rec_item, catalog_product, tracking_url)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"], msg["Cc"] = subject, gmail_address, recipient_email, "spjnaman@gmail.com"
    msg.set_content(plain_text)
    msg.add_alternative(html_content, subtype="html")

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(gmail_address, gmail_password)
            smtp.send_message(msg)
        print(f"  ✅ [High-Value Email #{step}] To: {cid} ({recipient_email}) | Product: {product_id} | Link: {tracking_url}")
        return True
    except Exception as e:
        print(f"  ❌ [Send Failed High-Value Email #{step}] To: {cid}: {e}")
        return False


def send_at_risk_customer_email(cid: str, recipient_email: str, step: int, tracking_base_url: str = TRACKING_BASE_URL):
    ensure_campaigns_columns()
    load_dotenv(BASE_DIR / ".env")
    gmail_address = os.getenv("GMAIL_ADDRESS", "spjnaman@gmail.com")
    gmail_password = os.getenv("GMAIL_APP_PASSWORD")
    if not gmail_password:
        return False

    prev_item = get_customer_latest_purchase(cid)
    recs = recommend_next_products(prev_item.get("category", "Shirts"), prev_item.get("subcategory", "Formal Shirt"), top_k=5)
    rec_index = min(step - 1, len(recs) - 1) if recs else 0
    rec_item = recs[rec_index] if recs else {"rank": step, "recommended_category": "Pants & Jeans", "recommended_subcategory": "Straight Leg Jeans", "percentage_of_customers": 18.5}
    catalog_product = find_catalog_product_for_recommendation(rec_item["recommended_category"], rec_item["recommended_subcategory"])
    product_id = catalog_product["product_id"]

    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO campaigns (customer_id, campaign_type, email_number, discount_percent, sent_at, status, opened, open_link, purchased) VALUES (?, ?, ?, 15, ?, 'sent', 'no', 'no', 'no')", (cid, f"at_risk_reengage_{step}", step, now))
    campaign_id = cursor.lastrowid
    conn.commit()
    conn.close()

    tracking_url = f"{tracking_base_url}/click?customer_id={cid}&campaign_id={campaign_id}&product_id={product_id}&type=at_risk"
    subject, plain_text, html_content = get_at_risk_customer_email_content(step, cid, prev_item, rec_item, catalog_product, tracking_url)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"], msg["Cc"] = subject, gmail_address, recipient_email, "spjnaman@gmail.com"
    msg.set_content(plain_text)
    msg.add_alternative(html_content, subtype="html")

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(gmail_address, gmail_password)
            smtp.send_message(msg)
        print(f"  ✅ [At-Risk Email #{step}] To: {cid} ({recipient_email}) | Product: {product_id} | Link: {tracking_url}")
        return True
    except Exception as e:
        print(f"  ❌ [Send Failed At-Risk Email #{step}] To: {cid}: {e}")
        return False


def send_dormant_customer_email(cid: str, recipient_email: str, step: int, tracking_base_url: str = TRACKING_BASE_URL):
    """Dispatches Email #step for Dormant Customers (20% discount, up to 10 emails)."""
    ensure_campaigns_columns()
    load_dotenv(BASE_DIR / ".env")
    gmail_address = os.getenv("GMAIL_ADDRESS", "spjnaman@gmail.com")
    gmail_password = os.getenv("GMAIL_APP_PASSWORD")
    if not gmail_password:
        return False

    prev_item = get_customer_latest_purchase(cid)
    recs = recommend_next_products(prev_item.get("category", "Shirts"), prev_item.get("subcategory", "Formal Shirt"), top_k=10)
    rec_index = min(step - 1, len(recs) - 1) if recs else 0
    rec_item = recs[rec_index] if recs else {"rank": step, "recommended_category": "Shirts", "recommended_subcategory": "Overshirt", "percentage_of_customers": 12.0}
    catalog_product = find_catalog_product_for_recommendation(rec_item["recommended_category"], rec_item["recommended_subcategory"])
    product_id = catalog_product["product_id"]

    now = datetime.now(timezone.utc).isoformat()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO campaigns (customer_id, campaign_type, email_number, discount_percent, sent_at, status, opened, open_link, purchased) VALUES (?, ?, ?, 20, ?, 'sent', 'no', 'no', 'no')", (cid, f"dormant_winback_{step}", step, now))
    campaign_id = cursor.lastrowid
    conn.commit()
    conn.close()

    tracking_url = f"{tracking_base_url}/click?customer_id={cid}&campaign_id={campaign_id}&product_id={product_id}&type=dormant"
    subject, plain_text, html_content = get_dormant_customer_email_content(step, cid, prev_item, rec_item, catalog_product, tracking_url)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"], msg["Cc"] = subject, gmail_address, recipient_email, "spjnaman@gmail.com"
    msg.set_content(plain_text)
    msg.add_alternative(html_content, subtype="html")

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(gmail_address, gmail_password)
            smtp.send_message(msg)
        print(f"  ✅ [Dormant Email #{step}] To: {cid} ({recipient_email}) | Product: {product_id} | Link: {tracking_url}")
        return True
    except Exception as e:
        print(f"  ❌ [Send Failed Dormant Email #{step}] To: {cid}: {e}")
        return False


# ==============================================================================
# CAMPAIGN RUNNERS
# ==============================================================================

def run_campaign_cycle_generic(title: str, get_cust_fn, eval_fn, send_fn, tracking_base_url: str, limit: int = 20):
    now_ist = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S %Z")
    print(f"\n{'='*75}\n🕒 [{title}]\n   Execution Timestamp: {now_ist}\n{'='*75}")
    customers = get_cust_fn()
    if not customers:
        print("⚠️ No customers found in database for this segment.")
        return
    batch = customers[:limit]
    print(f"Evaluating {len(batch)} candidate(s) (Total in segment: {len(customers)}):\n")
    dispatched, skipped_cooldown, terminated, completed = 0, 0, 0, 0
    for idx, c in enumerate(batch, start=1):
        cid, email = c["customer_id"], c["email"]
        eval_result = eval_fn(cid)
        status = eval_result["status"]
        if eval_result["eligible"]:
            dispatched += 1
            print(f"[{idx}/{len(batch)}] 🟢 {cid} -> {eval_result['reason']}")
            send_fn(cid, email, eval_result["next_email_number"], tracking_base_url=tracking_base_url)
        elif status == "COOLDOWN":
            skipped_cooldown += 1
            print(f"[{idx}/{len(batch)}] ⏳ {cid} -> {eval_result['reason']}")
        elif status == "CAMPAIGN_COMPLETED_MAX_REACHED":
            completed += 1
            print(f"[{idx}/{len(batch)}] 🏁 {cid} -> {eval_result['reason']}")
        else:
            terminated += 1
            icon = "🛑" if status == "TERMINATED_PURCHASED" else "⏸️"
            print(f"[{idx}/{len(batch)}] {icon} {cid} -> {eval_result['reason']}")
    print(f"\n📊 Summary: {dispatched} sent | {skipped_cooldown} cooldown | {terminated} terminated | {completed} completed.")


def run_active_customer_engagement_cycle(tracking_base_url: str = TRACKING_BASE_URL, limit: int = 20):
    run_campaign_cycle_generic("Daily 3:00 PM IST — Active Customers", get_active_customers_from_db, evaluate_active_customer_eligibility, send_active_customer_email, tracking_base_url, limit)

def run_loyal_customer_engagement_cycle(tracking_base_url: str = TRACKING_BASE_URL, limit: int = 20):
    run_campaign_cycle_generic("Daily 3:00 PM IST — Loyal Customers", get_loyal_customers_from_db, evaluate_loyal_customer_eligibility, send_loyal_customer_email, tracking_base_url, limit)

def run_high_value_customer_engagement_cycle(tracking_base_url: str = TRACKING_BASE_URL, limit: int = 20):
    run_campaign_cycle_generic("Daily 3:00 PM IST — High-Value Customers", get_high_value_customers_from_db, evaluate_high_value_customer_eligibility, send_high_value_customer_email, tracking_base_url, limit)

def run_at_risk_customer_engagement_cycle(tracking_base_url: str = TRACKING_BASE_URL, limit: int = 20):
    run_campaign_cycle_generic("Daily 3:00 PM IST — At-Risk Customers (Max 5)", get_at_risk_customers_from_db, evaluate_at_risk_customer_eligibility, send_at_risk_customer_email, tracking_base_url, limit)

def run_dormant_customer_engagement_cycle(tracking_base_url: str = TRACKING_BASE_URL, limit: int = 20):
    run_campaign_cycle_generic("Daily 3:00 PM IST — Dormant Customers (Win-Back Max 10)", get_dormant_customers_from_db, evaluate_dormant_customer_eligibility, send_dormant_customer_email, tracking_base_url, limit)


# ==============================================================================
# SCHEDULER (3:00 PM IST DAILY RUNNER)
# ==============================================================================

def get_seconds_until_next_3pm_ist():
    now_ist = datetime.now(IST)
    target_ist = now_ist.replace(hour=15, minute=0, second=0, microsecond=0)
    if now_ist >= target_ist:
        target_ist += timedelta(days=1)
    return (target_ist - now_ist).total_seconds(), target_ist


def start_daily_scheduler(run_immediate: bool = False, campaign: str = "all", tracking_base_url: str = TRACKING_BASE_URL):
    def scheduler_worker():
        if run_immediate:
            print("\n⚡ Running immediate startup campaign cycles...")
            if campaign in ("all", "active"): run_active_customer_engagement_cycle(tracking_base_url=tracking_base_url)
            if campaign in ("all", "loyal"): run_loyal_customer_engagement_cycle(tracking_base_url=tracking_base_url)
            if campaign in ("all", "high_value"): run_high_value_customer_engagement_cycle(tracking_base_url=tracking_base_url)
            if campaign in ("all", "at_risk"): run_at_risk_customer_engagement_cycle(tracking_base_url=tracking_base_url)
            if campaign in ("all", "dormant"): run_dormant_customer_engagement_cycle(tracking_base_url=tracking_base_url)

        while True:
            wait_seconds, next_run = get_seconds_until_next_3pm_ist()
            print(f"\n⏰ [Daily Scheduler Active] Next run: {next_run.strftime('%Y-%m-%d %H:%M:%S %Z')} (in {wait_seconds/3600:.2f} hrs)")
            slept = 0
            while slept < wait_seconds:
                chunk = min(60, wait_seconds - slept)
                time.sleep(chunk)
                slept += chunk

            print("\n🔔 [Daily Scheduler Triggered] It is 3:00 PM IST! Starting campaign cycles...")
            try:
                if campaign in ("all", "active"): run_active_customer_engagement_cycle(tracking_base_url=tracking_base_url)
                if campaign in ("all", "loyal"): run_loyal_customer_engagement_cycle(tracking_base_url=tracking_base_url)
                if campaign in ("all", "high_value"): run_high_value_customer_engagement_cycle(tracking_base_url=tracking_base_url)
                if campaign in ("all", "at_risk"): run_at_risk_customer_engagement_cycle(tracking_base_url=tracking_base_url)
                if campaign in ("all", "dormant"): run_dormant_customer_engagement_cycle(tracking_base_url=tracking_base_url)
            except Exception as e:
                print(f"❌ [Scheduler Error]: {e}")

    thread = threading.Thread(target=scheduler_worker, daemon=True)
    thread.start()
    return thread


# ==============================================================================
# REPORTING & SIMULATION HELPERS
# ==============================================================================

def print_generic_status(customers: list, title: str, eval_fn, limit: int = 15):
    ensure_campaigns_columns()
    print(f"\n{'='*85}\n📋 {title} (Showing {min(limit, len(customers))} of {len(customers)})\n{'='*85}")
    print(f"{'Customer ID':<15} {'Email':<26} {'Sent':<6} {'History (Clicks)':<18} {'Funnel State'}")
    print(f"{'-'*85}")
    for c in customers[:limit]:
        cid, email = c["customer_id"], c["email"]
        eval_result = eval_fn(cid)
        history = eval_result.get("history", [])
        if history:
            click_symbols = [f"E{h.get('email_number', '?')}:{'✓' if (h.get('open_link') == 'yes' or h.get('opened') == 'yes') else '✗'}" for h in history]
            history_str = " ".join(click_symbols)
        else:
            history_str = "None"
        status_display = eval_result["status"]
        if status_display == "ACTIVE":
            status_display += f" (Ready: E#{eval_result['next_email_number']})"
        print(f"{cid:<15} {email:<26} {len(history):<6} {history_str:<18} {status_display}")
    print(f"{'='*85}\n")


def print_engagement_status(limit: int = 15):
    print_generic_status(get_active_customers_from_db(), "Active Customers Pipeline Status", evaluate_active_customer_eligibility, limit=limit)

def print_loyal_engagement_status(limit: int = 15):
    print_generic_status(get_loyal_customers_from_db(), "Loyal Customers Pipeline Status", evaluate_loyal_customer_eligibility, limit=limit)

def print_high_value_engagement_status(limit: int = 15):
    print_generic_status(get_high_value_customers_from_db(), "High-Value Customers Pipeline Status", evaluate_high_value_customer_eligibility, limit=limit)

def print_at_risk_engagement_status(limit: int = 15):
    print_generic_status(get_at_risk_customers_from_db(), "At-Risk Customers Pipeline Status (Max 5)", evaluate_at_risk_customer_eligibility, limit=limit)

def print_dormant_engagement_status(limit: int = 15):
    print_generic_status(get_dormant_customers_from_db(), "Dormant Customers Pipeline Status (Win-Back Max 10)", evaluate_dormant_customer_eligibility, limit=limit)


def seed_test_active_customer(customer_id: str = "CUST_ACTIVE_TEST", email: str = "spjnaman@gmail.com", product_id: str = "P00001"):
    ensure_campaigns_columns()
    conn = get_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()
    c.execute("INSERT OR REPLACE INTO customers (customer_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)", (customer_id, email, now, now))
    c.execute("DELETE FROM past_sales WHERE customer_id = ?", (customer_id,))
    c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, ?, 71.22, 1)", (f"T_ACTIVE_{customer_id}_LATEST", customer_id, now[:10], product_id))
    for i in range(1, 12):
        c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, 'P00133', 60.0, 1)", (f"T_ACTIVE_{customer_id}_{i}", customer_id, (datetime.now(timezone.utc) - timedelta(days=i * 12)).isoformat()[:10]))
    c.execute("DELETE FROM campaigns WHERE customer_id = ?", (customer_id,))
    conn.commit()
    conn.close()
    print(f"✨ [Seeded Active Test Customer] '{customer_id}' ({email}) seeded with previous purchase {product_id}.")


def seed_test_loyal_customer(customer_id: str = "CUST_LOYAL_TEST", email: str = "spjnaman@gmail.com", product_id: str = "P00001"):
    ensure_campaigns_columns()
    conn = get_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()
    c.execute("INSERT OR REPLACE INTO customers (customer_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)", (customer_id, email, now, now))
    c.execute("DELETE FROM past_sales WHERE customer_id = ?", (customer_id,))
    c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, ?, 85.0, 1)", (f"T_LOYAL_{customer_id}_LATEST", customer_id, now[:10], product_id))
    for i in range(1, 22):
        c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, 'P00003', 75.0, 1)", (f"T_LOYAL_{customer_id}_{i}", customer_id, (datetime.now(timezone.utc) - timedelta(days=i * 8)).isoformat()[:10]))
    c.execute("DELETE FROM campaigns WHERE customer_id = ?", (customer_id,))
    conn.commit()
    conn.close()
    print(f"👑 [Seeded Loyal Test Customer] '{customer_id}' ({email}) seeded with 22 orders and previous purchase {product_id}.")


def seed_test_high_value_customer(customer_id: str = "CUST_HIGH_VAL_TEST", email: str = "spjnaman@gmail.com", product_id: str = "P00001"):
    ensure_campaigns_columns()
    conn = get_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()
    c.execute("INSERT OR REPLACE INTO customers (customer_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)", (customer_id, email, now, now))
    c.execute("DELETE FROM past_sales WHERE customer_id = ?", (customer_id,))
    c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, ?, 240.0, 1)", (f"T_HV_{customer_id}_LATEST", customer_id, now[:10], product_id))
    for i in range(1, 18):
        c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, 'P00267', 200.0, 1)", (f"T_HV_{customer_id}_{i}", customer_id, (datetime.now(timezone.utc) - timedelta(days=i * 9)).isoformat()[:10]))
    c.execute("DELETE FROM campaigns WHERE customer_id = ?", (customer_id,))
    conn.commit()
    conn.close()
    print(f"💎 [Seeded High-Value Test Customer] '{customer_id}' ({email}) seeded with > Rs. 3,600 spend and previous purchase {product_id}.")


def seed_test_at_risk_customer(customer_id: str = "CUST_AT_RISK_TEST", email: str = "spjnaman@gmail.com", product_id: str = "P00001"):
    ensure_campaigns_columns()
    conn = get_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc)
    c.execute("INSERT OR REPLACE INTO customers (customer_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)", (customer_id, email, now.isoformat(), now.isoformat()))
    c.execute("DELETE FROM past_sales WHERE customer_id = ?", (customer_id,))
    last_purchase_date = (now - timedelta(days=85)).isoformat()[:10]
    c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, ?, 75.0, 1)", (f"T_ATRISK_{customer_id}_LATEST", customer_id, last_purchase_date, product_id))
    for i in range(1, 8):
        c.execute("INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity) VALUES (?, ?, ?, 'P00012', 65.0, 1)", (f"T_ATRISK_{customer_id}_{i}", customer_id, (now - timedelta(days=85 + (i * 15))).isoformat()[:10]))
    c.execute("DELETE FROM campaigns WHERE customer_id = ?", (customer_id,))
    conn.commit()
    conn.close()
    print(f"🔄 [Seeded At-Risk Test Customer] '{customer_id}' ({email}) seeded with recency = 85 days and previous purchase {product_id}.")


def seed_test_dormant_customer(customer_id: str = "CUST_DORMANT_TEST", email: str = "spjnaman@gmail.com", product_id: str = "P00001"):
    """
    Seeds a test customer in Dormant Customers segment.
    Last purchase was 150 days ago (recency > 120 days).
    """
    ensure_campaigns_columns()
    conn = get_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc)
    c.execute("INSERT OR REPLACE INTO customers (customer_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)", (customer_id, email, now.isoformat(), now.isoformat()))
    c.execute("DELETE FROM past_sales WHERE customer_id = ?", (customer_id,))

    # Last purchase was 150 days ago
    last_purchase_date = (now - timedelta(days=150)).isoformat()[:10]
    c.execute("""
        INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity)
        VALUES (?, ?, ?, ?, 65.0, 1)
    """, (f"T_DORMANT_{customer_id}_LATEST", customer_id, last_purchase_date, product_id))

    # Add earlier purchases so tenure is substantial
    for i in range(1, 10):
        past_date = (now - timedelta(days=150 + (i * 20))).isoformat()[:10]
        c.execute("""
            INSERT INTO past_sales (transaction_id, customer_id, transaction_date, product_id, unit_price, quantity)
            VALUES (?, ?, ?, 'P00008', 55.0, 1)
        """, (f"T_DORMANT_{customer_id}_{i}", customer_id, past_date))

    c.execute("DELETE FROM campaigns WHERE customer_id = ?", (customer_id,))
    conn.commit()
    conn.close()
    print(f"💤 [Seeded Dormant Test Customer] '{customer_id}' ({email}) seeded with recency = 150 days and previous purchase {product_id}.")


def simulate_customer_click(customer_id: str, email_number: int = None):
    conn = get_connection()
    cursor = conn.cursor()
    if email_number is not None:
        cursor.execute("SELECT campaign_id FROM campaigns WHERE customer_id = ? AND email_number = ? ORDER BY campaign_id DESC LIMIT 1", (customer_id, email_number))
    else:
        cursor.execute("SELECT campaign_id FROM campaigns WHERE customer_id = ? ORDER BY campaign_id DESC LIMIT 1", (customer_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        print(f"❌ [Simulate Click] No campaign found for {customer_id} (email_number={email_number})")
        return False
    camp_id = row["campaign_id"]
    record_link_open(customer_id, campaign_id=camp_id)
    print(f"🖱️ [Simulated Click] Customer '{customer_id}' clicked Email #{email_number or 'latest'} (CampID #{camp_id})")
    return True


def simulate_customer_purchase(customer_id: str):
    from database import record_purchase
    res = record_purchase(
        customer_id=customer_id,
        email=f"{customer_id.lower()}@gmail.com",
        amount=120.0,
        payment_id=f"pay_sim_{int(time.time())}",
        items=[{"product_id": "P00009", "price": 120.0, "quantity": 1}]
    )
    print(f"💰 [Simulated Purchase] Purchase recorded for '{customer_id}'. Campaign will terminate.")
    return res


def fast_forward_campaign_dates(customer_id: str, days_back: int = 5):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT campaign_id, sent_at FROM campaigns WHERE customer_id = ?", (customer_id,))
    rows = cursor.fetchall()
    for r in rows:
        old_sent = datetime.fromisoformat(r["sent_at"])
        new_sent = (old_sent - timedelta(days=days_back)).isoformat()
        cursor.execute("UPDATE campaigns SET sent_at = ? WHERE campaign_id = ?", (new_sent, r["campaign_id"]))
    conn.commit()
    conn.close()
    print(f"⏩ [Fast-Forwarded] Shifted campaigns for '{customer_id}' back by {days_back} days.")


# ==============================================================================
# MAIN ENTRYPOINT
# ==============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Campaign Orchestrator — Active, Loyal, High-Value, At-Risk & Dormant Campaigns")
    parser.add_argument("--active-campaign", action="store_true", help="Run Active Customers cross-sell/upsell cycle")
    parser.add_argument("--loyal-campaign", action="store_true", help="Run Loyal Customers loyalty/upsell cycle")
    parser.add_argument("--high-value-campaign", action="store_true", help="Run High-Value Customers premium upsell cycle")
    parser.add_argument("--at-risk-campaign", action="store_true", help="Run At-Risk Customers re-engagement cycle (Max 5)")
    parser.add_argument("--dormant-campaign", action="store_true", help="Run Dormant Customers win-back cycle (Max 10, Blocks of 3)")
    parser.add_argument("--run-now", action="store_true", help="Execute campaign cycles immediately on startup")
    parser.add_argument("--status", action="store_true", help="Display Active Customers pipeline status table")
    parser.add_argument("--status-loyal", action="store_true", help="Display Loyal Customers pipeline status table")
    parser.add_argument("--status-high-value", action="store_true", help="Display High-Value Customers pipeline status table")
    parser.add_argument("--status-at-risk", action="store_true", help="Display At-Risk Customers pipeline status table")
    parser.add_argument("--status-dormant", action="store_true", help="Display Dormant Customers pipeline status table")
    parser.add_argument("--seed-active-test", action="store_true", help="Seed test customer (CUST_ACTIVE_TEST)")
    parser.add_argument("--seed-loyal-test", action="store_true", help="Seed test loyal customer (CUST_LOYAL_TEST)")
    parser.add_argument("--seed-high-value-test", action="store_true", help="Seed test high-value customer (CUST_HIGH_VAL_TEST)")
    parser.add_argument("--seed-at-risk-test", action="store_true", help="Seed test at-risk customer (CUST_AT_RISK_TEST)")
    parser.add_argument("--seed-dormant-test", action="store_true", help="Seed test dormant customer (CUST_DORMANT_TEST)")
    parser.add_argument("--test-cid", type=str, default=None, help="Custom Customer ID for test seeding")
    parser.add_argument("--test-email", type=str, default="spjnaman@gmail.com", help="Custom Email for test seeding")
    parser.add_argument("--test-pid", type=str, default="P00001", help="Previous purchase Product ID for test seeding")
    parser.add_argument("--simulate-click", action="store_true", help="Simulate an email link click for a customer")
    parser.add_argument("--seq", type=int, default=None, help="Email sequence number for simulated click")
    parser.add_argument("--simulate-purchase", action="store_true", help="Simulate a store purchase for a customer")
    parser.add_argument("--fast-forward-days", type=int, default=None, help="Fast forward sent_at by N days for testing cooldown")
    args = parser.parse_args()

    # Seeding actions
    if args.seed_active_test:
        cid = args.test_cid or "CUST_ACTIVE_TEST"
        seed_test_active_customer(customer_id=cid, email=args.test_email, product_id=args.test_pid)

    if args.seed_loyal_test:
        cid = args.test_cid or "CUST_LOYAL_TEST"
        seed_test_loyal_customer(customer_id=cid, email=args.test_email, product_id=args.test_pid)

    if args.seed_high_value_test:
        cid = args.test_cid or "CUST_HIGH_VAL_TEST"
        seed_test_high_value_customer(customer_id=cid, email=args.test_email, product_id=args.test_pid)

    if args.seed_at_risk_test:
        cid = args.test_cid or "CUST_AT_RISK_TEST"
        seed_test_at_risk_customer(customer_id=cid, email=args.test_email, product_id=args.test_pid)

    if args.seed_dormant_test:
        cid = args.test_cid or "CUST_DORMANT_TEST"
        seed_test_dormant_customer(customer_id=cid, email=args.test_email, product_id=args.test_pid)

    # Fast forward action
    if args.fast_forward_days is not None:
        target_cid = args.test_cid or ("CUST_DORMANT_TEST" if args.status_dormant else ("CUST_AT_RISK_TEST" if args.status_at_risk else ("CUST_HIGH_VAL_TEST" if args.status_high_value else ("CUST_LOYAL_TEST" if args.status_loyal else "CUST_ACTIVE_TEST"))))
        fast_forward_campaign_dates(customer_id=target_cid, days_back=args.fast_forward_days)

    # Click simulation
    if args.simulate_click:
        target_cid = args.test_cid or ("CUST_DORMANT_TEST" if args.status_dormant else ("CUST_AT_RISK_TEST" if args.status_at_risk else ("CUST_HIGH_VAL_TEST" if args.status_high_value else ("CUST_LOYAL_TEST" if args.status_loyal else "CUST_ACTIVE_TEST"))))
        simulate_customer_click(customer_id=target_cid, email_number=args.seq)
        if args.status_dormant:
            print_dormant_engagement_status()
        elif args.status_at_risk:
            print_at_risk_engagement_status()
        elif args.status_high_value:
            print_high_value_engagement_status()
        elif args.status_loyal:
            print_loyal_engagement_status()
        else:
            print_engagement_status()
        sys.exit(0)

    # Purchase simulation
    if args.simulate_purchase:
        target_cid = args.test_cid or ("CUST_DORMANT_TEST" if args.status_dormant else ("CUST_AT_RISK_TEST" if args.status_at_risk else ("CUST_HIGH_VAL_TEST" if args.status_high_value else ("CUST_LOYAL_TEST" if args.status_loyal else "CUST_ACTIVE_TEST"))))
        simulate_customer_purchase(customer_id=target_cid)
        if args.status_dormant:
            print_dormant_engagement_status()
        elif args.status_at_risk:
            print_at_risk_engagement_status()
        elif args.status_high_value:
            print_high_value_engagement_status()
        elif args.status_loyal:
            print_loyal_engagement_status()
        else:
            print_engagement_status()
        sys.exit(0)

    # View status tables
    if args.status:
        print_engagement_status()
        sys.exit(0)

    if args.status_loyal:
        print_loyal_engagement_status()
        sys.exit(0)

    if args.status_high_value:
        print_high_value_engagement_status()
        sys.exit(0)

    if args.status_at_risk:
        print_at_risk_engagement_status()
        sys.exit(0)

    if args.status_dormant:
        print_dormant_engagement_status()
        sys.exit(0)

    # Individual campaign runners
    if args.active_campaign:
        run_active_customer_engagement_cycle(tracking_base_url=TRACKING_BASE_URL)
        sys.exit(0)

    if args.loyal_campaign:
        run_loyal_customer_engagement_cycle(tracking_base_url=TRACKING_BASE_URL)
        sys.exit(0)

    if args.high_value_campaign:
        run_high_value_customer_engagement_cycle(tracking_base_url=TRACKING_BASE_URL)
        sys.exit(0)

    if args.at_risk_campaign:
        run_at_risk_customer_engagement_cycle(tracking_base_url=TRACKING_BASE_URL)
        sys.exit(0)

    if args.dormant_campaign:
        run_dormant_customer_engagement_cycle(tracking_base_url=TRACKING_BASE_URL)
        sys.exit(0)

    # Full Service Mode
    server = start_tracking_server(port=TRACKING_PORT)
    start_daily_scheduler(run_immediate=args.run_now, campaign="all", tracking_base_url=TRACKING_BASE_URL)

    print(f"\n⏳ Orchestrator & Tracking Server running on port {TRACKING_PORT}.")
    print(f"   Daily evaluations for Active, Loyal, High-Value, At-Risk & Dormant Customers will run at 3:00 PM IST (4-day email cadence).")
    print(f"   Press Ctrl + C to stop.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑 Shutting down tracking server.")
        server.shutdown()
