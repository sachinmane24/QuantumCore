/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import { marketEngine } from './market.ts';
import { tradeLogger } from './logger.ts';
import { strategyEngine } from './strategy.ts';
import { riskEngine } from './risk.ts';

import { intelligenceEngine, TradeParams } from './intelligence.ts';

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
  private peakPnL: number = 0;
  private currentTradeParams: TradeParams | null = null;
  private currentActiveSL: number = 0;
  private rollsToday: number = 0;
  private lastRollTime: number = 0;
  private lastTradeScore: any = null;
  private currentTradeBias: 'BULLISH' | 'BEARISH' | null = null;
  private currentEntryTime: number = 0;
  private currentSpotAtEntry: number = 0;
  private currentStrikeAtEntry: number = 0;
  private currentVixAtEntry: number = 0;
  private currentIsExpiryDay: boolean = false;
  private currentIsMonthlyExpiry: boolean = false;
  private currentEntryNetDelta: number = 0;
  private currentEntryNetGamma: number = 0;
  private currentIndicatorsAtEntry: any = null;
  private netDelta: number = 0;
  private netGamma: number = 0;
  private hedgeLogs: string[] = [];
  private lastRiskValidation: { allowed: boolean; reason: string | null } | null = null;

  async executeTrade(bias: 'BULLISH' | 'BEARISH') {
    if (this.activePositions.length > 0) return;

    const spot = marketEngine.getSpotPrice();
    const score = strategyEngine.calculateScore();
    const atmStrike = Math.round(spot / 50) * 50;
    
    // Derive Dynamic SL/Target first
    const derivation = intelligenceEngine.deriveParams(
      score.mode === 'MOMENTUM_SNIPER' ? 'BUY' : 'SELL',
      score.mode,
      spot,
      bias
    );

    // Validate with Risk Engine
    const validation = riskEngine.validateEntry(config.LOT_SIZE, derivation.stopLossRupees);
    this.lastRiskValidation = validation;
    
    if (!validation.allowed) {
      console.warn(`[EXECUTION] Trade blocked by Risk Engine: ${validation.reason}`);
      return;
    }

    this.currentTradeParams = derivation;
    this.currentActiveSL = -derivation.stopLossRupees;
    this.peakPnL = 0;
    this.lastTradeScore = score;
    this.currentTradeBias = bias;
    this.currentEntryTime = Date.now();
    this.currentSpotAtEntry = spot;
    this.currentStrikeAtEntry = atmStrike;
    this.currentVixAtEntry = marketEngine.getVix();
    this.currentIndicatorsAtEntry = marketEngine.getTechnicalIndicators();
    
    const expiryStatus = marketEngine.getExpiryStatus();
    this.currentIsExpiryDay = expiryStatus.isExpiryDay;
    this.currentIsMonthlyExpiry = expiryStatus.isMonthlyExpiry;

    const getStrikeByDelta = (targetDelta: number, type: 'CE' | 'PE') => {
      const chain = marketEngine.getOptionChain();
      if (chain.length === 0) return Math.round(spot / 50) * 50;
      let closest = chain[0];
      let minDiff = Infinity;
      chain.forEach(opt => {
        let delta = opt.delta || 0.5;
        if (type === 'PE' && delta < 0) delta = Math.abs(delta);
        const diff = Math.abs(delta - targetDelta);
        if (diff < minDiff) {
          minDiff = diff;
          closest = opt;
        }
      });
      return closest.strike;
    };

    const getLTP = (strike: number, type: 'CE' | 'PE') => {
      const chain = marketEngine.getOptionChain();
      const option = chain.find(o => o.strike === strike);
      if (option) return type === 'CE' ? option.ce_price : option.pe_price;
      const dist = Math.abs(strike - spot);
      return Math.max(5, 100 - (dist * 0.5));
    };

    const newPositions: Position[] = [];

    switch (score.strategyType) {
      case 'NAKED_BUY': {
        const targetDelta = expiryStatus.isExpiryDay ? 0.65 : 0.55;
        const strike = getStrikeByDelta(targetDelta, bias === 'BULLISH' ? 'CE' : 'PE');
        newPositions.push({ strike, type: bias === 'BULLISH' ? 'CE' : 'PE', entryPrice: getLTP(strike, bias === 'BULLISH' ? 'CE' : 'PE'), qty: config.LOT_SIZE, side: 'BUY' });
        break;
      }

      case 'BULL_CALL_SPREAD': {
        const buyStrike = atmStrike;
        const sellStrike = atmStrike + 150;
        newPositions.push(
          { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' }
        );
        break;
      }

      case 'BEAR_PUT_SPREAD': {
        const buyStrike = atmStrike;
        const sellStrike = atmStrike - 150;
        newPositions.push(
          { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: sellStrike, type: 'PE', entryPrice: getLTP(sellStrike, 'PE'), qty: config.LOT_SIZE, side: 'SELL' }
        );
        break;
      }

      case 'BULL_PUT_SPREAD': {
        const sellStrike = getStrikeByDelta(0.25, 'PE');
        const buyStrike = sellStrike - 100;
        newPositions.push(
          { strike: sellStrike, type: 'PE', entryPrice: getLTP(sellStrike, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'BEAR_CALL_SPREAD': {
        const sellStrike = getStrikeByDelta(0.25, 'CE');
        const buyStrike = sellStrike + 100;
        newPositions.push(
          { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'IRON_CONDOR': {
        const sellPE = getStrikeByDelta(0.15, 'PE');
        const buyPE = sellPE - 100;
        const sellCE = getStrikeByDelta(0.15, 'CE');
        const buyCE = sellCE + 100;
        newPositions.push(
          { strike: sellPE, type: 'PE', entryPrice: getLTP(sellPE, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyPE, type: 'PE', entryPrice: getLTP(buyPE, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: sellCE, type: 'CE', entryPrice: getLTP(sellCE, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyCE, type: 'CE', entryPrice: getLTP(buyCE, 'CE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'IRON_FLY': {
        const buyPE = atmStrike - 250;
        const buyCE = atmStrike + 250;
        newPositions.push(
          { strike: atmStrike, type: 'PE', entryPrice: getLTP(atmStrike, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: atmStrike, type: 'CE', entryPrice: getLTP(atmStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyPE, type: 'PE', entryPrice: getLTP(buyPE, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: buyCE, type: 'CE', entryPrice: getLTP(buyCE, 'CE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'STRADDLE': {
        newPositions.push(
          { strike: atmStrike, type: 'CE', entryPrice: getLTP(atmStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: atmStrike, type: 'PE', entryPrice: getLTP(atmStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'RATIO_SPREAD': {
        if (bias === 'BULLISH') {
          const buyStrike = atmStrike;
          const sellStrike = atmStrike + 200;
          newPositions.push(
            { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' },
            { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'), qty: config.LOT_SIZE * 2, side: 'SELL' }
          );
        } else {
          const buyStrike = atmStrike;
          const sellStrike = atmStrike - 200;
          newPositions.push(
            { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
            { strike: sellStrike, type: 'PE', entryPrice: getLTP(sellStrike, 'PE'), qty: config.LOT_SIZE * 2, side: 'SELL' }
          );
        }
        break;
      }

      case 'BUTTERFLY': {
        const center = atmStrike;
        const wingSize = 100;
        const type = bias === 'BULLISH' ? 'CE' : 'PE';
        newPositions.push(
          { strike: center - wingSize, type, entryPrice: getLTP(center - wingSize, type), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: center, type, entryPrice: getLTP(center, type), qty: config.LOT_SIZE * 2, side: 'SELL' },
          { strike: center + wingSize, type, entryPrice: getLTP(center + wingSize, type), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'STRANGLE': {
        const buyPE = getStrikeByDelta(0.20, 'PE');
        const buyCE = getStrikeByDelta(0.20, 'CE');
        newPositions.push(
          { strike: buyPE, type: 'PE', entryPrice: getLTP(buyPE, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: buyCE, type: 'CE', entryPrice: getLTP(buyCE, 'CE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'CALENDAR': {
        // Simulated as a neutral spread with staggered strikes to mimic theta behavior
        const buyStrike = atmStrike;
        const sellStrike = atmStrike; 
        newPositions.push(
          { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE') * 1.5, qty: config.LOT_SIZE, side: 'BUY' }, // Premium proxy for far-month
          { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' }    // Near-month
        );
        break;
      }

      default: {
         // Fallback to simple naked buy
         const strike = atmStrike;
         newPositions.push({ strike, type: bias === 'BEARISH' ? 'PE' : 'CE', entryPrice: getLTP(strike, bias === 'BEARISH' ? 'PE' : 'CE'), qty: config.LOT_SIZE, side: 'BUY' });
         break;
      }
    }

    this.activePositions = newPositions;
    console.log(`[EXECUTION] AI AUTO-DECIDE: Structure [${score.strategyType}] selected based on VIX ${this.currentVixAtEntry.toFixed(2)} and Score ${score.total}.`);

    this.calculatePortfolioGreeks();
    this.currentEntryNetDelta = this.netDelta;
    this.currentEntryNetGamma = this.netGamma;

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
    this.peakPnL = Math.max(this.peakPnL, this.pnl);

    // Update Intelligence for Trailing SL
    if (this.currentTradeParams) {
      this.currentActiveSL = intelligenceEngine.calculateTrailingSL(
        this.pnl,
        this.peakPnL,
        this.currentTradeParams
      );
    }

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

    const istTime = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const totalMin = istTime.getUTCHours() * 60 + istTime.getUTCMinutes();
    const expiryStatus = marketEngine.getExpiryStatus();

    // 1:30 PM Shift on Monthly Expiry - Aggressive profit taking or narrowing
    if (expiryStatus.isMonthlyExpiry && totalMin >= 810) {
      if (this.pnl > 0 && this.activePositions.length > 0) {
        console.log("[EXECUTION] Monthly Expiry Afternoon Shift: Securing profits before roll-over volatility.");
        await this.exitAll("Monthly Expiry 1:30 PM Protective Exit");
        return;
      }
    }

    if (this.currentTradeParams) {
      // Time-Based Decay Intelligence (Option Buying specific)
      const durationMins = (Date.now() - this.currentEntryTime) / 60000;
      if (this.lastTradeScore?.mode === 'MOMENTUM_SNIPER' && durationMins > 45) {
         if (this.pnl < this.currentTradeParams.targetRupees * 0.25) {
            await this.exitAll(`Time-Decay Exit: 45m Stagnation Threshold Reached`);
            return;
         }
      }

      if (this.pnl <= this.currentActiveSL) {
        await this.exitAll(`Stop Loss Hit (₹${this.currentActiveSL})`);
      } else if (this.pnl >= this.currentTradeParams.targetRupees) {
        await this.exitAll(`Target Hit (₹${this.currentTradeParams.targetRupees})`);
      }
    } else {
      // Fallback
      if (this.pnl <= -config.SL_RUPEES || this.pnl >= config.TARGET_RUPEES) {
        await this.exitAll('SL/Target Hit');
      }
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
      // Use a slight OTM strike for hedging to avoid direct conflict with core ATM positions
      const hedgeBias = this.netDelta > 0 ? 50 : -50;
      const hedgeStrike = Math.round((spot + hedgeBias) / 50) * 50;
      
      const hedgeType = this.netDelta > 0 ? 'CE' : 'PE'; 
      const hedgeQty = Math.round(Math.abs(this.netDelta) / 0.5) * config.LOT_SIZE;
      
      if (hedgeQty > 0) {
        console.log(`[GAMMA SCALP] Net Delta ${this.netDelta.toFixed(2)} exceeds tolerance. Hedging ${hedgeQty} ${hedgeType} at ${hedgeStrike}...`);
        
        const chain = marketEngine.getOptionChain();
        const opt = chain.find(o => o.strike === hedgeStrike);
        const price = opt ? (hedgeType === 'CE' ? opt.ce_price : opt.pe_price) : 100;

        // Check if we already have a position at this strike to net it out
        const existingIdx = this.activePositions.findIndex(p => p.strike === hedgeStrike && p.type === hedgeType);
        
        if (existingIdx !== -1) {
          const existing = this.activePositions[existingIdx];
          // If we are selling a hedge but are already long, subtract qty
          if (existing.side === 'BUY') {
            if (existing.qty > hedgeQty) {
              existing.qty -= hedgeQty;
            } else if (existing.qty === hedgeQty) {
              this.activePositions.splice(existingIdx, 1);
            } else {
              const remaining = hedgeQty - existing.qty;
              existing.qty = remaining;
              existing.side = 'SELL';
              existing.entryPrice = price; // Update to mid-entry
            }
          } else {
            // Both are SELL sides, just add qty
            existing.qty += hedgeQty;
          }
        } else {
          // No existing position at this strike, add new hedge leg
          this.activePositions.push({
            strike: hedgeStrike,
            type: hedgeType,
            entryPrice: price,
            qty: hedgeQty,
            side: 'SELL',
            isHedge: true
          });
        }

        this.hedgeLogs.unshift(`[${new Date().toLocaleTimeString()}] Net Delta shifted to ${this.netDelta.toFixed(2)}. Hedged with ${hedgeQty} qty ${hedgeType} @ ${hedgeStrike}`);
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
      const primaryQty = this.activePositions[0]?.qty || config.LOT_SIZE;
      const lots = primaryQty / config.LOT_SIZE;

      if (sellLegs.length > 0) {
        // Option Selling / Spreads Margin Heuristic
        const isHedged = buyLegs.length > 0;
        totalInvestment = (isHedged ? 38000 : 115000) * lots;
      } else {
        // Option Buying: Real cost calculation
        totalInvestment = buyLegs.reduce((sum, p) => sum + (p.entryPrice * p.qty), 0);
      }

      // Record trade result in Risk Engine
      riskEngine.recordTradeResult(this.pnl);

      try {
        await tradeLogger.logTrade({
          timestamp: new Date().toISOString(),
          score: this.lastTradeScore?.total || 0,
          mode: this.lastTradeScore?.mode || 'INST_SPREAD',
          gamma: this.lastTradeScore?.gamma || 0,
          oi_bias: this.lastTradeScore?.oiBias || 0,
          trap: this.lastTradeScore?.trap === 0,
          pnl: Math.round(this.pnl),
          win: this.pnl > 0,
          bias: this.currentTradeBias || undefined,
          vix: this.currentVixAtEntry || 14,
          spot: this.currentSpotAtEntry || 0,
          isExpiryDay: this.currentIsExpiryDay,
          isMonthlyExpiry: this.currentIsMonthlyExpiry,
          entryNetDelta: this.currentEntryNetDelta,
          entryNetGamma: this.currentEntryNetGamma,
          phase: phase,
          duration: durationSeconds,
          entryTime: new Date(this.currentEntryTime).toISOString(),
          buyPrice: buyPrice,
          sellPrice: sellPrice,
          totalInvestment: totalInvestment,
          strike: this.currentStrikeAtEntry,
          indicators: this.currentIndicatorsAtEntry ? {
            rsi: this.currentIndicatorsAtEntry.rsi,
            macd: this.currentIndicatorsAtEntry.macd.macd,
            macdSignal: this.currentIndicatorsAtEntry.macd.signal,
            macdHist: this.currentIndicatorsAtEntry.macd.histogram,
            bbUpper: this.currentIndicatorsAtEntry.bollinger.upper,
            bbLower: this.currentIndicatorsAtEntry.bollinger.lower,
            bbMiddle: this.currentIndicatorsAtEntry.bollinger.middle,
          } : undefined,
          intelligence: this.currentTradeParams ? {
            atr: this.currentTradeParams.atrValue,
            vixFactor: this.currentTradeParams.vixFactor,
            rr: this.currentTradeParams.riskRewardRatio,
            slPrice: this.currentTradeParams.stopLossPrice,
            targetPrice: this.currentTradeParams.targetPrice,
            slRupees: this.currentTradeParams.stopLossRupees,
            targetRupees: this.currentTradeParams.targetRupees,
            pop: this.currentTradeParams.pop
          } : undefined
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
      peakPnL: Math.round(this.peakPnL),
      params: this.currentTradeParams,
      activeSL: this.currentActiveSL,
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

