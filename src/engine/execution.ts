/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import { marketEngine } from './market.ts';
import { tradeLogger } from './logger.ts';
import { strategyEngine } from './strategy.ts';

export interface Position {
  strike: number;
  type: 'CE' | 'PE';
  entryPrice: number;
  qty: number;
  side: 'SELL' | 'BUY';
}

class ExecutionEngine {
  private activePositions: Position[] = [];
  private pnl: number = 0;
  private rollsToday: number = 0;
  private lastRollTime: number = 0;
  private lastTradeScore: any = null;
  private currentTradeBias: 'BULLISH' | 'BEARISH' | null = null;
  private currentEntryTime: number = 0;
  private currentSpotAtEntry: number = 0;
  private currentVixAtEntry: number = 0;

  async executeTrade(bias: 'BULLISH' | 'BEARISH') {
    if (this.activePositions.length > 0) return;

    const spot = marketEngine.getSpotPrice();
    const atmStrike = Math.round(spot / 50) * 50;
    const score = strategyEngine.calculateScore();
    
    this.lastTradeScore = score;
    this.currentTradeBias = bias;
    this.currentEntryTime = Date.now();
    this.currentSpotAtEntry = spot;
    this.currentVixAtEntry = marketEngine.getVix();

    const getLTP = (strike: number, type: 'CE' | 'PE') => {
      const chain = marketEngine.getOptionChain();
      const option = chain.find(o => o.strike === strike);
      if (option) {
        return type === 'CE' ? option.ce_price : option.pe_price;
      }
      // Probabilistic pricing fallback if strike not in main chain view
      const dist = Math.abs(strike - spot);
      return Math.max(5, 100 - (dist * 0.5));
    };

    if (score.mode === 'MOMENTUM_SNIPER') {
      // Momentum Sniper: Naked Buying
      const entryPrice = getLTP(atmStrike, bias === 'BULLISH' ? 'CE' : 'PE');
      this.activePositions = [
        { strike: atmStrike, type: bias === 'BULLISH' ? 'CE' : 'PE', entryPrice, qty: config.LOT_SIZE, side: 'BUY' }
      ];
      console.log(`[EXECUTION] TRIGGERED MOMENTUM SNIPER: Naked ${bias} ${atmStrike} @ ${entryPrice.toFixed(2)}.`);
    } else {
      // Institutional Logic: Credit Spreads
      if (bias === 'BULLISH') {
        const sellPrice = getLTP(atmStrike, 'PE');
        const buyStrike = atmStrike - 100;
        const buyPrice = getLTP(buyStrike, 'PE');
        this.activePositions = [
          { strike: atmStrike, type: 'PE', entryPrice: sellPrice, qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'PE', entryPrice: buyPrice, qty: config.LOT_SIZE, side: 'BUY' }
        ];
      } else {
        const sellPrice = getLTP(atmStrike, 'CE');
        const buyStrike = atmStrike + 100;
        const buyPrice = getLTP(buyStrike, 'CE');
        this.activePositions = [
          { strike: atmStrike, type: 'CE', entryPrice: sellPrice, qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'CE', entryPrice: buyPrice, qty: config.LOT_SIZE, side: 'BUY' }
        ];
      }
      console.log(`[EXECUTION] TRIGGERED INST SPREAD: ${bias} credit spread at ${atmStrike}.`);
    }
  }

  async updatePnL() {
    if (this.activePositions.length === 0) return;
    
    const chain = marketEngine.getOptionChain();
    let currentPnL = 0;

    this.activePositions.forEach(pos => {
      const option = chain.find(o => o.strike === pos.strike);
      if (option) {
        const currentPrice = pos.type === 'CE' ? option.ce_price : option.pe_price;
        const diff = pos.side === 'BUY' 
          ? (currentPrice - pos.entryPrice) 
          : (pos.entryPrice - currentPrice);
        currentPnL += diff * pos.qty;
      }
    });

    this.pnl = Math.round(currentPnL);

    // Check Rolling 
    await this.checkRolling();

    // Check Risk Management
    if (this.pnl <= -config.SL_RUPEES || this.pnl >= config.TARGET_RUPEES) {
      await this.exitAll('SL/Target Hit');
    }
  }

  private async checkRolling() {
    if (this.activePositions.length === 0) return;
    if (this.rollsToday >= config.MAX_ROLLS) return;
    const now = Date.now();
    if (now - this.lastRollTime < 15 * 60 * 1000) return;

    const spot = marketEngine.getSpotPrice();
    const sellPos = this.activePositions.find(p => p.side === 'SELL');
    if (!sellPos) return;

    let shouldRoll = false;
    if (sellPos.type === 'PE' && spot > sellPos.strike + 50) shouldRoll = true;
    if (sellPos.type === 'CE' && spot < sellPos.strike - 50) shouldRoll = true;

    if (shouldRoll) {
      console.log('Rolling Position...');
      this.rollsToday++;
      this.lastRollTime = now;
      await this.exitAll('Rolling');
      await this.executeTrade(sellPos.type === 'PE' ? 'BULLISH' : 'BEARISH');
    }
  }

  async exitAll(reason: string) {
    if (this.activePositions.length > 0) {
      const now = Date.now();
      const durationSeconds = Math.round((now - this.currentEntryTime) / 1000);
      
      // Determine market phase
      const hours = new Date().getHours();
      let phase = 'MID-SESSION';
      if (hours < 11) phase = 'MARKET OPEN';
      else if (hours >= 14) phase = 'RE-SETTLEMENT';

      const buyLegs = this.activePositions.filter(p => p.side === 'BUY');
      const sellLegs = this.activePositions.filter(p => p.side === 'SELL');
      
      const buyPrice = buyLegs.length > 0 ? buyLegs.reduce((sum, p) => sum + p.entryPrice, 0) : 0;
      const sellPrice = sellLegs.length > 0 ? sellLegs.reduce((sum, p) => sum + p.entryPrice, 0) : 0;
      
      let totalInvestment = 0;
      if (sellLegs.length > 0) {
        // Option Selling / Spreads Margin Heuristic: ~1.2L per lot for Hedged Spreads
        totalInvestment = (buyLegs.length > 0 ? 120000 : 160000);
      } else {
        // Option Buying: Premium Paid
        totalInvestment = buyPrice * config.LOT_SIZE;
      }

      try {
        await tradeLogger.logTrade({
          timestamp: new Date().toISOString(),
          score: this.lastTradeScore?.total || 0,
          gamma: this.lastTradeScore?.gamma || 0,
          oi_bias: this.lastTradeScore?.oiBias || 0,
          trap: this.lastTradeScore?.trap === 0,
          pnl: Math.round(this.pnl),
          win: this.pnl > 0,
          bias: this.currentTradeBias || undefined,
          vix: this.currentVixAtEntry || 14,
          spot: this.currentSpotAtEntry || 0,
          phase: phase,
          duration: durationSeconds,
          entryTime: new Date(this.currentEntryTime).toISOString(),
          buyPrice: buyPrice,
          sellPrice: sellPrice,
          totalInvestment: totalInvestment
        });
      } catch (logErr) {
        console.error("[EXECUTION] Failed to log trade, but continuing with exit:", logErr);
      }
    }
    console.log(`Exiting all positions. Reason: ${reason}. Final PnL: ${this.pnl}`);
    this.activePositions = [];
    this.pnl = 0; 
    this.currentTradeBias = null;
    this.currentEntryTime = 0;
  }

  getState() {
    return {
      positions: this.activePositions,
      pnl: Math.round(this.pnl),
      rollsToday: this.rollsToday
    };
  }
}

export const executionEngine = new ExecutionEngine();
