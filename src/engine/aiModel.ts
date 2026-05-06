/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from "@google/genai";
import { config } from "./config.ts";

export interface TradeLogEntry {
  timestamp: string;
  score: number;
  gamma: number;
  oi_bias: number;
  trap: boolean;
  pnl: number;
  win: boolean;
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
      // Mock prediction if no API key
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
}

export const aiEngine = new AIEngine();
