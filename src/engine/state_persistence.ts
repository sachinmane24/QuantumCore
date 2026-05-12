/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { savePersistentData, loadPersistentData } from './persistence.ts';
import type { ExecutionState } from './types.ts';

export class StatePersistenceManager {
  static async syncState(state: ExecutionState) {
    try {
      await savePersistentData('engine_state', 'current', state);
    } catch (err) {
      console.error("[STATE_PERSISTENCE] Failed to sync state:", err);
    }
  }

  static async loadState(): Promise<ExecutionState | null> {
    try {
      const data = await loadPersistentData('engine_state', 'current');
      if (data) {
        console.log("[STATE_PERSISTENCE] Successfully loaded engine state.");
        return data as ExecutionState;
      }
    } catch (err) {
      console.error("[STATE_PERSISTENCE] Failed to load state:", err);
    }
    return null;
  }

  static async saveRiskStats(stats: any) {
    try {
      await savePersistentData('risk_stats', 'current', stats);
    } catch (err) {
      console.error("[STATE_PERSISTENCE] Failed to save risk stats:", err);
    }
  }

  static async loadRiskStats(): Promise<any | null> {
    try {
      const data = await loadPersistentData('risk_stats', 'current');
      if (data) {
        return data;
      }
    } catch (err) {
      console.error("[STATE_PERSISTENCE] Failed to load risk stats:", err);
    }
    return null;
  }
}
