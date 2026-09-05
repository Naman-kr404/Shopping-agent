import os
from contextlib import asynccontextmanager
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from pydantic import BaseModel, Field
import uvicorn

# Resolve path relative to this script directory
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_FILE_PATH = os.path.join(
    BASE_DIR, "80k_clothing_realistic_correlated_sales.csv"
)

# Global in-memory transition tables
transition_df = pd.DataFrame()
valid_combinations = set()


def init_recommendation_engine(csv_path: str = CSV_FILE_PATH):
    """Loads dataset and precalculates sequential transition patterns."""
    global transition_df, valid_combinations

    if not os.path.exists(csv_path):
        raise FileNotFoundError(
            f"Dataset not found at '{csv_path}'. Ensure the CSV is in the same folder as model.py."
        )

    # 1. Load and sort dataset
    df = pd.read_csv(csv_path)
    df["transaction_date"] = pd.to_datetime(df["transaction_date"])
    df = df.sort_values(
        ["customer_id", "transaction_date", "transaction_id"]
    ).reset_index(drop=True)

    valid_combinations = set(zip(df["category"], df["subcategory"]))

    # 2. Extract customer purchase sequences
    customer_histories = {}
    for customer_id, history in df.groupby("customer_id"):
        customer_histories[customer_id] = history.sort_values(
            ["transaction_date", "transaction_id"]
        ).reset_index(drop=True)

    # 3. Build sequential transition relationships
    transition_customers = {}
    for customer_id, history in customer_histories.items():
        purchases = history[["category", "subcategory"]].values.tolist()
        for i in range(len(purchases) - 1):
            curr_key = (purchases[i][0], purchases[i][1])
            next_key = (purchases[i + 1][0], purchases[i + 1][1])

            # Exclude identical consecutive category + subcategory
            if curr_key == next_key:
                continue

            if curr_key not in transition_customers:
                transition_customers[curr_key] = {}
            if next_key not in transition_customers[curr_key]:
                transition_customers[curr_key][next_key] = set()

            transition_customers[curr_key][next_key].add(customer_id)

    # 4. Format into DataFrame
    transition_rows = []
    for curr_key, next_products in transition_customers.items():
        for next_key, customers in next_products.items():
            transition_rows.append({
                "input_category": curr_key[0],
                "input_subcategory": curr_key[1],
                "recommended_category": next_key[0],
                "recommended_subcategory": next_key[1],
                "customers": len(customers),
            })

    transition_df = pd.DataFrame(transition_rows)

    # 5. Compute base conversion percentage
    input_customer_counts = (
        df[["customer_id", "category", "subcategory"]]
        .drop_duplicates()
        .groupby(["category", "subcategory"])
        .size()
        .to_dict()
    )

    def calculate_percentage(row):
        key = (row["input_category"], row["input_subcategory"])
        total_customers = input_customer_counts.get(key, 1)
        return round((row["customers"] / total_customers) * 100, 2)

    transition_df["percentage"] = transition_df.apply(
        calculate_percentage, axis=1
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Precalculating recommendation matrix from dataset...")
    init_recommendation_engine()
    print("Recommendation engine is ready to serve requests.")
    yield


# FastAPI Application Instance
app = FastAPI(
    title="Product Recommendation REST API",
    version="1.0.0",
    lifespan=lifespan,
)

# ============================================================
# CORS MIDDLEWARE SETUP
# ============================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows requests from React frontend on http://localhost:3000
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# PYDANTIC SCHEMAS
# ============================================================

class RecommendationRequest(BaseModel):
    category: Optional[str] = Field("Pants & Jeans", example="Pants & Jeans")
    subcategory: Optional[str] = Field("Straight Leg Jeans", example="Straight Leg Jeans")
    top_k: Optional[int] = Field(4, ge=1, le=20, example=4)


class RecommendedItem(BaseModel):
    rank: int
    recommended_category: str
    recommended_subcategory: str
    customers_also_bought: int
    percentage_of_customers: float


class RecommendationResponse(BaseModel):
    input_category: str
    input_subcategory: str
    total_recommendations: int
    recommendations: List[RecommendedItem]


# ============================================================
# API ENDPOINTS
# ============================================================


@app.get("/")
def health_check():
    return {"status": "online", "message": "Recommendation API is running"}


@app.post("/recommend", response_model=RecommendationResponse)
def get_product_recommendations(payload: RecommendationRequest):
    input_cat = (payload.category or "Pants & Jeans").strip()
    input_subcat = (payload.subcategory or "Straight Leg Jeans").strip()

    # Case-insensitive validation against catalog
    matched_entry = [
        (cat, sub)
        for cat, sub in valid_combinations
        if cat.lower() == input_cat.lower()
        and sub.lower() == input_subcat.lower()
    ]

    # Fallback to standard default if provided entry isn't directly matched
    if not matched_entry:
        matched_entry = [
            (cat, sub)
            for cat, sub in valid_combinations
            if cat.lower() == "pants & jeans"
            and sub.lower() == "straight leg jeans"
        ]

    if not matched_entry:
        # Fall back to first available pair if default category isn't in dataset
        matched_entry = [next(iter(valid_combinations))]

    exact_cat, exact_subcat = matched_entry[0]

    # Filter precomputed recommendations
    matches = transition_df[
        (transition_df["input_category"] == exact_cat)
        & (transition_df["input_subcategory"] == exact_subcat)
    ].copy()

    if matches.empty:
        # If no transition history for matched entry, select top 4 general entries
        matches = transition_df.copy().head(payload.top_k)

    matches = (
        matches.sort_values(["customers", "percentage"], ascending=False)
        .head(payload.top_k)
        .reset_index(drop=True)
    )
    matches.insert(0, "rank", range(1, len(matches) + 1))

    recommendation_list = [
        RecommendedItem(
            rank=int(row["rank"]),
            recommended_category=row["recommended_category"],
            recommended_subcategory=row["recommended_subcategory"],
            customers_also_bought=int(row["customers"]),
            percentage_of_customers=float(row["percentage"]),
        )
        for _, row in matches.iterrows()
    ]

    return RecommendationResponse(
        input_category=exact_cat,
        input_subcategory=exact_subcat,
        total_recommendations=len(recommendation_list),
        recommendations=recommendation_list,
    )


def recommend_next_products(category: str, subcategory: str, top_k: int = 3):
    """
    Direct synchronous helper to get ML recommendations given category and subcategory.
    Ensures recommendation engine is initialized.
    Returns a list of dicts: [{'rank': 1, 'category': ..., 'subcategory': ..., 'percentage': ...}, ...]
    """
    global transition_df, valid_combinations
    if transition_df.empty or not valid_combinations:
        init_recommendation_engine()

    req = RecommendationRequest(category=category, subcategory=subcategory, top_k=top_k)
    res = get_product_recommendations(req)
    return [
        {
            "rank": r.rank,
            "recommended_category": r.recommended_category,
            "recommended_subcategory": r.recommended_subcategory,
            "customers_also_bought": r.customers_also_bought,
            "percentage_of_customers": r.percentage_of_customers,
        }
        for r in res.recommendations
    ]


# ============================================================
# DIRECT EXECUTION ENTRYPOINT
# ============================================================

if __name__ == "__main__":
    uvicorn.run("model:app", host="0.0.0.0", port=8000, reload=True)