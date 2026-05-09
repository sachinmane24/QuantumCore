/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { adminDb as db } from './firebase-server';
import { FieldValue } from 'firebase-admin/firestore';
import { TradeLogEntry } from './types';
import fs from 'fs-extra';
import path from 'path';

const tradesCollection = db.collection('trades');

// Connection test
(async () => {
  try {
    console.log("[LOGGER] Running Firestore connectivity check (v5.4 - ADMIN)...");
    await tradesCollection.limit(1).get();
    console.log("[LOGGER] Firestore Admin connection successful.");
  } catch (e) {
    console.error("[LOGGER] Firestore Admin connectivity check FAILED. Error:", e);
  }
})();

class TradeLogger {
  async logTrade(entry: TradeLogEntry) {
    try {
      console.log("[LOGGER] Attempting to log trade at:", entry.timestamp);
      const res = await tradesCollection.add({
        ...entry,
        serverTimestamp: FieldValue.serverTimestamp()
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
      console.log("[LOGGER] Fetching logs from Firestore Admin...");
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
      console.error("[LOGGER] FAILED to fetch trade logs from Firestore Admin:", err);
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
