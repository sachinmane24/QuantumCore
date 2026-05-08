/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config';
import { Position } from './execution';

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

  private dailyHistory: { pnl: number; timestamp: number }[] = [];

  updatePnL(currentPnL: number, positions: Position[]) {
    this.stats.dailyPnL = currentPnL;
    
    // Track Drawdown
    if (currentPnL > this.stats.peakPnLToday) {
      this.stats.peakPnLToday = currentPnL;
    }
    const drawdown = this.stats.peakPnLToday - currentPnL;
    this.stats.maxDrawdownToday = Math.max(this.stats.maxDrawdownToday, drawdown);

    // Calculate Portfolio Heat
    // Simplified: (Total Qty * Spot) / Capital
    // For now, let's use a rough risk per position
    const totalRisk = positions.length * config.SL_RUPEES;
    this.stats.portfolioHeat = Number(((totalRisk / config.CAPITAL_BASE) * 100).toFixed(2));

    this.calculateRiskScore(positions);
    this.checkThresholds();
  }

  recordTradeResult(pnl: number) {
    this.stats.tradesToday++;
    if (pnl < 0) {
      this.stats.consecutiveLosses++;
    } else {
      this.stats.consecutiveLosses = 0;
    }
    this.checkThresholds();
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

  private checkThresholds() {
    if (this.stats.isKillSwitchActive) return;

    if (this.stats.dailyPnL <= -config.DAILY_LOSS_LIMIT) {
      this.activateKillSwitch('Daily Loss Limit Exceeded');
    } else if (this.stats.tradesToday >= config.MAX_TRADES_PER_DAY) {
      this.activateKillSwitch('Max Trades Per Day Reached');
    } else if (this.stats.consecutiveLosses >= config.CONSECUTIVE_LOSS_LIMIT) {
      this.activateKillSwitch('Consecutive Loss Limit Reached');
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
  }

  validateEntry(qty: number, expectedSL: number): { allowed: boolean; reason: string | null; score: number } {
    if (this.stats.isKillSwitchActive) {
      return { allowed: false, reason: `Kill Switch Active: ${this.stats.killReason}`, score: this.stats.riskScore };
    }

    // Time Check
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    if (timeStr < config.START_TIME || timeStr > config.END_TIME) {
      return { allowed: false, reason: `Outside Trading Hours (${config.START_TIME}-${config.END_TIME})`, score: this.stats.riskScore };
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

    return { allowed: true, reason: null, score: this.stats.riskScore };
  }

  getStats() {
    return {
      ...this.stats,
      limits: {
        dailyLoss: config.DAILY_LOSS_LIMIT,
        maxTrades: config.MAX_TRADES_PER_DAY,
        consectuiveLimit: config.CONSECUTIVE_LOSS_LIMIT,
        heatLimit: config.MAX_PORTFOLIO_HEAT
      }
    };
  }

  reset() {
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
  }
}

export const riskEngine = new RiskEngine();
