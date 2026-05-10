/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { adminDb as db } from './firebase-server.ts';
import fs from 'fs-extra';
import path from 'path';

let firestoreEnabled = true;

const LOCAL_STORAGE_DIR = path.join(process.cwd(), 'persistence_fallback');
fs.ensureDirSync(LOCAL_STORAGE_DIR);

export async function savePersistentData(collectionName: string, id: string, data: any) {
  const localPath = path.join(LOCAL_STORAGE_DIR, `${collectionName}_${id}.json`);
  
  if (firestoreEnabled) {
    try {
      const docRef = db.collection(collectionName).doc(id);
      await docRef.set({
        ...data,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      console.log(`[PERSISTENCE] Saved ${collectionName}/${id} to Cloud`);
      return;
    } catch (err: any) {
      if (err?.code === 7 || err?.code === 8 || err?.message?.includes("PERMISSION_DENIED") || err?.message?.includes("RESOURCE_EXHAUSTED") || err?.message?.includes("Quota exceeded")) {
        console.error(`[PERSISTENCE] Cloud unavailable for ${collectionName}/${id}. Falling back to local.`);
        firestoreEnabled = false;
      } else {
        console.error(`[PERSISTENCE] Save failed for ${collectionName}/${id}:`, err);
      }
    }
  }

  // Local fallback
  try {
    await fs.writeJson(localPath, { ...data, updatedAt: new Date().toISOString() });
    console.log(`[PERSISTENCE] Saved ${collectionName}/${id} to Local Fallback`);
  } catch (localErr) {
    console.error(`[PERSISTENCE] Local save failed:`, localErr);
  }
}

export async function loadPersistentData(collectionName: string, id: string) {
  const localPath = path.join(LOCAL_STORAGE_DIR, `${collectionName}_${id}.json`);

  if (firestoreEnabled) {
    try {
      const docRef = db.collection(collectionName).doc(id);
      const snap = await docRef.get();
      if (snap.exists) {
        return snap.data();
      }
    } catch (err: any) {
      if (err?.code === 7 || err?.code === 8 || err?.message?.includes("PERMISSION_DENIED") || err?.message?.includes("RESOURCE_EXHAUSTED") || err?.message?.includes("Quota exceeded")) {
        console.error(`[PERSISTENCE] Cloud unavailable for loading ${collectionName}/${id}. Checking local.`);
        firestoreEnabled = false;
      } else {
        console.error(`[PERSISTENCE] Load failed for ${collectionName}/${id}:`, err);
      }
    }
  }

  // Local fallback check
  try {
    if (await fs.pathExists(localPath)) {
      console.log(`[PERSISTENCE] Loaded ${collectionName}/${id} from Local Fallback`);
      return await fs.readJson(localPath);
    }
  } catch (localErr) {
    console.error(`[PERSISTENCE] Local load failed:`, localErr);
  }

  return null;
}
