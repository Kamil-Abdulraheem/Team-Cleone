// All the numbers you might want to change live here. Nothing else needs editing for most tweaks.

export const PLANS = {
  free: { label: "Free", scansPerMonth: 3, visiblePerLane: 1 },
  pro: { label: "Pro", scansPerMonth: 100, visiblePerLane: 999 },
};

export const CUTOFF = 75; // a match must score at least this to appear (same rule as the prototype)

export const SESSION_DAYS = 30;
export const PASSWORD_MIN = 8;
export const PBKDF2_ITERATIONS = 100000; // Cloudflare's maximum

// How many scans one person may start per hour (protects the shared GitHub quota).
export const SCANS_PER_HOUR = 10;

// Paid plan shown in the app. The real charge is set in your Paystack plan.
export const PRICE_LABEL = "$19 a month";
