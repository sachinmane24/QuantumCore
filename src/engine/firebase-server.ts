/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs-extra';
import path from 'path';

const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
let firebaseConfig = { projectId: 'mock-project', firestoreDatabaseId: '(default)' };
try {
  if (fs.pathExistsSync(configPath)) {
    firebaseConfig = fs.readJsonSync(configPath);
  }
} catch (e) {
  console.error("[FIREBASE-SERVER] Failed to read firebase-applet-config.json:", e);
}

if (!getApps().length && firebaseConfig.projectId && firebaseConfig.projectId !== 'mock-project') {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Ensure the databaseId is used if provided
export const adminDb = getFirestore(firebaseConfig.firestoreDatabaseId === '(default)' ? undefined : firebaseConfig.firestoreDatabaseId);

console.log(`[FIREBASE-SERVER] Initialized Firebase Admin for project: ${firebaseConfig.projectId}, database: ${firebaseConfig.firestoreDatabaseId || 'default'}`);
