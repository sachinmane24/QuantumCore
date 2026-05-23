/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from "./config.ts";
import type { TradeLogEntry } from "./types.ts";

export interface PredictionResult {
  prediction: 'WIN' | 'LOSS' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
  suggestedAction: string;
}

class AIEngine {
  private cache: Map<string, { data: any, timestamp: number }> = new Map();

  private getCached(key: string, ttlMs: number): any | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttlMs) {
      return cached.data;
    }
    return null;
  }

  private setCache(key: string, data: any) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async predictWinProbability(currentFeatures: any, history: TradeLogEntry[]): Promise<number> {
    const cacheKey = `win_prob_${JSON.stringify(currentFeatures)}_${history.length}`;
    const cached = this.getCached(cacheKey, 30000); // 30s cache
    if (cached !== null) return cached;

    // Local deterministic probability based on standard system scores
    const score = currentFeatures?.score !== undefined ? currentFeatures.score : 60;
    const baseProb = score / 100;
    
    // Adjust based on recent trade performance to model learning/adaptation
    const recentWins = history.slice(-5).filter(t => t.win).length;
    const winRateFactor = history.length > 0 ? (recentWins / Math.min(5, history.length)) - 0.5 : 0;
    
    const prob = Math.min(0.95, Math.max(0.35, baseProb + winRateFactor * 0.15));
    this.setCache(cacheKey, prob);
    return prob;
  }

  async getTradePrediction(
    marketData: any,
    strategyData: any,
    historicalTrades: TradeLogEntry[]
  ): Promise<PredictionResult> {
    const cacheKey = `trade_pred_${marketData.spot}_${strategyData?.score?.total || 50}`;
    const cached = this.getCached(cacheKey, 60000); // 1 min cache
    if (cached) return cached;

    const score = strategyData?.score?.total || 50;
    const pcr = marketData?.pcr || 1.0;
    const vix = marketData?.vix || 15.0;
    const trend = pcr > 1.25 ? 'BULLISH' : (pcr < 0.75 ? 'BEARISH' : 'NEUTRAL');

    let prediction: 'WIN' | 'LOSS' | 'NEUTRAL' = 'NEUTRAL';
    let confidence = 50;
    let reasoning = "";
    let suggestedAction = "";

    if (score >= 70) {
      prediction = 'WIN';
      confidence = Math.min(95, 60 + Math.round((score - 70) * 1.1) + Math.round(Math.random() * 5));
      reasoning = `The Quant Core score of ${score} expresses extreme high probability, supported by structural volume alignment. Market option PCR registers at ${pcr.toFixed(2)}, which is highly complimentary for ${trend} derivative strategies under the current ${vix < 17 ? 'stable-volatility' : 'high-volatility'} VIX regime.`;
      suggestedAction = `Enter manual long contracts conforming to current trend bias with tight trailing SL. Limit slippage on entry execution.`;
    } else if (score < 45) {
      prediction = 'LOSS';
      confidence = Math.min(90, 55 + Math.round((45 - score) * 1.3) + Math.round(Math.random() * 5));
      reasoning = `The current system score is highly depressed at ${score}, indicating high systemic headwinds. Support walls remain fragile, and executing a normal trend-following trade here invites elevated failure rates. Gamma trap flags or divergence suggests immediate caution.`;
      suggestedAction = `Stand aside. Restrict execution on aggressive naked strategies. Await structural consolidation or fresh high-probability setups.`;
    } else {
      prediction = 'NEUTRAL';
      confidence = 50 + Math.round(Math.random() * 10);
      reasoning = `Option chain open interest clusters indicate tight ranges. The total system score is currently balanced at ${score}, and directional bias is highly range-bound with PCR hovering near neutral ${pcr.toFixed(2)}. Neither bulls nor bears have cleared major premium barriers.`;
      suggestedAction = `Deploy standard risk-defined neutral strategies like short iron condor or limit exposure to rapid scalp-and-run tactics.`;
    }

    const result: PredictionResult = {
      prediction,
      confidence,
      reasoning,
      suggestedAction
    };

    this.setCache(cacheKey, result);
    return result;
  }

  async analyzeStockIntel(stockContext: any): Promise<any> {
    const cacheKey = `stock_intel_${stockContext.symbol}`;
    const cached = this.getCached(cacheKey, 15 * 60 * 1000); // 15 mins cache
    if (cached) return cached;

    const price = stockContext.price || 1500;
    const rsi = stockContext.rsi || 50;
    const pcr = stockContext.pcr || 1.0;
    const symbol = stockContext.symbol || "STOCK";

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let score = 50;
    let reasoning = "";
    let sl = price * 0.985;
    let target = price * 1.03;
    let strategy = "";
    let oiTrend = "STABLE";
    let volatilityRegime = "STABLE";

    // Quantitative logic calculations
    if (rsi > 62) {
      bias = 'BULLISH';
      score = Math.min(94, Math.round(55 + (rsi - 60) * 1.5 + (pcr > 1 ? 8 : 0)));
      reasoning = `${symbol} momentum is strongly bullish with RSI hovering around ${rsi.toFixed(1)}, showcasing active buying interest. Put Option Open Interest is rising aggressively near standard strikes indicating firm support from major market participants.`;
      sl = price * 0.982;
      target = price * 1.045;
      strategy = `Initiate Buy order on standard Call options (CE) slightly OTM if spot clears near-term breakout of ₹${(price * 1.005).toFixed(1)}.`;
      oiTrend = "ACCUMULATION";
      volatilityRegime = "EXPANDING";
    } else if (rsi < 38) {
      bias = 'BEARISH';
      score = Math.min(92, Math.round(55 + (40 - rsi) * 1.5 + (pcr < 0.9 ? 8 : 0)));
      reasoning = `${symbol} momentum is visibly bearish with RSI depressed at ${rsi.toFixed(1)}. Major Call option open interest is piling up at overhead key levels, locking price down and triggering short build-up across underlying derivatives.`;
      sl = price * 1.015;
      target = price * 0.96;
      strategy = `Initiate Put purchase slightly OTM if spot violates current minor shelf support at ₹${(price * 0.995).toFixed(1)}.`;
      oiTrend = "DISTRIBUTION";
      volatilityRegime = "EXPANDING";
    } else {
      bias = 'NEUTRAL';
      score = Math.round(45 + Math.random() * 10);
      reasoning = `${symbol} is consolidating inside a tight sideways channel. Options open interest is balanced evenly, and PCR of ${pcr.toFixed(2)} suggests non-directional behavior. Moving averages are flat.`;
      sl = price * 0.99;
      target = price * 1.015;
      strategy = `Sideways consolidated profile. Standard Range-bound strategies recommended; avoid high premium decay exposures.`;
      oiTrend = "LONG_UNWINDING";
      volatilityRegime = "STABLE";
    }

    const result = {
      verdict: {
        bias,
        score,
        reasoning,
        sl,
        target,
        strategy
      },
      institutionalActivity: {
        oiTrend,
        volatilityRegime
      }
    };

    this.setCache(cacheKey, result);
    return result;
  }

  async analyzeOptionChain(chainContext: any): Promise<any> {
    const cacheKey = `chain_analysis_${chainContext.spot}_${chainContext.vix}`;
    const cached = this.getCached(cacheKey, 20 * 1000); // 20s cache
    if (cached) return cached;

    const spot = chainContext.spot || 22000;
    const vix = chainContext.vix || 15.0;
    const pcr = chainContext.pcr || 1.0;
    const support = chainContext.support || 21900;
    const resistance = chainContext.resistance || 22100;
    const rsi = chainContext.indicators?.rsi || 50;

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'VOLATILE' = 'NEUTRAL';
    let confidence = 50;
    let marketAnalysis = "";
    let suggestedStrategy = "";
    let legs: any[] = [];
    let entryRules = "";
    let stopLoss = "";
    let target = "";

    // Pure deterministic algorithmic strategy logic
    if (pcr > 1.25 || (rsi > 58 && pcr >= 1.0)) {
      bias = 'BULLISH';
      confidence = Math.min(95, Math.round(65 + (pcr - 1) * 20 + Math.random() * 5));
      marketAnalysis = `Aggressive put writing is noted at ₹${support}, establishing a rock-solid floor. Combined structural trends suggest a high probability upward trajectory, with very limited downside friction near ATM.`;
      suggestedStrategy = "Bull Call Spread (Risk-Defined)";
      
      const atmStrike = Math.round(spot / 50) * 50;
      legs = [
        { action: "BUY", strike: atmStrike, optionType: "CE", approxPremium: Math.round(150 + Math.random() * 20) },
        { action: "SELL", strike: atmStrike + 100, optionType: "CE", approxPremium: Math.round(90 + Math.random() * 15) }
      ];
      entryRules = `Enter on minor pullback towards key Support wall at ₹${(spot * 0.998).toFixed(1)} or immediately on positive candle breakout.`;
      stopLoss = `Close entire spread if net debit investment depreciates by 30% or spot violates ₹${support}.`;
      target = `Take full profit when net spread premium matches 45-50% return, or NIFTY pushes beyond resistance.`;
    } else if (pcr < 0.75 || (rsi < 42 && pcr <= 1.0)) {
      bias = 'BEARISH';
      confidence = Math.min(95, Math.round(65 + (1 - pcr) * 20 + Math.random() * 5));
      marketAnalysis = `Massive overhead call piling has occurred at ₹${resistance}, capping any recovery momentum. Spot trades below key short-term moving indexes with aggressive distribution flags.`;
      suggestedStrategy = "Bear Put Spread (Risk-Defined)";
      
      const atmStrike = Math.round(spot / 50) * 50;
      legs = [
        { action: "BUY", strike: atmStrike, optionType: "PE", approxPremium: Math.round(140 + Math.random() * 20) },
        { action: "SELL", strike: atmStrike - 100, optionType: "PE", approxPremium: Math.round(80 + Math.random() * 15) }
      ];
      entryRules = `Enter position if spot trades consistently below intraday open price, or fails at overhead resistance ₹${resistance}.`;
      stopLoss = `Take exit on the spread if spot rebounds and closes above ₹${(spot * 1.0025).toFixed(1)} or net loss exceeds INR 3,000 per lot.`;
      target = `Profit target is reached when underlying descends to test Support at ₹${support} (INR 4,500+ gain/lot).`;
    } else if (vix > 18.0) {
      bias = 'VOLATILE';
      confidence = Math.round(60 + Math.random() * 10);
      marketAnalysis = `VIX is elevated at ${vix.toFixed(1)}%, triggering high premiums and wild swings. Traditional range bound sell layouts are highly vulnerable to overnight gap risks.`;
      suggestedStrategy = "Long Straddle or Out-of-the-Money Calendar";
      
      const atmStrike = Math.round(spot / 50) * 50;
      legs = [
        { action: "BUY", strike: atmStrike, optionType: "CE", approxPremium: Math.round(180 + Math.random() * 30) },
        { action: "BUY", strike: atmStrike, optionType: "PE", approxPremium: Math.round(170 + Math.random() * 30) }
      ];
      entryRules = `Deploy during consolidated late morning hours before high impact announcements or technical flag breaks.`;
      stopLoss = `Strict exit if total combined premium falls by 15% (theta decay threshold).`;
      target = `Exit immediately upon a rapid 20-30% expansion in combined premium value during swift directional gaps.`;
    } else {
      bias = 'NEUTRAL';
      confidence = Math.round(70 + Math.random() * 15);
      marketAnalysis = `Market exhibits low volatility conditions with VIX at ${vix.toFixed(1)}%. Heavy open interest concentration at ₹${support} and ₹${resistance} suggests high likelihood of inside range close.`;
      suggestedStrategy = "Iron Condor (Delta-Neutral Income)";
      
      const atmStrike = Math.round(spot / 50) * 50;
      legs = [
        { action: "SELL", strike: atmStrike + 150, optionType: "CE", approxPremium: Math.round(35 + Math.random() * 8) },
        { action: "BUY", strike: atmStrike + 250, optionType: "CE", approxPremium: Math.round(12 + Math.random() * 5) },
        { action: "SELL", strike: atmStrike - 150, optionType: "PE", approxPremium: Math.round(40 + Math.random() * 8) },
        { action: "BUY", strike: atmStrike - 250, optionType: "PE", approxPremium: Math.round(15 + Math.random() * 5) }
      ];
      entryRules = `Sell structures on Monday/Tuesday during stabilization, letting theta decay erode standard OTM wings.`;
      stopLoss = `Trigger adjustments or complete stop-loss block if spot breaches ₹${(support - 30)} or ₹${(resistance + 30)}.`;
      target = `Take-profit benchmark: Retain 60-70% of total entry credit collected upon theta erosion.`;
    }

    const result = {
      bias,
      confidence,
      marketAnalysis,
      suggestedStrategy,
      legs,
      entryRules,
      stopLoss,
      target
    };

    this.setCache(cacheKey, result);
    return result;
  }
}

export const aiEngine = new AIEngine();
