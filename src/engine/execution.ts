/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import { marketEngine } from './market.ts';
import { tradeLogger } from './logger.ts';
import { strategyEngine } from './strategy.ts';
import { riskEngine } from './risk.ts';
import { NotificationService } from './notifications.ts';

import { intelligenceEngine } from './intelligence.ts';
import type { TradeParams } from './intelligence.ts';
import { StatePersistenceManager } from './state_persistence.ts';
import { ExecutionState } from './types.ts';

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
  private currentTradeBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null = null;
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
  private netTheta: number = 0;
  private netVega: number = 0;
  private capitalDeployed: number = 0;
  private netPremium: number = 0;
  private maxRisk: number = 0;
  private maxReward: number = 0;
  private lastHedgeTime: number = 0;
  private lastTradeEndTime: number = 0;
  private lastTradeSuppression: { reason: string; timestamp: number } | null = null;
  private hedgeLogs: string[] = [];
  private lastRiskValidation: { allowed: boolean; reason: string | null } | null = null;
  private isProcessing: boolean = false;

  private async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.isProcessing) {
      return null;
    }
    this.isProcessing = true;
    try {
      return await fn();
    } finally {
      this.isProcessing = false;
    }
  }

  async executeTrade(bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL', isManual: boolean = false) {
    return await this.withLock(async () => {
      await this.executeTradeInternal(bias, isManual);
    });
  }

  private async executeTradeInternal(bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL', isManual: boolean = false) {
    if (this.activePositions.length > 0) return;

    // Entry Cooldown: 2 minute break between trades for Auto-Mode only
    if (!isManual) {
      const timeSinceLastTrade = (Date.now() - this.lastTradeEndTime) / 1000;
      if (timeSinceLastTrade < 120) {
        const reason = `Cooldown active (${Math.round((120 - timeSinceLastTrade))}s left)`;
        if (!this.lastTradeSuppression || this.lastTradeSuppression.reason !== reason) {
          console.log(`[EXECUTION] Entry Suppressed: ${reason}`);
        }
        this.lastTradeSuppression = { reason, timestamp: Date.now() };
        return;
      }
    }

    const spot = marketEngine.getSpotPrice();
    const score = strategyEngine.calculateScore();
    
    // Score Validation: Minimum 60 required for Auto-Mode only
    if (!isManual && score.total < 60) {
      const reason = `Low Signal Score (${score.total})`;
      if (!this.lastTradeSuppression || !this.lastTradeSuppression.reason.startsWith('Low Signal Score')) {
        console.log(`[EXECUTION] Entry Suppressed: ${reason}. At least 60 required.`);
      }
      this.lastTradeSuppression = { reason, timestamp: Date.now() };
      return;
    }

    const atmStrike = Math.round(spot / 50) * 50;
    
    // Derive Dynamic SL/Target first
    const derivation = intelligenceEngine.deriveParams(
      score.mode === 'MOMENTUM_SNIPER' ? 'BUY' : 'SELL',
      score.mode,
      spot,
      bias,
      score.total
    );

    // Validate with Risk Engine
    const validation = riskEngine.validateEntry(config.LOT_SIZE, derivation.stopLossRupees);
    this.lastRiskValidation = validation;
    
    if (!validation.allowed) {
      const reason = `Risk Block: ${validation.reason}`;
      this.lastTradeSuppression = { reason, timestamp: Date.now() };
      console.warn(`[EXECUTION] Trade blocked by Risk Engine: ${validation.reason}`);
      await tradeLogger.logAudit({
        timestamp: new Date().toISOString(),
        type: 'TRADE_SKIP',
        message: `Trade blocked for ${bias} setup: ${validation.reason}`,
        details: { score, riskScore: validation.score }
      });
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

    // Expiry Day Safety: No new entries after threshold (e.g., 2:30 PM) to avoid zero-gamma-risk
    if (this.currentIsExpiryDay && !isManual) {
      const istTime = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
      const hours = istTime.getUTCHours();
      const minutes = istTime.getUTCMinutes();
      const [hLimit, mLimit] = config.EXPIRY_NO_TRADE_TIME.split(':').map(Number);
      if (hours > hLimit || (hours === hLimit && minutes >= mLimit)) {
        const reason = `Expiry No-Trade Zone (after ${config.EXPIRY_NO_TRADE_TIME})`;
        this.lastTradeSuppression = { reason, timestamp: Date.now() };
        console.log(`[EXECUTION] Entry Suppressed: ${reason}`);
        return;
      }
    }

    const getStrikeByDelta = (targetDelta: number, type: 'CE' | 'PE', minPremium: number = 0) => {
      const chain = marketEngine.getOptionChain();
      if (chain.length === 0) return Math.round(spot / 50) * 50;
      
      // Filter by min premium if selling (heuristic)
      const validOptions = minPremium > 0 
        ? chain.filter(opt => (type === 'CE' ? opt.ce_price : opt.pe_price) >= minPremium)
        : chain;
      
      const sourceChain = validOptions.length > 0 ? validOptions : chain;
      
      let closest = sourceChain[0];
      let minDiff = Infinity;
      sourceChain.forEach(opt => {
        let delta = (type === 'CE' ? opt.delta : (opt as any).pe_delta) || 0.5;
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
        const sellPrice = getLTP(sellStrike, 'CE');
        newPositions.push(
          { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: sellStrike, type: 'CE', entryPrice: sellPrice, qty: config.LOT_SIZE, side: 'SELL' }
        );
        break;
      }

      case 'BEAR_PUT_SPREAD': {
        const buyStrike = atmStrike;
        const sellStrike = atmStrike - 150;
        const sellPrice = getLTP(sellStrike, 'PE');
        newPositions.push(
          { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
          { strike: sellStrike, type: 'PE', entryPrice: sellPrice, qty: config.LOT_SIZE, side: 'SELL' }
        );
        break;
      }

      case 'BULL_PUT_SPREAD': {
        const sellStrike = getStrikeByDelta(0.40, 'PE', config.MIN_CREDIT_PREMIUM);
        const buyStrike = sellStrike - 100;
        newPositions.push(
          { strike: sellStrike, type: 'PE', entryPrice: getLTP(sellStrike, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'BEAR_CALL_SPREAD': {
        const sellStrike = getStrikeByDelta(0.40, 'CE', config.MIN_CREDIT_PREMIUM);
        const buyStrike = sellStrike + 100;
        newPositions.push(
          { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }

      case 'IRON_CONDOR': {
        const sellPE = getStrikeByDelta(0.15, 'PE', config.MIN_CREDIT_PREMIUM);
        const buyPE = sellPE - 100;
        const sellCE = getStrikeByDelta(0.15, 'CE', config.MIN_CREDIT_PREMIUM);
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
          const sellPrice = getLTP(sellStrike, 'CE');
          if (sellPrice < config.MIN_CREDIT_PREMIUM && !isManual) {
            const reason = `CE Ratio Premium too low (₹${sellPrice.toFixed(1)})`;
            this.lastTradeSuppression = { reason, timestamp: Date.now() };
            console.log(`[EXECUTION] Ratio Spread Suppressed: ${reason}`);
            return;
          }
          newPositions.push(
            { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' },
            { strike: sellStrike, type: 'CE', entryPrice: sellPrice, qty: config.LOT_SIZE * 2, side: 'SELL' }
          );
        } else {
          const buyStrike = atmStrike;
          const sellStrike = atmStrike - 200;
          const sellPrice = getLTP(sellStrike, 'PE');
          if (sellPrice < config.MIN_CREDIT_PREMIUM && !isManual) {
            const reason = `PE Ratio Premium too low (₹${sellPrice.toFixed(1)})`;
            this.lastTradeSuppression = { reason, timestamp: Date.now() };
            console.log(`[EXECUTION] Ratio Spread Suppressed: ${reason}`);
            return;
          }
          newPositions.push(
            { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' },
            { strike: sellStrike, type: 'PE', entryPrice: sellPrice, qty: config.LOT_SIZE * 2, side: 'SELL' }
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

    // Risk/Reward Validation: Enforce Minimum RR for Spreads
    if (newPositions.length >= 1) {
      if (newPositions.length >= 2) {
        const sellLegs = newPositions.filter(p => p.side === 'SELL');
        const buyLegs = newPositions.filter(p => p.side === 'BUY');
        
        if (sellLegs.length > 0 && buyLegs.length > 0) {
          // Calculate weighted net premium
          const totalSellPrem = sellLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
          const totalBuyPrem = buyLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
          const netCredit = totalSellPrem - totalBuyPrem;
          
          // Width based risk for normal and ratio spreads
          const width = Math.abs(buyLegs[0].strike - sellLegs[0].strike);
          const primaryQty = buyLegs[0].qty;
          
          // For ratio spreads (e.g. Sell 2x), risk is higher but so is credit usually.
          // We calculate actual max points of risk.
          let maxRiskPoints = 0;
          if (netCredit > 0) {
             // Credit Spread/Ratio
             maxRiskPoints = (width * primaryQty - netCredit) / primaryQty;
          } else {
             // Debit Spread
             maxRiskPoints = Math.abs(netCredit) / primaryQty;
          }

          const maxRewardPoints = netCredit > 0 ? (netCredit / primaryQty) : (width - Math.abs(netCredit) / primaryQty);
          const rr = maxRewardPoints > 0 ? maxRiskPoints / maxRewardPoints : 100;

          // Relaxed threshold: Risk can be up to 7x the potential Reward for these setups.
          // High probability credit spreads often have 4:1 to 6:1 R:R.
          if (rr > 7.0) { 
            const reason = `Poor RR ratio (1:${(1/rr).toFixed(2)})`;
            this.lastTradeSuppression = { reason, timestamp: Date.now() };
            console.warn(`[EXECUTION] Entry Suppressed: ${reason}. Minimum 1:7.0 R:R required.`);
            return;
          }
        }
      } else if (newPositions.length === 1 && newPositions[0].side === 'BUY') {
        // Naked Buy: Risk is SL, Reward is Target
        const risk = this.currentTradeParams?.stopLossRupees || config.SL_RUPEES;
        const reward = this.currentTradeParams?.targetRupees || config.TARGET_RUPEES;
        const rr = reward > 0 ? risk / reward : 100;
        
        // Relaxed threshold for Option Buying to allow dynamic premiums and floor levels
        if (rr > 1.2) { 
          const reason = `Naked Buy RR too low (1:${(1/rr).toFixed(1)})`;
          this.lastTradeSuppression = { reason, timestamp: Date.now() };
          return;
        }
      }
    }

    this.activePositions = newPositions;
    console.log(`[EXECUTION] AI AUTO-DECIDE: Structure [${score.strategyType}] selected based on VIX ${this.currentVixAtEntry.toFixed(2)} and Score ${score.total}.`);
    
    NotificationService.notifyTradeEntry({
      symbol: config.TRADING_SYMBOL,
      strategyMode: score.mode,
      bias: bias,
      entrySpot: spot,
      status: 'OPEN'
    });

    await tradeLogger.logAudit({
      timestamp: new Date().toISOString(),
      type: 'TRADE_TRIGGER',
      message: `${bias} Signal: Executing [${score.strategyType}] structure.`,
      details: { 
        spot, 
        vix: this.currentVixAtEntry, 
        score: score.total, 
        params: this.currentTradeParams 
      }
    });

    this.calculatePortfolioGreeks();
    this.calculateCapitalDeployed();
    this.currentEntryNetDelta = this.netDelta;
    this.currentEntryNetGamma = this.netGamma;

    riskEngine.recordTradeEntry();
    this.lastTradeSuppression = null;
    await this.saveState();
  }

  async updatePnL() {
    // Pure PnL update does not need lock as it just reads and updates primitive state
    // But management actions inside it DO need protection.
    if (this.activePositions.length === 0) {
      riskEngine.updatePnL(0, []);
      return;
    }
    
    const chain = marketEngine.getOptionChain();
    if (chain.length > 0) {
      const validPositions: Position[] = [];
      let hadGhostPurge = false;
      this.activePositions.forEach(pos => {
        const option = chain.find(o => o.strike === pos.strike);
        if (option) {
          validPositions.push(pos);
        } else {
          console.warn(`[EXECUTION] Ghost option position NIFTY ${pos.strike} ${pos.type} not in active chain. Purging.`);
          hadGhostPurge = true;
        }
      });
      if (hadGhostPurge) {
        this.activePositions = validPositions;
        await this.saveState();
        if (this.activePositions.length === 0) {
          this.pnl = 0;
          this.peakPnL = 0;
          this.currentTradeParams = null;
          this.currentActiveSL = 0;
          this.rollsToday = 0;
          this.currentTradeBias = null;
          this.currentEntryTime = 0;
          this.currentSpotAtEntry = 0;
          this.currentStrikeAtEntry = 0;
          this.currentVixAtEntry = 0;
          this.calculatePortfolioGreeks();
          this.calculateCapitalDeployed();
          riskEngine.updatePnL(0, []);
          return;
        }
      }
    }
    
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
    
    this.calculateCapitalDeployed();

    // Shield management logic with lock
    await this.withLock(async () => {
      // Check Rolling 
      await this.checkRolling();

      // Check Gamma Scalping
      await this.checkGammaScalp();

      // Check Risk Management
      const riskStats = riskEngine.getStats();
      if (riskStats.isKillSwitchActive) {
        await tradeLogger.logAudit({
          timestamp: new Date().toISOString(),
          type: 'RISK_ALERT',
          message: `Kill Switch Triggered mid-trade: ${riskStats.killReason}`,
          details: { pnl: this.pnl }
        });
        await this.exitAllInternal(`Risk Kill Switch: ${riskStats.killReason}`);
        return;
      }

      const istTime = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
      const totalMin = istTime.getUTCHours() * 60 + istTime.getUTCMinutes();
      const expiryStatus = marketEngine.getExpiryStatus();

      // 1:30 PM Shift on Monthly Expiry - Aggressive profit taking or narrowing
      if (expiryStatus.isMonthlyExpiry && totalMin >= 810) {
        if (this.pnl > 0 && this.activePositions.length > 0) {
          console.log("[EXECUTION] Monthly Expiry Afternoon Shift: Securing profits before roll-over volatility.");
          await this.exitAllInternal("Monthly Expiry 1:30 PM Protective Exit");
          return;
        }
      }

      // 2:45 PM Shift on Weekly Expiry - Standard expiry liquidity drain
      if (expiryStatus.isWeekly && totalMin >= 885) {
        if (this.activePositions.length > 0) {
          console.log("[EXECUTION] Weekly Expiry 2:45 PM: Closing positions to avoid settlement spikes.");
          await this.exitAllInternal("Weekly Expiry 2:45 PM Protective Exit");
          return;
        }
      }

      if (this.currentTradeParams) {
        // Time-Based Decay Intelligence (Option Buying specific)
        const durationMins = (Date.now() - this.currentEntryTime) / 60000;
        if (this.lastTradeScore?.mode === 'MOMENTUM_SNIPER' && durationMins > 60) {
           if (this.pnl < this.currentTradeParams.targetRupees * 0.15) {
              await this.exitAllInternal(`Time-Decay Exit: 60m Stagnation Threshold Reached`);
              return;
           }
        }

        if (this.pnl <= this.currentActiveSL) {
          await this.exitAllInternal(`Stop Loss Hit (₹${this.currentActiveSL})`);
        } else if (this.pnl >= this.currentTradeParams.targetRupees) {
          await this.exitAllInternal(`Target Hit (₹${this.currentTradeParams.targetRupees})`);
        }
      } else {
        // Fallback
        if (this.pnl <= -config.SL_RUPEES || this.pnl >= config.TARGET_RUPEES) {
          await this.exitAllInternal('SL/Target Hit');
        }
      }
    });
  }

  private calculatePortfolioGreeks() {
    const chain = marketEngine.getOptionChain();
    const vix = marketEngine.getVix();
    let d = 0;
    let g = 0;
    let t = 0;
    let v = 0;

    this.activePositions.forEach(pos => {
      if (pos.type === 'FUT') {
        d += (pos.side === 'BUY' ? 1 : -1) * (pos.qty / config.LOT_SIZE);
        return;
      }

      const opt = chain.find(o => o.strike === pos.strike);
      if (opt) {
        const multiplier = pos.side === 'BUY' ? 1 : -1;
        const units = pos.qty / config.LOT_SIZE;

        // Delta logic: CE Delta (0 to 1), PE Delta (-1 to 0)
        let delta = opt.delta || 0.5;
        if (pos.type === 'PE' && delta > 0) delta = delta - 1; 
        
        const gamma = opt.gamma || 0.01;
        
        // Approximate Theta and Vega if not in chain data
        // For Nifty: Theta is approx -0.5 to -2% of premium per day
        const ltp = pos.type === 'CE' ? opt.ce_price : opt.pe_price;
        const iv = opt.iv || vix;
        const theta = opt.theta || -((ltp * (iv/100) * 0.5) / Math.sqrt(252));
        const vega = opt.vega || (ltp * 0.05);

        d += delta * multiplier * units;
        g += gamma * multiplier * units;
        t += theta * multiplier * units;
        v += vega * multiplier * units;
      }
    });

    this.netDelta = d;
    this.netGamma = g;
    this.netTheta = t;
    this.netVega = v;
  }

  private calculateCapitalDeployed() {
    if (this.activePositions.length === 0) {
      this.capitalDeployed = 0;
      this.maxRisk = 0;
      this.maxReward = 0;
      return;
    }

    const buyLegs = this.activePositions.filter(p => p.side === 'BUY');
    const sellLegs = this.activePositions.filter(p => p.side === 'SELL');
    
    // Total Units 
    const totalQty = Math.max(...this.activePositions.map(p => p.qty)) || config.LOT_SIZE;
    
    const netPremium = this.activePositions.reduce((sum, p) => {
      const val = p.entryPrice * p.qty;
      return sum + (p.side === 'BUY' ? val : -val);
    }, 0);
    this.netPremium = netPremium;

    // Capital Deployed (Margin Requirement)
    if (sellLegs.length > 0) {
      // Option Selling requires Margin
      const isHedged = buyLegs.length > 0;
      
      // Based on Kotak Neo / Reference: 
      // Hedged Spread Margin ~ ₹415 per unit (approx ₹10.3k for 25 qty lot, or ₹31k for 75 qty)
      // Naked Sell Margin ~ ₹4500 per unit (approx ₹1.1L for 25 qty lot)
      const marginPerUnit = isHedged ? 415 : 4500;
      this.capitalDeployed = marginPerUnit * totalQty;
    } else {
      // Option Buying: Capital is the premium paid
      this.capitalDeployed = buyLegs.reduce((sum, p) => sum + (p.entryPrice * p.qty), 0);
    }

    // Calculate Max Risk/Reward for the spread
    if (this.activePositions.length >= 2) {
      const sellLegs = this.activePositions.filter(p => p.side === 'SELL');
      const buyLegs = this.activePositions.filter(p => p.side === 'BUY');
      
      if (sellLegs.length > 0 && buyLegs.length > 0) {
        const totalSellPrem = sellLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
        const totalBuyPrem = buyLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
        const netCredit = totalSellPrem - totalBuyPrem;
        
        const primaryQty = buyLegs[0].qty;
        const width = Math.abs(buyLegs[0].strike - sellLegs[0].strike);
        
        this.maxReward = Math.round(netCredit > 0 ? netCredit : (width * primaryQty + netCredit));
        this.maxRisk = Math.round(netCredit > 0 ? (width * primaryQty - netCredit) : Math.abs(netCredit));
      }
    } else if (this.activePositions.length === 1) {
      // Simplified for other structures
      this.maxReward = this.activePositions.reduce((sum, p) => sum + (p.side === 'SELL' ? p.entryPrice * p.qty : 5000), 0);
      this.maxRisk = this.activePositions.reduce((sum, p) => sum + (p.side === 'BUY' ? p.entryPrice * p.qty : 1000 * p.qty), 0);
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
    // Only roll if position is deep OTM (80% profit) to lock in gains and redeploy
    const currentPrice = sellPos.type === 'CE' 
      ? marketEngine.getOptionChain().find(o => o.strike === sellPos.strike)?.ce_price || 0
      : marketEngine.getOptionChain().find(o => o.strike === sellPos.strike)?.pe_price || 0;
    
    const profitPct = (sellPos.entryPrice - currentPrice) / sellPos.entryPrice;

    if (profitPct > 0.8) {
      shouldRoll = true;
      console.log(`[EXECUTION] Rolling winner: Strike ${sellPos.strike} ${sellPos.type} at 80% decay.`);
    }

    if (shouldRoll) {
      console.log('Rolling Position...');
      this.rollsToday++;
      this.lastRollTime = now;
      await this.exitAllInternal('Rolling');
      await this.executeTradeInternal(sellPos.type === 'PE' ? 'BULLISH' : 'BEARISH');
    }
  }

  private async checkGammaScalp() {
    if (this.activePositions.length === 0) return;
    
    const now = Date.now();
    const timeSinceLastHedge = (now - this.lastHedgeTime) / 1000;
    
    // Cooldown: Don't hedge more than once every 5 minutes unless delta is extreme (> 1.5)
    // This allows the trade to breathe and follow path dependency.
    if (timeSinceLastHedge < 300 && Math.abs(this.netDelta) < 1.5) {
       return;
    }

    // If net delta exceeds tolerance, we need to scalp/hedge
    if (Math.abs(this.netDelta) > config.DELTA_TOLERANCE) {
      const spot = marketEngine.getSpotPrice();
      // Use a slight OTM strike for hedging to avoid direct conflict with core ATM positions
      const hedgeBias = this.netDelta > 0 ? 50 : -50;
      const hedgeStrike = Math.round((spot + hedgeBias) / 50) * 50;
      
      const hedgeType = this.netDelta > 0 ? 'CE' : 'PE'; 
      // Use floor to under-hedge slightly, maintaining directional edge
      const hedgeQty = Math.max(1, Math.floor(Math.abs(this.netDelta) / 0.5)) * config.LOT_SIZE;
      
      if (hedgeQty > 0) {
        console.log(`[GAMMA SCALP] Net Delta ${this.netDelta.toFixed(2)} exceeds tolerance (${config.DELTA_TOLERANCE}). Hedging ${hedgeQty} ${hedgeType} at ${hedgeStrike}...`);
        
        const chain = marketEngine.getOptionChain();
        const opt = chain.find(o => o.strike === hedgeStrike);
        const price = opt ? (hedgeType === 'CE' ? opt.ce_price : opt.pe_price) : 100;

        // Update state
        this.lastHedgeTime = now;

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
              existing.entryPrice = price; 
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

        this.hedgeLogs.unshift(`[${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}] Delta threshold crossed (${this.netDelta.toFixed(2)}). Hedged with ${hedgeQty} qty ${hedgeType}.`);
        if (this.hedgeLogs.length > 10) this.hedgeLogs.pop();
        
        // Recalculate after hedge
        this.calculatePortfolioGreeks();
      }
    }
  }

  async exitAll(reason: string) {
    return await this.withLock(async () => {
      await this.exitAllInternal(reason);
    });
  }

  private async exitAllInternal(reason: string) {
    if (this.activePositions.length > 0) {
      const now = Date.now();
      const durationSeconds = Math.round((now - this.currentEntryTime) / 1000);
      
      // Determine market phase
      const hours = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
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
          exitReason: reason,
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
    
    NotificationService.notifyTradeExit({
      symbol: config.TRADING_SYMBOL,
      pnl: this.pnl,
      entryTimestamp: this.currentEntryTime
    }, reason);

    this.activePositions = [];
    this.lastTradeEndTime = Date.now();
    this.pnl = 0; 
    this.capitalDeployed = 0;
    this.currentTradeBias = null;
    this.currentEntryTime = 0;
    this.currentTradeParams = null;
    await this.saveState();
  }

  public async saveState() {
    const state: any = {
      activePositions: this.activePositions,
      pnl: this.pnl,
      peakPnL: this.peakPnL,
      currentTradeParams: this.currentTradeParams,
      currentActiveSL: this.currentActiveSL,
      rollsToday: this.rollsToday,
      lastTradeEndTime: this.lastTradeEndTime,
      lastTradeScore: this.lastTradeScore,
      currentTradeBias: this.currentTradeBias,
      currentEntryTime: this.currentEntryTime,
      currentSpotAtEntry: this.currentSpotAtEntry,
      currentStrikeAtEntry: this.currentStrikeAtEntry,
      currentVixAtEntry: this.currentVixAtEntry,
      currentIsExpiryDay: this.currentIsExpiryDay,
      currentIsMonthlyExpiry: this.currentIsMonthlyExpiry,
      currentEntryNetDelta: this.currentEntryNetDelta,
      currentEntryNetGamma: this.currentEntryNetGamma,
      currentIndicatorsAtEntry: this.currentIndicatorsAtEntry,
      hedgeLogs: this.hedgeLogs,
    };
    await StatePersistenceManager.syncState(state as any);
  }

  public async loadState() {
    const data = await StatePersistenceManager.loadState();
    if (data) {
      console.log("[EXECUTION] Restoring engine state from persistence.");
      const s = data as any;
      this.activePositions = s.activePositions || [];
      this.pnl = s.pnl || 0;
      this.peakPnL = s.peakPnL || 0;
      this.currentTradeParams = s.currentTradeParams || null;
      this.currentActiveSL = s.currentActiveSL || 0;
      this.rollsToday = s.rollsToday || 0;
      this.lastTradeEndTime = s.lastTradeEndTime || 0;
      this.lastTradeScore = s.lastTradeScore || null;
      this.currentTradeBias = s.currentTradeBias || null;
      this.currentEntryTime = s.currentEntryTime || 0;
      this.currentSpotAtEntry = s.currentSpotAtEntry || 0;
      this.currentStrikeAtEntry = s.currentStrikeAtEntry || 0;
      this.currentVixAtEntry = s.currentVixAtEntry || 0;
      this.currentIsExpiryDay = s.currentIsExpiryDay || false;
      this.currentIsMonthlyExpiry = s.currentIsMonthlyExpiry || false;
      this.currentEntryNetDelta = s.currentEntryNetDelta || 0;
      this.currentEntryNetGamma = s.currentEntryNetGamma || 0;
      this.currentIndicatorsAtEntry = s.currentIndicatorsAtEntry || null;
      this.hedgeLogs = s.hedgeLogs || [];
      
      this.calculatePortfolioGreeks();
      this.calculateCapitalDeployed();
    }
  }

  public async resetState() {
    this.activePositions = [];
    this.pnl = 0;
    this.peakPnL = 0;
    this.currentTradeParams = null;
    this.currentActiveSL = 0;
    this.rollsToday = 0;
    this.lastTradeEndTime = 0;
    this.lastTradeScore = null;
    this.currentTradeBias = null;
    this.currentEntryTime = 0;
    this.currentSpotAtEntry = 0;
    this.currentStrikeAtEntry = 0;
    this.currentVixAtEntry = 0;
    this.currentIsExpiryDay = false;
    this.currentIsMonthlyExpiry = false;
    this.currentEntryNetDelta = 0;
    this.currentEntryNetGamma = 0;
    this.currentIndicatorsAtEntry = null;
    this.hedgeLogs = [];
    this.lastTradeSuppression = null;
    this.lastRiskValidation = null;
    this.calculatePortfolioGreeks();
    this.calculateCapitalDeployed();
    await this.saveState();
  }

  getState() {
    return {
      positions: this.activePositions,
      pnl: Math.round(this.pnl),
      peakPnL: Math.round(this.peakPnL),
      params: this.currentTradeParams,
      activeSL: this.currentActiveSL,
      rollsToday: this.rollsToday,
      capitalDeployed: Math.round(this.capitalDeployed),
      netPremium: Math.round(this.netPremium),
      maxRisk: this.maxRisk,
      maxReward: this.maxReward,
      lastTradeSuppression: this.lastTradeSuppression,
      netDelta: Number(this.netDelta.toFixed(3)),
      netGamma: Number(this.netGamma.toFixed(4)),
      netTheta: Number(this.netTheta.toFixed(2)),
      netVega: Number(this.netVega.toFixed(2)),
      hedgeLogs: this.hedgeLogs,
      risk: riskEngine.getStats(),
      lastRiskValidation: this.lastRiskValidation
    };
  }
}

export const executionEngine = new ExecutionEngine();

