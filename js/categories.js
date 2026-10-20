export const CATEGORY_ICONS = {
  Food: "🍔",
  Transport: "🚕",
  Stay: "🏨",
  Groceries: "🛒",
  Entertainment: "🎬",
  Utilities: "💡",
  Other: "📦",
  Settlement: "🤝"
};

export const CATEGORY_COLORS = {
  Food: "#d97706",
  Transport: "#2563eb",
  Stay: "#7c3aed",
  Groceries: "#059669",
  Entertainment: "#db2777",
  Utilities: "#ca8a04",
  Other: "#475569"
};

const KEYWORD_RULES = [
  { category: "Food", keywords: ["food", "dinner", "lunch", "breakfast", "chai", "coffee", "cafe", "swiggy", "zomato", "burger", "pizza", "biryani", "drinks", "pub", "beer"] },
  { category: "Transport", keywords: ["uber", "ola", "cab", "taxi", "auto", "rickshaw", "petrol", "diesel", "fuel", "flight", "train", "metro", "bus", "parking", "toll"] },
  { category: "Groceries", keywords: ["grocery", "groceries", "blinkit", "zepto", "instamart", "bigbasket", "dmart", "vegetables", "fruits", "milk", "bread", "eggs"] },
  { category: "Stay", keywords: ["hotel", "resort", "airbnb", "stay", "room", "hostel", "villa", "lodge", "booking"] },
  { category: "Entertainment", keywords: ["movie", "cinema", "pvr", "inox", "netflix", "spotify", "concert", "game", "bowling", "party"] },
  { category: "Utilities", keywords: ["wifi", "internet", "electricity", "power bill", "water", "gas", "rent", "maintenance", "recharge", "airtel", "jio"] }
];

export function predictCategory(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  for (const rule of KEYWORD_RULES) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword)) return rule.category;
    }
  }
  return null;
}
