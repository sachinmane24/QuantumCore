/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { marketEngine } from './market.ts';
import type { OptionChainData } from './market.ts';

export interface StrategyScore {
  total: number;
  trend: number;
  oiBias: number;
  gamma: number;
  trap: number;
  timeFilter: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
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
    if (diff > 5) trendScore = 20;
    else if (diff > 0) trendScore = 15;
    else if (diff < -5) trendScore = 5;
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
    if (pcr > 1.25 || oiChangeBias > 300000) oiBiasScore = 20;
    else if (pcr > 1.1 || oiChangeBias > 100000) oiBiasScore = 15;
    else if (pcr < 0.75 || oiChangeBias < -300000) oiBiasScore = 0;
    else if (pcr < 0.9 || oiChangeBias < -100000) oiBiasScore = 5;

    // 3. Gamma Condition (VIX based) - 15 points
    // Lower VIX = Stable Gamma environment (better for premium decay)
    const gammaScore = Math.min(15, Math.max(0, 25 - vix));

    // 4. Trap Presence (OI Change Concentration) - 20 points
    // High divergence in OI change often precedes a sharp reversal/trap
    const trapScore = (Math.abs(oiChangeBias) > 1500000) ? 5 : 20;

    // 5. Time Filter - 20 points (Execution Timing)
    // 09:15 to 15:30 IST is the high-liquidity window
    const istTime = new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
    const istDate = new Date(istTime);
    const istHour = istDate.getHours();
    const istMin = istDate.getMinutes();
    const totalMin = istHour * 60 + istMin;
    
    // 09:15 is 555 min, 15:30 is 930 min
    const timeFilterScore = (totalMin >= 555 && totalMin <= 930) ? 20 : 5;

    const total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore;
    
    // Debug log occasionally
    if (Math.floor(Date.now() / 1000) % 20 === 0) {
       console.log(`[STRATEGY] Trend: ${trendScore.toFixed(0)}, OI: ${oiBiasScore.toFixed(0)}, Gamma: ${gammaScore.toFixed(0)}, Trap: ${trapScore.toFixed(0)}, Time: ${timeFilterScore.toFixed(0)} | Total: ${total.toFixed(0)}`);
    }

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (total > 60) {
      bias = (pcr > 1.05 || oiChangeBias > 0) ? 'BULLISH' : 'BEARISH';
    } else if (total < 45) {
      bias = (pcr < 0.95 || oiChangeBias < 0) ? 'BEARISH' : 'BULLISH';
    }

    return {
      total: Math.round(total),
      trend: Math.round(trendScore),
      oiBias: Math.round(oiBiasScore),
      gamma: Math.round(gammaScore),
      trap: Math.round(trapScore),
      timeFilter: Math.round(timeFilterScore),
      bias
    };
  }
}

export const strategyEngine = new StrategyEngine();
