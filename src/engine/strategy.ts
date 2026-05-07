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
    if (diff > 5) trendScore = 25; // MAX MOMENTUM
    else if (diff > 0) trendScore = 15;
    else if (diff < -5) trendScore = 25; // MAX MOMENTUM (Downside)
    else if (diff < 0) trendScore = 8;

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
    const timeFilterScore = (totalMin >= 555 && totalMin <= 930) ? 20 : 5;

    const total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore;
    
    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let mode: StrategyMode = 'INST_SPREAD';
    let recommendation = '--';

    if (total > 75) {
      mode = 'MOMENTUM_SNIPER';
      bias = oiChangeBias > 500000 ? 'BULLISH' : 'BEARISH';
      recommendation = `BUY NAKED ${atmStrike} ${bias === 'BULLISH' ? 'CE' : 'PE'}`;
    } else if (total > 55) {
      mode = 'INST_SPREAD';
      bias = oiChangeBias > 0 ? 'BULLISH' : 'BEARISH';
      recommendation = `${atmStrike} ${bias === 'BULLISH' ? 'BULL SPREAD' : 'BEAR SPREAD'}`;
    } else {
      mode = 'INST_SPREAD';
      bias = 'NEUTRAL';
      recommendation = 'STANDBY';
    }

    return {
      total: Math.round(total),
      trend: Math.round(trendScore),
      oiBias: Math.round(oiBiasScore),
      gamma: Math.round(gammaScore),
      trap: Math.round(trapScore),
      timeFilter: Math.round(timeFilterScore),
      bias,
      mode,
      recommendation
    };
  }
}

export const strategyEngine = new StrategyEngine();
