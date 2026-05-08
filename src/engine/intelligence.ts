/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config';
import { marketEngine } from './market';

export interface TradeParams {
  stopLossPrice: number;
  targetPrice: number;
  stopLossRupees: number;
  targetRupees: number;
  riskRewardRatio: number;
  trailingSlTrigger: number;
  atrValue: number;
  vixFactor: number;
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
    strategyMode: 'MOMENTUM_SNIPER' | 'INSTITUTIONAL_SPREAD',
    entrySpot: number,
    bias: 'BULLISH' | 'BEARISH'
  ): TradeParams {
    const vix = marketEngine.getVix();
    const atr = this.calculateATR() || (entrySpot * 0.0025); // Baseline 0.25% if no ATR
    const vwap = marketEngine.getVWAP();
    
    // Expiry Day Logic (Nifty expires on Thursday)
    const isExpiryDay = new Date().getDay() === 4; // 4 = Thursday
    
    // VIX Factor: Higher VIX = Wider SL, Lower VIX = Tighter SL
    const vixFactor = Math.max(0.8, Math.min(1.5, vix / 15));
    
    let slPoints = 0;
    let targetPoints = 0;
    let riskRewardRatio = 1.5;

    if (strategyMode === 'MOMENTUM_SNIPER') {
      // Option Buying Logic
      // On expiry day, reduce SL because premium decay is brutal
      const expiryMultiplier = isExpiryDay ? 0.7 : 1.0;
      slPoints = atr * 1.2 * vixFactor * expiryMultiplier;
      riskRewardRatio = isExpiryDay ? 3.0 : 2.0; // Higher RR needed on expiry to offset decay
      
      slPoints = Math.min(isExpiryDay ? 30 : 45, slPoints);
      targetPoints = slPoints * riskRewardRatio;
    } else {
      // Option Selling / Spread Logic
      // On expiry day, increase buffer to avoid gamma spikes
      const expiryMultiplier = isExpiryDay ? 1.3 : 1.0;
      const vwapDist = Math.abs(entrySpot - vwap);
      slPoints = Math.max(atr * 1.5 * vixFactor * expiryMultiplier, vwapDist + 10);
      riskRewardRatio = 1.2; 
      
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
      vixFactor: Number(vixFactor.toFixed(2))
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
