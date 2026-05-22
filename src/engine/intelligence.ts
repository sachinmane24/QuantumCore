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
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    totalScore: number = 70
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
    
    // Stop Loss Hunting Protection: 
    // We check the recent swing high/low and put our SL at least X points beyond it 
    // to avoid getting hunted in a liquidity sweep.
    const swings = marketEngine.getSwingLevels(30); 
    const huntingBuffer = Math.max(8, atr * 0.2); // Slightly increased buffer for Nifty
    
    let slPoints = 0;
    let targetPoints = 0;
    let riskRewardRatio = 1.5;

    if (strategyMode === 'MOMENTUM_SNIPER') {
      // Option Buying Logic
      // On expiry day, reduce SL because premium decay is brutal
      let expiryMultiplier = isExpiryDay ? 0.6 : 1.0;
      if (isMonthlyExpiry) expiryMultiplier = 0.75; // Monthly is slightly more stable

      // Base SL
      slPoints = atr * 1.5 * vixFactor * expiryMultiplier;
      
      // SL Hunting Mitigation
      if (bias === 'BULLISH') {
        const structuralSL = entrySpot - (swings.low - huntingBuffer);
        slPoints = Math.max(slPoints, structuralSL);
      } else if (bias === 'BEARISH') {
        const structuralSL = (swings.high + huntingBuffer) - entrySpot;
        slPoints = Math.max(slPoints, structuralSL);
      } else {
        const structuralSL = Math.max(entrySpot - (swings.low - huntingBuffer), (swings.high + huntingBuffer) - entrySpot);
        slPoints = Math.max(slPoints, structuralSL);
      }

      riskRewardRatio = isExpiryDay ? 3.5 : 2.5; // Improved RR for sniper
      
      // Afternoon Gamma Blast (Post 1:45 PM IST = 825 mins)
      if (isExpiryDay && totalMin >= 825) {
        riskRewardRatio = 5.5; 
        slPoints = Math.max(18, slPoints * 0.85); // Adjusted for better stability
      }

      slPoints = Math.min(isExpiryDay ? (isMonthlyExpiry ? 55 : 45) : 65, slPoints); // Slightly wider caps
      targetPoints = slPoints * riskRewardRatio;
      
      // Ensure target is at least 0.7% of Spot for Momentum to catch real moves
      targetPoints = Math.max(targetPoints, entrySpot * 0.007);
    } else {
      // Option Selling / Spread Logic
      let expiryMultiplier = isExpiryDay ? 1.4 : 1.0;
      if (isMonthlyExpiry) expiryMultiplier = 1.6;

      const vwapDist = Math.abs(entrySpot - vwap);
      const baseSL = Math.max(atr * 1.8 * vixFactor * expiryMultiplier, vwapDist + 25);
      
      // Structural SL Protection for selling
      if (bias === 'BULLISH') {
        const structuralSL = entrySpot - (swings.low - huntingBuffer * 2); 
        slPoints = Math.max(baseSL, structuralSL);
      } else if (bias === 'BEARISH') {
        const structuralSL = (swings.high + huntingBuffer * 2) - entrySpot;
        slPoints = Math.max(baseSL, structuralSL);
      } else {
        const structuralSL = Math.max(entrySpot - (swings.low - huntingBuffer * 2), (swings.high + huntingBuffer * 2) - entrySpot);
        slPoints = Math.max(baseSL, structuralSL);
      }

      riskRewardRatio = isExpiryDay ? 1.5 : 1.3; 
      
      // Max Pain Convergence Logic
      if (isExpiryDay && totalMin >= 810) {
        const maxPain = marketEngine.getMaxPain();
        const distToMaxPain = Math.abs(entrySpot - maxPain);
        if (distToMaxPain < 40) {
           slPoints *= 0.85; 
        }
      }

      targetPoints = slPoints * riskRewardRatio;
    }

    // Convert Points to Price Levels
    const stopLossPrice = bias === 'BULLISH' ? entrySpot - slPoints : (bias === 'BEARISH' ? entrySpot + slPoints : entrySpot - slPoints);
    const targetPrice = bias === 'BULLISH' ? entrySpot + targetPoints : (bias === 'BEARISH' ? entrySpot - targetPoints : entrySpot + targetPoints);

    // Convert Points to Rupees
    const deltaHedgeFactor = strategyMode === 'MOMENTUM_SNIPER' ? 0.7 : 0.45; 
    const stopLossRupees = Math.max(config.SL_RUPEES * 0.5, slPoints * deltaHedgeFactor * config.LOT_SIZE);
    const targetRupees = targetPoints * deltaHedgeFactor * config.LOT_SIZE;

    // Calculate Dynamic POP
    let pop = strategyMode === 'MOMENTUM_SNIPER' ? 38 : 65;
    const volatilityImpact = (15 - vix) * 1.5; // Lower VIX = Higher certainty
    const scoreBonus = (totalScore - 60) * 0.8;
    pop = Math.min(92, Math.max(5, pop + volatilityImpact + scoreBonus));

    return {
      stopLossPrice: Number(stopLossPrice.toFixed(2)),
      targetPrice: Number(targetPrice.toFixed(2)),
      stopLossRupees: Math.round(stopLossRupees),
      targetRupees: Math.round(targetRupees),
      riskRewardRatio,
      trailingSlTrigger: Math.round(targetRupees * 0.4), 
      atrValue: Number(atr.toFixed(2)),
      vixFactor: Number(vixFactor.toFixed(2)),
      pop: Math.round(pop),
      maxProfit: strategyMode === 'MOMENTUM_SNIPER' ? undefined : 2500, 
      maxLoss: strategyMode === 'MOMENTUM_SNIPER' ? slPoints * 75 : 5500
    };
  }

  private calculateATR(): number {
    // Attempt to use real market swings first
    const swings = marketEngine.getSwingLevels(50);
    const swingRange = swings.high - swings.low;
    if (swingRange > 0 && swingRange < 500) {
      return swingRange / 4; // ATR approx from recent channel
    }

    // Fallback: uses historical candles / VIX expectancy
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
    // Stage 1: Move to Break-even once 30% target reached
    if (currentPnL >= params.targetRupees * 0.30) {
      // Lock at least 15% of target once 30% hit
      const floor = params.targetRupees * 0.15;
      return Math.max(-params.stopLossRupees, floor);
    }

    // Stage 2: Move to 40% lock once 60% target reached
    if (currentPnL >= params.targetRupees * 0.60) {
      return params.targetRupees * 0.40;
    }

    // Stage 3: Move to 70% lock once 90% target reached
    if (currentPnL >= params.targetRupees * 0.90) {
        return params.targetRupees * 0.70;
    }

    return -params.stopLossRupees;
  }
}

export const intelligenceEngine = new IntelligenceEngine();
