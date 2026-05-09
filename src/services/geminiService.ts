/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { TradeLogEntry } from "../engine/logger";

// Initialize the Gemini AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface PredictionResult {
  prediction: 'WIN' | 'LOSS' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
  suggestedAction: string;
}

/**
 * Predicts the outcome of a potential trade based on current market context and historical performance.
 */
export async function getTradePrediction(
  marketData: any,
  strategyData: any,
  historicalTrades: TradeLogEntry[]
): Promise<PredictionResult> {
  try {
    // Sanitize data to reduce token usage and focus on key metrics
    const context = {
      market: {
        spot: marketData.spot,
        vix: marketData.vix,
        pcr: marketData.pcr,
        gapPercent: marketData.gapPercent,
        vwap: marketData.vwap,
        indicators: marketData.indicators
      },
      strategy: strategyData.score,
      history: historicalTrades.slice(0, 15).map(t => ({
        win: t.win,
        pnl: t.pnl,
        bias: t.bias,
        score: t.score,
        vix: t.vix
      }))
    };

    const prompt = `
      You are an expert quantitative trading analyst specializing in Indian index options (NIFTY/BANKNIFTY).
      Analyze the current market context and historical performance to predict the outcome of a potential trade.
      
      Current Market & Strategy Context:
      ${JSON.stringify(context, null, 2)}
      
      Predict if a trade entered now would be a WIN or a LOSS based on these parameters.
      Provide the result in the following JSON format:
      {
        "prediction": "WIN" | "LOSS" | "NEUTRAL",
        "confidence": number (from 0 to 100),
        "reasoning": "A concise expert analysis of the factors",
        "suggestedAction": "Specific tactical advice (e.g., 'Wait for RSI cooling', 'Aggressive Entry', 'Scale down size')"
      }
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            prediction: { 
              type: Type.STRING, 
              enum: ["WIN", "LOSS", "NEUTRAL"],
              description: "The predicted outcome of the trade"
            },
            confidence: { 
              type: Type.NUMBER,
              description: "Confidence level between 0 and 100"
            },
            reasoning: { 
              type: Type.STRING,
              description: "Detailed logic for the prediction"
            },
            suggestedAction: { 
              type: Type.STRING,
              description: "Actionable advice for the trader"
            }
          },
          required: ["prediction", "confidence", "reasoning", "suggestedAction"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("Empty response from AI");
    
    return JSON.parse(text) as PredictionResult;
  } catch (error) {
    console.error("[GEMINI] Prediction Error:", error);
    return {
      prediction: 'NEUTRAL',
      confidence: 0,
      reasoning: "AI node synchronization failed. Falling back to base algorithmic model.",
      suggestedAction: "Rely on deterministic strategy scores."
    };
  }
}
