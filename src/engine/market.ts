/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
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
  private priceHistory: number[] = [];
  private readonly MAX_HISTORY = 100;
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

  public getTechnicalIndicators() {
    if (this.priceHistory.length < 30) {
      return { rsi: 50, macd: { macd: 0, signal: 0, histogram: 0 }, bollinger: { upper: this.spotPrice, lower: this.spotPrice, middle: this.spotPrice } };
    }

    const prices = this.priceHistory;
    
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

    // MACD (12, 26, 9)
    const ema12 = computeEMA(prices, 12);
    const ema26 = computeEMA(prices, 26);
    const macdValue = ema12 - ema26;
    // For Signal, we'd ideally need history of MACD values, but for now we approximate or use last few.
    // Simplifying: Histogram as proxy if we don't have MACD history
    
    return {
      rsi: computeRSI(prices),
      macd: { macd: macdValue, signal: macdValue * 0.9, histogram: macdValue * 0.1 },
      bollinger: computeBBands(prices)
    };
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
    }
  }

  private generateChain(spot: number): OptionChainData[] {
    const atmStrike = Math.round(spot / 50) * 50;
    const chain: OptionChainData[] = [];
    for (let i = -5; i <= 5; i++) {
      const strike = atmStrike + (i * 50);
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
        ce_iv: 12 + Math.random() * 4,
        pe_iv: 13 + Math.random() * 4,
        iv: 12.5 + Math.random() * 4,
        delta: Math.max(-1, Math.min(1, (spot - strike) / 100)),
        gamma: Math.max(0.001, (1 / (50 + Math.abs(spot - strike)))) * 2, // ATM Gamma is higher
        theta: -10 - (Math.random() * 5),
        vega: 5 + (Math.random() * 2),
      });
    }
    return chain;
  }

  private startMockData() {
    // Initial Gap for testing
    this.yesterdayClose = 24300;
    this.todayOpen = 24350; // +50 pts gap (~0.2%)
    this.spotPrice = this.todayOpen;
    this.vwap = this.spotPrice;

    this.mockInterval = setInterval(() => {
      // Mock spot price movement
      const change = (Math.random() - 0.5) * 5;
      this.spotPrice += change;
      
      // Update VWAP (simple moving weighted average mock)
      this.vwap = (this.vwap * 0.95) + (this.spotPrice * 0.05);

      // Update ticks
      const mockTick: Tick = {
        tradable: true,
        mode: 'full',
        instrument_token: 256265, // NIFTY
        last_price: this.spotPrice,
        last_quantity: Math.floor(Math.random() * 500),
        average_price: this.spotPrice - 2,
        volume: 1000000 + Math.random() * 50000,
        buy_quantity: 500000,
        sell_quantity: 480000,
        ohlc: { open: this.spotPrice - 30, high: this.spotPrice + 20, low: this.spotPrice - 40, close: this.spotPrice },
        change: 0.15,
        oi: 12000000,
        oi_day_high: 13000000,
        oi_day_low: 11000000,
        timestamp: new Date()
      };
      this.ticks.set(mockTick.instrument_token, mockTick);

      this.optionChain = this.generateChain(this.spotPrice);
    }, 1000);
  }

  getLatestTick(token: number = 256265): Tick | undefined {
    return this.ticks.get(token);
  }

  getSpotPrice(): number {
    return this.spotPrice;
  }

  getVix(): number {
    return this.ticks.get(264969)?.last_price || 12.42; // Token for INDIA VIX is 264969
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
    }

    if (chain && chain.length > 0) {
      this.optionChain = chain;
    } else if (config.DATA_SOURCE === 'MOCK') {
      this.optionChain = this.generateChain(spotPrice);
    }

    if (vwap) this.vwap = vwap;
    
    // Set daily structure values if they are reported by exchange
    if (niftyOhlc) {
      if (niftyOhlc.close && (this.yesterdayClose === 0)) {
         this.yesterdayClose = niftyOhlc.close;
      }
      if (niftyOhlc.open && (this.todayOpen === 0)) {
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
    const istTime = new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const istDate = new Date(istTime);
    const hours = istDate.getHours();
    const minutes = istDate.getMinutes();
    const timeInMins = hours * 60 + minutes;

    if (timeInMins >= 555 && timeInMins < 570) { // 9:15 to 9:30 AM IST
      if (niftyOhlc) {
        if (this.orbHigh === 0 || niftyOhlc.high > this.orbHigh) this.orbHigh = niftyOhlc.high;
        if (this.orbLow === 0 || niftyOhlc.low < this.orbLow) this.orbLow = niftyOhlc.low;
      }
    }
    
    // Update VIX tick if provided
    if (vix) {
      if (this.ticks.get(264969)) {
        const prevVix = this.ticks.get(264969)!.last_price;
        if (prevVix > 0) {
           // We can calculate a session delta if we want, but usually VIX % change is from prev close.
           // However, if we don't have prev close, we just show 0 or calculate from first tick.
           this.vixDelta = ((vix - prevVix) / prevVix) * 100;
        }
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
        timestamp: new Date()
      };
      this.ticks.set(264969, vixTick);
    }
    
    // Also update NIFTY tick
    const tick: Tick = {
      tradable: true,
      mode: 'full',
      instrument_token: 256265,
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
    this.ticks.set(256265, tick);
  }
}

export const marketEngine = new MarketEngine();
