
export const FREE_PLAN = {
  storage: 0.5 * 1024 ** 3, // 512 MB
  deviceLimit: 1,
};

// Entitlements follow the plan TIER, not the billing cycle:
//   Pro     → 100 GB / 3 devices   (monthly and yearly)
//   Premium → 500 GB / 4 devices   (monthly and yearly)
const PRO = { storage: 100 * 1024 ** 3, deviceLimit: 3 };
const PREMIUM = { storage: 500 * 1024 ** 3, deviceLimit: 4 };

export const PLAN_CONFIG = {
  plan_T7QOKw1SWn3YA9: { ...PRO }, // Pro Monthly
  plan_T7QTobe7VSThyp: { ...PREMIUM }, // Premium Monthly
  plan_T7QPutFKX9ueS5: { ...PRO }, // Pro Yearly
  plan_T7QV7r2nId24Vo: { ...PREMIUM }, // Premium Yearly
};

export const PLAN_DETAILS = {
  plan_T7QOKw1SWn3YA9: { name: "Pro", cycle: "monthly", price: 169 },
  plan_T7QTobe7VSThyp: { name: "Premium", cycle: "monthly", price: 499 },
  plan_T7QPutFKX9ueS5: { name: "Pro", cycle: "yearly", price: 1599 },
  plan_T7QV7r2nId24Vo: { name: "Premium", cycle: "yearly", price: 4999 },
};