/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config, getActiveSpec } from './config.ts';
import type { OptionChainData } from './types.ts';

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
  private priceHistory: number[] = []; // raw tick history (used as fallback)
  private readonly MAX_HISTORY = 100;
  // 1-minute candle closes — primary series for RSI/MACD/Bollinger.
  // ~390 bars covers a full Indian equities session.
  private minuteCandles: number[] = [];
  private currentMinuteKey: number = -1;
  private currentMinuteClose: number = 0;
  private readonly MAX_CANDLES = 390;
  // Rolling IV samples (one per minute) for IV rank / percentile.
  private ivSamples: number[] = [];
  private readonly MAX_IV_SAMPLES = 1560; // ~4 sessions worth, for trailing rank
  private expiryInfo: { weekly: string | null, monthly: string | null } = { weekly: null, monthly: null };
  private mockInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  public setExpiryInfo(weekly: string | null, monthly: string | null) {
    this.expiryInfo = { weekly, monthly };
  }

  public getExpiryStatus() {
    const istTime = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const today = istTime.toISOString().split('T')[0];
    
    const isWeekly = this.expiryInfo.weekly === today;
    const isMonthlyExpiry = this.expiryInfo.monthly === today;
    
    return {
      isWeekly,
      isMonthlyExpiry,
      isExpiryDay: isWeekly || isMonthlyExpiry,
    };
  }

  public isMarketClosed(): boolean {
    const holidays = [
      "2026-01-26", "2026-03-08", "2026-03-25", "2026-03-29", "2026-04-11",
      "2026-04-17", "2026-05-01", "2026-06-17", "2026-07-17", "2026-08-15",
      "2026-10-02", "2026-11-01", "2026-11-15", "2026-12-25"
    ];
    
    try {
      const now = new Date();
      
      const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const istDate = new Date(istString);
      
      const day = istDate.getDay(); // 0 (Sun) to 6 (Sat)
      const hours = istDate.getHours(); // 0 to 23
      const minutes = istDate.getMinutes(); // 0 to 59
      const currentTimeMinutes = hours * 60 + minutes;
      
      const year = istDate.getFullYear();
      const month = String(istDate.getMonth() + 1).padStart(2, '0');
      const dateVal = String(istDate.getDate()).padStart(2, '0');
      const today = `${year}-${month}-${dateVal}`;
      
      const isWeekend = day === 0 || day === 6;
      const isHoliday = holidays.includes(today);
      const isOffMarketHours = currentTimeMinutes < 555 || currentTimeMinutes > 930; // 9:15 AM to 3:30 PM
      
      return isWeekend || isHoliday || isOffMarketHours;
    } catch (err) {
      console.error('[MARKET] Error calculating market hours:', err);
      return false;
    }
  }

  public getTechnicalIndicators() {
    // Prefer 1-minute candles (clean signal) when we have enough bars; fall back to
    // raw tick history during warm-up so the UI isn't flat-50 for the first session.
    const useCandles = this.minuteCandles.length >= 35;
    if (!useCandles && this.priceHistory.length < 30) {
      return { rsi: 50, macd: { macd: 0, signal: 0, histogram: 0 }, bollinger: { upper: this.spotPrice, lower: this.spotPrice, middle: this.spotPrice } };
    }

    const prices = useCandles ? this.minuteCandles : this.priceHistory;
    
    // RSI (14)
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
      return 100 - (100 / (1 + rs));
    };

    // EMA
    const computeEMA = (data: number[], period: number) => {
      const k = 2 / (period + 1);
      let ema = data[data.length - period];
      for (let i = data.length - period + 1; i < data.length; i++) {
        ema = (data[i] * k) + (ema * (1 - k));
      }
      return ema;
    };

    // Bollinger Bands (20, 2)
    const computeBBands = (data: number[], period: number = 20, stdDev: number = 2) => {
      const window = data.slice(-period);
      const sma = window.reduce((a, b) => a + b, 0) / period;
      const variance = window.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
      const sd = Math.sqrt(variance);
      return { upper: sma + stdDev * sd, middle: sma, lower: sma - stdDev * sd };
    };

    // MACD (12, 26, 9) — build a rolling MACD-line series, then EMA(9) it for signal.
    // Need at least 26 + 9 = 35 bars for a meaningful signal line; otherwise return raw line.
    const macdLineAt = (idxFromEnd: number) => {
      // Compute EMA(period) over data[0 .. data.length - 1 - idxFromEnd]
      const slice = prices.slice(0, prices.length - idxFromEnd);
      if (slice.length < 26) return 0;
      const ema = (period: number) => {
        const k = 2 / (period + 1);
        let e = slice[slice.length - period];
        for (let i = slice.length - period + 1; i < slice.length; i++) {
          e = (slice[i] * k) + (e * (1 - k));
        }
        return e;
      };
      return ema(12) - ema(26);
    };

    const macdValue = macdLineAt(0);
    let signal = macdValue;
    let histogram = 0;

    if (prices.length >= 35) {
      const signalWindow = 9;
      const macdSeries: number[] = [];
      for (let i = signalWindow - 1; i >= 0; i--) {
        macdSeries.push(macdLineAt(i));
      }
      const k = 2 / (signalWindow + 1);
      signal = macdSeries[0];
      for (let i = 1; i < macdSeries.length; i++) {
        signal = (macdSeries[i] * k) + (signal * (1 - k));
      }
      histogram = macdValue - signal;
    }

    return {
      rsi: computeRSI(prices),
      macd: { macd: macdValue, signal, histogram },
      bollinger: computeBBands(prices)
    };
  }

  // Black-Scholes Delta Approximation
  public calculateDelta(spot: number, strike: number, type: 'CE' | 'PE', iv?: number): number {
    const sigma = (iv || 15) / 100;
    const t = 1/252; // Extreme approx for 1 day / 0 DTE
    const r = 0.07;
    
    const d1 = (Math.log(spot / strike) + (r + sigma * sigma / 2) * t) / (sigma * Math.sqrt(t));
    
    // Normal distribution approx
    const n_d1 = (x: number) => {
      const b1 = 0.319381530;
      const b2 = -0.356563782;
      const b3 = 1.781477937;
      const b4 = -1.821255978;
      const b5 = 1.330274429;
      const p = 0.2316419;
      const c = 0.39894228;
      const t = 1.0 / (1.0 + p * Math.abs(x));
      const val = 1.0 - c * Math.exp(-x * x / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
      return x >= 0 ? val : 1 - val;
    };

    if (type === 'CE') return n_d1(d1);
    return n_d1(d1) - 1;
  }

  constructor() {
    this.syncMode();
  }

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
    return this.vwap || this.spotPrice; // Fallback to spot
  }

  public setVWAP(price: number) {
    this.vwap = price;
  }

  public getTodayOpen(): number {
    return this.todayOpen;
  }

  public updateDailyStructure(data: { prevClose?: number, open?: number, high?: number, low?: number, vwap?: number }) {
    if (data.prevClose !== undefined && data.prevClose > 0) this.yesterdayClose = data.prevClose;
    if (data.open !== undefined && data.open > 0) this.todayOpen = data.open;
    if (data.high !== undefined && data.high > 0) this.orbHigh = data.high;
    if (data.low !== undefined && data.low > 0) this.orbLow = data.low;
    if (data.vwap !== undefined && data.vwap > 0) this.vwap = data.vwap;
    console.log(`[MARKET] Daily structure updated from persistence: Close=${this.yesterdayClose}, Open=${this.todayOpen}, ORB_H=${this.orbHigh}, ORB_L=${this.orbLow}, VWAP=${this.vwap}`);
  }

  public getDailyStructure() {
    return {
      prevClose: this.yesterdayClose,
      open: this.todayOpen,
      high: this.orbHigh,
      low: this.orbLow,
      vwap: this.vwap
    };
  }

  public getSwingLevels(window: number = 20): { high: number; low: number } {
    if (this.priceHistory.length < window) {
      return { 
        high: Math.max(...(this.priceHistory.length > 0 ? this.priceHistory : [this.spotPrice])), 
        low: Math.min(...(this.priceHistory.length > 0 ? this.priceHistory : [this.spotPrice])) 
      };
    }
    const recent = this.priceHistory.slice(-window);
    return {
      high: Math.max(...recent),
      low: Math.min(...recent)
    };
  }

  public getPriceHistory() {
    return this.priceHistory;
  }

  public syncMode() {
    console.log(`[MARKET] Syncing mode: ${config.DATA_SOURCE}`);
    if (config.DATA_SOURCE === 'MOCK') {
      if (this.mockInterval) {
        clearInterval(this.mockInterval);
      }
      this.startMockData();
    } else {
      if (this.mockInterval) {
        clearInterval(this.mockInterval);
        this.mockInterval = null;
        console.log(`[MARKET] Mock interval cleared`);
      }
      // Reset mock-initialized values to allow live data to take over
      this.yesterdayClose = 0;
      this.todayOpen = 0;
      this.orbHigh = 0;
      this.orbLow = 0;
      this.vwap = 0;
      this.initialized = false;
    }
  }

  private generateChain(spot: number): OptionChainData[] {
    const atmStrike = Math.round(spot / config.STRIKE_STEP) * config.STRIKE_STEP;
    const chain: OptionChainData[] = [];
    for (let i = -5; i <= 5; i++) {
      const strike = atmStrike + (i * config.STRIKE_STEP);
      const ce_iv = 12 + Math.random() * 4;
      const pe_iv = 13 + Math.random() * 4;
      chain.push({
        strike,
        ce_oi: 5000000 - (i * 500000) + (Math.random() * 100000),
        ce_oi_change: (Math.random() - 0.4) * 40000,
        pe_oi: 5000000 + (i * 500000) + (Math.random() * 100000),
        pe_oi_change: (Math.random() - 0.6) * 40000,
        ce_price: Math.max(1, 100 - (strike - spot) * 0.4),
        pe_price: Math.max(1, 100 + (strike - spot) * 0.4),
        ce_volume: Math.floor(Math.random() * 1000000),
        pe_volume: Math.floor(Math.random() * 1000000),
        ce_iv,
        pe_iv,
        iv: (ce_iv + pe_iv) / 2,
        delta: this.calculateDelta(spot, strike, 'CE', ce_iv),
        pe_delta: this.calculateDelta(spot, strike, 'PE', pe_iv),
        gamma: Math.max(0.001, (1 / (50 + Math.abs(spot - strike)))) * 2, // ATM Gamma is higher
        theta: -10 - (Math.random() * 5),
        vega: 5 + (Math.random() * 2),
      });
    }
    return chain;
  }

  private startMockData() {
    // Initial Gap for testing
    // Baseline derived from the active symbol so SENSEX mock starts at ~78k, not 24k.
    const baseline = getActiveSpec().mockBaseline;
    this.yesterdayClose = baseline;
    this.todayOpen = baseline + Math.round(baseline * 0.002 / config.STRIKE_STEP) * config.STRIKE_STEP; // ~0.2% gap, snapped to step
    this.spotPrice = this.todayOpen;
    this.vwap = this.spotPrice;

    // Pre-populate price history with organic random walk to warm up indicators immediately
    this.priceHistory = [];
    let simPrice = this.yesterdayClose;
    for (let i = 0; i < 80; i++) {
      simPrice += (Math.random() - 0.49) * 4 * getActiveSpec().pointScale; // micro-oscillations, scaled by index
      this.priceHistory.push(simPrice);
    }
    // Set current price history endpoint
    this.priceHistory.push(this.spotPrice);

    this.mockInterval = setInterval(() => {
      // Safety check: if mode was changed but interval not cleared or still running
      if (config.DATA_SOURCE !== 'MOCK') {
        if (this.mockInterval) {
          clearInterval(this.mockInterval);
          this.mockInterval = null;
        }
        return;
      }

      // Mock spot price movement with slight momentum/drift
      const change = (Math.random() - 0.495) * 6 * getActiveSpec().pointScale;
      this.spotPrice += change;
      
      // Update VWAP (simple moving weighted average mock)
      this.vwap = (this.vwap * 0.95) + (this.spotPrice * 0.05);

      const changePct = ((this.spotPrice - this.yesterdayClose) / this.yesterdayClose) * 100;

      // Update ticks
      const mockTick: Tick = {
        tradable: true,
        mode: 'full',
        instrument_token: getActiveSpec().spotToken,
        last_price: this.spotPrice,
        last_quantity: Math.floor(Math.random() * 500),
        average_price: this.spotPrice - 2,
        volume: 1000000 + Math.random() * 50000,
        buy_quantity: 500000,
        sell_quantity: 480000,
        ohlc: { open: this.spotPrice - 30, high: this.spotPrice + 20, low: this.spotPrice - 40, close: this.spotPrice },
        change: changePct,
        oi: 12000000,
        oi_day_high: 13000000,
        oi_day_low: 11000000,
        timestamp: new Date()
      };
      this.ticks.set(mockTick.instrument_token, mockTick);

      const generatedChain = this.generateChain(this.spotPrice);
      this.updateData(this.spotPrice, generatedChain, 12.42, mockTick.ohlc, changePct, this.vwap);
    }, 1000);
  }

  // Default to the active symbol's spot token so callers don't need to know
  // which index is current.
  getLatestTick(token?: number): Tick | undefined {
    const t = token ?? getActiveSpec().spotToken;
    return this.ticks.get(t);
  }

  getSpotPrice(): number {
    return this.spotPrice;
  }

  getVix(): number {
    const vt = getActiveSpec().vixToken;
    if (vt === null) return 12.42;
    return this.ticks.get(vt)?.last_price || 12.42;
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
        // CE Pain: Max(0, Strike - OptionStrike) * OI
        const cePain = Math.max(0, target.strike - option.strike) * option.ce_oi;
        // PE Pain: Max(0, OptionStrike - Strike) * OI
        const pePain = Math.max(0, option.strike - target.strike) * option.pe_oi;
        totalPain += (cePain + pePain);
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
    if (this.optionChain.length === 0) return { ce: { strike: 0, oi: 0 }, pe: { strike: 0, oi: 0 } };
    let maxCe = { strike: 0, oi: 0 };
    let maxPe = { strike: 0, oi: 0 };
    this.optionChain.forEach(c => {
      if ((c.ce_oi || 0) > maxCe.oi) maxCe = { strike: c.strike, oi: c.ce_oi };
      if ((c.pe_oi || 0) > maxPe.oi) maxPe = { strike: c.strike, oi: c.pe_oi };
    });
    return { ce: maxCe, pe: maxPe };
  }

  // ATM average IV — used as the live IV reading. Falls back to VIX if chain has no IV.
  public getAtmIV(): number {
    if (this.optionChain.length === 0 || this.spotPrice === 0) return this.getVix();
    const atmStrike = Math.round(this.spotPrice / 50) * 50;
    const atm = this.optionChain.find(c => c.strike === atmStrike);
    if (!atm) return this.getVix();
    const ce = atm.ce_iv || 0;
    const pe = atm.pe_iv || 0;
    if (ce > 0 && pe > 0) return (ce + pe) / 2;
    if (ce > 0) return ce;
    if (pe > 0) return pe;
    return this.getVix();
  }

  // IV Rank — where current IV sits between historical min and max (0–100).
  // Returns null until we have at least a session's worth of samples (~30 bars).
  public getIVRank(): number | null {
    if (this.ivSamples.length < 30) return null;
    const current = this.getAtmIV();
    let min = Infinity, max = -Infinity;
    for (const v of this.ivSamples) { if (v < min) min = v; if (v > max) max = v; }
    if (max - min < 0.01) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
  }

  // IV Percentile — % of historical samples below the current reading.
  public getIVPercentile(): number | null {
    if (this.ivSamples.length < 30) return null;
    const current = this.getAtmIV();
    let below = 0;
    for (const v of this.ivSamples) if (v < current) below++;
    return (below / this.ivSamples.length) * 100;
  }

  public getMinuteCandles(): number[] {
    return this.minuteCandles;
  }

  updateData(spotPrice: number, chain?: OptionChainData[], vix?: number, niftyOhlc?: any, niftyChange?: number, vwap?: number) {
    this.spotPrice = spotPrice;

    // Update price history
    if (spotPrice > 0) {
      if (this.priceHistory.length === 0 || this.priceHistory[this.priceHistory.length - 1] !== spotPrice) {
        this.priceHistory.push(spotPrice);
        if (this.priceHistory.length > this.MAX_HISTORY) {
          this.priceHistory.shift();
        }
      }

      // 1-minute candle bucketing — anchor on UTC minute (timezone-agnostic, monotonic).
      const minuteKey = Math.floor(Date.now() / 60000);
      if (this.currentMinuteKey === -1) {
        this.currentMinuteKey = minuteKey;
        this.currentMinuteClose = spotPrice;
      } else if (minuteKey !== this.currentMinuteKey) {
        // Minute rolled over — commit the previous minute's last tick as its close.
        this.minuteCandles.push(this.currentMinuteClose);
        if (this.minuteCandles.length > this.MAX_CANDLES) this.minuteCandles.shift();
        // Sample IV (ATM avg) once per minute for rank/percentile.
        const atmIv = this.getAtmIV();
        if (atmIv > 0) {
          this.ivSamples.push(atmIv);
          if (this.ivSamples.length > this.MAX_IV_SAMPLES) this.ivSamples.shift();
        }
        this.currentMinuteKey = minuteKey;
      }
      this.currentMinuteClose = spotPrice;
    }

    if (chain && chain.length > 0) {
      this.optionChain = chain;
    } else if (config.DATA_SOURCE === 'MOCK') {
      this.optionChain = this.generateChain(spotPrice);
    }

    if (vwap) this.vwap = vwap;
    
    // Set daily structure values if they are reported by exchange
    if (niftyOhlc) {
      if (niftyOhlc.close && niftyOhlc.close > 0) {
         this.yesterdayClose = niftyOhlc.close;
      }
      if (niftyOhlc.open && niftyOhlc.open > 0) {
         this.todayOpen = niftyOhlc.open;
      }
    }
    
    if (!this.initialized && spotPrice > 0) {
      this.spotPrice = spotPrice;
      if (this.todayOpen === 0) {
        this.todayOpen = this.yesterdayClose > 0 ? this.yesterdayClose : spotPrice;
      }
      this.initialized = true;
    }
    
    // Capture ORB between 9:15 and 9:30 IST
    const getISTDate = () => {
      const now = new Date();
      const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      return {
        hours: istDate.getUTCHours(),
        minutes: istDate.getUTCMinutes()
      };
    };

    const ist = getISTDate();
    const timeInMins = ist.hours * 60 + ist.minutes;

    if (timeInMins >= 555 && timeInMins < 570) { // 9:15 to 9:30 AM IST
      if (niftyOhlc) {
        if (this.orbHigh === 0 || niftyOhlc.high > this.orbHigh) this.orbHigh = niftyOhlc.high;
        if (this.orbLow === 0 || niftyOhlc.low < this.orbLow) this.orbLow = niftyOhlc.low;
      }
    }
    
    // Update VIX tick if provided (token from the active symbol's spec — INDIA VIX
    // for all currently-supported indices since neither SENSEX nor BANKNIFTY has its
    // own VIX index).
    const spec = getActiveSpec();
    if (vix && spec.vixToken !== null) {
      const vxToken = spec.vixToken;
      if (this.ticks.get(vxToken)) {
        const prevVix = this.ticks.get(vxToken)!.last_price;
        if (prevVix > 0) {
           this.vixDelta = ((vix - prevVix) / prevVix) * 100;
        }
      }
      const vixTick: Tick = {
        tradable: true,
        mode: 'full',
        instrument_token: vxToken,
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
        timestamp: new Date()
      };
      this.ticks.set(vxToken, vixTick);
    }

    // Spot tick for the active symbol.
    const tick: Tick = {
      tradable: true,
      mode: 'full',
      instrument_token: spec.spotToken,
      last_price: spotPrice,
      last_quantity: 0,
      average_price: spotPrice,
      volume: 12500000,
      buy_quantity: 6000000,
      sell_quantity: 6500000,
      ohlc: niftyOhlc || { open: spotPrice, high: spotPrice + 10, low: spotPrice - 10, close: spotPrice },
      change: niftyChange || 0,
      oi: 0,
      oi_day_high: 0,
      oi_day_low: 0,
      timestamp: new Date()
    };
    this.ticks.set(spec.spotToken, tick);
  }
}

export const marketEngine = new MarketEngine();
