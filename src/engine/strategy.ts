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

export interface StandardStrategyInfo {
  name: 'Buy CE' | 'Buy PE' | 'Sell CE' | 'Sell PE' | 'Bull Call Spread' | 'Bear Put Spread' | 'Iron Condor';
  category: 'Option Buying' | 'Option Selling' | 'Safer Spread Strategies';
  biasText: 'Bullish' | 'Bearish' | 'Bearish/Neutral' | 'Bullish/Neutral';
}

export function getStandardStrategy(strategyType: StrategyType, bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): StandardStrategyInfo {
  if (strategyType === 'BULL_CALL_SPREAD') {
    return { name: 'Bull Call Spread', category: 'Safer Spread Strategies', biasText: 'Bullish' };
  }
  if (strategyType === 'BEAR_PUT_SPREAD') {
    return { name: 'Bear Put Spread', category: 'Safer Spread Strategies', biasText: 'Bearish' };
  }
  if (strategyType === 'IRON_CONDOR' || strategyType === 'IRON_FLY' || strategyType === 'BUTTERFLY' || strategyType === 'CALENDAR') {
    return { name: 'Iron Condor', category: 'Safer Spread Strategies', biasText: 'Bearish/Neutral' };
  }
  
  if (strategyType === 'NAKED_BUY' || strategyType === 'STRADDLE' || strategyType === 'STRANGLE') {
    if (bias === 'BULLISH') {
      return { name: 'Buy CE', category: 'Option Buying', biasText: 'Bullish' };
    } else {
      return { name: 'Buy PE', category: 'Option Buying', biasText: 'Bearish' };
    }
  }

  // Selling options
  if (strategyType === 'BEAR_CALL_SPREAD' || (strategyType === 'RATIO_SPREAD' && bias === 'BEARISH')) {
    return { name: 'Sell CE', category: 'Option Selling', biasText: 'Bearish/Neutral' };
  }
  
  if (strategyType === 'BULL_PUT_SPREAD' || (strategyType === 'RATIO_SPREAD' && bias === 'BULLISH')) {
    return { name: 'Sell PE', category: 'Option Selling', biasText: 'Bullish/Neutral' };
  }

  // Fallback default
  if (bias === 'BULLISH') {
    return { name: 'Buy CE', category: 'Option Buying', biasText: 'Bullish' };
  } else if (bias === 'BEARISH') {
    return { name: 'Buy PE', category: 'Option Buying', biasText: 'Bearish' };
  } else {
    return { name: 'Iron Condor', category: 'Safer Spread Strategies', biasText: 'Bearish/Neutral' };
  }
}

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
  standardStrategy: StandardStrategyInfo;
  recommendation: string;
  trendScore: number;
  oiBiasScore: number;
  gammaScore: number;
  timeFilterScore: number;
  oiChangeBias: number;
  ivRank: number | null;
  ivPercentile: number | null;
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

    if (pcr > 1.2 || oiChangeBias > 250000) oiBiasScore = 20;
    else if (pcr > 1.05 || oiChangeBias > 80000) oiBiasScore = 15;
    else if (pcr < 0.8 || oiChangeBias < -250000) oiBiasScore = 20;
    else if (pcr < 0.95 || oiChangeBias < -80000) oiBiasScore = 15;

    // 3. Gamma Condition (VIX based) - 15 points
    const gammaScore = Math.min(15, Math.max(0, 25 - vix));

    // 4. Trap Presence (OI Change Concentration) - 20 points
    const trapScore = (Math.abs(oiChangeBias) > 2000000) ? 5 : 20;

    // Robust IST Date Calculation Helper
    const getISTDate = () => {
      const now = new Date();
      const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      return {
        hours: istDate.getUTCHours(),
        minutes: istDate.getUTCMinutes()
      };
    };

    // 5. Time Filter - 20 points (Execution Timing)
    const istTime = getISTDate();
    const istHour = istTime.hours;
    const istMin = istTime.minutes;
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

    // Dynamic Support and Resistance Strike levels from the option chain
    let maxCeOiVal = -1;
    let maxCeOiStrike = atmStrike;
    let maxPeOiVal = -1;
    let maxPeOiStrike = atmStrike;

    chain.forEach(c => {
      if ((c.ce_oi || 0) > maxCeOiVal) {
        maxCeOiVal = c.ce_oi || 0;
        maxCeOiStrike = c.strike;
      }
      if ((c.pe_oi || 0) > maxPeOiVal) {
        maxPeOiVal = c.pe_oi || 0;
        maxPeOiStrike = c.strike;
      }
    });

    const support = maxPeOiStrike;
    const resistance = maxCeOiStrike;

    const distToSupport = spot - support;
    const distToResistance = resistance - spot;

    const isNearSupport = distToSupport <= 30 && distToSupport >= -10;
    const isNearResistance = distToResistance <= 30 && distToResistance >= -10;

    let total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore + techIndicatorScore;
    
    if (orbTrigger !== 0) total += 15;
    if (trapDetected) total -= 30;
    if (isNearSupport || isNearResistance) total += 15; // Score premium for trading near core ranges
    
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

    if (!isObservationPeriod || total >= 55) {
      const isStrongScore = total > 75; // Lowered from 80 for better reactivity
      const isOrbConfirmed = orbTrigger !== 0 && total > 65; // Lowered from 70
      const isSideways = Math.abs(oiChangeBias) < 80000 && Math.abs(diff) < 8;
      // IV-rank-aware vol regime: prefer rank when we have enough samples,
      // otherwise fall back to absolute VIX thresholds for warm-up.
      const ivRank = marketEngine.getIVRank();
      const isHighVol = ivRank !== null ? ivRank > 70 : vix > 18;
      const isLowVol = ivRank !== null ? ivRank < 30 : vix < 12;

      // 1. Determine Trend Candidate Bias with high sensitivity
      let candidateBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
      let candidateReason = "";

      if (isNearSupport) {
         candidateBias = 'BULLISH';
         candidateReason = `Dynamic OI Support Floor Reached (Floor: ₹${support}, Dist: ${distToSupport.toFixed(1)})`;
      } else if (isNearResistance) {
         candidateBias = 'BEARISH';
         candidateReason = `Dynamic OI Resistance Ceiling Reached (Ceiling: ₹${resistance}, Dist: ${distToResistance.toFixed(1)})`;
      } else if (isSideways && total < 52) {
        candidateBias = 'NEUTRAL';
        candidateReason = "Sideways market with low OI shift";
      } else {
        if (orbTrigger === 1) {
          candidateBias = 'BULLISH';
          candidateReason = "ORB Breakout High confirmed by VWAP";
        } else if (orbTrigger === -1) {
          candidateBias = 'BEARISH';
          candidateReason = "ORB Breakdown Low confirmed by VWAP";
        } else {
          // Trend + OI Confirmation
          if (oiChangeBias > 75000) {
             candidateBias = 'BULLISH';
             candidateReason = "Strong Put Writing (+OI Change)";
          } else if (oiChangeBias < -75000) {
             candidateBias = 'BEARISH';
             candidateReason = "Strong Call Writing (-OI Change)";
          } else if (Math.abs(diff) > 8 || (Math.abs(marketEngine.getLatestTick()?.change || 0) > 0.18)) {
             // Pure Price Push / Significant Day Change if OI is lagging or neutral
             const priceChange = (marketEngine.getLatestTick()?.change || 0);
             const momentumFactor = Math.abs(diff) / 4; 
             const macdConfirm = (indicators.macd.histogram || 0) > 0 ? 'BULLISH' : 'BEARISH';
             const vixCooling = (marketEngine.getVixDelta() || 0) < 0;
             
             // If price is up but VIX is spiking and MACD is bearish, stay NEUTRAL or cautious
             if (priceChange > 0 && indicators.macd.histogram && indicators.macd.histogram < -2 && !vixCooling) {
                candidateBias = 'NEUTRAL';
                candidateReason = "Price Up but Bearish Divergence (MACD/VIX Spike)";
             } else {
                candidateBias = (diff > 0 || priceChange > 0) ? 'BULLISH' : 'BEARISH';
                candidateReason = `Price Velocity Dominant (${candidateBias}) - Momentum: ${momentumFactor.toFixed(1)} [${macdConfirm}]`;
             }
          } else {
             candidateBias = 'NEUTRAL';
             candidateReason = `Rangebound (OI Bias: ${oiChangeBias}, Spot Dist: ${diff.toFixed(1)})`;
          }
        }
      }

      // 2. Trend Pullback & Bollinger Reversal Confluence Engine (Anti-Chasing Rules)
      const prices = marketEngine.getPriceHistory();
      const computeEMA = (data: number[], period: number) => {
        if (data.length === 0) return spot;
        if (data.length < period) return data[data.length - 1];
        const k = 2 / (period + 1);
        let ema = data[data.length - period];
        for (let i = data.length - period + 1; i < data.length; i++) {
          ema = (data[i] * k) + (ema * (1 - k));
        }
        return ema;
      };

      const ema20 = computeEMA(prices, 20);
      const vwap = marketEngine.getVWAP();

      const prevSpot = prices.length >= 2 ? prices[prices.length - 2] : spot;
      const prevSpot2 = prices.length >= 3 ? prices[prices.length - 3] : prevSpot;

      const isSlightBullishSlope = spot > prevSpot || spot > prevSpot2;
      const isSlightBearishSlope = spot < prevSpot || spot < prevSpot2;

      if (candidateBias === 'BULLISH') {
        const chaseThreshold = 18; // Trigger point where we consider price has flown too far from baseline EMA/VWAP
        const isFarAbove = spot > vwap + chaseThreshold && spot > ema20 + chaseThreshold;
        const isBollingerExhausted = spot > indicators.bollinger.upper;

        if (isFarAbove || isBollingerExhausted) {
          // Exceeds safe boundaries, suppress entry to avoid buying the peak
          bias = 'NEUTRAL';
          biasReason = `Suppress Chasing: Spot (₹${spot.toFixed(1)}) is far from EMA20/VWAP (₹${ema20.toFixed(1)}/₹${vwap.toFixed(1)}). Awaiting Pullback.`;
        } else {
          // Check if spot has compressed down into the active confluence zone
          const isNearEmaOrVwap = Math.abs(spot - ema20) <= 15 || Math.abs(spot - vwap) <= 15 || (spot >= Math.min(ema20, vwap) - 10 && spot <= Math.max(ema20, vwap) + 12);
          const isNearLowerBollinger = spot <= indicators.bollinger.lower + 12;

          if (isNearEmaOrVwap || isNearLowerBollinger) {
            if (isSlightBullishSlope) {
              bias = 'BULLISH';
              const source = isNearEmaOrVwap ? "EMA20/VWAP Confluence" : "Bollinger Extreme Reversal";
              biasReason = `Early Pullback Trigger: Met ${source} zone with rise continuation & volume confirmation.`;
            } else {
              bias = 'NEUTRAL';
              biasReason = `Zone Confluence: Price is in Pullback Zone (EMA20/VWAP). Waiting for upward resumption.`;
            }
          } else {
            // normal breathing territory
            if (isSlightBullishSlope) {
              bias = 'BULLISH';
              biasReason = `${candidateReason} (Anti-Chase Entry active)`;
            } else {
              bias = 'NEUTRAL';
              biasReason = "Waiting for trend resumption";
            }
          }
        }
      } else if (candidateBias === 'BEARISH') {
        const chaseThreshold = 18;
        const isFarBelow = spot < vwap - chaseThreshold && spot < ema20 - chaseThreshold;
        const isBollingerExhausted = spot < indicators.bollinger.lower;

        if (isFarBelow || isBollingerExhausted) {
          bias = 'NEUTRAL';
          biasReason = `Suppress Chasing: Spot (₹${spot.toFixed(1)}) is far from EMA20/VWAP (₹${ema20.toFixed(1)}/₹${vwap.toFixed(1)}). Awaiting Pullback.`;
        } else {
          const isNearEmaOrVwap = Math.abs(spot - ema20) <= 15 || Math.abs(spot - vwap) <= 15 || (spot >= Math.min(ema20, vwap) - 12 && spot <= Math.max(ema20, vwap) + 10);
          const isNearUpperBollinger = spot >= indicators.bollinger.upper - 12;

          if (isNearEmaOrVwap || isNearUpperBollinger) {
            if (isSlightBearishSlope) {
              bias = 'BEARISH';
              const source = isNearEmaOrVwap ? "EMA20/VWAP Confluence" : "Bollinger Extreme Reversal";
              biasReason = `Early Pullback Trigger: Met ${source} zone with fall continuation & volume confirmation.`;
            } else {
              bias = 'NEUTRAL';
              biasReason = `Zone Confluence: Price is in Pullback Zone (EMA20/VWAP). Waiting for downward resumption.`;
            }
          } else {
            if (isSlightBearishSlope) {
              bias = 'BEARISH';
              biasReason = `${candidateReason} (Anti-Chase Entry active)`;
            } else {
              bias = 'NEUTRAL';
              biasReason = "Waiting for trend resumption";
            }
          }
        }
      } else {
        bias = 'NEUTRAL';
        biasReason = candidateReason;
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
        // Neutral Strategies — sell premium when IV-rank is rich, buy when cheap.
        mode = 'INST_SPREAD';
        if (isHighVol) {
          // High IV rank → SELL premium (collect inflated theta). Iron fly for ATM neutrality.
          strategyType = 'IRON_FLY';
          recommendation = `IRON FLY (SELL RICH IV${ivRank !== null ? ` — RANK ${Math.round(ivRank)}` : ''})`;
        } else if (isLowVol) {
          // Low IV rank → BUY premium (vol expansion play). Long straddle/calendar.
          strategyType = total > 50 ? 'STRADDLE' : 'CALENDAR';
          recommendation = total > 50
            ? `LONG STRADDLE (CHEAP IV${ivRank !== null ? ` — RANK ${Math.round(ivRank)}` : ''})`
            : `CALENDAR SPREAD (TIME DECAY)`;
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
      standardStrategy: getStandardStrategy(strategyType, bias),
      recommendation,
      trendScore: Math.round(trendScore),
      oiBiasScore: Math.round(oiBiasScore),
      gammaScore: Math.round(gammaScore),
      timeFilterScore: Math.round(timeFilterScore),
      oiChangeBias: Math.round(oiChangeBias),
      ivRank: marketEngine.getIVRank(),
      ivPercentile: marketEngine.getIVPercentile()
    };
  }
}

export const strategyEngine = new StrategyEngine();
