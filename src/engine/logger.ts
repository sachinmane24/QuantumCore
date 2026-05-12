/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { adminDb as db } from './firebase-server.ts';
import { FieldValue } from 'firebase-admin/firestore';
import type { TradeLogEntry } from './types.ts';
import fs from 'fs-extra';
import path from 'path';

const tradesCollection = db.collection('trades');
const auditCollection = db.collection('audit_logs');

let firestoreEnabled = true;

// Define Audit Entry Type
export interface AuditLogEntry {
  id?: string;
  timestamp: string;
  type: 'INFO' | 'WARNING' | 'ERROR' | 'TRADE_TRIGGER' | 'TRADE_SKIP' | 'RISK_ALERT';
  message: string;
  details?: any;
}

// Connection test
(async () => {
  try {
    console.log("[LOGGER] Running Firestore connectivity check (v5.4 - ADMIN)...");
    await tradesCollection.limit(1).get();
    console.log("[LOGGER] Firestore Admin connection successful.");
  } catch (e: any) {
    if (e?.code === 7 || e?.code === 8 || e?.message?.includes("PERMISSION_DENIED") || e?.message?.includes("RESOURCE_EXHAUSTED") || e?.message?.includes("Quota exceeded")) {
      console.error("[LOGGER] Firestore Admin unavailable (Permission/Quota). Disabling Firestore persistence.");
      firestoreEnabled = false;
    } else {
      console.error("[LOGGER] Firestore Admin connectivity check FAILED:", e);
    }
  }
})();

class TradeLogger {
  private async saveLocal(entry: TradeLogEntry | AuditLogEntry, file: string = 'trades_fallback.json') {
    try {
      const fallbackPath = path.join(process.cwd(), file);
      const existing = await fs.readJson(fallbackPath).catch(() => []);
      existing.push(entry);
      await fs.writeJson(fallbackPath, existing);
    } catch (e) {
      console.error("[LOGGER] Local save failed:", e);
    }
  }

  async logAudit(entry: AuditLogEntry) {
    console.log(`[AUDIT] [${entry.type}] ${entry.message}`);
    if (!firestoreEnabled) {
      await this.saveLocal(entry, 'audit_fallback.json');
      return;
    }
    try {
      await auditCollection.add({
        ...entry,
        serverTimestamp: FieldValue.serverTimestamp()
      });
    } catch (err) {
      await this.saveLocal(entry, 'audit_fallback.json');
    }
  }

  async getAuditLogs(): Promise<AuditLogEntry[]> {
    let logs: AuditLogEntry[] = [];
    if (firestoreEnabled) {
      try {
        const snapshot = await auditCollection.orderBy('timestamp', 'desc').limit(50).get();
        logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as AuditLogEntry[];
      } catch (err) {}
    }
    
    try {
      const fallbackPath = path.join(process.cwd(), 'audit_fallback.json');
      if (await fs.pathExists(fallbackPath)) {
        const fallbackLogs = await fs.readJson(fallbackPath);
        logs = [...fallbackLogs.slice(-50), ...logs]
          .sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 50);
      }
    } catch (e) {}

    return logs;
  }

  async logTrade(entry: TradeLogEntry) {
    if (!firestoreEnabled) {
      console.log("[LOGGER] Firestore disabled. Using local storage.");
      await this.saveLocal(entry);
      return;
    }
    try {
      console.log("[LOGGER] Attempting to log trade at:", entry.timestamp);
      const res = await tradesCollection.add({
        ...entry,
        serverTimestamp: FieldValue.serverTimestamp()
      });
      console.log("[LOGGER] Trade successfully logged with ID:", res.id);
    } catch (err) {
      console.error("[LOGGER] FAILED to log trade to Firestore:", err);
      await this.saveLocal(entry);
    }
  }

  async getLogs(): Promise<TradeLogEntry[]> {
    let logs: TradeLogEntry[] = [];
    if (firestoreEnabled) {
      try {
        console.log("[LOGGER] Fetching logs from Firestore Admin...");
        const snapshot = await tradesCollection.orderBy('timestamp', 'desc').limit(100).get();
        console.log(`[LOGGER] Fetched ${snapshot.size} logs.`);
        
        logs = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as TradeLogEntry[];
      } catch (err) {
        console.error("[LOGGER] FAILED to fetch trade logs from Firestore Admin:", err);
      }
    }

    // Always check for local fallback logs
    try {
      const fallbackPath = path.join(process.cwd(), 'trades_fallback.json');
      if (await fs.pathExists(fallbackPath)) {
        const fallbackLogs = await fs.readJson(fallbackPath);
        logs = [...fallbackLogs, ...logs].sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      }
    } catch (e) {}

    return logs;
  }
}

export const tradeLogger = new TradeLogger();
