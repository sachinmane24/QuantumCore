/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs-extra';
import path from 'path';

const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = fs.readJsonSync(configPath);

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Ensure the databaseId is used if provided
export const adminDb = getFirestore(firebaseConfig.firestoreDatabaseId === '(default)' ? undefined : firebaseConfig.firestoreDatabaseId);

console.log(`[FIREBASE-SERVER] Initialized Firebase Admin for project: ${firebaseConfig.projectId}, database: ${firebaseConfig.firestoreDatabaseId || 'default'}`);
