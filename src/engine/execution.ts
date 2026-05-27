/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * execution.ts — Execution Engine
 *
 * Changes from original:
 *  1. DAILY SL COOLDOWN — after DAILY_LOSS_LIMIT is hit, blocks ALL new entries
 *     for the rest of the calendar day. State persists through server restarts
 *     via Firestore (dailySLHitDate field in saveState/loadState).
 *
 *  2. DAILY TRADE COUNTER RESET — rollsToday and dailyTradeCount reset at
 *     market open (9:15 IST) each day, not just on server restart.
 *
 *  3. DAILY PROFIT LOCK — when cumulative daily P&L exceeds DAILY_PROFIT_LOCK,
 *     the engine switches to exit-only mode and suppresses new entries
 *     (was already in config but not enforced in executeTradeInternal).
 *
 *  4. calculatePortfolioGreeks() now uses real Greeks from chain data
 *     (chain already enriched with BSM values by market.ts + server.ts).
 *     Removed the heuristic theta/vega approximation fallback.
 *
 *  All other logic — strategy selection, rolling, gamma scalping, exit rules,
 *  persistence, notifications — is IDENTICAL to original.
 */

import { config, getStrikeStep } from './config.ts';
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns "YYYY-MM-DD" in IST for today */
function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

/** Returns IST hour and minute as { h, m } */
function nowIST(): { h: number; m: number; totalMin: number } {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  return { h, m, totalMin: h * 60 + m };
}

// ─── Engine ───────────────────────────────────────────────────────────────────

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

  /**
   * Optional callback invoked after every exitAllInternal().
   * Used by server.ts to invalidate tradeLogsCache immediately.
   */
  public onTradeExit: (() => void) | null = null;

  // ── NEW: Daily risk gate fields ─────────────────────────────────────────────

  /**
   * IST date ("YYYY-MM-DD") on which the daily SL was hit.
   * Persisted to Firestore so a server restart mid-day doesn't reset it.
   */
  private dailySLHitDate: string | null = null;

  /**
   * IST date for which rollsToday / dailyTradeCount were last reset.
   * Ensures counters roll over at midnight IST even without a server restart.
   */
  private dailyResetDate: string | null = null;

  /**
   * Cumulative realised P&L for today (resets at midnight IST).
   * Used to enforce DAILY_PROFIT_LOCK exit-only mode.
   */
  private dailyRealizedPnL: number = 0;

  /** Count of completed trades today (for MAX_TRADES_PER_DAY guard). */
  private dailyTradeCount: number = 0;

  // ─── Mutex ───────────────────────────────────────────────────────────────────

  private async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.isProcessing) return null;
    this.isProcessing = true;
    try {
      return await fn();
    } finally {
      this.isProcessing = false;
    }
  }

  // ─── Daily counter reset ─────────────────────────────────────────────────────

  /**
   * Called at the top of executeTradeInternal() and updatePnL().
   * Resets per-day counters when the IST date has changed since last reset.
   * This is the ONLY place these counters reset — not on server restart.
   */
  private maybeResetDailyCounters() {
    const today = todayIST();
    if (this.dailyResetDate === today) return; // Already reset for today

    console.log(`[EXECUTION] Daily counter reset for ${today} (was ${this.dailyResetDate ?? 'never'})`);
    this.rollsToday = 0;
    this.dailyTradeCount = 0;
    this.dailyRealizedPnL = 0;
    // Clear daily SL hit if it was from a previous day
    if (this.dailySLHitDate && this.dailySLHitDate !== today) {
      console.log(`[EXECUTION] Daily SL cooldown cleared (was set ${this.dailySLHitDate}, today is ${today})`);
      this.dailySLHitDate = null;
    }
    this.dailyResetDate = today;
    // Persist asynchronously — don't await to avoid blocking the loop
    this.saveState().catch(e => console.error('[EXECUTION] saveState after daily reset failed:', e));
  }

  // ─── Entry gate ──────────────────────────────────────────────────────────────

  /**
   * Returns suppression reason string if a daily-level block is active,
   * or null if entry is allowed at the daily level.
   *
   * Checked before any strategy or risk validation.
   */
  private checkDailyGate(isManual: boolean): string | null {
    const today = todayIST();

    // 1. Daily SL Cooldown — blocks the ENTIRE remainder of the trading day
    if (this.dailySLHitDate === today) {
      return `Daily Loss Limit hit (₹${config.DAILY_LOSS_LIMIT.toLocaleString('en-IN')}). No new entries until tomorrow.`;
    }

    // 2. Daily Profit Lock — exit-only mode after hitting profit target
    if (this.dailyRealizedPnL >= config.DAILY_PROFIT_LOCK && !isManual) {
      return `Daily Profit Lock active (₹${config.DAILY_PROFIT_LOCK.toLocaleString('en-IN')} achieved). Exit-only mode until tomorrow.`;
    }

    // 3. Max trades per day
    if (this.dailyTradeCount >= config.MAX_TRADES_PER_DAY && !isManual) {
      return `Max trades per day reached (${config.MAX_TRADES_PER_DAY}).`;
    }

    // 4. Consecutive loss limit — pause after N losses in a row regardless of rupee amount
    if (!isManual) {
      const riskStats = riskEngine.getStats();
      const consecutiveLosses = (riskStats as any).consecutiveLosses ?? 0;
      if (consecutiveLosses >= config.CONSECUTIVE_LOSS_LIMIT) {
        return `Consecutive loss limit reached (${consecutiveLosses} losses in a row). Pausing entries — reset risk engine to resume.`;
      }
    }

    return null;
  }

  // ─── Public entry point ───────────────────────────────────────────────────────

  async executeTrade(bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL', isManual: boolean = false) {
    return await this.withLock(async () => {
      await this.executeTradeInternal(bias, isManual);
    });
  }

  private async executeTradeInternal(
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    isManual: boolean = false
  ) {
    if (this.activePositions.length > 0) return;

    // Reset counters if day has changed
    this.maybeResetDailyCounters();

    // ── Daily gate check ──────────────────────────────────────────────────────
    const dailyBlock = this.checkDailyGate(isManual);
    if (dailyBlock) {
      if (isManual) throw new Error(`Execution Blocked: ${dailyBlock}`);
      if (!this.lastTradeSuppression || this.lastTradeSuppression.reason !== dailyBlock) {
        console.log(`[EXECUTION] Auto Entry Suppressed (Daily Gate): ${dailyBlock}`);
      }
      this.lastTradeSuppression = { reason: dailyBlock, timestamp: Date.now() };
      return;
    }

    // Market Closed Protection
    if (marketEngine.isMarketClosed()) {
      const reason = 'Live market is closed (Weekend, Holiday, or Off-Market Hours)';
      if (isManual) throw new Error(`Execution Blocked: ${reason}`);
      if (!this.lastTradeSuppression || this.lastTradeSuppression.reason !== reason) {
        console.log(`[EXECUTION] Auto Entry Suppressed: ${reason}`);
      }
      this.lastTradeSuppression = { reason, timestamp: Date.now() };
      return;
    }

    // Entry Cooldown: 2 minute break between trades for Auto-Mode only
    if (!isManual) {
      const timeSinceLastTrade = (Date.now() - this.lastTradeEndTime) / 1000;
      if (timeSinceLastTrade < 120) {
        // When lastTradeEndTime is set to a future timestamp (protective exit 30-min block),
        // timeSinceLastTrade is negative — show actual remaining seconds correctly
        const remainingSecs = timeSinceLastTrade < 0
          ? Math.round(-timeSinceLastTrade)          // show seconds until unblock
          : Math.round(120 - timeSinceLastTrade);    // normal 2-min cooldown
        const reason = `Cooldown active (${remainingSecs}s left)`;
        if (!this.lastTradeSuppression || this.lastTradeSuppression.reason !== reason) {
          console.log(`[EXECUTION] Entry Suppressed: ${reason}`);
        }
        this.lastTradeSuppression = { reason, timestamp: Date.now() };
        return;
      }
    }

    const spot = marketEngine.getSpotPrice();
    const score = strategyEngine.calculateScore();

    // Score Validation
    if (!isManual && score.total < 60) {
      const reason = `Low Signal Score (${score.total})`;
      if (!this.lastTradeSuppression || !this.lastTradeSuppression.reason.startsWith('Low Signal Score')) {
        console.log(`[EXECUTION] Entry Suppressed: ${reason}. At least 60 required.`);
      }
      this.lastTradeSuppression = { reason, timestamp: Date.now() };
      return;
    }

    const strikeStep = getStrikeStep();
    const atmStrike = Math.round(spot / strikeStep) * strikeStep;

    // Derive Dynamic SL/Target
    const derivation = intelligenceEngine.deriveParams(
      score.mode === 'MOMENTUM_SNIPER' ? 'BUY' : 'SELL',
      score.mode,
      spot,
      bias,
      score.total
    );

    if (!isManual && derivation.pop !== undefined && derivation.pop < 55) {
      const reason = `Probability of Profit too low (${derivation.pop}%)`;
      if (!this.lastTradeSuppression || this.lastTradeSuppression.reason !== reason) {
        console.log(`[EXECUTION] Entry Suppressed: ${reason}`);
      }
      this.lastTradeSuppression = { reason, timestamp: Date.now() };
      return;
    }

    if (!isManual) {
      const rr = derivation.riskRewardRatio;
      if (score.mode === 'INST_SPREAD' && rr < 1.0) {
        const rrReason = `Poor Base R:R Ratio (${rr.toFixed(2)})`;
        if (!this.lastTradeSuppression || this.lastTradeSuppression.reason !== rrReason) {
          console.log(`[EXECUTION] Entry Suppressed: ${rrReason}`);
        }
        this.lastTradeSuppression = { reason: rrReason, timestamp: Date.now() };
        return;
      }
    }

    // Risk Engine validation
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
        details: { score, riskScore: validation.score },
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

    // Expiry Day Safety
    if (this.currentIsExpiryDay && !isManual) {
      const { h, m } = nowIST();
      const [hLimit, mLimit] = config.EXPIRY_NO_TRADE_TIME.split(':').map(Number);
      if (h > hLimit || (h === hLimit && m >= mLimit)) {
        const reason = `Expiry No-Trade Zone (after ${config.EXPIRY_NO_TRADE_TIME})`;
        this.lastTradeSuppression = { reason, timestamp: Date.now() };
        console.log(`[EXECUTION] Entry Suppressed: ${reason}`);
        return;
      }
    }

    // ── Strike selection helpers (unchanged) ───────────────────────────────────

    const getStrikeByDelta = (targetDelta: number, type: 'CE' | 'PE', minPremium: number = 0) => {
      const chain = marketEngine.getOptionChain();
      if (chain.length === 0) return Math.round(spot / getStrikeStep()) * getStrikeStep();
      const validOptions =
        minPremium > 0
          ? chain.filter(opt => (type === 'CE' ? opt.ce_price : opt.pe_price) >= minPremium)
          : chain;
      const sourceChain = validOptions.length > 0 ? validOptions : chain;
      let closest = sourceChain[0];
      let minDiff = Infinity;
      sourceChain.forEach(opt => {
        let delta = (type === 'CE' ? opt.delta : (opt as any).pe_delta);
        // Fallback: if chain delta is missing/zero, compute from BSM rather than defaulting to 0.5
        if (!delta || delta === 0) {
          delta = Math.abs(marketEngine.calculateDelta(spot, opt.strike, type));
        } else if (type === 'PE' && delta < 0) {
          delta = Math.abs(delta);
        }
        const diff = Math.abs(delta - targetDelta);
        if (diff < minDiff) { minDiff = diff; closest = opt; }
      });
      return closest.strike;
    };

    const getLTP = (strike: number, type: 'CE' | 'PE') => {
      const chain = marketEngine.getOptionChain();
      const option = chain.find(o => o.strike === strike);
      if (option) return type === 'CE' ? option.ce_price : option.pe_price;
      const dist = Math.abs(strike - spot);
      return Math.max(5, 100 - dist * 0.5);
    };

    const chain = marketEngine.getOptionChain();
    let support = atmStrike;
    let resistance = atmStrike;
    if (chain.length > 0) {
      let maxPeOi = -1;
      let maxCeOi = -1;
      chain.forEach(c => {
        if ((c.pe_oi || 0) > maxPeOi) { maxPeOi = c.pe_oi || 0; support = c.strike; }
        if ((c.ce_oi || 0) > maxCeOi) { maxCeOi = c.ce_oi || 0; resistance = c.strike; }
      });
    }

    const newPositions: Position[] = [];

    // ── Strategy structure selection (unchanged) ───────────────────────────────

    switch (score.strategyType) {
      case 'NAKED_BUY': {
        const targetDelta = expiryStatus.isExpiryDay ? 0.65 : 0.55;
        const strike = getStrikeByDelta(targetDelta, bias === 'BULLISH' ? 'CE' : 'PE');
        newPositions.push({
          strike,
          type: bias === 'BULLISH' ? 'CE' : 'PE',
          entryPrice: getLTP(strike, bias === 'BULLISH' ? 'CE' : 'PE'),
          qty: config.LOT_SIZE,
          side: 'BUY',
        });
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
        const sellStrike = Math.round(support / getStrikeStep()) * getStrikeStep();
        const buyStrike = sellStrike - 100;
        newPositions.push(
          { strike: sellStrike, type: 'PE', entryPrice: getLTP(sellStrike, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }
      case 'BEAR_CALL_SPREAD': {
        const sellStrike = Math.round(resistance / getStrikeStep()) * getStrikeStep();
        const buyStrike = sellStrike + 100;
        newPositions.push(
          { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyStrike, type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE, side: 'BUY' }
        );
        break;
      }
      case 'IRON_CONDOR': {
        const sellPE = Math.round(support / getStrikeStep()) * getStrikeStep();
        const buyPE = sellPE - 100;
        const sellCE = Math.round(resistance / getStrikeStep()) * getStrikeStep();
        const buyCE = sellCE + 100;
        newPositions.push(
          { strike: sellPE, type: 'PE', entryPrice: getLTP(sellPE, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyPE,  type: 'PE', entryPrice: getLTP(buyPE,  'PE'), qty: config.LOT_SIZE, side: 'BUY'  },
          { strike: sellCE, type: 'CE', entryPrice: getLTP(sellCE, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyCE,  type: 'CE', entryPrice: getLTP(buyCE,  'CE'), qty: config.LOT_SIZE, side: 'BUY'  }
        );
        break;
      }
      case 'IRON_FLY': {
        const buyPE = atmStrike - 250;
        const buyCE = atmStrike + 250;
        newPositions.push(
          { strike: atmStrike, type: 'PE', entryPrice: getLTP(atmStrike, 'PE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: atmStrike, type: 'CE', entryPrice: getLTP(atmStrike, 'CE'), qty: config.LOT_SIZE, side: 'SELL' },
          { strike: buyPE,     type: 'PE', entryPrice: getLTP(buyPE,     'PE'), qty: config.LOT_SIZE, side: 'BUY'  },
          { strike: buyCE,     type: 'CE', entryPrice: getLTP(buyCE,     'CE'), qty: config.LOT_SIZE, side: 'BUY'  }
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
            { strike: buyStrike,  type: 'CE', entryPrice: getLTP(buyStrike, 'CE'), qty: config.LOT_SIZE,     side: 'BUY'  },
            { strike: sellStrike, type: 'CE', entryPrice: sellPrice,               qty: config.LOT_SIZE * 2, side: 'SELL' }
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
            { strike: buyStrike,  type: 'PE', entryPrice: getLTP(buyStrike, 'PE'), qty: config.LOT_SIZE,     side: 'BUY'  },
            { strike: sellStrike, type: 'PE', entryPrice: sellPrice,               qty: config.LOT_SIZE * 2, side: 'SELL' }
          );
        }
        break;
      }
      case 'BUTTERFLY': {
        const center = atmStrike;
        const wingSize = 100;
        const btype = bias === 'BULLISH' ? 'CE' : 'PE';
        newPositions.push(
          { strike: center - wingSize, type: btype, entryPrice: getLTP(center - wingSize, btype), qty: config.LOT_SIZE,     side: 'BUY'  },
          { strike: center,            type: btype, entryPrice: getLTP(center,            btype), qty: config.LOT_SIZE * 2, side: 'SELL' },
          { strike: center + wingSize, type: btype, entryPrice: getLTP(center + wingSize, btype), qty: config.LOT_SIZE,     side: 'BUY'  }
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
        const buyStrike = atmStrike;
        const sellStrike = atmStrike;
        newPositions.push(
          { strike: buyStrike,  type: 'CE', entryPrice: getLTP(buyStrike,  'CE') * 1.5, qty: config.LOT_SIZE, side: 'BUY'  },
          { strike: sellStrike, type: 'CE', entryPrice: getLTP(sellStrike, 'CE'),        qty: config.LOT_SIZE, side: 'SELL' }
        );
        break;
      }
      default: {
        const strike = atmStrike;
        newPositions.push({
          strike,
          type: bias === 'BEARISH' ? 'PE' : 'CE',
          entryPrice: getLTP(strike, bias === 'BEARISH' ? 'PE' : 'CE'),
          qty: config.LOT_SIZE,
          side: 'BUY',
        });
        break;
      }
    }

    // ── RR validation (unchanged) ──────────────────────────────────────────────

    if (newPositions.length >= 1) {
      if (newPositions.length >= 2) {
        const sellLegs = newPositions.filter(p => p.side === 'SELL');
        const buyLegs  = newPositions.filter(p => p.side === 'BUY');
        if (sellLegs.length > 0 && buyLegs.length > 0) {
          const totalSellPrem = sellLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
          const totalBuyPrem  = buyLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
          const netCredit = totalSellPrem - totalBuyPrem;
          const width = Math.abs(buyLegs[0].strike - sellLegs[0].strike);
          const primaryQty = buyLegs[0].qty;
          let maxRiskPoints = 0;
          if (netCredit > 0) {
            maxRiskPoints = (width * primaryQty - netCredit) / primaryQty;
          } else {
            maxRiskPoints = Math.abs(netCredit) / primaryQty;
          }
          const maxRewardPoints = netCredit > 0
            ? netCredit / primaryQty
            : width - Math.abs(netCredit) / primaryQty;
          const rr = maxRewardPoints > 0 ? maxRiskPoints / maxRewardPoints : 100;
          if (rr > 7.0) {
            const reason = `Poor RR ratio (1:${(1 / rr).toFixed(2)})`;
            this.lastTradeSuppression = { reason, timestamp: Date.now() };
            console.warn(`[EXECUTION] Entry Suppressed: ${reason}. Minimum 1:7.0 R:R required.`);
            return;
          }
        }
      } else if (newPositions.length === 1 && newPositions[0].side === 'BUY') {
        const risk   = this.currentTradeParams?.stopLossRupees || config.SL_RUPEES;
        const reward = this.currentTradeParams?.targetRupees   || config.TARGET_RUPEES;
        const rr = reward > 0 ? risk / reward : 100;
        if (rr > 1.2) {
          const reason = `Naked Buy RR too low (1:${(1 / rr).toFixed(1)})`;
          this.lastTradeSuppression = { reason, timestamp: Date.now() };
          return;
        }
      }
    }

    // ── Commit positions ───────────────────────────────────────────────────────

    this.activePositions = newPositions;
    this.dailyTradeCount++;

    // ── Premium-aware SL/Target override ─────────────────────────────────────
    // The intelligence engine derives SL/Target from ATR points on spot.
    // For credit spreads, the realistic P&L range is bounded by collected premium
    // and max spread width — so we override with premium-anchored values.
    if (this.currentTradeParams) {
      const sellLegs = newPositions.filter(p => p.side === 'SELL');
      const buyLegs  = newPositions.filter(p => p.side === 'BUY');

      if (sellLegs.length > 0) {
        // Credit spread / Iron Condor / Iron Fly
        const totalSellPrem = sellLegs.reduce((s, p) => s + p.entryPrice * p.qty, 0);
        const totalBuyPrem  = buyLegs.reduce((s, p)  => s + p.entryPrice * p.qty, 0);
        const netCredit = totalSellPrem - totalBuyPrem; // total ₹ received

        if (netCredit > 0) {
          // Target: capture 60% of net credit (realistic for spread strategies)
          const premiumTarget = Math.round(netCredit * 0.60);
          // SL: lose no more than 2× net credit (standard credit spread risk rule)
          const premiumSL     = Math.round(netCredit * 2.0);

          // Only use premium-based values if they are tighter than ATR-derived ones
          // This prevents the ATR model from setting a ₹4,000 target on a ₹400 credit trade
          if (premiumTarget < this.currentTradeParams.targetRupees) {
            console.log(
              `[EXECUTION] Premium-aware target override: ₹${this.currentTradeParams.targetRupees} → ₹${premiumTarget} ` +
              `(60% of ₹${Math.round(netCredit)} net credit)`
            );
            this.currentTradeParams = { ...this.currentTradeParams, targetRupees: premiumTarget };
          }
          if (premiumSL < this.currentTradeParams.stopLossRupees) {
            console.log(
              `[EXECUTION] Premium-aware SL override: ₹${this.currentTradeParams.stopLossRupees} → ₹${premiumSL} ` +
              `(2× net credit)`
            );
            this.currentTradeParams = { ...this.currentTradeParams, stopLossRupees: premiumSL };
          }
          // Re-set active SL after potential override
          this.currentActiveSL = -this.currentTradeParams.stopLossRupees;
        }
      } else if (buyLegs.length > 0) {
        // Naked buy / debit spread — SL = premium paid, Target = 2× premium paid
        const totalDebit = buyLegs.reduce((s, p) => s + p.entryPrice * p.qty, 0);
        if (totalDebit > 0) {
          const debitTarget = Math.round(totalDebit * 2.0);   // 2R target
          const debitSL     = Math.round(totalDebit * 0.5);   // 50% of premium
          if (debitTarget < this.currentTradeParams.targetRupees) {
            this.currentTradeParams = { ...this.currentTradeParams, targetRupees: debitTarget };
          }
          if (debitSL < this.currentTradeParams.stopLossRupees) {
            this.currentTradeParams = { ...this.currentTradeParams, stopLossRupees: debitSL };
          }
          this.currentActiveSL = -this.currentTradeParams.stopLossRupees;
        }
      }
    }

    console.log(
      `[EXECUTION] AI AUTO-DECIDE: Structure [${score.strategyType}] selected based on VIX ${this.currentVixAtEntry.toFixed(2)} and Score ${score.total}.`
    );

    NotificationService.notifyTradeEntry({
      symbol: config.TRADING_SYMBOL,
      strategyMode: score.mode,
      strategyType: score.strategyType,
      bias,
      entrySpot: spot,
      status: 'OPEN',
      params: derivation,
    });

    await tradeLogger.logAudit({
      timestamp: new Date().toISOString(),
      type: 'TRADE_TRIGGER',
      message: `${bias} Signal: Executing [${score.strategyType}] structure.`,
      details: {
        spot,
        vix: this.currentVixAtEntry,
        score: score.total,
        params: this.currentTradeParams,
      },
    });

    this.calculatePortfolioGreeks();
    this.calculateCapitalDeployed();
    this.currentEntryNetDelta = this.netDelta;
    this.currentEntryNetGamma = this.netGamma;

    riskEngine.recordTradeEntry();
    this.lastTradeSuppression = null;
    await this.saveState();
  }

  // ─── P&L update loop ─────────────────────────────────────────────────────────

  async updatePnL() {
    await this.withLock(async () => {
      // Check daily counter reset on every tick
      this.maybeResetDailyCounters();

      if (this.activePositions.length === 0) {
        riskEngine.updatePnL(0, []);
        return;
      }

      const chain = marketEngine.getOptionChain();
      if (chain.length === 0) return;

      let currentPnL = 0;
      this.activePositions.forEach(pos => {
        const option = chain.find(o => o.strike === pos.strike);
        const currentPrice = option
          ? pos.type === 'CE' ? option.ce_price : option.pe_price
          : pos.entryPrice;
        const diff =
          pos.side === 'BUY'
            ? currentPrice - pos.entryPrice
            : pos.entryPrice - currentPrice;
        currentPnL += diff * pos.qty;
      });

      this.pnl = Math.round(currentPnL);
      this.peakPnL = Math.max(this.peakPnL, this.pnl);

      if (this.currentTradeParams) {
        this.currentActiveSL = intelligenceEngine.calculateTrailingSL(
          this.pnl,
          this.peakPnL,
          this.currentTradeParams
        );
      }

      riskEngine.updatePnL(this.pnl, this.activePositions);
      this.calculatePortfolioGreeks();
      this.calculateCapitalDeployed();

      await this.checkRolling();
      await this.checkGammaScalp();

      // Kill switch
      const riskStats = riskEngine.getStats();
      if (riskStats.isKillSwitchActive) {
        await tradeLogger.logAudit({
          timestamp: new Date().toISOString(),
          type: 'RISK_ALERT',
          message: `Kill Switch Triggered mid-trade: ${riskStats.killReason}`,
          details: { pnl: this.pnl },
        });
        await this.exitAllInternal(`Risk Kill Switch: ${riskStats.killReason}`);
        return;
      }

      const { totalMin } = nowIST();
      const expiryStatus = marketEngine.getExpiryStatus();

      // Monthly expiry 1:30 PM exit — minimum 5 min hold to avoid instant-flip exits
      const tradeAgeMins = this.currentEntryTime > 0
        ? (Date.now() - this.currentEntryTime) / 60000
        : 999;

      if (expiryStatus.isMonthlyExpiry && totalMin >= 810) {
        if (this.activePositions.length > 0 && tradeAgeMins >= 5) {
          // Exit whether profitable or not — gamma risk at monthly expiry is too high to hold
          console.log(`[EXECUTION] Monthly Expiry 1:30 PM: Closing after ${tradeAgeMins.toFixed(1)}m (P&L ₹${this.pnl}).`);
          await this.exitAllInternal('Monthly Expiry 1:30 PM Protective Exit');
          return;
        } else if (this.activePositions.length > 0 && tradeAgeMins < 5) {
          console.log(`[EXECUTION] Monthly Expiry 1:30 PM: Skipping early exit — trade is only ${tradeAgeMins.toFixed(1)}m old (min 5m required).`);
        }
      }

      // Weekly expiry 2:45 PM exit — minimum 5 min hold
      if (expiryStatus.isWeekly && totalMin >= 885) {
        if (this.activePositions.length > 0 && tradeAgeMins >= 5) {
          console.log(`[EXECUTION] Weekly Expiry 2:45 PM: Closing after ${tradeAgeMins.toFixed(1)}m.`);
          await this.exitAllInternal('Weekly Expiry 2:45 PM Protective Exit');
          return;
        }
      }

      // Time-based decay exit for option buyers
      if (this.currentTradeParams) {
        const durationMins = (Date.now() - this.currentEntryTime) / 60000;
        if (this.lastTradeScore?.mode === 'MOMENTUM_SNIPER' && durationMins > 60) {
          if (this.pnl < this.currentTradeParams.targetRupees * 0.15) {
            await this.exitAllInternal('Time-Decay Exit: 60m Stagnation Threshold Reached');
            return;
          }
        }

        if (this.pnl <= this.currentActiveSL) {
          await this.exitAllInternal(`Stop Loss Hit (₹${this.currentActiveSL})`);
        } else if (this.pnl >= this.currentTradeParams.targetRupees) {
          await this.exitAllInternal(`Target Hit (₹${this.currentTradeParams.targetRupees})`);
        }
      } else {
        if (this.pnl <= -config.SL_RUPEES || this.pnl >= config.TARGET_RUPEES) {
          await this.exitAllInternal('SL/Target Hit');
        }
      }
    });
  }

  // ─── Portfolio Greeks — uses real BSM values from chain ──────────────────────

  /**
   * Uses real BSM Greeks stored in the chain by the server loop.
   * No more heuristic theta = -ltp * iv * 0.5 / sqrt(252) approximation.
   */
  private calculatePortfolioGreeks() {
    const chain = marketEngine.getOptionChain();
    const spot = marketEngine.getSpotPrice();
    let d = 0, g = 0, t = 0, v = 0;

    this.activePositions.forEach(pos => {
      if (pos.type === 'FUT') {
        d += (pos.side === 'BUY' ? 1 : -1) * (pos.qty / config.LOT_SIZE);
        return;
      }

      const opt = chain.find(o => o.strike === pos.strike);
      if (opt) {
        const multiplier = pos.side === 'BUY' ? 1 : -1;
        const units = pos.qty / config.LOT_SIZE;

        // Delta: CE in [0,1], PE in [-1,0]. Chain stores signed deltas.
        // Use real BSM delta from chain; if missing compute via calculateDelta
        let delta: number;
        if (pos.type === 'CE') {
          delta = opt.delta || marketEngine.calculateDelta(spot, pos.strike, 'CE');
        } else {
          delta = (opt as any).pe_delta || marketEngine.calculateDelta(spot, pos.strike, 'PE');
        }

        // Gamma is always positive from BSM; sign comes from buy/sell
        const gamma = opt.gamma || 0;

        // Theta and Vega: now real BSM values from chain (₹/day and ₹/1%IV respectively)
        // Use real values; fall back to zero rather than a random approximation
        const theta = opt.theta || 0;
        const vega  = opt.vega  || 0;

        d += delta * multiplier * units;
        g += gamma * multiplier * units;
        t += theta * multiplier * units;
        v += vega  * multiplier * units;
      }
    });

    this.netDelta = d;
    this.netGamma = g;
    this.netTheta = t;
    this.netVega  = v;
  }

  // ─── Capital deployed (unchanged) ────────────────────────────────────────────

  private calculateCapitalDeployed() {
    if (this.activePositions.length === 0) {
      this.capitalDeployed = 0;
      this.maxRisk = 0;
      this.maxReward = 0;
      return;
    }

    const buyLegs  = this.activePositions.filter(p => p.side === 'BUY');
    const sellLegs = this.activePositions.filter(p => p.side === 'SELL');
    const totalQty = Math.max(...this.activePositions.map(p => p.qty)) || config.LOT_SIZE;

    const netPremium = this.activePositions.reduce((sum, p) => {
      const val = p.entryPrice * p.qty;
      return sum + (p.side === 'BUY' ? val : -val);
    }, 0);
    this.netPremium = netPremium;

    if (sellLegs.length > 0) {
      const isHedged = buyLegs.length > 0;
      const marginPerUnit = isHedged ? 415 : 4500;
      this.capitalDeployed = marginPerUnit * totalQty;
    } else {
      this.capitalDeployed = buyLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
    }

    if (this.activePositions.length >= 2) {
      const sLegs = this.activePositions.filter(p => p.side === 'SELL');
      const bLegs = this.activePositions.filter(p => p.side === 'BUY');
      if (sLegs.length > 0 && bLegs.length > 0) {
        const totalSellPrem = sLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
        const totalBuyPrem  = bLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
        const netCredit = totalSellPrem - totalBuyPrem;
        const primaryQty = bLegs[0].qty;
        const width = Math.abs(bLegs[0].strike - sLegs[0].strike);
        this.maxReward = Math.round(netCredit > 0 ? netCredit : width * primaryQty + netCredit);
        this.maxRisk   = Math.round(netCredit > 0 ? width * primaryQty - netCredit : Math.abs(netCredit));
      }
    } else if (this.activePositions.length === 1) {
      this.maxReward = this.activePositions.reduce(
        (sum, p) => sum + (p.side === 'SELL' ? p.entryPrice * p.qty : 5000), 0
      );
      this.maxRisk = this.activePositions.reduce(
        (sum, p) => sum + (p.side === 'BUY' ? p.entryPrice * p.qty : 1000 * p.qty), 0
      );
    }
  }

  // ─── Rolling (unchanged) ──────────────────────────────────────────────────────

  private async checkRolling() {
    if (this.activePositions.length === 0) return;
    if (this.rollsToday >= config.MAX_ROLLS) return;
    const now = Date.now();
    if (now - this.lastRollTime < 15 * 60 * 1000) return;

    const sellPos = this.activePositions.find(p => p.side === 'SELL');
    if (!sellPos) return;

    const currentPrice =
      sellPos.type === 'CE'
        ? marketEngine.getOptionChain().find(o => o.strike === sellPos.strike)?.ce_price || 0
        : marketEngine.getOptionChain().find(o => o.strike === sellPos.strike)?.pe_price || 0;

    const profitPct = (sellPos.entryPrice - currentPrice) / sellPos.entryPrice;
    if (profitPct > 0.8) {
      console.log(`[EXECUTION] Rolling winner: Strike ${sellPos.strike} ${sellPos.type} at 80% decay.`);
      this.rollsToday++;
      this.lastRollTime = now;
      await this.exitAllInternal('Rolling');
      await this.executeTradeInternal(sellPos.type === 'PE' ? 'BULLISH' : 'BEARISH');
    }
  }

  // ─── Gamma scalp (unchanged) ──────────────────────────────────────────────────

  private async checkGammaScalp() {
    if (this.activePositions.length === 0) return;
    const now = Date.now();
    const timeSinceLastHedge = (now - this.lastHedgeTime) / 1000;
    if (timeSinceLastHedge < 300 && Math.abs(this.netDelta) < 1.5) return;
    if (Math.abs(this.netDelta) <= config.DELTA_TOLERANCE) return;

    const spot = marketEngine.getSpotPrice();
    const hedgeBias = this.netDelta > 0 ? 50 : -50;
    const hedgeStrike = Math.round((spot + hedgeBias) / getStrikeStep()) * getStrikeStep();
    const hedgeType = this.netDelta > 0 ? 'CE' : 'PE';
    const hedgeQty = Math.max(1, Math.floor(Math.abs(this.netDelta) / 0.5)) * config.LOT_SIZE;

    if (hedgeQty > 0) {
      console.log(
        `[GAMMA SCALP] Net Delta ${this.netDelta.toFixed(2)} exceeds tolerance (${config.DELTA_TOLERANCE}). ` +
        `Hedging ${hedgeQty} ${hedgeType} at ${hedgeStrike}...`
      );
      const chain = marketEngine.getOptionChain();
      const opt = chain.find(o => o.strike === hedgeStrike);
      const price = opt ? (hedgeType === 'CE' ? opt.ce_price : opt.pe_price) : 100;

      this.lastHedgeTime = now;

      const existingIdx = this.activePositions.findIndex(
        p => p.strike === hedgeStrike && p.type === hedgeType
      );
      if (existingIdx !== -1) {
        const existing = this.activePositions[existingIdx];
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
          existing.qty += hedgeQty;
        }
      } else {
        this.activePositions.push({
          strike: hedgeStrike,
          type: hedgeType,
          entryPrice: price,
          qty: hedgeQty,
          side: 'SELL',
          isHedge: true,
        });
      }

      this.hedgeLogs.unshift(
        `[${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}] ` +
        `Delta threshold crossed (${this.netDelta.toFixed(2)}). Hedged ${hedgeQty} qty ${hedgeType}.`
      );
      if (this.hedgeLogs.length > 10) this.hedgeLogs.pop();

      this.calculatePortfolioGreeks();
    }
  }

  // ─── Exit ────────────────────────────────────────────────────────────────────

  async exitAll(reason: string) {
    return await this.withLock(async () => {
      await this.exitAllInternal(reason);
    });
  }

  private async exitAllInternal(reason: string) {
    if (this.activePositions.length > 0) {
      const now = Date.now();
      const durationSeconds = Math.round((now - this.currentEntryTime) / 1000);
      const finalPnl = this.pnl;

      // ── NEW: Update daily realized P&L and check daily SL gate ───────────────
      this.dailyRealizedPnL += finalPnl;

      if (this.dailyRealizedPnL <= -config.DAILY_LOSS_LIMIT) {
        const today = todayIST();
        this.dailySLHitDate = today;
        console.warn(
          `[EXECUTION] ⛔ DAILY LOSS LIMIT HIT: ₹${Math.abs(this.dailyRealizedPnL).toLocaleString('en-IN')} ` +
          `(limit ₹${config.DAILY_LOSS_LIMIT.toLocaleString('en-IN')}). ` +
          `All new entries BLOCKED for rest of day (${today}).`
        );
        await tradeLogger.logAudit({
          timestamp: new Date().toISOString(),
          type: 'RISK_ALERT',
          message: `Daily Loss Limit hit: ₹${Math.abs(this.dailyRealizedPnL).toLocaleString('en-IN')}. Entry blocked until tomorrow.`,
          details: { dailyRealizedPnL: this.dailyRealizedPnL, limit: config.DAILY_LOSS_LIMIT },
        });
      }

      if (this.dailyRealizedPnL >= config.DAILY_PROFIT_LOCK) {
        console.log(
          `[EXECUTION] 🔒 DAILY PROFIT LOCK: ₹${this.dailyRealizedPnL.toLocaleString('en-IN')} achieved. ` +
          `Switching to exit-only mode.`
        );
      }
      // ─────────────────────────────────────────────────────────────────────────

      const hours = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
      ).getHours();
      let phase = 'MID-SESSION';
      if (hours < 11) phase = 'MARKET OPEN';
      else if (hours >= 14) phase = 'RE-SETTLEMENT';

      const buyLegs  = this.activePositions.filter(p => p.side === 'BUY');
      const sellLegs = this.activePositions.filter(p => p.side === 'SELL');
      const buyPrice  = buyLegs.length  > 0 ? buyLegs.reduce((s, p)  => s + p.entryPrice, 0) : 0;
      const sellPrice = sellLegs.length > 0 ? sellLegs.reduce((s, p) => s + p.entryPrice, 0) : 0;

      const primaryQty = this.activePositions[0]?.qty || config.LOT_SIZE;
      const lots = primaryQty / config.LOT_SIZE;
      let totalInvestment = 0;
      if (sellLegs.length > 0) {
        const isHedged = buyLegs.length > 0;
        totalInvestment = (isHedged ? 38_000 : 115_000) * lots;
      } else {
        totalInvestment = buyLegs.reduce((sum, p) => sum + p.entryPrice * p.qty, 0);
      }

      riskEngine.recordTradeResult(finalPnl);

      try {
        await tradeLogger.logTrade({
          timestamp: new Date().toISOString(),
          score: this.lastTradeScore?.total || 0,
          mode: this.lastTradeScore?.mode || 'INST_SPREAD',
          strategyType: this.lastTradeScore?.strategyType || 'IRON_CONDOR',
          gamma: this.lastTradeScore?.gamma || 0,
          oi_bias: this.lastTradeScore?.oiBias || 0,
          trap: this.lastTradeScore?.trap === 0,
          pnl: Math.round(finalPnl),
          win: finalPnl > 0,
          bias: this.currentTradeBias || undefined,
          vix: this.currentVixAtEntry || 14,
          spot: this.currentSpotAtEntry || 0,
          isExpiryDay: this.currentIsExpiryDay,
          isMonthlyExpiry: this.currentIsMonthlyExpiry,
          entryNetDelta: this.currentEntryNetDelta,
          entryNetGamma: this.currentEntryNetGamma,
          phase,
          duration: durationSeconds,
          entryTime: new Date(this.currentEntryTime).toISOString(),
          buyPrice,
          sellPrice,
          totalInvestment,
          strike: this.currentStrikeAtEntry,
          exitReason: reason,
          indicators: this.currentIndicatorsAtEntry
            ? {
                rsi: this.currentIndicatorsAtEntry.rsi,
                macd: this.currentIndicatorsAtEntry.macd.macd,
                macdSignal: this.currentIndicatorsAtEntry.macd.signal,
                macdHist: this.currentIndicatorsAtEntry.macd.histogram,
                bbUpper: this.currentIndicatorsAtEntry.bollinger.upper,
                bbLower: this.currentIndicatorsAtEntry.bollinger.lower,
                bbMiddle: this.currentIndicatorsAtEntry.bollinger.middle,
              }
            : undefined,
          intelligence: this.currentTradeParams
            ? {
                atr: this.currentTradeParams.atrValue,
                vixFactor: this.currentTradeParams.vixFactor,
                rr: this.currentTradeParams.riskRewardRatio,
                slPrice: this.currentTradeParams.stopLossPrice,
                targetPrice: this.currentTradeParams.targetPrice,
                slRupees: this.currentTradeParams.stopLossRupees,
                targetRupees: this.currentTradeParams.targetRupees,
                pop: this.currentTradeParams.pop,
              }
            : undefined,
        });
      } catch (logErr) {
        console.error('[EXECUTION] Failed to log trade, but continuing with exit:', logErr);
      }
    }

    console.log(`Exiting all positions. Reason: ${reason}. Final PnL: ${this.pnl}`);

    NotificationService.notifyTradeExit(
      {
        symbol: config.TRADING_SYMBOL,
        pnl: this.pnl,
        entryTimestamp: this.currentEntryTime,
        entrySpot: this.currentSpotAtEntry,
        strategyType: this.lastTradeScore?.strategyType || 'N/A',
        params: this.currentTradeParams,
      },
      reason
    ).catch(err => console.error('Notify failed:', err));

    this.activePositions = [];
    // For protective expiry exits, block re-entry for 30 minutes to prevent
    // the auto-mode loop from immediately re-entering into high-gamma conditions
    const isProtectiveExit = reason.includes('Protective Exit') || reason.includes('Kill Switch');
    this.lastTradeEndTime = isProtectiveExit
      ? Date.now() + (30 * 60 * 1000)  // 30-min forward block
      : Date.now();
    if (isProtectiveExit) {
      console.log(`[EXECUTION] Protective exit (${reason}): re-entry blocked for 30 minutes.`);
    }
    this.pnl = 0;
    this.capitalDeployed = 0;
    this.currentTradeBias = null;
    this.currentEntryTime = 0;
    this.currentTradeParams = null;
    // Notify server to invalidate trade log cache immediately
    if (this.onTradeExit) this.onTradeExit();
    await this.saveState();
  }

  // ─── Persistence (updated to include new daily fields) ────────────────────────

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
      // ── NEW daily risk fields ──
      dailySLHitDate: this.dailySLHitDate,
      dailyResetDate: this.dailyResetDate,
      dailyRealizedPnL: this.dailyRealizedPnL,
      dailyTradeCount: this.dailyTradeCount,
    };
    await StatePersistenceManager.syncState(state as any);
  }

  public async loadState() {
    const data = await StatePersistenceManager.loadState();
    if (data) {
      console.log('[EXECUTION] Restoring engine state from persistence.');
      const s = data as any;
      this.activePositions         = s.activePositions || [];
      this.pnl                     = s.pnl || 0;
      this.peakPnL                 = s.peakPnL || 0;
      this.currentTradeParams      = s.currentTradeParams || null;
      this.currentActiveSL         = s.currentActiveSL || 0;
      this.rollsToday              = s.rollsToday || 0;
      this.lastTradeEndTime        = s.lastTradeEndTime || 0;
      this.lastTradeScore          = s.lastTradeScore || null;
      this.currentTradeBias        = s.currentTradeBias || null;
      this.currentEntryTime        = s.currentEntryTime || 0;
      this.currentSpotAtEntry      = s.currentSpotAtEntry || 0;
      this.currentStrikeAtEntry    = s.currentStrikeAtEntry || 0;
      this.currentVixAtEntry       = s.currentVixAtEntry || 0;
      this.currentIsExpiryDay      = s.currentIsExpiryDay || false;
      this.currentIsMonthlyExpiry  = s.currentIsMonthlyExpiry || false;
      this.currentEntryNetDelta    = s.currentEntryNetDelta || 0;
      this.currentEntryNetGamma    = s.currentEntryNetGamma || 0;
      this.currentIndicatorsAtEntry = s.currentIndicatorsAtEntry || null;
      this.hedgeLogs               = s.hedgeLogs || [];
      // ── NEW daily risk fields ──
      this.dailySLHitDate   = s.dailySLHitDate   || null;
      this.dailyResetDate   = s.dailyResetDate   || null;
      this.dailyRealizedPnL = s.dailyRealizedPnL || 0;
      this.dailyTradeCount  = s.dailyTradeCount  || 0;

      // Run the daily counter check immediately on load — if server restarted
      // on a new day, this clears the stale dailySLHitDate and resets counters.
      this.maybeResetDailyCounters();

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
    this.dailySLHitDate = null;
    this.dailyResetDate = null;
    this.dailyRealizedPnL = 0;
    this.dailyTradeCount = 0;
    this.calculatePortfolioGreeks();
    this.calculateCapitalDeployed();
    await this.saveState();
  }

  // ─── State getter (updated with new daily fields) ─────────────────────────────

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
      lastRiskValidation: this.lastRiskValidation,
      lastTradeScore: this.lastTradeScore,
      currentTradeBias: this.currentTradeBias,
      // ── NEW ──
      dailySLHitDate: this.dailySLHitDate,
      dailyRealizedPnL: Math.round(this.dailyRealizedPnL),
      dailyTradeCount: this.dailyTradeCount,
      isDailyLimitHit: this.dailySLHitDate === todayIST(),
      isDailyProfitLocked: this.dailyRealizedPnL >= config.DAILY_PROFIT_LOCK,
    };
  }
}

export const executionEngine = new ExecutionEngine();
