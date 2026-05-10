/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { adminDb as db } from './firebase-server.ts';
import fs from 'fs-extra';
import path from 'path';

export async function savePersistentData(collectionName: string, id: string, data: any) {
  try {
    const docRef = db.collection(collectionName).doc(id);
    await docRef.set({
      ...data,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    console.log(`[PERSISTENCE] Saved ${collectionName}/${id}`);
  } catch (err) {
    console.error(`[PERSISTENCE] Save failed for ${collectionName}/${id}:`, err);
  }
}

export async function loadPersistentData(collectionName: string, id: string) {
  try {
    const docRef = db.collection(collectionName).doc(id);
    const snap = await docRef.get();
    if (snap.exists) {
      return snap.data();
    }
  } catch (err) {
    console.error(`[PERSISTENCE] Load failed for ${collectionName}/${id}:`, err);
  }
  return null;
}
