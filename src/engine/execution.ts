/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { config } from './config.ts';
import { marketEngine } from './market.ts';
import { tradeLogger } from './logger.ts';
import { strategyEngine } from './strategy.ts';

export interface Position {
  strike: number;
  type: 'CE' | 'PE';
  entryPrice: number;
  qty: number;
  side: 'SELL' | 'BUY';
}

class ExecutionEngine {
  private activePositions: Position[] = [];
  private pnl: number = 0;
  private rollsToday: number = 0;
  private lastRollTime: number = 0;
  private lastTradeScore: any = null;

  async executeTrade(bias: 'BULLISH' | 'BEARISH') {
    if (this.activePositions.length > 0) return;

    const spot = marketEngine.getSpotPrice();
    const atmStrike = Math.round(spot / 50) * 50;
    this.lastTradeScore = strategyEngine.calculateScore();

    if (bias === 'BULLISH') {
      // Sell ATM Put, Buy OTM Put (Spread)
      this.activePositions = [
        { strike: atmStrike, type: 'PE', entryPrice: 100, qty: config.LOT_SIZE, side: 'SELL' },
        { strike: atmStrike - 100, type: 'PE', entryPrice: 30, qty: config.LOT_SIZE, side: 'BUY' }
      ];
    } else {
      // Sell ATM Call, Buy OTM Call (Spread)
      this.activePositions = [
        { strike: atmStrike, type: 'CE', entryPrice: 100, qty: config.LOT_SIZE, side: 'SELL' },
        { strike: atmStrike + 100, type: 'CE', entryPrice: 30, qty: config.LOT_SIZE, side: 'BUY' }
      ];
    }
    console.log(`Executed ${bias} strategy. Positions:`, this.activePositions);
  }

  updatePnL() {
    if (this.activePositions.length === 0) return;
    
    // Simulate real-time PnL movement
    const movement = (Math.random() - 0.5) * 500;
    this.pnl += movement;

    // Check Rolling 
    this.checkRolling();

    // Check Risk Management
    if (this.pnl <= -config.SL_RUPEES || this.pnl >= config.TARGET_RUPEES) {
      this.exitAll('SL/Target Hit');
    }
  }

  private checkRolling() {
    if (this.activePositions.length === 0) return;
    if (this.rollsToday >= config.MAX_ROLLS) return;
    const now = Date.now();
    if (now - this.lastRollTime < 15 * 60 * 1000) return;

    const spot = marketEngine.getSpotPrice();
    const sellPos = this.activePositions.find(p => p.side === 'SELL');
    if (!sellPos) return;

    let shouldRoll = false;
    if (sellPos.type === 'PE' && spot > sellPos.strike + 50) shouldRoll = true;
    if (sellPos.type === 'CE' && spot < sellPos.strike - 50) shouldRoll = true;

    if (shouldRoll) {
      console.log('Rolling Position...');
      this.rollsToday++;
      this.lastRollTime = now;
      this.exitAll('Rolling');
      this.executeTrade(sellPos.type === 'PE' ? 'BULLISH' : 'BEARISH');
    }
  }

  exitAll(reason: string) {
    if (this.activePositions.length > 0) {
      tradeLogger.logTrade({
        timestamp: new Date().toISOString(),
        score: this.lastTradeScore?.total || 0,
        gamma: this.lastTradeScore?.gamma || 0,
        oi_bias: this.lastTradeScore?.oiBias || 0,
        trap: this.lastTradeScore?.trap === 0,
        pnl: Math.round(this.pnl),
        win: this.pnl > 0
      });
    }
    console.log(`Exiting all positions. Reason: ${reason}. Final PnL: ${this.pnl}`);
    this.activePositions = [];
    this.pnl = 0; // Reset PnL for next trade session
  }

  getState() {
    return {
      positions: this.activePositions,
      pnl: Math.round(this.pnl),
      rollsToday: this.rollsToday
    };
  }
}

export const executionEngine = new ExecutionEngine();
