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

// Signal vote — one row per indicator, shown in the UI for transparency
export interface SignalVote {
  name: string;
  vote: 'UP' | 'DOWN' | 'NEUTRAL';
  weight: number;
}

// Output of predictMovement() — probabilities always sum to 100
export interface MovementPrediction {
  up:        number;                           // % probability of upward move
  down:      number;                           // % probability of downward move
  sideways:  number;                           // % probability of sideways / range
  direction: 'UP' | 'DOWN' | 'SIDEWAYS';      // dominant direction
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';      // how decisive the signal mix is
  magnitude:  'EXPLOSIVE' | 'MODERATE' | 'CONTAINED';  // expected move character
  signals:   SignalVote[];                     // only non-neutral votes shown
  disclaimer: string;
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
  movementPrediction: MovementPrediction;
}

class StrategyEngine {
  // Cache so the execution-state endpoint can read the latest prediction
  // without triggering a redundant calculateScore() call.
  private lastMovementPrediction: MovementPrediction | null = null;

  getLastMovementPrediction(): MovementPrediction | null {
    return this.lastMovementPrediction;
  }

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
      const isHighVol = vix > 18;
      const isLowVol = vix < 12;

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

    // ── Movement Prediction ───────────────────────────────────────────────────
    // Bayesian-style weighted vote model. Each signal votes UP / DOWN with a
    // weight reflecting its intraday reliability on NIFTY.
    // A large sideways base weight ensures probabilities stay honest —
    // even with all signals aligned, we cap directional probability at ~70%.
    // All weights are additive; correlated signals naturally reinforce each other
    // without allowing artificial certainty.

    let _bullW = 0;
    let _bearW = 0;
    const _votes: SignalVote[] = [];

    const _vote = (name: string, direction: 'UP' | 'DOWN' | 'NEUTRAL', weight: number) => {
      _votes.push({ name, vote: direction, weight });
      if (direction === 'UP')   _bullW += weight;
      if (direction === 'DOWN') _bearW += weight;
    };

    // 1. OI Writing Flow (20 pts) — institutional smart money; strongest intraday signal
    if      (oiChangeBias >  250_000) _vote('OI Writing Flow', 'UP',   20);
    else if (oiChangeBias >   80_000) _vote('OI Writing Flow', 'UP',   12);
    else if (oiChangeBias < -250_000) _vote('OI Writing Flow', 'DOWN', 20);
    else if (oiChangeBias <  -80_000) _vote('OI Writing Flow', 'DOWN', 12);
    else                              _vote('OI Writing Flow', 'NEUTRAL', 0);

    // 2. ORB Breakout (18 pts) — most reliable confirmed intraday signal
    if      (orbTrigger ===  1) _vote('ORB Breakout', 'UP',   18);
    else if (orbTrigger === -1) _vote('ORB Breakout', 'DOWN', 18);
    else                        _vote('ORB Breakout', 'NEUTRAL', 0);

    // 3. PCR Sentiment (12 pts) — options market consensus
    // PCR > 1 = more puts than calls = bullish (market has downside protection)
    if      (pcr > 1.3)  _vote('PCR Sentiment', 'UP',   12);
    else if (pcr > 1.1)  _vote('PCR Sentiment', 'UP',    6);
    else if (pcr < 0.8)  _vote('PCR Sentiment', 'DOWN', 12);
    else if (pcr < 0.9)  _vote('PCR Sentiment', 'DOWN',  6);
    else                 _vote('PCR Sentiment', 'NEUTRAL', 0);

    // 4. VWAP Position (12 pts) — institutional intraday reference level
    const _vwap = marketEngine.getVWAP();
    const _vwapDist = spot - _vwap;
    if      (_vwapDist >  15) _vote('VWAP Position', 'UP',   12);
    else if (_vwapDist >   5) _vote('VWAP Position', 'UP',    6);
    else if (_vwapDist < -15) _vote('VWAP Position', 'DOWN', 12);
    else if (_vwapDist <  -5) _vote('VWAP Position', 'DOWN',  6);
    else                      _vote('VWAP Position', 'NEUTRAL', 0);

    // 5. EMA20 Trend (8 pts) — short-term trend direction
    const _ph    = marketEngine.getPriceHistory();
    const _k20   = 2 / 21;
    let   _ema20 = _ph.length >= 20 ? _ph[_ph.length - 20] : spot;
    for (let _i = _ph.length - 19; _i < _ph.length; _i++) {
      _ema20 = (_ph[_i] * _k20) + (_ema20 * (1 - _k20));
    }
    const _emaDist  = spot - _ema20;
    const _risingEma = _ph.length >= 2 && _ph[_ph.length - 1] > _ph[_ph.length - 2];
    if      (_emaDist >  10 && _risingEma)  _vote('EMA20 Trend', 'UP',   8);
    else if (_emaDist >   0 && _risingEma)  _vote('EMA20 Trend', 'UP',   4);
    else if (_emaDist < -10 && !_risingEma) _vote('EMA20 Trend', 'DOWN', 8);
    else if (_emaDist <   0 && !_risingEma) _vote('EMA20 Trend', 'DOWN', 4);
    else                                    _vote('EMA20 Trend', 'NEUTRAL', 0);

    // 6. MACD Histogram (8 pts) — momentum confirmation
    const _macd = indicators.macd.histogram || 0;
    if      (_macd >  2) _vote('MACD Momentum', 'UP',   8);
    else if (_macd >  0) _vote('MACD Momentum', 'UP',   4);
    else if (_macd < -2) _vote('MACD Momentum', 'DOWN', 8);
    else if (_macd <  0) _vote('MACD Momentum', 'DOWN', 4);
    else                 _vote('MACD Momentum', 'NEUTRAL', 0);

    // 7. RSI Extremes (6 pts) — overbought/oversold reversals
    if      (indicators.rsi < 30) _vote('RSI Extreme', 'UP',   6);  // oversold → mean revert up
    else if (indicators.rsi > 70) _vote('RSI Extreme', 'DOWN', 6);  // overbought → pullback
    else                          _vote('RSI Extreme', 'NEUTRAL', 0);

    // 8. Bollinger Band Position (6 pts)
    if      (spot <= indicators.bollinger.lower + 10) _vote('Bollinger Band', 'UP',   6);
    else if (spot >= indicators.bollinger.upper - 10) _vote('Bollinger Band', 'DOWN', 6);
    else                                              _vote('Bollinger Band', 'NEUTRAL', 0);

    // 9. Opening Gap Bias (4 pts) — directional momentum from open
    if      (gapBias >  0) _vote('Opening Gap', 'UP',   4);
    else if (gapBias <  0) _vote('Opening Gap', 'DOWN', 4);
    else                   _vote('Opening Gap', 'NEUTRAL', 0);

    // 10. OI Structure Level (6 pts) — support / resistance proximity
    if      (isNearSupport)    _vote('OI Structure', 'UP',   6);  // at PE wall → support bounce
    else if (isNearResistance) _vote('OI Structure', 'DOWN', 6);  // at CE wall → rejection
    else                       _vote('OI Structure', 'NEUTRAL', 0);

    // Trap reduces directional confidence (false move risk)
    if (trapDetected) { _bullW *= 0.5; _bearW *= 0.5; }

    // Sideways base weight — VIX-calibrated.
    // Low VIX = market tends to range; high VIX = more directional.
    // High sidewaysWeight = honest floor on uncertainty even when signals align.
    // With all 10 signals aligned (max ~100 directional weight):
    //   VIX < 12 (sw=70): max P(dir) = 100/170 = 59%
    //   VIX 12-17 (sw=45): max P(dir) = 100/145 = 69%
    //   VIX 17-22 (sw=25): max P(dir) = 100/125 = 80%
    //   VIX > 22  (sw=15): max P(dir) = 100/115 = 87%
    const _sw = vix < 12 ? 70 : vix < 17 ? 45 : vix < 22 ? 25 : 15;

    const _total = _bullW + _bearW + _sw;
    const _probUp   = _total > 0 ? Math.round((_bullW / _total) * 100) : 33;
    const _probDown = _total > 0 ? Math.round((_bearW / _total) * 100) : 33;
    const _probSide = Math.max(0, 100 - _probUp - _probDown);

    const _dom = Math.max(_probUp, _probDown, _probSide);
    const _dir: 'UP' | 'DOWN' | 'SIDEWAYS' =
      _probUp === _dom ? 'UP' : _probDown === _dom ? 'DOWN' : 'SIDEWAYS';
    const _conf: 'HIGH' | 'MEDIUM' | 'LOW' =
      _dom >= 58 ? 'HIGH' : _dom >= 50 ? 'MEDIUM' : 'LOW';
    const _mag: 'EXPLOSIVE' | 'MODERATE' | 'CONTAINED' =
      (vix > 18 && orbTrigger !== 0 && _dom >= 58)   ? 'EXPLOSIVE' :
      (vix < 12 || trapDetected || _dom < 45)         ? 'CONTAINED' : 'MODERATE';

    const movementPrediction: MovementPrediction = {
      up:        _probUp,
      down:      _probDown,
      sideways:  _probSide,
      direction: _dir,
      confidence: _conf,
      magnitude:  _mag,
      signals:   _votes.filter(v => v.vote !== 'NEUTRAL'),
      disclaimer: 'Probabilistic model estimate — no prediction system is perfect. Always trade with defined risk.',
    };

    // Cache for endpoint reads without double-compute
    this.lastMovementPrediction = movementPrediction;

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
      movementPrediction,
    };
  }
}

export const strategyEngine = new StrategyEngine();
