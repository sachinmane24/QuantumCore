/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../firebase-applet-config.json' assert { type: 'json' };

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

// Initializing Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Accessing the specific Firestore database instance
const db = getFirestore(firebaseConfig.firestoreDatabaseId);
const tradesCollection = db.collection('trades');

class TradeLogger {
  async logTrade(entry: TradeLogEntry) {
    try {
      console.log("[LOGGER] Logging trade to Firestore:", entry.timestamp);
      await tradesCollection.add({
        ...entry,
        // Ensure server-side consistency for timestamps if possible, 
        // but here we use the ISO string provided by the engine.
      });
    } catch (err) {
      console.error("[LOGGER] Failed to log trade to Firestore:", err);
    }
  }

  async getLogs(): Promise<TradeLogEntry[]> {
    try {
      const snapshot = await tradesCollection.orderBy('timestamp', 'desc').limit(100).get();
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as TradeLogEntry[];
    } catch (err) {
      console.error("[LOGGER] Failed to fetch trade logs from Firestore:", err);
      return [];
    }
  }
}

export const tradeLogger = new TradeLogger();
