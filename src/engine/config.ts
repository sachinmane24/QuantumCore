/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

export const ConfigSchema = z.object({
  KITE_API_KEY: z.string().optional(),
  KITE_API_SECRET: z.string().optional(),
  KITE_ACCESS_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  DATA_SOURCE: z.enum(['MOCK', 'LIVE']).default('MOCK'),
  EXECUTION_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),
  AUTO_MODE: z.boolean().default(false),
  TRADING_SYMBOL: z.string().default('NIFTY'),
  LOT_SIZE: z.number().default(65), // Updated for Nifty current lot size
  SL_RUPEES: z.number().default(2000),
  TARGET_RUPEES: z.number().default(4000),
  MAX_ROLLS: z.number().default(2),
  GAMMA_THRESHOLD: z.number().default(0.05), // Threshold to trigger rebalance
  DELTA_TOLERANCE: z.number().default(0.2), // Max net Delta shift before hedging
});

export type Config = z.infer<typeof ConfigSchema>;

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const isValidKey = GEMINI_KEY && GEMINI_KEY !== 'MY_GEMINI_API_KEY' && GEMINI_KEY.length > 10;

export const config: Config = {
  KITE_API_KEY: process.env.KITE_API_KEY,
  KITE_API_SECRET: process.env.KITE_API_SECRET,
  KITE_ACCESS_TOKEN: process.env.KITE_ACCESS_TOKEN,
  GEMINI_API_KEY: isValidKey ? GEMINI_KEY : undefined,
  DATA_SOURCE: 'MOCK',
  EXECUTION_MODE: 'PAPER',
  AUTO_MODE: false,
  TRADING_SYMBOL: 'NIFTY',
  LOT_SIZE: 65,
  SL_RUPEES: 2000,
  TARGET_RUPEES: 4000,
  MAX_ROLLS: 2,
  GAMMA_THRESHOLD: 0.05,
  DELTA_TOLERANCE: 0.2,
};

export const setDataMode = (mode: 'MOCK' | 'LIVE') => {
  config.DATA_SOURCE = mode;
};

export const setExecutionMode = (mode: 'PAPER' | 'LIVE') => {
  config.EXECUTION_MODE = mode;
};

export const setAutoMode = (mode: boolean) => {
  config.AUTO_MODE = mode;
};
