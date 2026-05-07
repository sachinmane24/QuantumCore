/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
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
  vix?: number;
  spot?: number;
  phase?: string;
  duration?: number; // Holding time in seconds
  entryTime?: string;
  buyPrice?: number;
  sellPrice?: number;
  totalInvestment?: number;
}

// Load config using fs to avoid ESM import issues
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = fs.readJsonSync(configPath);

console.log("[LOGGER] Initializing with Project:", firebaseConfig.projectId, "DB ID:", firebaseConfig.firestoreDatabaseId);

// Initializing Firebase Admin if not already initialized
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });
    console.log("[LOGGER] Firebase Admin initialized.");
  } catch (e) {
    console.error("[LOGGER] Firebase Admin initialization FAILED:", e);
  }
}

// Accessing the specific Firestore database instance
const db = getFirestore(firebaseConfig.firestoreDatabaseId || '(default)');
const tradesCollection = db.collection('trades');

// Connection test
(async () => {
  try {
    console.log("[LOGGER] Running Firestore connection test...");
    await tradesCollection.limit(1).get();
    console.log("[LOGGER] Firestore connection successful.");
  } catch (e) {
    console.error("[LOGGER] Firestore connection test FAILED. Error:", e);
  }
})();

class TradeLogger {
  async logTrade(entry: TradeLogEntry) {
    try {
      console.log("[LOGGER] Attempting to log trade at:", entry.timestamp);
      const res = await tradesCollection.add({
        ...entry,
        serverTimestamp: admin.firestore.FieldValue.serverTimestamp()
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
      const snapshot = await tradesCollection.orderBy('timestamp', 'desc').limit(100).get();
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
