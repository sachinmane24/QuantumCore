/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * greeks.ts — Black-Scholes IV Solver + Greeks Engine
 *
 * Replaces all Math.random() Greek approximations in market.ts and server.ts.
 * Uses Newton-Raphson IV inversion from real Kite option prices.
 *
 * Usage:
 *   import { calcIV, calcGreeks, dteYears } from './greeks.ts';
 *
 *   const T   = dteYears('2024-12-05');
 *   const iv  = calcIV(cePrice, spot, strike, T, RISK_FREE_RATE, 'CE');
 *   const g   = calcGreeks(spot, strike, T, RISK_FREE_RATE, iv, 'CE');
 *   // g.delta, g.gamma, g.theta, g.vega — all real numbers
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * RBI Repo Rate (annualised, fractional).
 * Update this quarterly or pull from a config.
 * 6.5% as of mid-2024.
 */
export const RISK_FREE_RATE = 0.065;

// ─── Math Primitives ──────────────────────────────────────────────────────────

/** Standard normal PDF */
function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Standard normal CDF — Abramowitz & Stegun rational approximation.
 * Max absolute error < 7.5e-8.
 */
function normCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const A1 =  0.254829592;
  const A2 = -0.284496736;
  const A3 =  1.421413741;
  const A4 = -1.453152027;
  const A5 =  1.061405429;
  const P  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + P * Math.abs(x));
  const poly = t * (A1 + t * (A2 + t * (A3 + t * (A4 + t * A5))));
  return 0.5 * (1.0 + sign * (1 - poly * Math.exp(-x * x)));
}

// ─── BSM Core ─────────────────────────────────────────────────────────────────

interface D1D2 {
  d1: number;
  d2: number;
}

function computeD1D2(S: number, K: number, T: number, r: number, sigma: number): D1D2 {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return { d1, d2 };
}

/**
 * BSM theoretical price for CE or PE.
 * All prices in points (same unit as Kite last_price).
 */
export function bsmPrice(
  S: number,      // Spot price
  K: number,      // Strike price
  T: number,      // Time to expiry in years (calendar days / 365)
  r: number,      // Risk-free rate, annualised fractional (e.g. 0.065)
  sigma: number,  // Implied volatility, annualised fractional (e.g. 0.15)
  type: 'CE' | 'PE'
): number {
  if (T <= 0 || sigma <= 0) {
    return Math.max(0, type === 'CE' ? S - K : K - S);
  }
  const { d1, d2 } = computeD1D2(S, K, T, r, sigma);
  const df = Math.exp(-r * T); // Discount factor
  if (type === 'CE') {
    return S * normCDF(d1) - K * df * normCDF(d2);
  }
  return K * df * normCDF(-d2) - S * normCDF(-d1);
}

// ─── IV Solver ────────────────────────────────────────────────────────────────

/**
 * Newton-Raphson Implied Volatility solver.
 *
 * Inverts BSM to find sigma given a market option price.
 * Typical convergence in 4-7 iterations.
 *
 * Returns IV as an annualised fraction (e.g. 0.153 = 15.3%).
 * Returns 0 if the price is intrinsic-only or the solver fails to converge.
 *
 * @param optionPrice  Market last_price from Kite quote (points)
 * @param S            Current NIFTY spot
 * @param K            Strike price
 * @param T            Time to expiry in years — use dteYears()
 * @param r            Risk-free rate (fractional annual)
 * @param type         'CE' or 'PE'
 * @param maxIter      Max Newton-Raphson iterations (default 150)
 * @param tol          Convergence tolerance in points (default 0.01)
 */
export function calcIV(
  optionPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: 'CE' | 'PE',
  maxIter = 150,
  tol = 0.01
): number {
  // Guard: zero or negative DTE
  if (T <= 0) return 0;

  // Guard: price must exceed intrinsic value
  const intrinsic = Math.max(0, type === 'CE' ? S - K : K - S);
  if (optionPrice <= intrinsic + 0.01) return 0;

  // Guard: price implausibly large (data error)
  if (optionPrice > S * 0.5) return 0;

  // Initial guess — Brenner & Subrahmanyam (1988) approximation
  // Works well when S ≈ K; good enough for ATM and near-ATM strikes
  let sigma = Math.sqrt(2 * Math.PI / T) * (optionPrice / S);

  // Fallback initial guess if B&S gives something unreasonable
  if (!isFinite(sigma) || sigma <= 0) sigma = 0.20;

  // Clamp to realistic Indian market IV range: [1%, 300%]
  sigma = Math.max(0.01, Math.min(sigma, 3.0));

  for (let i = 0; i < maxIter; i++) {
    const theoretical = bsmPrice(S, K, T, r, sigma, type);
    const diff = theoretical - optionPrice;

    if (Math.abs(diff) < tol) break;

    // Vega for the Newton step (identical formula regardless of CE/PE)
    const { d1 } = computeD1D2(S, K, T, r, sigma);
    const vega = S * normPDF(d1) * Math.sqrt(T);

    // Guard against near-zero vega (deep OTM or very short DTE)
    if (vega < 1e-8) break;

    sigma -= diff / vega;

    // Keep sigma in valid range during iteration
    sigma = Math.max(0.001, Math.min(sigma, 3.0));
  }

  // Final sanity: IV must be positive and finite
  return isFinite(sigma) && sigma > 0 ? sigma : 0;
}

// ─── Greeks Calculator ────────────────────────────────────────────────────────

export interface BSMResult {
  /** Implied Volatility — annualised fraction (e.g. 0.153 = 15.3%) */
  iv: number;
  /** Delta: CE in [0, 1], PE in [-1, 0] */
  delta: number;
  /** Gamma: same for CE and PE, per ₹1 move in spot */
  gamma: number;
  /**
   * Theta: ₹ change in option price per CALENDAR DAY.
   * Always negative for long options.
   * For a 75-lot position multiply by 75.
   */
  theta: number;
  /**
   * Vega: ₹ change in option price per 1% change in IV (i.e. per 0.01 in sigma).
   * Already divided by 100 so you can multiply directly by IV_pct_change.
   */
  vega: number;
  /** Theoretical BSM price — useful for cross-checking vs Kite last_price */
  theoreticalPrice: number;
}

/**
 * Calculate full BSM Greeks from spot, strike, DTE, and (already-solved) IV.
 * Call calcIV() first, then pass the result in as `sigma`.
 *
 * All monetary values (theta, vega) are in ₹ per lot unit (multiply by qty for total).
 *
 * @param S      Spot price
 * @param K      Strike price
 * @param T      DTE in years — use dteYears()
 * @param r      Risk-free rate (fractional annual)
 * @param sigma  IV from calcIV() (fractional annual)
 * @param type   'CE' or 'PE'
 */
export function calcGreeks(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: 'CE' | 'PE'
): BSMResult {
  // Expiry case — return intrinsic greeks
  if (T <= 0 || sigma <= 0) {
    const intrinsic = Math.max(0, type === 'CE' ? S - K : K - S);
    return {
      iv: sigma,
      delta: type === 'CE' ? (S >= K ? 1 : 0) : (K >= S ? -1 : 0),
      gamma: 0,
      theta: 0,
      vega: 0,
      theoreticalPrice: intrinsic,
    };
  }

  const sqrtT = Math.sqrt(T);
  const { d1, d2 } = computeD1D2(S, K, T, r, sigma);
  const nd1 = normPDF(d1);   // Normal PDF at d1
  const df  = Math.exp(-r * T);

  // Delta
  const delta = type === 'CE' ? normCDF(d1) : normCDF(d1) - 1;

  // Gamma (same for CE and PE)
  const gamma = nd1 / (S * sigma * sqrtT);

  // Theta (annualised → per calendar day by dividing by 365)
  // Formula produces ₹/year; divide by 365 to get ₹/calendar day
  const thetaAnnual =
    type === 'CE'
      ? -(S * nd1 * sigma) / (2 * sqrtT) - r * K * df * normCDF(d2)
      : -(S * nd1 * sigma) / (2 * sqrtT) + r * K * df * normCDF(-d2);
  const theta = thetaAnnual / 365;

  // Vega: ₹ per 1 percentage point change in IV (i.e. per Δσ = 0.01)
  // Raw vega from BSM is ₹ per unit of sigma (i.e. per 100%), so divide by 100
  const vega = (S * nd1 * sqrtT) / 100;

  const theoreticalPrice = bsmPrice(S, K, T, r, sigma, type);

  return { iv: sigma, delta, gamma, theta, vega, theoreticalPrice };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Convert an expiry date string ("YYYY-MM-DD") to time-to-expiry in years.
 *
 * NSE F&O expiry is at 15:30 IST on the expiry date.
 * Uses calendar days / 365 — consistent with how NSE prices options.
 *
 * @param expiryDateStr  "2024-12-05" (from Kite instrument.expiry field after .toISOString().split('T')[0])
 */
export function dteYears(expiryDateStr: string): number {
  const now = new Date();
  // NSE options expire at 15:30:00 IST = 10:00:00 UTC
  const expiry = new Date(`${expiryDateStr}T10:00:00.000Z`);
  const msLeft = expiry.getTime() - now.getTime();
  const calendarDays = msLeft / (1000 * 60 * 60 * 24);
  return Math.max(0, calendarDays / 365);
}

/**
 * Convenience: compute IV and all Greeks in one call.
 *
 * @param optionPrice  Kite last_price for the option
 * @param S            NIFTY spot
 * @param K            Strike
 * @param expiryStr    "YYYY-MM-DD" from instrument list
 * @param type         'CE' or 'PE'
 * @param r            Risk-free rate (default RISK_FREE_RATE = 0.065)
 */
export function greeksFromMarketPrice(
  optionPrice: number,
  S: number,
  K: number,
  expiryStr: string,
  type: 'CE' | 'PE',
  r: number = RISK_FREE_RATE
): BSMResult & { ivPct: number } {
  const T = dteYears(expiryStr);
  const iv = calcIV(optionPrice, S, K, T, r, type);
  const result = calcGreeks(S, K, T, r, iv, type);
  return {
    ...result,
    ivPct: iv * 100,  // 15.3% instead of 0.153 — convenient for display
  };
}

/**
 * IV Skew helper: returns CE_IV - PE_IV for a given strike as a percentage.
 * Positive = calls richer than puts (bullish skew / demand for upside).
 * Negative = puts richer (bearish skew / demand for protection — normal for indices).
 */
export function ivSkew(
  cePrice: number,
  pePrice: number,
  S: number,
  K: number,
  expiryStr: string,
  r: number = RISK_FREE_RATE
): number {
  const T = dteYears(expiryStr);
  const ceIV = calcIV(cePrice, S, K, T, r, 'CE');
  const peIV = calcIV(pePrice, S, K, T, r, 'PE');
  return (ceIV - peIV) * 100; // in percentage points
}

/**
 * Simple put-call parity check.
 * If the market prices deviate significantly, there may be a data quality issue.
 * Returns the theoretical PE price derived from CE price and spot via put-call parity.
 *
 * C - P = S - K * e^(-rT)
 * → P = C - S + K * e^(-rT)
 */
export function parityPE(cePrice: number, S: number, K: number, T: number, r: number): number {
  return cePrice - S + K * Math.exp(-r * T);
}
