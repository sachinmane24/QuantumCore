/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';

export interface TradeLogEntry {
  timestamp: string;
  score: number;
  gamma: number;
  oi_bias: number;
  trap: boolean;
  pnl: number;
  win: boolean;
}

const LOG_FILE = path.join(process.cwd(), 'data', 'trade_log.csv');

class TradeLogger {
  constructor() {
    this.ensureDirectory();
    this.ensureHeader();
  }

  private ensureDirectory() {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private ensureHeader() {
    if (!fs.existsSync(LOG_FILE)) {
      const header = 'timestamp,score,gamma,oi_bias,trap,pnl,win\n';
      fs.writeFileSync(LOG_FILE, header);
    }
  }

  logTrade(entry: TradeLogEntry) {
    const row = `${entry.timestamp},${entry.score},${entry.gamma},${entry.oi_bias},${entry.trap},${entry.pnl},${entry.win}\n`;
    fs.appendFileSync(LOG_FILE, row);
  }

  getLogs(): TradeLogEntry[] {
    if (!fs.existsSync(LOG_FILE)) return [];
    
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').slice(1); // Skip header

    return lines.map(line => {
      const [timestamp, score, gamma, oi_bias, trap, pnl, win] = line.split(',');
      return {
        timestamp,
        score: Number(score),
        gamma: Number(gamma),
        oi_bias: Number(oi_bias),
        trap: trap === 'true',
        pnl: Number(pnl),
        win: win === 'true'
      };
    });
  }
}

export const tradeLogger = new TradeLogger();
