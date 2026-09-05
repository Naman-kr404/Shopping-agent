import pandas as pd
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from database import record_purchase, get_customer, get_connection


# ============================================================
# CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

FILE_PATH = (
    BASE_DIR /
    "80k_clothing_realistic_correlated_sales.csv"
)

LOOKBACK_DAYS = 365


# ============================================================
# FASTAPI APPLICATION
# ============================================================

app = FastAPI(
    title="Campaign Orchestrator - Customer Segmentation API",
    description="Customer segmentation and section-wise discount API",
    version="1.0.0"
)


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,

    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],

    allow_credentials=True,

    allow_methods=["*"],

    allow_headers=["*"],
)


# ============================================================
# 1. LOAD SALES DATA
# ============================================================

print("\n========================================")
print("Campaign Orchestrator")
print("Customer Segmentation Service")
print("========================================")

print("\nLoading sales data...")
print(f"CSV path: {FILE_PATH}")


if not FILE_PATH.exists():

    raise RuntimeError(
        f"\nCSV file not found!\n\n"
        f"Expected location:\n{FILE_PATH}\n\n"
        f"Make sure the CSV file exists in the "
        f"same folder as segmentation.py."
    )


df = pd.read_csv(FILE_PATH)


print(
    f"Total transactions loaded: {len(df)}"
)


# ============================================================
# 2. CLEAN DATA
# ============================================================

df["transaction_date"] = pd.to_datetime(
    df["transaction_date"],
    errors="coerce"
)


df["total_amount"] = pd.to_numeric(
    df["total_amount"],
    errors="coerce"
)


df = df.dropna(
    subset=[
        "customer_id",
        "transaction_id",
        "transaction_date",
        "total_amount"
    ]
)


print(
    f"Valid transactions: {len(df)}"
)


# ============================================================
# 3. DETERMINE ANALYSIS DATE
# ============================================================

AS_OF_DATE = df["transaction_date"].max()


WINDOW_START = (
    AS_OF_DATE -
    pd.Timedelta(days=LOOKBACK_DAYS)
)


print(
    f"\nAnalysis period:"
    f"\n{WINDOW_START.date()} → {AS_OF_DATE.date()}"
)


# ============================================================
# 4. FILTER LAST 365 DAYS
# ============================================================

df_365 = df[
    (df["transaction_date"] >= WINDOW_START)
    &
    (df["transaction_date"] <= AS_OF_DATE)
].copy()


print(
    f"Transactions in last 365 days: {len(df_365)}"
)


# ============================================================
# 5. CUSTOMER METRICS
# ============================================================

customers = (
    df_365
    .groupby("customer_id")
    .agg(

        # Number of unique orders in last 365 days
        orders_365d=(
            "transaction_id",
            "nunique"
        ),

        # Total spending in last 365 days
        spend_365d=(
            "total_amount",
            "sum"
        ),

        # Most recent purchase
        last_purchase_date=(
            "transaction_date",
            "max"
        )
    )
    .reset_index()
)


# ============================================================
# 6. FIRST PURCHASE DATE
# ============================================================

# We use the complete dataset here.
# This ensures that "New Customer" really means
# the customer's first-ever purchase was recent.

first_purchase = (
    df
    .groupby("customer_id")
    .agg(
        first_purchase_date=(
            "transaction_date",
            "min"
        )
    )
    .reset_index()
)


customers = customers.merge(
    first_purchase,
    on="customer_id",
    how="left"
)


# ============================================================
# 7. RECENCY
# ============================================================

customers["recency_days"] = (
    AS_OF_DATE -
    customers["last_purchase_date"]
).dt.days


# ============================================================
# 8. TENURE
# ============================================================

customers["tenure_days"] = (
    AS_OF_DATE -
    customers["first_purchase_date"]
).dt.days


# ============================================================
# 9. AVERAGE ORDER VALUE
# ============================================================

customers["average_order_value"] = (
    customers["spend_365d"]
    /
    customers["orders_365d"]
)


# ============================================================
# 10. PERCENTILE SCORES
# ============================================================

# Order frequency percentile
customers["orders_pct"] = (
    customers["orders_365d"]
    .rank(
        pct=True,
        method="average"
    )
)


# Spending percentile
customers["spend_pct"] = (
    customers["spend_365d"]
    .rank(
        pct=True,
        method="average"
    )
)


# ============================================================
# 11. CUSTOMER SEGMENT CLASSIFICATION
# ============================================================

def classify_customer(row):

    orders = row["orders_365d"]

    spend_pct = row["spend_pct"]

    orders_pct = row["orders_pct"]

    recency = row["recency_days"]

    tenure = row["tenure_days"]


    # ========================================================
    # 1. NEW CUSTOMERS
    # ========================================================

    if tenure <= 60:

        return (
            "New Customers",
            "First purchase was within the last 60 days"
        )


    # ========================================================
    # 2. DORMANT CUSTOMERS
    # ========================================================

    if recency > 120:

        return (
            "Dormant Customers",
            "No purchase for more than 120 days"
        )


    # ========================================================
    # 3. AT-RISK CUSTOMERS
    # ========================================================

    if 60 < recency <= 120:

        return (
            "At-Risk Customers",
            "No purchase for 61 to 120 days"
        )


    # ========================================================
    # 4. HIGH-VALUE CUSTOMERS
    # ========================================================

    if spend_pct >= 0.85:

        return (
            "High-Value Customers",
            "Customer is in the top 15% by spending"
        )


    # ========================================================
    # 5. LOYAL CUSTOMERS
    # ========================================================

    # Customer is Loyal when:
    #
    # orders >= 20
    #
    # OR
    #
    # orders_pct >= 75th percentile
    # AND
    # spend_pct >= 65th percentile

    if (
        orders >= 20
        or
        (
            orders_pct >= 0.75
            and
            spend_pct >= 0.65
        )
    ):

        return (
            "Loyal Customers",
            "Customer has at least 20 orders OR "
            "is in the top 25% by order frequency "
            "and top 35% by spending"
        )


    # ========================================================
    # 6. CART / INTENT CUSTOMERS
    # ========================================================
    #
    # IMPORTANT:
    #
    # The current CSV contains completed sales.
    # It does not contain:
    #
    # - product views
    # - cart additions
    # - wishlist events
    # - checkout events
    #
    # Therefore this is currently a PROXY.
    #
    # ========================================================

    if (
        recency <= 14
        and
        orders >= 12
    ):

        return (
            "Cart/Intent Customers",
            "Proxy: customer has high recent "
            "purchase activity"
        )


    # ========================================================
    # 7. BROWSERS / PROSPECTS
    # ========================================================
    #
    # This is also a PROXY because a sales dataset
    # cannot identify people who never purchased.
    #
    # ========================================================

    if (
        orders <= 10
        or
        spend_pct <= 0.30
    ):

        return (
            "Browsers/Prospects",
            "Proxy: customer has relatively low "
            "purchase activity or spending"
        )


    # ========================================================
    # 8. ACTIVE CUSTOMERS
    # ========================================================

    return (
        "Active Customers",
        "Recently purchased customer who does not "
        "match another higher-priority segment"
    )


# ============================================================
# 12. APPLY CLASSIFICATION
# ============================================================

print("\nClassifying customers...")


classification = customers.apply(
    classify_customer,
    axis=1
)


customers["segment"] = (
    classification
    .apply(lambda result: result[0])
)


customers["segment_reason"] = (
    classification
    .apply(lambda result: result[1])
)


# ============================================================
# 13. CAMPAIGN GOALS
# ============================================================

campaign_goals = {

    "New Customers":
        "Encourage second purchase",

    "Loyal Customers":
        "Retention and loyalty",

    "High-Value Customers":
        "Premium upsell / VIP treatment",

    "Active Customers":
        "Cross-sell and upsell",

    "At-Risk Customers":
        "Prevent churn",

    "Dormant Customers":
        "Win-back / reactivation",

    "Cart/Intent Customers":
        "Convert high purchase intent",

    "Browsers/Prospects":
        "Encourage first purchase"
}


customers["campaign_goal"] = (
    customers["segment"]
    .map(campaign_goals)
)


# ============================================================
# 14. SECTION-WISE DISCOUNTS
# ============================================================

segment_discounts = {

    "New Customers": 15,

    "Loyal Customers": 5,

    "High-Value Customers": 10,

    "Active Customers": 5,

    "At-Risk Customers": 15,

    "Dormant Customers": 20,

    "Cart/Intent Customers": 10,

    "Browsers/Prospects": 15
}


# Map segment → discount
customers["discount_percent"] = (
    customers["segment"]
    .map(segment_discounts)
)


# ============================================================
# 15. CREATE CUSTOMER LOOKUP
# ============================================================

customer_lookup = (
    customers
    .set_index("customer_id")
    .to_dict(
        orient="index"
    )
)


print(
    f"Customers classified: "
    f"{len(customer_lookup)}"
)


# ============================================================
# 16. DISPLAY SEGMENT DISTRIBUTION
# ============================================================

print("\n========================================")
print("CUSTOMER SEGMENT DISTRIBUTION")
print("========================================")


segment_counts = (
    customers["segment"]
    .value_counts()
)


for segment, count in segment_counts.items():

    percentage = (
        count /
        len(customers)
        *
        100
    )

    discount = segment_discounts.get(
        segment,
        0
    )

    print(
        f"{segment}: "
        f"{count} customers "
        f"({percentage:.2f}%) "
        f"| Discount: {discount}%"
    )


print("========================================\n")


# ============================================================
# API ENDPOINT 1
# ROOT
# ============================================================

@app.get("/")
def home():

    return {

        "message":
            "Campaign Orchestrator API is running",

        "customers_classified":
            len(customer_lookup),

        "lookback_days":
            LOOKBACK_DAYS,

        "analysis_period": {

            "start":
                str(WINDOW_START.date()),

            "end":
                str(AS_OF_DATE.date())
        }
    }


# ============================================================
# API ENDPOINT 2
# GET CUSTOMER SEGMENT + DISCOUNT
# ============================================================

@app.get("/customer/{customer_id}")
def get_customer_segment(
    customer_id: str
):

    # Convert ID to uppercase
    customer_id = customer_id.upper()


    # --------------------------------------------------------
    # Check customer
    # --------------------------------------------------------

    if customer_id not in customer_lookup:

        raise HTTPException(

            status_code=404,

            detail=
                f"Customer '{customer_id}' not found"
        )


    customer = customer_lookup[customer_id]


    # --------------------------------------------------------
    # Return customer information
    # --------------------------------------------------------

    return {

        "customer_id":
            customer_id,

        "segment":
            customer["segment"],

        "segment_reason":
            customer["segment_reason"],

        "campaign_goal":
            customer["campaign_goal"],

        "discount_percent":
            int(
                customer["discount_percent"]
            ),

        "metrics": {

            "orders_365d":
                int(
                    customer["orders_365d"]
                ),

            "spend_365d":
                round(
                    float(
                        customer["spend_365d"]
                    ),
                    2
                ),

            "average_order_value":
                round(
                    float(
                        customer["average_order_value"]
                    ),
                    2
                ),

            "recency_days":
                int(
                    customer["recency_days"]
                ),

            "tenure_days":
                int(
                    customer["tenure_days"]
                ),

            "orders_percentile":
                round(
                    float(
                        customer["orders_pct"]
                    ),
                    4
                ),

            "spend_percentile":
                round(
                    float(
                        customer["spend_pct"]
                    ),
                    4
                )
        }
    }


# ============================================================
# API ENDPOINT 3
# GET ALL SEGMENTS
# ============================================================

@app.get("/segments")
def get_segments():

    segment_counts = (
        customers["segment"]
        .value_counts()
        .to_dict()
    )


    result = {}


    for segment, count in segment_counts.items():

        result[segment] = {

            "customers":
                int(count),

            "discount_percent":
                segment_discounts.get(
                    segment,
                    0
                ),

            "campaign_goal":
                campaign_goals.get(
                    segment,
                    ""
                )
        }


    return {

        "total_customers":
            len(customers),

        "segments":
            result
    }


# ============================================================
# API ENDPOINT 4
# GET CUSTOMERS BY SEGMENT
# ============================================================

@app.get("/segment/{segment_name}")
def get_customers_by_segment(
    segment_name: str
):

    # --------------------------------------------------------
    # Find matching segment
    # --------------------------------------------------------

    matching_segment = None


    for segment in customers["segment"].unique():

        if (
            segment.lower()
            ==
            segment_name.lower()
        ):

            matching_segment = segment

            break


    # --------------------------------------------------------
    # Segment not found
    # --------------------------------------------------------

    if matching_segment is None:

        raise HTTPException(

            status_code=404,

            detail=
                f"Segment '{segment_name}' not found"
        )


    # --------------------------------------------------------
    # Filter customers
    # --------------------------------------------------------

    segment_customers = customers[
        customers["segment"]
        ==
        matching_segment
    ]


    # --------------------------------------------------------
    # Build response
    # --------------------------------------------------------

    result = []


    for _, row in segment_customers.iterrows():

        result.append({

            "customer_id":
                row["customer_id"],

            "orders_365d":
                int(
                    row["orders_365d"]
                ),

            "spend_365d":
                round(
                    float(
                        row["spend_365d"]
                    ),
                    2
                ),

            "recency_days":
                int(
                    row["recency_days"]
                ),

            "campaign_goal":
                row["campaign_goal"],

            "discount_percent":
                int(
                    row["discount_percent"]
                )
        })


    return {

        "segment":
            matching_segment,

        "customer_count":
            len(result),

        "discount_percent":
            segment_discounts.get(
                matching_segment,
                0
            ),

        "campaign_goal":
            campaign_goals.get(
                matching_segment,
                ""
            ),

        "customers":
            result
    }


# ============================================================
# API ENDPOINT 5
# RECORD CUSTOMER PURCHASE
# ============================================================

@app.post("/purchase")
def record_purchase_endpoint(payload: dict):

    customer_id = payload.get("customer_id")

    if not customer_id:
        raise HTTPException(
            status_code=400,
            detail="customer_id is required"
        )

    customer_id = customer_id.strip().upper()
    cust_info = customer_lookup.get(customer_id, {})

    segment = payload.get("segment") or cust_info.get("segment", "New Customers")
    discount = (
        payload.get("discount_percent")
        if payload.get("discount_percent") is not None
        else cust_info.get("discount_percent", 0)
    )
    email = payload.get("email") or f"{customer_id.lower()}@example.com"
    customer_name = payload.get("customer_name") or payload.get("name") or customer_id

    saved = record_purchase(
        customer_id=customer_id,
        email=email,
        segment=segment,
        discount_percent=discount,
        amount=payload.get("amount", 0.0),
        payment_id=payload.get("payment_id"),
        items=payload.get("items"),
        customer_name=customer_name
    )

    return {
        "status": "success",
        "message": f"Purchase recorded for {customer_id}",
        "customer": saved
    }


# ============================================================
# API ENDPOINT 6
# GET DATABASE CUSTOMERS
# ============================================================

@app.get("/db-customers")
def get_db_customers():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM customers")
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return {"total": len(rows), "customers": rows}


# ============================================================
# API ENDPOINT 7
# GET WEEKLY TRANSACTION AUDIT TRAIL
# ============================================================

@app.get("/audit-trail")
def get_audit_trail_endpoint(timeframe: str = "current_week", days: int = 7):
    from database import get_weekly_audit_trail
    return get_weekly_audit_trail(days_back=days, filter_type=timeframe)


# ============================================================
# DIRECT EXECUTION ENTRYPOINT
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("segmentation:app", host="0.0.0.0", port=8001, reload=True)