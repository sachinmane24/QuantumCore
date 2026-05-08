/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { marketEngine } from './market.ts';
import type { OptionChainData } from './market.ts';

export type StrategyMode = 'INST_SPREAD' | 'MOMENTUM_SNIPER';

export interface StrategyScore {
  total: number;
  trend: number;
  oiBias: number;
  gamma: number;
  trap: number;
  timeFilter: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  mode: StrategyMode;
  recommendation: string;
}

class StrategyEngine {
  calculateScore(): StrategyScore {
    const spot = marketEngine.getSpotPrice();
    const chain = marketEngine.getOptionChain();
    const vix = marketEngine.getVix();

    // 1. Trend (Spot vs ATM Strike) - 25 points
    const atmStrike = Math.round(spot / 50) * 50;
    const diff = spot - atmStrike;
    let trendScore = 12.5;
    let trendDirection = 1; // 1 for Bullish, -1 for Bearish
    
    if (diff > 5) trendScore = 25; 
    else if (diff > 0) trendScore = 15;
    else if (diff < -5) { trendScore = 25; trendDirection = -1; }
    else if (diff < 0) { trendScore = 8; trendDirection = -1; }

    // 2. OI Bias - 20 points
    let callOi = 0;
    let putOi = 0;
    let callOiChange = 0;
    let putOiChange = 0;
    
    chain.forEach(c => {
      callOi += c.ce_oi || 0;
      putOi += c.pe_oi || 0;
      callOiChange += c.ce_oi_change || 0;
      putOiChange += c.pe_oi_change || 0;
    });

    const pcr = callOi > 0 ? putOi / callOi : 1.0;
    const oiChangeBias = putOiChange - callOiChange;
    
    let oiBiasScore = 10;
    let oiDirection = oiChangeBias >= 0 ? 1 : -1;

    if (pcr > 1.3 || Math.abs(oiChangeBias) > 500000) oiBiasScore = 20;
    else if (pcr > 1.1 || Math.abs(oiChangeBias) > 200000) oiBiasScore = 15;
    else if (pcr < 0.7 || Math.abs(oiChangeBias) < -500000) oiBiasScore = 20;
    else if (pcr < 0.9 || Math.abs(oiChangeBias) < -200000) oiBiasScore = 15;

    // 3. Gamma Condition (VIX based) - 15 points
    const gammaScore = Math.min(15, Math.max(0, 25 - vix));

    // 4. Trap Presence (OI Change Concentration) - 20 points
    const trapScore = (Math.abs(oiChangeBias) > 2000000) ? 5 : 20;

    // 5. Time Filter - 20 points (Execution Timing)
    const istTime = new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const istDate = new Date(istTime);
    const istHour = istDate.getHours();
    const istMin = istDate.getMinutes();
    const totalMin = istHour * 60 + istMin;
    
    // Observation Period: 9:00 to 9:30 AM IST (540 to 570 mins)
    const isObservationPeriod = totalMin >= 540 && totalMin < 570;
    const timeFilterScore = (totalMin >= 555 && totalMin <= 930) ? 20 : 5;

    // 6. Gap Analysis
    const gapPercent = marketEngine.getGapPercent();
    let gapBias = 0; // -1 to 1
    if (gapPercent > 0.3) gapBias = 1;
    else if (gapPercent < -0.3) gapBias = -1;

    // 7. ORB & Trap Detection
    const { high: orbHigh, low: orbLow } = marketEngine.getORB();
    const vwap = marketEngine.getVWAP();
    let orbTrigger = 0; // 0: None, 1: Bullish, -1: Bearish
    let trapDetected = false;

    if (totalMin >= 570) { // After 9:30 AM
      if (spot > orbHigh && spot > vwap && putOiChange > callOiChange) {
        orbTrigger = 1;
      } else if (spot < orbLow && spot < vwap && callOiChange > putOiChange) {
        orbTrigger = -1;
      }

      // Simple Trap Detection: Price breaks high but OI shift is opposite
      if (spot > orbHigh && putOiChange < callOiChange) trapDetected = true;
      if (spot < orbLow && putOiChange > callOiChange) trapDetected = true;
    }

    let total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore;
    
    // Bonus for ORB alignment
    if (orbTrigger !== 0) total += 15;
    // Penalty for Trap
    if (trapDetected) total -= 30;
    // Observation period constraint
    if (isObservationPeriod) total = Math.min(total, 40);

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let mode: StrategyMode = 'INST_SPREAD';
    let recommendation = isObservationPeriod ? "OBSERVATION PERIOD (9:00-9:30)" : "--";

    if (!isObservationPeriod) {
      // Significantly increased thresholds for Naked Option Buying (MOMENTUM_SNIPER)
      // Base threshold increased from 75 -> 85
      // ORB assisted threshold increased from 60 -> 75
      const isStrongScore = total > 85;
      const isOrbConfirmed = orbTrigger !== 0 && total > 75;
      
      if (isStrongScore || isOrbConfirmed) {
        mode = 'MOMENTUM_SNIPER';
        
        // Ensure strong bias alignment for naked buying
        // Requires at least 400k OI difference or ORB trigger
        const significantOiBias = Math.abs(oiChangeBias) > 400000;
        
        if (orbTrigger === 1) {
          bias = 'BULLISH';
        } else if (orbTrigger === -1) {
          bias = 'BEARISH';
        } else {
          bias = oiChangeBias > 100000 ? 'BULLISH' : oiChangeBias < -100000 ? 'BEARISH' : 'NEUTRAL';
        }
        
        // Final sanity check for naked buying: 
        // 1. Must not be NEUTRAL bias
        // 2. If no ORB, must have significant OI bias and extreme score
        if (bias === 'NEUTRAL' || (orbTrigger === 0 && (!significantOiBias || total < 90))) {
          mode = 'INST_SPREAD'; // Demote to spread if logic isn't "Extreme" or bias is fuzzy
          bias = oiChangeBias > 0 ? 'BULLISH' : 'BEARISH';
        }
        
        recommendation = mode === 'MOMENTUM_SNIPER' 
          ? `BUY NAKED ${atmStrike} ${bias === 'BULLISH' ? 'CE' : 'PE'} ${orbTrigger !== 0 ? '(ORB CONFIRMED)' : '(HIGH MOMENTUM)'}`
          : `${atmStrike} ${bias === 'BULLISH' ? 'BULL SPREAD' : 'BEAR SPREAD'} (CONSOLIDATION BIAS)`;
      } else if (total > 55) {
        mode = 'INST_SPREAD';
        bias = oiChangeBias > 0 ? 'BULLISH' : 'BEARISH';
        recommendation = `${atmStrike} ${bias === 'BULLISH' ? 'BULL SPREAD' : 'BEAR SPREAD'}`;
      } else {
        mode = 'INST_SPREAD';
        bias = 'NEUTRAL';
        recommendation = trapDetected ? 'TRAP DETECTED - STANDBY' : 'VOLATILITY LOW - STANDBY';
      }
    }

    return {
      total: Math.round(total),
      trend: Math.round(trendScore * trendDirection), // SIGNED
      oiBias: Math.round(oiBiasScore * oiDirection), // SIGNED
      gamma: Math.round(gammaScore),
      trap: trapDetected ? 0 : Math.round(trapScore),
      timeFilter: Math.round(timeFilterScore),
      bias,
      mode,
      recommendation
    };
  }
}

export const strategyEngine = new StrategyEngine();
