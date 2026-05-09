/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TradeLogEntry } from "../engine/types";

export interface PredictionResult {
  prediction: 'WIN' | 'LOSS' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
  suggestedAction: string;
}

/**
 * Predicts the outcome of a potential trade by calling the server API.
 */
export async function getTradePrediction(
  marketData: any,
  strategyData: any,
  historicalTrades: TradeLogEntry[]
): Promise<PredictionResult> {
  try {
    const res = await fetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketData, strategyData, historicalTrades })
    });
    
    if (!res.ok) throw new Error("Failed to fetch prediction from server");
    
    return await res.json();
  } catch (error) {
    console.error("[GEMINI-CLIENT] Prediction Request Error:", error);
    return {
      prediction: 'NEUTRAL',
      confidence: 0,
      reasoning: "Failed to connect to Quantum AI Core logic.",
      suggestedAction: "Check network connection or server status."
    };
  }
}
