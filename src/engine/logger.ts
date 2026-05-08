/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  getDocs, 
  query, 
  orderBy, 
  limit, 
  serverTimestamp,
  type Firestore
} from 'firebase/firestore';
import fs from 'fs-extra';
import path from 'path';

export interface TradeLogEntry {
  id?: string;
  timestamp: string;
  score: number;
  gamma: number;
  oi_bias: number;
  trap: boolean;
  pnl: number;
  win: boolean;
  bias?: 'BULLISH' | 'BEARISH';
  mode?: string;
  vix?: number;
  spot?: number;
  phase?: string;
  isExpiryDay?: boolean;
  isMonthlyExpiry?: boolean;
  entryNetDelta?: number;
  entryNetGamma?: number;
  indicators?: {
    rsi: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHist: number | null;
    bbUpper: number | null;
    bbLower: number | null;
    bbMiddle: number | null;
  };
  duration?: number; // Holding time in seconds
  entryTime?: string;
  buyPrice?: number;
  sellPrice?: number;
  totalInvestment?: number;
  strike?: number;
  intelligence?: {
    atr: number;
    vixFactor: number;
    rr: number;
    slPrice: number;
    targetPrice: number;
    pop?: number;
  };
  serverTimestamp?: any;
}

// Load config using fs
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = fs.readJsonSync(configPath);

console.log("[LOGGER] Initializing Firebase Client SDK...");

const app = initializeApp(firebaseConfig);
// Initialize Firestore with the specific database ID from config
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const tradesCollection = collection(db, 'trades');

// Connection test
(async () => {
  try {
    console.log("[LOGGER] Running Firestore connectivity check (v5.3)...");
    const testQuery = query(tradesCollection, limit(1));
    await getDocs(testQuery);
    console.log("[LOGGER] Firestore connection successful.");
  } catch (e) {
    console.error("[LOGGER] Firestore connectivity check FAILED. Error:", e);
  }
})();

class TradeLogger {
  async logTrade(entry: TradeLogEntry) {
    try {
      console.log("[LOGGER] Attempting to log trade at:", entry.timestamp);
      const res = await addDoc(tradesCollection, {
        ...entry,
        serverTimestamp: serverTimestamp()
      });
      console.log("[LOGGER] Trade successfully logged with ID:", res.id);
    } catch (err) {
      console.error("[LOGGER] FAILED to log trade to Firestore:", err);
      // Fallback: log to a local file if Firestore fails
      try {
        const fallbackPath = path.join(process.cwd(), 'trades_fallback.json');
        const existing = await fs.readJson(fallbackPath).catch(() => []);
        existing.push(entry);
        await fs.writeJson(fallbackPath, existing);
        console.log("[LOGGER] Fallback: Trade saved to local JSON.");
      } catch (e) {
        console.error("[LOGGER] Fallback also failed:", e);
      }
    }
  }

  async getLogs(): Promise<TradeLogEntry[]> {
    try {
      console.log("[LOGGER] Fetching logs from Firestore...");
      const q = query(tradesCollection, orderBy('timestamp', 'desc'), limit(100));
      const snapshot = await getDocs(q);
      console.log(`[LOGGER] Fetched ${snapshot.size} logs.`);
      
      const logs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as TradeLogEntry[];

      // Check for local fallback logs
      try {
        const fallbackPath = path.join(process.cwd(), 'trades_fallback.json');
        if (await fs.pathExists(fallbackPath)) {
          const fallbackLogs = await fs.readJson(fallbackPath);
          return [...fallbackLogs, ...logs].sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        }
      } catch (e) {}

      return logs;
    } catch (err) {
      console.error("[LOGGER] FAILED to fetch trade logs from Firestore:", err);
      // Fallback to local
      try {
        const fallbackPath = path.join(process.cwd(), 'trades_fallback.json');
        if (await fs.pathExists(fallbackPath)) {
          return await fs.readJson(fallbackPath);
        }
      } catch (e) {}
      return [];
    }
  }
}

export const tradeLogger = new TradeLogger();
