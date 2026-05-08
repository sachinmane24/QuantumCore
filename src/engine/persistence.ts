/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc,
  collection
} from 'firebase/firestore';
import fs from 'fs-extra';
import path from 'path';

const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = fs.readJsonSync(configPath);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

export async function savePersistentData(collectionName: string, id: string, data: any) {
  try {
    const docRef = doc(db, collectionName, id);
    await setDoc(docRef, {
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
    const docRef = doc(db, collectionName, id);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    console.error(`[PERSISTENCE] Load failed for ${collectionName}/${id}:`, err);
  }
  return null;
}
