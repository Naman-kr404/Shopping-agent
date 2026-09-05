import sqlite3
import csv
import json
import os
import re
import time
import smtplib
import threading
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta
from pathlib import Path
from dotenv import load_dotenv

# Store database in the same directory as this file
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "campaign.db"
PAST_SALES_CSV_PATH = BASE_DIR / "80k_clothing_realistic_correlated_sales.csv"

# Load environment variables
load_dotenv(BASE_DIR / ".env")


def get_connection():
    conn = sqlite3.connect(DB_PATH)

    # Allows us to access columns by name
    conn.row_factory = sqlite3.Row

    return conn


def create_database():

    conn = get_connection()
    cursor = conn.cursor()

    # --------------------------------------------------
    # 1. CUSTOMERS TABLE
    # --------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS customers (

            customer_id TEXT PRIMARY KEY,

            email TEXT NOT NULL,

            next_campaign TEXT,

            next_campaign_at TEXT,

            created_at TEXT,
            updated_at TEXT
        )
    """)

    # Drop deprecated columns if migrating an existing database
    existing_cols = [c[1] for c in cursor.execute("PRAGMA table_info(customers)").fetchall()]
    for col in ["segment", "discount_percent", "purchase_count", "first_purchase_at", "last_purchase_at"]:
        if col in existing_cols:
            cursor.execute(f"ALTER TABLE customers DROP COLUMN {col}")


    # --------------------------------------------------
    # 2. CAMPAIGNS TABLE
    # --------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS campaigns (

            campaign_id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_id TEXT NOT NULL,

            campaign_type TEXT NOT NULL,

            discount_percent INTEGER,

            scheduled_at TEXT,

            sent_at TEXT,

            status TEXT DEFAULT 'scheduled',

            opened TEXT DEFAULT 'no',

            open_link TEXT DEFAULT 'no',

            purchased TEXT DEFAULT 'no',

            FOREIGN KEY (customer_id)
                REFERENCES customers(customer_id)
        )
    """)

    # Ensure opened, open_link, and purchased columns exist if migrating an existing database
    existing_campaign_cols = [c[1] for c in cursor.execute("PRAGMA table_info(campaigns)").fetchall()]
    if "opened" not in existing_campaign_cols:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN opened TEXT DEFAULT 'no'")
    if "open_link" not in existing_campaign_cols:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN open_link TEXT DEFAULT 'no'")
    if "purchased" not in existing_campaign_cols:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN purchased TEXT DEFAULT 'no'")
    if "email_number" not in existing_campaign_cols:
        cursor.execute("ALTER TABLE campaigns ADD COLUMN email_number INTEGER DEFAULT 1")



    # --------------------------------------------------
    # 3. CAMPAIGN EVENTS TABLE
    # --------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS campaign_events (

            event_id INTEGER PRIMARY KEY AUTOINCREMENT,

            customer_id TEXT NOT NULL,

            campaign_id INTEGER,

            event_type TEXT NOT NULL,

            event_time TEXT NOT NULL,

            metadata TEXT,

            FOREIGN KEY (customer_id)
                REFERENCES customers(customer_id),

            FOREIGN KEY (campaign_id)
                REFERENCES campaigns(campaign_id)
        )
    """)


    # --------------------------------------------------
    # 4. PAST SALES TABLE
    # --------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS past_sales (

            transaction_id TEXT PRIMARY KEY,

            customer_id TEXT NOT NULL,

            transaction_date TEXT NOT NULL,

            product_id TEXT NOT NULL,

            unit_price REAL,

            quantity INTEGER
        )
    """)


    # --------------------------------------------------
    # INDEXES
    # --------------------------------------------------

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_customer_email
        ON customers(email)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_next_campaign
        ON customers(next_campaign_at)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_campaign_status
        ON campaigns(status, scheduled_at)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_campaign_events
        ON campaign_events(customer_id, event_type)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_past_sales_customer
        ON past_sales(customer_id)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_past_sales_date
        ON past_sales(transaction_date)
    """)


    conn.commit()
    conn.close()

    print(f"Database created at: {DB_PATH}")

    # Automatically populate past_sales if empty
    populate_past_sales()


def send_notification_email(customer_name: str):
    """Sends an email notification to the GMAIL_ADDRESS in .env after a record is added."""
    try:
        load_dotenv(BASE_DIR / ".env")
        gmail_address = os.getenv("GMAIL_ADDRESS", "spjnaman@gmail.com")
        gmail_password = os.getenv("GMAIL_APP_PASSWORD")

        if not gmail_password:
            print("[Email Warning] GMAIL_APP_PASSWORD not set in .env")
            return

        msg = EmailMessage()
        msg["Subject"] = str(customer_name)
        msg["From"] = gmail_address
        msg["To"] = "spjnaman@gmail.com"
        msg.set_content("new record added to the database")

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(gmail_address, gmail_password)
            smtp.send_message(msg)

        print(f"📧 [Email Sent] Notification sent to spjnaman@gmail.com | Subject: '{customer_name}' | Body: 'new record added to the database'", flush=True)
    except Exception as e:
        print(f"❌ [Email Error] Failed to send notification email: {e}", flush=True)


def schedule_notification_email(customer_name: str, delay_seconds: float = 5.0):
    """Schedules the notification email to be sent asynchronously after delay_seconds."""
    def worker():
        time.sleep(delay_seconds)
        send_notification_email(customer_name)

    thread = threading.Thread(target=worker)
    thread.start()
    print(f"⏳ [Timer Started] Email notification will be sent in {delay_seconds}s for customer '{customer_name}'", flush=True)


def record_purchase(
    customer_id: str,
    email: str = None,
    segment: str = None,
    discount_percent: int = None,
    amount: float = None,
    payment_id: str = None,
    items: list = None,
    customer_name: str = None
):
    """Records or updates customer purchase details and logs a purchase event."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()

    now = datetime.now(timezone.utc).isoformat()
    cid = customer_id.strip().upper()
    sample_email = email.strip() if email else f"{cid.lower()}@example.com"
    name_to_notify = customer_name.strip() if customer_name else cid

    cursor.execute("SELECT * FROM customers WHERE customer_id = ?", (cid,))
    existing = cursor.fetchone()

    if existing:
        updated_email = email.strip() if email else existing["email"]

        cursor.execute("""
            UPDATE customers
            SET email = ?,
                updated_at = ?
            WHERE customer_id = ?
        """, (
            updated_email,
            now,
            cid
        ))
    else:
        cursor.execute("""
            INSERT INTO customers (
                customer_id,
                email,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?)
        """, (
            cid,
            sample_email,
            now,
            now
        ))

    # Record purchase event in campaign_events
    metadata = {
        "amount": amount,
        "payment_id": payment_id,
        "items_count": len(items) if items else 0,
        "items": items,
        "segment": segment,
        "discount_percent": discount_percent,
        "email": sample_email,
        "customer_name": name_to_notify
    }

    cursor.execute("""
        INSERT INTO campaign_events (
            customer_id,
            event_type,
            event_time,
            metadata
        ) VALUES (?, 'purchase', ?, ?)
    """, (
        cid,
        now,
        json.dumps(metadata)
    ))

    # --------------------------------------------------
    # Record transaction items into past_sales table
    # --------------------------------------------------
    tx_date = now[:10]
    base_tx_id = payment_id or f"T{int(time.time() * 1000)}"

    if items and isinstance(items, list):
        for idx, item in enumerate(items):
            item_tx_id = f"{base_tx_id}_{idx + 1}" if len(items) > 1 else base_tx_id
            pid = str(item.get("product_id") or item.get("id") or item.get("sku") or "P00001")
            raw_price = item.get("price") if item.get("price") is not None else item.get("unit_price", amount or 0.0)
            if isinstance(raw_price, str):
                clean_p = re.sub(r"[^0-9.]", "", raw_price)
                u_price = float(clean_p) if clean_p else 0.0
            else:
                u_price = float(raw_price or 0.0)
            qty = int(item.get("quantity") or 1)

            cursor.execute("""
                INSERT OR REPLACE INTO past_sales (
                    transaction_id,
                    customer_id,
                    transaction_date,
                    product_id,
                    unit_price,
                    quantity
                ) VALUES (?, ?, ?, ?, ?, ?)
            """, (item_tx_id, cid, tx_date, pid, u_price, qty))
    else:
        cursor.execute("""
            INSERT OR REPLACE INTO past_sales (
                transaction_id,
                customer_id,
                transaction_date,
                product_id,
                unit_price,
                quantity
            ) VALUES (?, ?, ?, ?, ?, ?)
        """, (base_tx_id, cid, tx_date, "P00001", float(amount or 0.0), 1))

    # --------------------------------------------------
    # Update campaign conversion: if customer makes a purchase,
    # set purchased = 'yes' across their campaigns to terminate sequence
    # --------------------------------------------------
    cursor.execute("""
        UPDATE campaigns
        SET purchased = 'yes'
        WHERE customer_id = ?
    """, (cid,))

    conn.commit()

    cursor.execute("SELECT * FROM customers WHERE customer_id = ?", (cid,))
    record = dict(cursor.fetchone())
    conn.close()

    print(f"Recorded purchase for {cid} ({record['email']})")

    # Send email notification after 5 seconds
    schedule_notification_email(name_to_notify, delay_seconds=5.0)

    return record



def get_customer(customer_id: str):
    """Retrieve a single customer by customer_id."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM customers WHERE customer_id = ?", (customer_id.strip().upper(),))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def populate_past_sales(csv_path: Path = PAST_SALES_CSV_PATH, force_reload: bool = False):
    """Loads all past sales from the CSV file into the past_sales table at once."""
    if not csv_path.exists():
        print(f"Warning: Past sales CSV not found at {csv_path}")
        return 0

    conn = get_connection()
    cursor = conn.cursor()

    if not force_reload:
        cursor.execute("SELECT count(*) FROM past_sales")
        existing_count = cursor.fetchone()[0]
        if existing_count > 0:
            conn.close()
            return existing_count

    if force_reload:
        cursor.execute("DELETE FROM past_sales")

    print(f"Loading past sales data from {csv_path.name} into past_sales table at once...")
    with open(csv_path, mode="r", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader)  # Skip header row
        cursor.executemany("""
            INSERT OR REPLACE INTO past_sales (
                transaction_id,
                customer_id,
                transaction_date,
                product_id,
                unit_price,
                quantity
            ) VALUES (?, ?, ?, ?, ?, ?)
        """, ((r[0], r[1], r[2], r[3], float(r[8]), int(r[11])) for r in reader))

    conn.commit()
    cursor.execute("SELECT count(*) FROM past_sales")
    total_count = cursor.fetchone()[0]
    conn.close()

    print(f"Successfully loaded {total_count} records into past_sales table.")
    return total_count


def get_past_sales(customer_id: str = None, limit: int = 50):
    """Retrieve past sales records, optionally filtered by customer_id."""
    conn = get_connection()
    cursor = conn.cursor()
    if customer_id:
        cursor.execute(
            "SELECT * FROM past_sales WHERE customer_id = ? ORDER BY transaction_date DESC LIMIT ?",
            (customer_id.strip().upper(), limit),
        )
    else:
        cursor.execute(
            "SELECT * FROM past_sales ORDER BY transaction_date DESC LIMIT ?",
            (limit,),
        )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def seed_dummy_customers(count: int = 500):
    """Inserts dummy customers with IDs like CUST_00001 and emails like cust_00001@gmail.com."""
    create_database()
    conn = get_connection()
    cursor = conn.cursor()

    now = datetime.now(timezone.utc).isoformat()
    dummy_data = [
        (
            f"CUST_{i:05d}",
            f"cust_{i:05d}@gmail.com",
            now,
            now
        )
        for i in range(1, count + 1)
    ]

    cursor.executemany("""
        INSERT OR REPLACE INTO customers (
            customer_id,
            email,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?)
    """, dummy_data)

    conn.commit()
    cursor.execute("SELECT count(*) FROM customers")
    total = cursor.fetchone()[0]
    conn.close()

    print(f"Successfully seeded {len(dummy_data)} dummy customers (Total in table: {total}).")
    return total


def get_weekly_audit_trail(days_back: int = 7, filter_type: str = "current_week"):
    """
    Retrieves transactions performed by all customers in that week.
    Does NOT include past historical sales transactions.
    """
    create_database()
    conn = get_connection()
    cursor = conn.cursor()

    now = datetime.now(timezone.utc)
    if filter_type == "last_7_days":
        start_time = (now - timedelta(days=days_back)).isoformat()
        end_time = (now + timedelta(days=1)).isoformat()
    else:
        # Current calendar week (Monday to Sunday)
        weekday = now.weekday()  # Monday is 0, Sunday is 6
        monday = (now - timedelta(days=weekday)).replace(hour=0, minute=0, second=0, microsecond=0)
        sunday = (monday + timedelta(days=6)).replace(hour=23, minute=59, second=59, microsecond=999999)
        start_time = monday.isoformat()
        end_time = sunday.isoformat()

    cursor.execute("""
        SELECT ce.event_id, ce.customer_id, ce.event_time, ce.metadata,
               c.email as customer_email, c.created_at
        FROM campaign_events ce
        LEFT JOIN customers c ON ce.customer_id = c.customer_id
        WHERE ce.event_type = 'purchase'
          AND ce.event_time >= ?
          AND ce.event_time <= ?
        ORDER BY ce.event_time DESC
    """, (start_time, end_time))

    rows = cursor.fetchall()
    conn.close()

    total_revenue = 0.0
    total_units = 0
    unique_customers = set()
    transactions = []

    for r in rows:
        meta = {}
        if r["metadata"]:
            try:
                meta = json.loads(r["metadata"])
            except Exception:
                meta = {}

        amt = meta.get("amount", 0.0)
        try:
            amt = float(amt)
        except (ValueError, TypeError):
            amt = 0.0

        total_revenue += amt
        cid = r["customer_id"]
        unique_customers.add(cid)

        raw_items = meta.get("items") or []
        items = []
        item_count = 0
        if isinstance(raw_items, list):
            for it in raw_items:
                q = int(it.get("quantity") or 1)
                item_count += q
                items.append({
                    "product_id": str(it.get("product_id") or it.get("id") or ""),
                    "title": str(it.get("title") or it.get("name") or it.get("description") or "Product"),
                    "price": it.get("price", 0),
                    "quantity": q,
                    "color": it.get("color", ""),
                    "material": it.get("material", ""),
                    "category": it.get("category", ""),
                    "subcategory": it.get("subcategory", "")
                })
        else:
            item_count = 1

        total_units += item_count

        transactions.append({
            "event_id": r["event_id"],
            "transaction_id": meta.get("payment_id") or f"TXN_{r['event_id']}",
            "payment_id": meta.get("payment_id") or "N/A",
            "customer_id": cid,
            "customer_email": meta.get("email") or r["customer_email"] or f"{cid.lower()}@example.com",
            "customer_name": meta.get("customer_name") or cid,
            "segment": meta.get("segment") or "Customer",
            "discount_percent": meta.get("discount_percent", 0),
            "amount": round(amt, 2),
            "items_count": item_count,
            "items": items,
            "timestamp": r["event_time"],
            "status": "PAID",
            "payment_gateway": "Razorpay"
        })

    return {
        "timeframe": filter_type,
        "start_date": start_time,
        "end_date": end_time,
        "total_transactions": len(transactions),
        "total_revenue": round(total_revenue, 2),
        "total_units": total_units,
        "unique_customers": len(unique_customers),
        "transactions": transactions
    }


if __name__ == "__main__":
    create_database()
    populate_past_sales()
    seed_dummy_customers(500)