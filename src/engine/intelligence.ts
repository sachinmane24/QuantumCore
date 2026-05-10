/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import { marketEngine } from './market.ts';

export interface TradeParams {
  stopLossPrice: number;
  targetPrice: number;
  stopLossRupees: number;
  targetRupees: number;
  riskRewardRatio: number;
  trailingSlTrigger: number;
  atrValue: number;
  vixFactor: number;
  pop?: number;
  maxProfit?: number;
  maxLoss?: number;
}

class IntelligenceEngine {
  private atrPeriod = 14;
  private recentHighs: number[] = [];
  private recentLows: number[] = [];
  private recentCloses: number[] = [];

  /**
   * Derives Stop Loss and Target based on Market Conditions
   */
  public deriveParams(
    side: 'BUY' | 'SELL',
    strategyMode: 'MOMENTUM_SNIPER' | 'INST_SPREAD',
    entrySpot: number,
    bias: 'BULLISH' | 'BEARISH'
  ): TradeParams {
    const vix = marketEngine.getVix();
    const atr = this.calculateATR() || (entrySpot * 0.0025); // Baseline 0.25% if no ATR
    const vwap = marketEngine.getVWAP();
    
    // Expiry Day Logic
    const expiryStatus = marketEngine.getExpiryStatus();
    const isExpiryDay = expiryStatus.isExpiryDay;
    const isMonthlyExpiry = expiryStatus.isMonthlyExpiry;

    const istTime = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const hours = istTime.getUTCHours();
    const minutes = istTime.getUTCMinutes();
    const totalMin = hours * 60 + minutes;
    
    // VIX Factor: Higher VIX = Wider SL, Lower VIX = Tighter SL
    const vixFactor = Math.max(0.8, Math.min(1.5, vix / 15));
    
    let slPoints = 0;
    let targetPoints = 0;
    let riskRewardRatio = 1.5;

    if (strategyMode === 'MOMENTUM_SNIPER') {
      // Option Buying Logic
      // On expiry day, reduce SL because premium decay is brutal
      let expiryMultiplier = isExpiryDay ? 0.6 : 1.0;
      if (isMonthlyExpiry) expiryMultiplier = 0.75; // Monthly is slightly more stable

      slPoints = atr * 1.2 * vixFactor * expiryMultiplier;
      riskRewardRatio = isExpiryDay ? 3.5 : 2.0; // Extremely high RR needed on expiry
      
      // Afternoon Gamma Blast (Post 1:45 PM IST = 825 mins)
      if (isExpiryDay && totalMin >= 825) {
        riskRewardRatio = 5.0; // Targeting explosive moves
        slPoints = Math.max(15, slPoints * 0.8); // Tighter SL for scalps
      }

      slPoints = Math.min(isExpiryDay ? (isMonthlyExpiry ? 35 : 25) : 45, slPoints);
      targetPoints = slPoints * riskRewardRatio;
    } else {
      // Option Selling / Spread Logic
      // On expiry day, increase buffer to avoid gamma spikes
      let expiryMultiplier = isExpiryDay ? 1.4 : 1.0;
      if (isMonthlyExpiry) expiryMultiplier = 1.6; // Monthly roll-over risk is higher

      const vwapDist = Math.abs(entrySpot - vwap);
      slPoints = Math.max(atr * 1.5 * vixFactor * expiryMultiplier, vwapDist + 15);
      riskRewardRatio = 1.2; 
      
      // Max Pain Convergence Logic (Post 1:30 PM IST = 810 mins)
      if (isExpiryDay && totalMin >= 810) {
        const maxPain = marketEngine.getMaxPain();
        const distToMaxPain = Math.abs(entrySpot - maxPain);
        if (distToMaxPain < 30) {
           slPoints *= 0.8; // High confidence if already near Max Pain
        }
      }

      targetPoints = slPoints * riskRewardRatio;
    }

    // Convert Points to Price Levels
    const stopLossPrice = bias === 'BULLISH' ? entrySpot - slPoints : entrySpot + slPoints;
    const targetPrice = bias === 'BULLISH' ? entrySpot + targetPoints : entrySpot - targetPoints;

    // Convert Points to Rupees (Approximate impact on PnL for the whole strategy)
    // Note: Options have Delta. If Nifty moves 50 pts, ATM CE moves ~25 pts.
    // For simplicity, we use an aggregate delta heuristic.
    const deltaHedgeFactor = strategyMode === 'MOMENTUM_SNIPER' ? 0.6 : 0.3; // Delta impact
    const stopLossRupees = slPoints * deltaHedgeFactor * config.LOT_SIZE;
    const targetRupees = targetPoints * deltaHedgeFactor * config.LOT_SIZE;

    return {
      stopLossPrice: Number(stopLossPrice.toFixed(2)),
      targetPrice: Number(targetPrice.toFixed(2)),
      stopLossRupees: Math.round(stopLossRupees),
      targetRupees: Math.round(targetRupees),
      riskRewardRatio,
      trailingSlTrigger: Math.round(targetRupees * 0.4), // Start trailing after 40% target achieved
      atrValue: Number(atr.toFixed(2)),
      vixFactor: Number(vixFactor.toFixed(2)),
      pop: strategyMode === 'MOMENTUM_SNIPER' ? 38 : 65, // Standard probabilities for these styles
      maxProfit: strategyMode === 'MOMENTUM_SNIPER' ? undefined : 2000, // Heuristic for spreads
      maxLoss: strategyMode === 'MOMENTUM_SNIPER' ? slPoints * 65 : 4500
    };
  }

  private calculateATR(): number {
    // In a real data scenario, this uses historical candles.
    // In mock, we derive it from VIX expectancy
    const vix = marketEngine.getVix();
    const spot = marketEngine.getSpotPrice();
    // Daily range expectancy: Spot * (VIX / 100) / sqrt(252)
    const dailyExpectedRange = (spot * (vix / 100)) / 15.87;
    // Hourly ATR is roughly 1/4th of daily range
    return dailyExpectedRange / 4;
  }

  /**
   * Intelligence for Trailing Stop Loss
   */
  public calculateTrailingSL(
    currentPnL: number,
    peakPnL: number,
    params: TradeParams
  ): number {
    if (currentPnL < params.trailingSlTrigger) return -params.stopLossRupees;

    // Implementation of aggressive trailing:
    // Move SL to Cost once 50% target hit
    // Then trail at 20% of current profit
    if (currentPnL >= params.targetRupees * 0.5) {
      const lockAmount = Math.max(0, currentPnL - (params.targetRupees * 0.2));
      return lockAmount;
    }

    return -params.stopLossRupees;
  }
}

export const intelligenceEngine = new IntelligenceEngine();
