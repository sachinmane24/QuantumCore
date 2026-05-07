/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';

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

export interface OptionChainData {
  strike: number;
  ce_oi: number;
  ce_oi_change: number;
  pe_oi: number;
  pe_oi_change: number;
  ce_price: number;
  pe_price: number;
  iv?: number;
  delta?: number;
  theta?: number;
  vega?: number;
}

class MarketEngine {
  private ticks: Map<number, Tick> = new Map();
  private optionChain: OptionChainData[] = [];
  private spotPrice: number = 24330; // Updated to match current market levels
  private mockInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.syncMode();
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
        iv: 12 + Math.random() * 4,
        delta: Math.max(-1, Math.min(1, (spot - strike) / 100)),
        theta: -10 - (Math.random() * 5),
        vega: 5 + (Math.random() * 2),
      });
    }
    return chain;
  }

  private startMockData() {
    this.mockInterval = setInterval(() => {
      // Mock spot price movement
      const change = (Math.random() - 0.5) * 5;
      this.spotPrice += change;
      
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

  updateData(spotPrice: number, chain?: OptionChainData[], vix?: number, niftyOhlc?: any, niftyChange?: number) {
    this.spotPrice = spotPrice;
    if (chain && chain.length > 0) {
      this.optionChain = chain;
    } else if (config.DATA_SOURCE === 'MOCK') {
      this.optionChain = this.generateChain(spotPrice);
    }
    
    // Update VIX tick if provided
    if (vix) {
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
