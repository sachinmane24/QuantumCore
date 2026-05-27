/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * market.ts — Market Engine
 *
 * Changes from original:
 *  1. Imports calcIV / calcGreeks / dteYears from ./greeks.ts
 *  2. calculateDelta() now uses real BSM (no more fixed t=1/252 approximation)
 *  3. generateChain() now uses real BSM Greeks — no Math.random() in gamma/theta/vega
 *  4. updateData() accepts optional `expiryStr` so the live server loop can pass
 *     the actual expiry date string for accurate DTE calculation
 *  5. Private expiryStr field stored and used in generateChain()
 *  6. All other logic is IDENTICAL to original — no behaviour changes
 */

import { config } from './config.ts';
import type { OptionChainData } from './types.ts';
import {
  calcIV,
  calcGreeks,
  dteYears,
  RISK_FREE_RATE,
} from './greeks.ts';

export interface Tick {
  tradable: boolean;
  mode: string;
  instrument_token: number;
  last_price: number;
  last_quantity: number;
  average_price: number;
  volume: number;
  buy_quantity: number;
  sell_quantity: number;
  ohlc: { open: number; high: number; low: number; close: number };
  change: number;
  oi: number;
  oi_day_high: number;
  oi_day_low: number;
  timestamp: Date;
}

class MarketEngine {
  private ticks: Map<number, Tick> = new Map();
  private optionChain: OptionChainData[] = [];
  private spotPrice: number = 0;
  private yesterdayClose: number = 0;
  private orbHigh: number = 0;
  private orbLow: number = 0;
  private vwap: number = 0;
  private todayOpen: number = 0;
  private vixDelta: number = 0;
  private priceHistory: number[] = [];
  private readonly MAX_HISTORY = 100;
  private expiryInfo: { weekly: string | null; monthly: string | null } = {
    weekly: null,
    monthly: null,
  };
  private mockInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  /**
   * Active expiry date string ("YYYY-MM-DD") used for DTE calculations.
   * Set by server.ts when the NFO instrument cache is refreshed.
   * Falls back to "next Thursday" heuristic if not set.
   */
  private currentExpiryStr: string | null = null;

  // ─── Expiry helpers ──────────────────────────────────────────────────────────

  public setExpiryInfo(weekly: string | null, monthly: string | null) {
    this.expiryInfo = { weekly, monthly };
    // Also update currentExpiryStr so Greeks calculations stay accurate
    if (weekly) this.currentExpiryStr = weekly;
    else if (monthly) this.currentExpiryStr = monthly;
  }

  /**
   * Called by server.ts after refreshNfoCache() to give the engine the
   * actual selected expiry date string for option DTE computation.
   */
  public setCurrentExpiry(expiryStr: string) {
    this.currentExpiryStr = expiryStr;
  }

  public getCurrentExpiry(): string {
    if (this.currentExpiryStr) return this.currentExpiryStr;
    // Fallback: next Thursday (NIFTY weekly expiry heuristic)
    const d = new Date();
    const day = d.getDay(); // 0=Sun, 4=Thu
    const daysUntilThursday = (4 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilThursday);
    return d.toISOString().split('T')[0];
  }

  public getExpiryStatus() {
    const istTime = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const today = istTime.toISOString().split('T')[0];
    const isWeekly = this.expiryInfo.weekly === today;
    const isMonthlyExpiry = this.expiryInfo.monthly === today;
    return {
      isWeekly,
      isMonthlyExpiry,
      isExpiryDay: isWeekly || isMonthlyExpiry,
    };
  }

  // ─── Market hours ─────────────────────────────────────────────────────────────

  public isMarketClosed(): boolean {
    const holidays = [
      '2026-01-26', '2026-03-08', '2026-03-25', '2026-03-29', '2026-04-11',
      '2026-04-17', '2026-05-01', '2026-06-17', '2026-07-17', '2026-08-15',
      '2026-10-02', '2026-11-01', '2026-11-15', '2026-12-25',
    ];
    try {
      const now = new Date();
      const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const istDate = new Date(istString);
      const day = istDate.getDay();
      const hours = istDate.getHours();
      const minutes = istDate.getMinutes();
      const currentTimeMinutes = hours * 60 + minutes;
      const year = istDate.getFullYear();
      const month = String(istDate.getMonth() + 1).padStart(2, '0');
      const dateVal = String(istDate.getDate()).padStart(2, '0');
      const today = `${year}-${month}-${dateVal}`;
      const isWeekend = day === 0 || day === 6;
      const isHoliday = holidays.includes(today);
      const isOffMarketHours = currentTimeMinutes < 555 || currentTimeMinutes > 930;
      return isWeekend || isHoliday || isOffMarketHours;
    } catch (err) {
      console.error('[MARKET] Error calculating market hours:', err);
      return false;
    }
  }

  // ─── Technical indicators (unchanged) ────────────────────────────────────────

  public getTechnicalIndicators() {
    if (this.priceHistory.length < 30) {
      return {
        rsi: 50,
        macd: { macd: 0, signal: 0, histogram: 0 },
        bollinger: {
          upper: this.spotPrice,
          lower: this.spotPrice,
          middle: this.spotPrice,
        },
      };
    }
    const prices = this.priceHistory;

    const computeRSI = (data: number[], period: number = 14) => {
      let gains = 0;
      let losses = 0;
      for (let i = data.length - period; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      const avgGain = gains / period;
      const avgLoss = losses / period;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - 100 / (1 + rs);
    };

    const computeEMA = (data: number[], period: number) => {
      const k = 2 / (period + 1);
      let ema = data[data.length - period];
      for (let i = data.length - period + 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
      }
      return ema;
    };

    const computeBBands = (data: number[], period: number = 20, stdDev: number = 2) => {
      const window = data.slice(-period);
      const sma = window.reduce((a, b) => a + b, 0) / period;
      const variance = window.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
      const sd = Math.sqrt(variance);
      return { upper: sma + stdDev * sd, middle: sma, lower: sma - stdDev * sd };
    };

    const ema12 = computeEMA(prices, 12);
    const ema26 = computeEMA(prices, 26);
    const macdValue = ema12 - ema26;

    return {
      rsi: computeRSI(prices),
      macd: { macd: macdValue, signal: macdValue * 0.9, histogram: macdValue * 0.1 },
      bollinger: computeBBands(prices),
    };
  }

  // ─── Delta (real BSM, replaces fixed t=1/252 approximation) ──────────────────

  /**
   * Calculate option Delta using real Black-Scholes.
   *
   * @param spot    Current NIFTY spot
   * @param strike  Option strike
   * @param type    'CE' or 'PE'
   * @param iv      IV as a percentage (e.g. 15.0 for 15%) — optional, falls back
   *                to current VIX as proxy (rough but better than a constant)
   * @param expiryStr  "YYYY-MM-DD" — optional, falls back to getCurrentExpiry()
   */
  public calculateDelta(
    spot: number,
    strike: number,
    type: 'CE' | 'PE',
    iv?: number,
    expiryStr?: string
  ): number {
    const T = dteYears(expiryStr ?? this.getCurrentExpiry());
    // iv parameter is in percentage form (e.g. 15.0); convert to fraction
    const sigma = ((iv ?? this.getVix()) / 100) || 0.15;

    // For zero-or-negative DTE, return intrinsic delta
    if (T <= 0) {
      return type === 'CE' ? (spot >= strike ? 1 : 0) : (spot <= strike ? -1 : 0);
    }

    const { delta } = calcGreeks(spot, strike, T, RISK_FREE_RATE, sigma, type);
    return delta;
  }

  // ─── Constructor / mode sync ──────────────────────────────────────────────────

  constructor() {
    this.syncMode();
  }

  // ─── Daily structure (unchanged) ─────────────────────────────────────────────

  public setYesterdayClose(price: number) {
    this.yesterdayClose = price;
  }

  public getYesterdayClose(): number {
    return this.yesterdayClose;
  }

  public getVixDelta(): number {
    return this.vixDelta;
  }

  public getGapPercent(): number {
    if (this.todayOpen === 0) return 0;
    return ((this.todayOpen - this.yesterdayClose) / this.yesterdayClose) * 100;
  }

  public setORB(high: number, low: number) {
    this.orbHigh = high;
    this.orbLow = low;
  }

  public getORB() {
    return { high: this.orbHigh, low: this.orbLow };
  }

  public getVWAP(): number {
    return this.vwap || this.spotPrice;
  }

  public setVWAP(price: number) {
    this.vwap = price;
  }

  public getTodayOpen(): number {
    return this.todayOpen;
  }

  public updateDailyStructure(data: {
    prevClose?: number;
    open?: number;
    high?: number;
    low?: number;
    vwap?: number;
  }) {
    if (data.prevClose !== undefined && data.prevClose > 0)
      this.yesterdayClose = data.prevClose;
    if (data.open !== undefined && data.open > 0) this.todayOpen = data.open;
    if (data.high !== undefined && data.high > 0) this.orbHigh = data.high;
    if (data.low !== undefined && data.low > 0) this.orbLow = data.low;
    if (data.vwap !== undefined && data.vwap > 0) this.vwap = data.vwap;
    console.log(
      `[MARKET] Daily structure updated from persistence: Close=${this.yesterdayClose}, Open=${this.todayOpen}, ORB_H=${this.orbHigh}, ORB_L=${this.orbLow}, VWAP=${this.vwap}`
    );
  }

  public getDailyStructure() {
    return {
      prevClose: this.yesterdayClose,
      open: this.todayOpen,
      high: this.orbHigh,
      low: this.orbLow,
      vwap: this.vwap,
    };
  }

  public getSwingLevels(window: number = 20): { high: number; low: number } {
    if (this.priceHistory.length < window) {
      return {
        high: Math.max(...(this.priceHistory.length > 0 ? this.priceHistory : [this.spotPrice])),
        low: Math.min(...(this.priceHistory.length > 0 ? this.priceHistory : [this.spotPrice])),
      };
    }
    const recent = this.priceHistory.slice(-window);
    return { high: Math.max(...recent), low: Math.min(...recent) };
  }

  public getPriceHistory() {
    return this.priceHistory;
  }

  // ─── Mode sync ────────────────────────────────────────────────────────────────

  public syncMode() {
    console.log(`[MARKET] Syncing mode: ${config.DATA_SOURCE}`);
    if (config.DATA_SOURCE === 'MOCK') {
      if (this.mockInterval) clearInterval(this.mockInterval);
      this.startMockData();
    } else {
      if (this.mockInterval) {
        clearInterval(this.mockInterval);
        this.mockInterval = null;
        console.log(`[MARKET] Mock interval cleared`);
      }
      this.yesterdayClose = 0;
      this.todayOpen = 0;
      this.orbHigh = 0;
      this.orbLow = 0;
      this.vwap = 0;
      this.initialized = false;
    }
  }

  // ─── Chain generator — real BSM Greeks ───────────────────────────────────────

  /**
   * Generates a synthetic option chain using real Black-Scholes.
   * Used only in MOCK mode. In LIVE mode, Kite prices + calcIV() are used
   * by the server loop before calling updateData().
   */
  private generateChain(spot: number): OptionChainData[] {
    const atmStrike = Math.round(spot / 50) * 50; // MOCK mode — NIFTY 50-pt step hardcoded intentionally
    const expiryStr = this.getCurrentExpiry();
    const T = dteYears(expiryStr);
    const vix = this.getVix();
    // Use VIX as base IV proxy for mock data; add a realistic skew (puts ~1-2% richer)
    const baseIvFrac = (vix / 100) || 0.15;

    const chain: OptionChainData[] = [];

    for (let i = -5; i <= 5; i++) {
      const strike = atmStrike + i * 50;
      const moneyness = (strike - spot) / spot;

      // Skew model: puts carry a premium (negative moneyness = OTM put = higher IV)
      // This is the NIFTY volatility smile — puts are always richer than equidistant calls
      const skewAdjCE = baseIvFrac + moneyness * 0.05;      // calls: slightly lower for OTM
      const skewAdjPE = baseIvFrac - moneyness * 0.08;      // puts: higher for OTM puts

      const ceIvFrac = Math.max(0.05, skewAdjCE);
      const peIvFrac = Math.max(0.05, skewAdjPE);

      // Theoretical prices from BSM (no randomness)
      const cePrice = Math.max(0.05, bsmPriceHelper(spot, strike, T, RISK_FREE_RATE, ceIvFrac, 'CE'));
      const pePrice = Math.max(0.05, bsmPriceHelper(spot, strike, T, RISK_FREE_RATE, peIvFrac, 'PE'));

      // Real Greeks from BSM
      const ceG = calcGreeks(spot, strike, T, RISK_FREE_RATE, ceIvFrac, 'CE');
      const peG = calcGreeks(spot, strike, T, RISK_FREE_RATE, peIvFrac, 'PE');

      // Synthetic OI — higher at ATM, falling off for OTM (realistic distribution)
      const oiDecay = Math.exp(-0.5 * Math.pow(i, 2) / 4);
      const ceOi = Math.round((3_000_000 + (i < 0 ? 500_000 * Math.abs(i) : 0)) * oiDecay);
      const peOi = Math.round((3_000_000 + (i > 0 ? 500_000 * i : 0)) * oiDecay);

      chain.push({
        strike,
        ce_oi: ceOi,
        ce_oi_change: Math.round((Math.random() - 0.4) * 40_000),
        pe_oi: peOi,
        pe_oi_change: Math.round((Math.random() - 0.6) * 40_000),
        ce_price: cePrice,
        pe_price: pePrice,
        ce_volume: Math.floor(Math.random() * 500_000),
        pe_volume: Math.floor(Math.random() * 500_000),
        ce_iv: ceIvFrac * 100,   // Store as percentage (e.g. 15.3)
        pe_iv: peIvFrac * 100,
        iv: ((ceIvFrac + peIvFrac) / 2) * 100,
        delta: ceG.delta,
        pe_delta: peG.delta,
        gamma: ceG.gamma,        // Real gamma — same for CE and PE at same strike
        theta: ceG.theta,        // Real theta ₹/day per unit
        vega: ceG.vega,          // Real vega ₹ per 1% IV move per unit
      });
    }
    return chain;
  }

  // ─── Mock data (structure unchanged, uses real chain generator) ───────────────

  private startMockData() {
    this.yesterdayClose = 24300;
    this.todayOpen = 24350;
    this.spotPrice = this.todayOpen;
    this.vwap = this.spotPrice;

    // Pre-warm price history for RSI/MACD/Bollinger
    this.priceHistory = [];
    let simPrice = this.yesterdayClose;
    for (let i = 0; i < 80; i++) {
      simPrice += (Math.random() - 0.49) * 4;
      this.priceHistory.push(simPrice);
    }
    this.priceHistory.push(this.spotPrice);

    this.mockInterval = setInterval(() => {
      if (config.DATA_SOURCE !== 'MOCK') {
        if (this.mockInterval) {
          clearInterval(this.mockInterval);
          this.mockInterval = null;
        }
        return;
      }

      const change = (Math.random() - 0.495) * 6;
      this.spotPrice += change;
      this.vwap = this.vwap * 0.95 + this.spotPrice * 0.05;
      const changePct = ((this.spotPrice - this.yesterdayClose) / this.yesterdayClose) * 100;

      const mockTick: Tick = {
        tradable: true,
        mode: 'full',
        instrument_token: 256265,
        last_price: this.spotPrice,
        last_quantity: Math.floor(Math.random() * 500),
        average_price: this.spotPrice - 2,
        volume: 1_000_000 + Math.random() * 50_000,
        buy_quantity: 500_000,
        sell_quantity: 480_000,
        ohlc: {
          open: this.spotPrice - 30,
          high: this.spotPrice + 20,
          low: this.spotPrice - 40,
          close: this.spotPrice,
        },
        change: changePct,
        oi: 12_000_000,
        oi_day_high: 13_000_000,
        oi_day_low: 11_000_000,
        timestamp: new Date(),
      };
      this.ticks.set(mockTick.instrument_token, mockTick);

      const generatedChain = this.generateChain(this.spotPrice);
      this.updateData(this.spotPrice, generatedChain, 12.42, mockTick.ohlc, changePct, this.vwap);
    }, 1000);
  }

  // ─── Public accessors (unchanged) ────────────────────────────────────────────

  getLatestTick(token: number = 256265): Tick | undefined {
    return this.ticks.get(token);
  }

  getSpotPrice(): number {
    return this.spotPrice;
  }

  getVix(): number {
    return this.ticks.get(264969)?.last_price || 12.42;
  }

  getPCR(): number {
    let callOi = 0;
    let putOi = 0;
    this.optionChain.forEach(c => {
      callOi += c.ce_oi || 0;
      putOi += c.pe_oi || 0;
    });
    return callOi > 0 ? Number((putOi / callOi).toFixed(2)) : 1.0;
  }

  getMaxPain(): number {
    if (this.optionChain.length === 0) return this.spotPrice;
    let maxPainStrike = this.spotPrice;
    let minPain = Infinity;
    this.optionChain.forEach(target => {
      let totalPain = 0;
      this.optionChain.forEach(option => {
        const cePain = Math.max(0, target.strike - option.strike) * option.ce_oi;
        const pePain = Math.max(0, option.strike - target.strike) * option.pe_oi;
        totalPain += cePain + pePain;
      });
      if (totalPain < minPain) {
        minPain = totalPain;
        maxPainStrike = target.strike;
      }
    });
    return maxPainStrike;
  }

  getOptionChain(): OptionChainData[] {
    return this.optionChain;
  }

  getMaxOi() {
    if (this.optionChain.length === 0)
      return { ce: { strike: 0, oi: 0 }, pe: { strike: 0, oi: 0 } };
    let maxCe = { strike: 0, oi: 0 };
    let maxPe = { strike: 0, oi: 0 };
    this.optionChain.forEach(c => {
      if ((c.ce_oi || 0) > maxCe.oi) maxCe = { strike: c.strike, oi: c.ce_oi };
      if ((c.pe_oi || 0) > maxPe.oi) maxPe = { strike: c.strike, oi: c.pe_oi };
    });
    return { ce: maxCe, pe: maxPe };
  }

  // ─── updateData ───────────────────────────────────────────────────────────────

  /**
   * Primary data ingestion method — called by the server market loop every tick.
   *
   * @param spotPrice   NIFTY last_price from Kite
   * @param chain       Option chain already enriched with real BSM Greeks by server.ts
   * @param vix         INDIA VIX last_price
   * @param niftyOhlc   OHLC from Kite quote
   * @param niftyChange % change from prev close
   * @param vwap        VWAP (calculated externally or passed through)
   * @param expiryStr   "YYYY-MM-DD" of the selected expiry — optional, keeps DTE accurate
   */
  updateData(
    spotPrice: number,
    chain?: OptionChainData[],
    vix?: number,
    niftyOhlc?: any,
    niftyChange?: number,
    vwap?: number,
    expiryStr?: string
  ) {
    this.spotPrice = spotPrice;

    // Keep expiry current if server provides it
    if (expiryStr) this.currentExpiryStr = expiryStr;

    // Price history
    if (spotPrice > 0) {
      if (
        this.priceHistory.length === 0 ||
        this.priceHistory[this.priceHistory.length - 1] !== spotPrice
      ) {
        this.priceHistory.push(spotPrice);
        if (this.priceHistory.length > this.MAX_HISTORY) this.priceHistory.shift();
      }
    }

    if (chain && chain.length > 0) {
      this.optionChain = chain;
    } else if (config.DATA_SOURCE === 'MOCK') {
      this.optionChain = this.generateChain(spotPrice);
    }

    if (vwap) this.vwap = vwap;

    if (niftyOhlc) {
      if (niftyOhlc.close && niftyOhlc.close > 0) this.yesterdayClose = niftyOhlc.close;
      if (niftyOhlc.open && niftyOhlc.open > 0) this.todayOpen = niftyOhlc.open;
    }

    if (!this.initialized && spotPrice > 0) {
      this.spotPrice = spotPrice;
      if (this.todayOpen === 0) {
        this.todayOpen = this.yesterdayClose > 0 ? this.yesterdayClose : spotPrice;
      }
      this.initialized = true;
    }

    // ORB: capture between 9:15–9:30 IST
    const now = new Date();
    const istDate = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const timeInMins = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
    if (timeInMins >= 555 && timeInMins < 570 && niftyOhlc) {
      if (this.orbHigh === 0 || niftyOhlc.high > this.orbHigh) this.orbHigh = niftyOhlc.high;
      if (this.orbLow === 0 || niftyOhlc.low < this.orbLow) this.orbLow = niftyOhlc.low;
    }

    // VIX tick
    if (vix) {
      const prevVixTick = this.ticks.get(264969);
      if (prevVixTick && prevVixTick.last_price > 0) {
        this.vixDelta = ((vix - prevVixTick.last_price) / prevVixTick.last_price) * 100;
      }
      const vixTick: Tick = {
        tradable: true,
        mode: 'full',
        instrument_token: 264969,
        last_price: vix,
        last_quantity: 0,
        average_price: vix,
        volume: 0,
        buy_quantity: 0,
        sell_quantity: 0,
        ohlc: { open: vix, high: vix + 0.1, low: vix - 0.1, close: vix },
        change: -0.05,
        oi: 0,
        oi_day_high: 0,
        oi_day_low: 0,
        timestamp: new Date(),
      };
      this.ticks.set(264969, vixTick);
    }

    // NIFTY tick
    const tick: Tick = {
      tradable: true,
      mode: 'full',
      instrument_token: 256265,
      last_price: spotPrice,
      last_quantity: 0,
      average_price: spotPrice,
      volume: 12_500_000,
      buy_quantity: 6_000_000,
      sell_quantity: 6_500_000,
      ohlc: niftyOhlc || {
        open: spotPrice,
        high: spotPrice + 10,
        low: spotPrice - 10,
        close: spotPrice,
      },
      change: niftyChange || 0,
      oi: 0,
      oi_day_high: 0,
      oi_day_low: 0,
      timestamp: new Date(),
    };
    this.ticks.set(256265, tick);
  }
}

// ─── Module-level BSM price helper (avoids circular import in generateChain) ──
// This is just a thin re-export wrapper so generateChain() can call it without
// going through the full greeks module import inside the method.
function bsmPriceHelper(
  S: number, K: number, T: number, r: number, sigma: number, type: 'CE' | 'PE'
): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const normCDF = (x: number): number => {
    if (x < -8) return 0; if (x > 8) return 1;
    const A1=0.254829592, A2=-0.284496736, A3=1.421413741, A4=-1.453152027, A5=1.061405429, P=0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + P * Math.abs(x));
    const poly = t*(A1+t*(A2+t*(A3+t*(A4+t*A5))));
    return 0.5*(1.0+sign*(1-poly*Math.exp(-x*x)));
  };
  const df = Math.exp(-r * T);
  return type === 'CE'
    ? S * normCDF(d1) - K * df * normCDF(d2)
    : K * df * normCDF(-d2) - S * normCDF(-d1);
}

export const marketEngine = new MarketEngine();
