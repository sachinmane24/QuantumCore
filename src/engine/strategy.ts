/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { marketEngine } from './market.ts';
import type { OptionChainData } from './types.ts';

export type StrategyMode = 'INST_SPREAD' | 'MOMENTUM_SNIPER';
export type StrategyType = 
  | 'NAKED_BUY' 
  | 'IRON_CONDOR' 
  | 'IRON_FLY' 
  | 'BUTTERFLY' 
  | 'RATIO_SPREAD' 
  | 'BULL_CALL_SPREAD' 
  | 'BEAR_PUT_SPREAD' 
  | 'BULL_PUT_SPREAD' 
  | 'BEAR_CALL_SPREAD' 
  | 'STRADDLE' 
  | 'STRANGLE' 
  | 'CALENDAR';

export interface StrategyScore {
  total: number;
  trend: number;
  oiBias: number;
  gamma: number;
  trap: number;
  timeFilter: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  biasReason: string;
  mode: StrategyMode;
  strategyType: StrategyType;
  recommendation: string;
}

class StrategyEngine {
  calculateScore(): StrategyScore {
    const spot = marketEngine.getSpotPrice();
    const chain = marketEngine.getOptionChain();
    const vix = marketEngine.getVix();

    // 1. Trend Sensitivity for Nifty - 25 points
    const atmStrike = Math.round(spot / 50) * 50;
    const diff = spot - atmStrike;
    let trendScore = 12.5;
    let trendDirection = 1; 
    
    // Nifty moves are significant even at 10-20 points
    if (Math.abs(diff) > 20) {
      trendScore = 25; 
      trendDirection = diff > 0 ? 1 : -1;
    } else if (Math.abs(diff) > 10) {
      trendScore = 20;
      trendDirection = diff > 0 ? 1 : -1;
    } else if (Math.abs(diff) > 0) {
      trendScore = 15;
      trendDirection = diff > 0 ? 1 : -1;
    }

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

    if (pcr > 1.2 || Math.abs(oiChangeBias) > 250000) oiBiasScore = 20;
    else if (pcr > 1.05 || Math.abs(oiChangeBias) > 80000) oiBiasScore = 15;
    else if (pcr < 0.8 || Math.abs(oiChangeBias) < -250000) oiBiasScore = 20;
    else if (pcr < 0.95 || Math.abs(oiChangeBias) < -80000) oiBiasScore = 15;

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

    // Expiry Context
    const expiryStatus = marketEngine.getExpiryStatus();
    const isExpiryDay = expiryStatus.isExpiryDay;
    const isMonthlyExpiry = expiryStatus.isMonthlyExpiry;
    const isMorningRange = totalMin >= 555 && totalMin < 630;
    const isAfternoonShift = totalMin >= 810;
    const isGammaBlastWindow = isExpiryDay && totalMin >= 825;

    // 6. Gap Analysis
    const gapPercent = marketEngine.getGapPercent();
    let gapBias = 0; // -1 to 1
    if (gapPercent > 0.3) gapBias = 1;
    else if (gapPercent < -0.3) gapBias = -1;

    // 7. Technical Indicators Analysis
    const indicators = marketEngine.getTechnicalIndicators();
    let techIndicatorScore = 0;
    
    // RSI Sentiment
    if (indicators.rsi > 70) {
      if (oiChangeBias > 0) techIndicatorScore -= 10; 
    } else if (indicators.rsi < 30) {
      if (oiChangeBias < 0) techIndicatorScore -= 10; 
    } else if (indicators.rsi > 50 && oiChangeBias > 0) {
      techIndicatorScore += 5; 
    } else if (indicators.rsi < 50 && oiChangeBias < 0) {
      techIndicatorScore += 5;
    }

    // MACD Histogram confirmation
    if (indicators.macd.histogram > 0 && oiChangeBias > 0) techIndicatorScore += 5;
    if (indicators.macd.histogram < 0 && oiChangeBias < 0) techIndicatorScore += 5;

    // Bollinger Band Constraint
    if (spot > indicators.bollinger.upper && oiChangeBias > 0) techIndicatorScore -= 5; 
    if (spot < indicators.bollinger.lower && oiChangeBias < 0) techIndicatorScore -= 5; 

    // 8. ORB & Trap Detection
    const { high: orbHigh, low: orbLow } = marketEngine.getORB();
    const vwap = marketEngine.getVWAP();
    let orbTrigger = 0; // 0: None, 1: Bullish, -1: Bearish
    let trapDetected = false;

    if (totalMin >= 560 && orbHigh > 0 && orbLow > 0) { 
      if (spot > orbHigh && spot > vwap && putOiChange > callOiChange) {
        orbTrigger = 1;
      } else if (spot < orbLow && spot < vwap && callOiChange > putOiChange) {
        orbTrigger = -1;
      }

      if (spot > orbHigh && putOiChange < callOiChange && Math.abs(diff) < 20) trapDetected = true;
      if (spot < orbLow && putOiChange > callOiChange && Math.abs(diff) < 20) trapDetected = true;
    }

    let total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore + techIndicatorScore;
    
    if (orbTrigger !== 0) total += 15;
    if (trapDetected) total -= 30;
    
    if (isExpiryDay) {
      if (isGammaBlastWindow && orbTrigger !== 0) total += 20; 
      if (isMorningRange) total += 5; 
      if (isAfternoonShift && isMonthlyExpiry) total -= 10; 
    }
    if (isObservationPeriod && total < 60) total = Math.min(total, 40);

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let biasReason = "Waiting for trend/OI confirmation";
    let mode: StrategyMode = 'INST_SPREAD';
    let strategyType: StrategyType = 'IRON_CONDOR';
    let recommendation = (isObservationPeriod && total < 60) ? "OBSERVATION PERIOD (9:00-9:30)" : "--";

    if (!isObservationPeriod || total >= 60) {
      const isStrongScore = total > 80;
      const isOrbConfirmed = orbTrigger !== 0 && total > 70;
      const isSideways = Math.abs(oiChangeBias) < 100000 && Math.abs(diff) < 10;
      const isHighVol = vix > 18;
      const isLowVol = vix < 12;

      // Determine Bias with higher sensitivity
      if (isSideways && total < 55) {
        bias = 'NEUTRAL';
        biasReason = "Sideways market with low OI shift";
      } else {
        if (orbTrigger === 1) {
          bias = 'BULLISH';
          biasReason = "ORB Breakout High confirmed by VWAP";
        } else if (orbTrigger === -1) {
          bias = 'BEARISH';
          biasReason = "ORB Breakdown Low confirmed by VWAP";
        } else {
          // Trend + OI Confirmation
          if (oiChangeBias > 80000) {
             bias = 'BULLISH';
             biasReason = "Put Writing Activity (+OI Change)";
          } else if (oiChangeBias < -80000) {
             bias = 'BEARISH';
             biasReason = "Call Writing Activity (-OI Change)";
          } else if (Math.abs(diff) > 12 || (Math.abs(marketEngine.getLatestTick().change || 0) > 0.25)) {
             // Pure Price Push / Significant Day Change if OI is lagging or neutral
             const priceChange = (marketEngine.getLatestTick().change || 0);
             bias = (diff > 0 || priceChange > 0) ? 'BULLISH' : 'BEARISH';
             biasReason = `Price Velocity Dominant (${diff > 0 ? 'Bullish' : 'Bearish'})`;
          } else {
             bias = 'NEUTRAL';
             biasReason = `Rangebound (OI Bias: ${oiChangeBias}, Spot Dist: ${diff.toFixed(1)})`;
          }
        }
      }

      // Selection Matrix
      if (bias === 'BULLISH') {
        if (isStrongScore || isOrbConfirmed) {
          if (isHighVol) {
             strategyType = 'RATIO_SPREAD';
             recommendation = "BULLISH RATIO SPREAD (SELL FAR OTM)";
          } else {
             strategyType = 'NAKED_BUY';
             recommendation = isGammaBlastWindow ? `GAMMA BLAST: NAKED CE BUY` : `NAKED ATM CE BUY (EXPLOSIVE)`;
          }
          mode = 'MOMENTUM_SNIPER';
        } else {
          strategyType = isHighVol ? 'BULL_PUT_SPREAD' : 'BULL_CALL_SPREAD';
          recommendation = isHighVol ? "BULL PUT SPREAD (CREDIT/H-IV)" : "BULL CALL SPREAD (DEBIT/L-IV)";
          mode = 'INST_SPREAD';
        }
      } else if (bias === 'BEARISH') {
        if (isStrongScore || isOrbConfirmed) {
          if (isHighVol) {
             strategyType = 'RATIO_SPREAD';
             recommendation = "BEARISH RATIO SPREAD (SELL FAR OTM)";
          } else {
             strategyType = 'NAKED_BUY';
             recommendation = isGammaBlastWindow ? `GAMMA BLAST: NAKED PE BUY` : `NAKED ATM PE BUY (EXPLOSIVE)`;
          }
          mode = 'MOMENTUM_SNIPER';
        } else {
          strategyType = isHighVol ? 'BEAR_CALL_SPREAD' : 'BEAR_PUT_SPREAD';
          recommendation = isHighVol ? "BEAR CALL SPREAD (CREDIT/H-IV)" : "BEAR PUT SPREAD (DEBIT/L-IV)";
          mode = 'INST_SPREAD';
        }
      } else {
        // Neutral Strategies
        mode = 'INST_SPREAD';
        if (isHighVol) {
          strategyType = total > 50 ? 'STRADDLE' : 'IRON_FLY';
          recommendation = total > 50 ? "LONG STRADDLE (VOL EXPANSION)" : "IRON FLY / STRADDLE (IV CRUSH)";
        } else if (isLowVol) {
          strategyType = 'CALENDAR';
          recommendation = "CALENDAR SPREAD (TIME DECAY)";
        } else {
          strategyType = total < 40 ? 'IRON_CONDOR' : 'BUTTERFLY';
          recommendation = total < 40 ? "IRON CONDOR (THETA DECAY)" : "BUTTERFLY (RANGE BOUND)";
        }
      }

      if (isExpiryDay && isAfternoonShift && mode === 'INST_SPREAD') {
        recommendation += " [MONTHLY ROLL-OVER RISK]";
      }
    }

    const oiBiasDirection = oiChangeBias > 75000 ? 1 : (oiChangeBias < -75000 ? -1 : 0);

    return {
      total: Math.round(total),
      trend: Math.round(trendScore * trendDirection), 
      oiBias: Math.round(oiBiasScore * oiBiasDirection), 
      gamma: Math.round(gammaScore),
      trap: trapDetected ? 0 : Math.round(trapScore),
      timeFilter: Math.round(timeFilterScore),
      bias,
      biasReason,
      mode,
      strategyType,
      recommendation
    };
  }
}

export const strategyEngine = new StrategyEngine();
