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

    // 1. Trend (EMA/VWAP Proxy) - 25 points
    const trendScore = Math.min(25, Math.max(0, 12.5 + (Math.random() - 0.5) * 25));

    // 2. OI Bias - 20 points
    let callOi = 0;
    let putOi = 0;
    chain.forEach(c => {
      callOi += c.ce_oi;
      putOi += c.pe_oi;
    });
    const pcr = putOi / callOi;
    const oiBiasScore = Math.min(20, Math.max(0, pcr * 10));

    // 3. Gamma Condition - 15 points
    const gammaScore = Math.random() * 15;

    // 4. Trap Presence - 20 points
    const trapScore = (Math.random() > 0.8) ? 0 : 20;

    // 5. Time Filter - 20 points
    const hour = new Date().getHours();
    const timeFilterScore = (hour >= 9 && hour <= 15) ? 20 : 0;

    const total = trendScore + oiBiasScore + gammaScore + trapScore + timeFilterScore;
    
    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (total > 70) {
      bias = (pcr > 1.1) ? 'BULLISH' : 'BEARISH';
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
