// All the numbers you might want to change live here. Nothing else needs editing for most tweaks.

export const PLANS = {
  free: { label: "Free", scansPerMonth: 3, visiblePerLane: 1, jobScansPerMonth: 3, jobsVisible: 3, jobAlerts: false },
  pro: { label: "Pro", scansPerMonth: 100, visiblePerLane: 999, jobScansPerMonth: 100, jobsVisible: 999, jobAlerts: true },
};

export const CUTOFF = 75; // a match must score at least this to appear (same rule as the prototype)

export const SESSION_DAYS = 30;
export const PASSWORD_MIN = 8;
export const PBKDF2_ITERATIONS = 100000; // slow enough to resist guessing, fast enough for a web request

// How many scans one person may start per hour (protects the shared GitHub quota).
export const SCANS_PER_HOUR = 10;

// Paid plan shown in the app. The real charge is set in your Paystack plan.
export const PRICE_LABEL = "$19 a month";

// Job Radar
export const JOB_CUTOFF = 40;          // a job must match at least this well to be shown
export const JOB_SCAM_HIDE = 50;       // at or above this the job moves to "Looks suspicious" and is never alerted
export const JOB_VERIFY_PER_SCAN = 25; // how many apply pages we check in one scan (keeps cost and time bounded)
export const JOB_RECHECK_AFTER = 6 * 3600; // a verdict newer than this is reused, shared across everyone
export const JOB_MAX_ALERTS_PER_RUN = 5;
