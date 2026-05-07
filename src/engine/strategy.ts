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
    const trendScore = (spot > atmStrike) ? 20 : (spot < atmStrike) ? 5 : 12.5;

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
    if (pcr > 1.15 || oiChangeBias > 500000) oiBiasScore = 18;
    else if (pcr < 0.85 || oiChangeBias < -500000) oiBiasScore = 4;

    // 3. Gamma Condition (VIX based) - 15 points
    const gammaScore = Math.min(15, Math.max(0, 25 - vix));

    // 4. Trap Presence (OI Change Concentration) - 20 points
    const trapScore = (Math.abs(oiChangeBias) > 1500000) ? 5 : 20;

    // 5. Time Filter - 20 points
    const istHour = (new Date().getHours() + 5) % 24; // Simple offset for IST approx
    const timeFilterScore = (istHour >= 9 && istHour <= 15) ? 20 : 5;

    const total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore;
    
    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (total > 65) {
      bias = (pcr > 1.05 || oiChangeBias > 0) ? 'BULLISH' : 'BEARISH';
    } else if (total < 40) {
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
