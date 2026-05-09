/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { config } from "./config.ts";
import { TradeLogEntry } from "./types";

export interface PredictionResult {
  prediction: 'WIN' | 'LOSS' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
  suggestedAction: string;
}

class AIEngine {
  private ai: GoogleGenAI | null = null;

  constructor() {
    if (config.GEMINI_API_KEY) {
      this.ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    }
  }

  async predictWinProbability(currentFeatures: any, history: TradeLogEntry[]): Promise<number> {
    if (!this.ai) {
      return 0.5 + (Math.random() - 0.5) * 0.4;
    }

    try {
      const prompt = `
        As a quant analyst, predict the win probability (0 to 1) for the following NIFTY options trade.
        Current Features: ${JSON.stringify(currentFeatures)}
        Last 5 Trades: ${JSON.stringify(history.slice(-5))}
        Return ONLY a number between 0 and 1.
      `;

      const response = await this.ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
      });

      const prob = parseFloat(response.text || "0.5");
      return isNaN(prob) ? 0.5 : prob;
    } catch (error) {
      console.error("AI Prediction Error:", error);
      return 0.5;
    }
  }

  async getTradePrediction(
    marketData: any,
    strategyData: any,
    historicalTrades: TradeLogEntry[]
  ): Promise<PredictionResult> {
    if (!this.ai) {
        return {
            prediction: 'NEUTRAL',
            confidence: 0,
            reasoning: "AI engine not initialized (Missing API Key).",
            suggestedAction: "Check configuration."
        };
    }

    try {
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
          "suggestedAction": "Specific tactical advice"
        }
      `;

      const response = await this.ai.models.generateContent({
        model: "gemini-2.0-flash",
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
        reasoning: "AI node synchronization failed.",
        suggestedAction: "Rely on deterministic strategy scores."
      };
    }
  }
}

export const aiEngine = new AIEngine();
