/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import type { Position } from './execution.ts';
import { StatePersistenceManager } from './state_persistence.ts';

interface RiskStats {
  tradesToday: number;
  dailyPnL: number;
  consecutiveLosses: number;
  maxDrawdownToday: number;
  peakPnLToday: number;
  portfolioHeat: number; // Percentage of capital at risk
  riskScore: number;     // 0-100 score of current safety
  isKillSwitchActive: boolean;
  killReason: string | null;
}

// Standalone Robust IST Date Utility
const getISTDate = () => {
  const now = new Date();
  const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const year = istDate.getUTCFullYear();
  const month = (istDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const date = istDate.getUTCDate().toString().padStart(2, '0');
  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  return {
    dateStr: `${year}-${month}-${date}`,
    hours,
    minutes,
    timeStr: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
    day: istDate.getUTCDay()
  };
};

class RiskEngine {
  private stats: RiskStats = {
    tradesToday: 0,
    dailyPnL: 0,
    consecutiveLosses: 0,
    maxDrawdownToday: 0,
    peakPnLToday: 0,
    portfolioHeat: 0,
    riskScore: 100,
    isKillSwitchActive: false,
    killReason: null,
  };

  private entriesToday: number = 0;

  private lastResetDate: string | null = null;

  updatePnL(currentPnL: number, positions: Position[], greeks?: { netDelta: number; netVega: number }) {
    this.checkForDailyReset();
    this.stats.dailyPnL = currentPnL;

    // Track Drawdown
    if (currentPnL > this.stats.peakPnLToday) {
      this.stats.peakPnLToday = currentPnL;
    }
    const drawdown = this.stats.peakPnLToday - currentPnL;
    this.stats.maxDrawdownToday = Math.max(this.stats.maxDrawdownToday, drawdown);

    // Calculate Portfolio Heat
    const totalRisk = positions.length * config.SL_RUPEES;
    this.stats.portfolioHeat = Number(((totalRisk / config.CAPITAL_BASE) * 100).toFixed(2));

    this.calculateRiskScore(positions);
    this.checkThresholds(greeks);
    this.saveState();
  }

  recordTradeEntry() {
    this.entriesToday++;
    this.checkThresholds();
    this.saveState();
  }

  recordTradeResult(pnl: number) {
    this.stats.tradesToday++;
    if (pnl < 0) {
      this.stats.consecutiveLosses++;
    } else {
      this.stats.consecutiveLosses = 0;
    }
    this.checkThresholds();
    this.saveState();
  }

  private calculateRiskScore(positions: Position[]) {
    let score = 100;
    
    // Deduct for trades count
    score -= (this.stats.tradesToday / config.MAX_TRADES_PER_DAY) * 20;
    
    // Deduct for drawdown
    if (this.stats.maxDrawdownToday > config.DAILY_LOSS_LIMIT * 0.5) {
      score -= 30;
    }

    // Deduct for heat
    if (this.stats.portfolioHeat > config.MAX_PORTFOLIO_HEAT) {
      score -= 40;
    }

    // Deduct for consecutive losses
    score -= this.stats.consecutiveLosses * 15;

    this.stats.riskScore = Math.max(0, Math.round(score));
  }

  private checkThresholds(greeks?: { netDelta: number; netVega: number }) {
    if (this.stats.isKillSwitchActive) return;

    // Time-based Kill Switch (15:15 IST Square-off)
    const ist = getISTDate();
    const timeStr = ist.timeStr;

    if (timeStr >= config.END_TIME && !config.BTST_MODE) {
      this.activateKillSwitch(`Auto-Square-off Time Reached (${config.END_TIME} IST)`);
      return;
    }

    // Trade limit check - only prevents NEW entries
    if (this.entriesToday >= config.MAX_TRADES_PER_DAY) {
      // Don't activate kill switch here, just let validateEntry handle it
    } else if (this.stats.dailyPnL <= -config.DAILY_LOSS_LIMIT) {
      this.activateKillSwitch('Daily Loss Limit Exceeded');
    } else if (this.stats.consecutiveLosses >= config.CONSECUTIVE_LOSS_LIMIT) {
      this.activateKillSwitch('Consecutive Loss Limit Reached');
    }

    // Greek exposure breach — flatten if portfolio drifts outside risk envelope
    if (greeks) {
      if (Math.abs(greeks.netDelta) > config.MAX_DELTA_LIMIT) {
        this.activateKillSwitch(`Net Delta breach (|${greeks.netDelta.toFixed(2)}| > ${config.MAX_DELTA_LIMIT})`);
        return;
      }
      if (Math.abs(greeks.netVega) > config.MAX_VEGA_LIMIT) {
        this.activateKillSwitch(`Net Vega breach (|${greeks.netVega.toFixed(2)}| > ${config.MAX_VEGA_LIMIT})`);
        return;
      }
    }

    // Profit Lock Logic
    if (this.stats.peakPnLToday >= config.DAILY_PROFIT_LOCK) {
      const lockThreshold = this.stats.peakPnLToday * 0.7; // Lock 70% of peak profit
      if (this.stats.dailyPnL < lockThreshold) {
        this.activateKillSwitch('Profit Protection Triggered (Trailing SL)');
      }
    }
  }

  private activateKillSwitch(reason: string) {
    this.stats.isKillSwitchActive = true;
    this.stats.killReason = reason;
    console.warn(`[RISK ENGINE] KILL SWITCH ACTIVATED: ${reason}`);
    this.saveState();
  }

  private async saveState() {
    const data = {
      stats: this.stats,
      entriesToday: this.entriesToday,
      lastResetDate: this.lastResetDate
    };
    await StatePersistenceManager.saveRiskStats(data);
  }

  public async loadState() {
    const data = await StatePersistenceManager.loadRiskStats();
    if (data) {
      console.log("[RISK] Restoring risk stats from persistence.");
      this.stats = { ...this.stats, ...data.stats };
      this.entriesToday = data.entriesToday || 0;
      this.lastResetDate = data.lastResetDate;
      this.checkForDailyReset();
    }
  }

  private checkForDailyReset() {
    const today = getISTDate().dateStr;
    if (!this.lastResetDate || this.lastResetDate !== today) {
      console.log(`[RISK] New day detected (${today}) or first boot. Resetting daily stats.`);
      this.reset();
    }
    this.lastResetDate = today;
  }

  validateEntry(qty: number, expectedSL: number, projectedGreeks?: { netDelta: number; netVega: number }): { allowed: boolean; reason: string | null; score: number } {
    this.checkForDailyReset();
    
    if (this.stats.isKillSwitchActive) {
      return { allowed: false, reason: `Kill Switch Active: ${this.stats.killReason}`, score: this.stats.riskScore };
    }

    if (this.entriesToday >= config.MAX_TRADES_PER_DAY) {
      return { allowed: false, reason: `Max Trades Per Day (${config.MAX_TRADES_PER_DAY}) Reached`, score: this.stats.riskScore };
    }

    // Time Check (Convert to IST: UTC+5:30)
    const ist = getISTDate();
    const day = ist.day; // 0=Sun, 6=Sat
    const timeStr = ist.timeStr;
    
    // Weekend check
    if (day === 0 || day === 6) {
      if (config.DATA_SOURCE !== 'MOCK') {
        return { allowed: false, reason: `Market Closed (Weekend)`, score: this.stats.riskScore };
      }
    }

    if (timeStr < config.START_TIME || timeStr > config.END_TIME) {
      if (config.DATA_SOURCE !== 'MOCK') {
        return { allowed: false, reason: `Outside Trading Hours (${config.START_TIME}-${config.END_TIME} IST). Current: ${timeStr}`, score: this.stats.riskScore };
      }
    }

    // Market Open Cool-off: Reduced to 5 minutes for higher responsiveness 
    // while still avoiding the extreme first-candle volatility.
    if (timeStr >= "09:15" && timeStr < "09:20") {
      if (config.DATA_SOURCE !== 'MOCK') {
        return { allowed: false, reason: `Market Warming Up. Cool-off active until 09:20 IST.`, score: this.stats.riskScore };
      }
    }

    // Risk per trade check
    const riskAmount = expectedSL;
    const maxRiskAllowed = (config.CAPITAL_BASE * config.MAX_RISK_PER_TRADE_PCT) / 100;
    if (riskAmount > maxRiskAllowed) {
      return { allowed: false, reason: `Risk Per Trade (₹${riskAmount}) > Max Allowed (₹${maxRiskAllowed})`, score: this.stats.riskScore };
    }

    // Heat check
    if (this.stats.portfolioHeat > config.MAX_PORTFOLIO_HEAT) {
       return { allowed: false, reason: `Portfolio Heat (${this.stats.portfolioHeat}%) too high`, score: this.stats.riskScore };
    }

    // Greek envelope pre-check
    if (projectedGreeks) {
      if (Math.abs(projectedGreeks.netDelta) > config.MAX_DELTA_LIMIT) {
        return { allowed: false, reason: `Projected Net Delta (${projectedGreeks.netDelta.toFixed(2)}) exceeds limit ${config.MAX_DELTA_LIMIT}`, score: this.stats.riskScore };
      }
      if (Math.abs(projectedGreeks.netVega) > config.MAX_VEGA_LIMIT) {
        return { allowed: false, reason: `Projected Net Vega (${projectedGreeks.netVega.toFixed(2)}) exceeds limit ${config.MAX_VEGA_LIMIT}`, score: this.stats.riskScore };
      }
    }

    return { allowed: true, reason: null, score: this.stats.riskScore };
  }

  getStats() {
    return {
      ...this.stats,
      entriesToday: this.entriesToday,
      limits: {
        dailyLoss: config.DAILY_LOSS_LIMIT,
        maxTrades: config.MAX_TRADES_PER_DAY,
        consectuiveLimit: config.CONSECUTIVE_LOSS_LIMIT,
        heatLimit: config.MAX_PORTFOLIO_HEAT
      }
    };
  }

  reset() {
    this.entriesToday = 0;
    this.stats = {
      tradesToday: 0,
      dailyPnL: 0,
      consecutiveLosses: 0,
      maxDrawdownToday: 0,
      peakPnLToday: 0,
      portfolioHeat: 0,
      riskScore: 100,
      isKillSwitchActive: false,
      killReason: null,
    };
    this.saveState();
  }
}

export const riskEngine = new RiskEngine();
