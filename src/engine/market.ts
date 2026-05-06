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
  private spotPrice: number = 22500; // Default mock spot
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
        ohlc: { open: 22400, high: 22600, low: 22350, close: 22500 },
        change: ((this.spotPrice - 22400) / 22400) * 100,
        oi: 12000000,
        oi_day_high: 13000000,
        oi_day_low: 11000000,
        timestamp: new Date()
      };
      this.ticks.set(mockTick.instrument_token, mockTick);

      // Generate Option Chain
      const atmStrike = Math.round(this.spotPrice / 50) * 50;
      const chain: OptionChainData[] = [];
      for (let i = -5; i <= 5; i++) {
        const strike = atmStrike + (i * 50);
        const dist = Math.abs(strike - this.spotPrice);
        chain.push({
          strike,
          ce_oi: 5000000 - (i * 500000) + (Math.random() * 100000),
          ce_oi_change: (Math.random() - 0.4) * 50000,
          pe_oi: 5000000 + (i * 500000) + (Math.random() * 100000),
          pe_oi_change: (Math.random() - 0.6) * 50000,
          ce_price: Math.max(1, 100 - (strike - this.spotPrice) * 0.4),
          pe_price: Math.max(1, 100 + (strike - this.spotPrice) * 0.4),
          iv: 12 + Math.random() * 4,
          delta: Math.max(-1, Math.min(1, (this.spotPrice - strike) / 100)),
          theta: -10 - (Math.random() * 5),
          vega: 5 + (Math.random() * 2),
        });
      }
      this.optionChain = chain;
    }, 1000);
  }

  getLatestTick(token: number = 256265): Tick | undefined {
    return this.ticks.get(token);
  }

  getSpotPrice(): number {
    return this.spotPrice;
  }

  getOptionChain(): OptionChainData[] {
    return this.optionChain;
  }

  updateData(spotPrice: number, chain: OptionChainData[]) {
    this.spotPrice = spotPrice;
    this.optionChain = chain;
    
    // Also update NIFTY tick
    const tick: Tick = {
      tradable: true,
      mode: 'full',
      instrument_token: 256265,
      last_price: spotPrice,
      last_quantity: 0,
      average_price: spotPrice,
      volume: 0,
      buy_quantity: 0,
      sell_quantity: 0,
      ohlc: { open: spotPrice, high: spotPrice, low: spotPrice, close: spotPrice },
      change: 0,
      oi: 0,
      oi_day_high: 0,
      oi_day_low: 0,
      timestamp: new Date()
    };
    this.ticks.set(256265, tick);
  }
}

export const marketEngine = new MarketEngine();
