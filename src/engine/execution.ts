/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import { marketEngine } from './market.ts';
import { tradeLogger } from './logger.ts';
import { strategyEngine } from './strategy.ts';
import { riskEngine } from './risk.ts';

export interface Position {
  strike: number;
  type: 'CE' | 'PE' | 'FUT';
  entryPrice: number;
  qty: number;
  side: 'SELL' | 'BUY';
  isHedge?: boolean;
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
  private netDelta: number = 0;
  private netGamma: number = 0;
  private hedgeLogs: string[] = [];
  private lastRiskValidation: { allowed: boolean; reason: string | null } | null = null;

  async executeTrade(bias: 'BULLISH' | 'BEARISH') {
    if (this.activePositions.length > 0) return;

    // Validate with Risk Engine
    const expectedSL = config.SL_RUPEES; // Simplified SL check
    const validation = riskEngine.validateEntry(config.LOT_SIZE, expectedSL);
    this.lastRiskValidation = validation;
    
    if (!validation.allowed) {
      console.warn(`[EXECUTION] Trade blocked by Risk Engine: ${validation.reason}`);
      return;
    }

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

    riskEngine.recordTradeEntry();
  }

  async updatePnL() {
    if (this.activePositions.length === 0) {
      riskEngine.updatePnL(0, []);
      return;
    }
    
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

    // Update Risk Engine
    riskEngine.updatePnL(this.pnl, this.activePositions);

    // Calculate Portfolio Greeks
    this.calculatePortfolioGreeks();

    // Check Rolling 
    await this.checkRolling();

    // Check Gamma Scalping
    await this.checkGammaScalp();

    // Check Risk Management
    const riskStats = riskEngine.getStats();
    if (riskStats.isKillSwitchActive) {
      await this.exitAll(`Risk Kill Switch: ${riskStats.killReason}`);
      return;
    }

    if (this.pnl <= -config.SL_RUPEES || this.pnl >= config.TARGET_RUPEES) {
      await this.exitAll('SL/Target Hit');
    }
  }

  private calculatePortfolioGreeks() {
    const chain = marketEngine.getOptionChain();
    let d = 0;
    let g = 0;

    this.activePositions.forEach(pos => {
      if (pos.type === 'FUT') {
        d += (pos.side === 'BUY' ? 1 : -1) * (pos.qty / config.LOT_SIZE);
        return;
      }

      const opt = chain.find(o => o.strike === pos.strike);
      if (opt) {
        // Delta logic: CE Delta (0 to 1), PE Delta (-1 to 0)
        let delta = opt.delta || 0.5;
        if (pos.type === 'PE' && delta > 0) delta = delta - 1; 
        
        const gamma = opt.gamma || 0.01;
        const multiplier = pos.side === 'BUY' ? 1 : -1;
        const units = pos.qty / config.LOT_SIZE;

        d += delta * multiplier * units;
        g += gamma * multiplier * units;
      }
    });

    this.netDelta = d;
    this.netGamma = g;
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

  private async checkGammaScalp() {
    if (this.activePositions.length === 0) return;
    
    // If net delta exceeds tolerance, we need to scalp/hedge
    if (Math.abs(this.netDelta) > config.DELTA_TOLERANCE) {
      const spot = marketEngine.getSpotPrice();
      const atmStrike = Math.round(spot / 50) * 50;
      
      // Calculate requirement: we want to bring netDelta back to 0
      // If netDelta is 0.5, we need to SELL 0.5 Delta
      // Using ATM Options for hedging (approx 0.5 delta)
      const hedgeType = this.netDelta > 0 ? 'CE' : 'PE'; // Sell CE or Sell PE to reduce delta? Wait.
      // NetDelta > 0 means Long Bias. To hedge, we need Short Delta.
      // Selling CE gives Negative Delta (~ -0.5)
      // Buying PE gives Negative Delta (~ -0.5)
      
      const hedgeQty = Math.round(Math.abs(this.netDelta) / 0.5) * config.LOT_SIZE;
      
      if (hedgeQty > 0) {
        console.log(`[GAMMA SCALP] Net Delta ${this.netDelta.toFixed(2)} exceeds tolerance. Hedging ${hedgeQty} ${hedgeType}...`);
        
        const chain = marketEngine.getOptionChain();
        const opt = chain.find(o => o.strike === atmStrike);
        const price = opt ? (hedgeType === 'CE' ? opt.ce_price : opt.pe_price) : 100;

        // In a real scalp, we might buy/sell options or futures.
        // Let's add a hedge position.
        this.activePositions.push({
          strike: atmStrike,
          type: hedgeType,
          entryPrice: price,
          qty: hedgeQty,
          side: 'SELL', // Using credit hedging for this strategy
          isHedge: true
        });

        this.hedgeLogs.unshift(`[${new Date().toLocaleTimeString()}] Hedged ${this.netDelta > 0 ? 'Short' : 'Long'} bias with ${hedgeQty} qty ATM ${hedgeType}`);
        if (this.hedgeLogs.length > 10) this.hedgeLogs.pop();
        
        // Recalculate after hedge
        this.calculatePortfolioGreeks();
      }
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

      // Record trade result in Risk Engine
      riskEngine.recordTradeResult(this.pnl);

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
      rollsToday: this.rollsToday,
      netDelta: Number(this.netDelta.toFixed(3)),
      netGamma: Number(this.netGamma.toFixed(4)),
      hedgeLogs: this.hedgeLogs,
      risk: riskEngine.getStats(),
      lastRiskValidation: this.lastRiskValidation
    };
  }
}

export const executionEngine = new ExecutionEngine();

