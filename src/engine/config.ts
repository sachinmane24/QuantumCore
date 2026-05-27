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
  LOT_SIZE: z.number().default(65), // Updated for Nifty current standard lot size
  SL_RUPEES: z.number().default(2000),
  TARGET_RUPEES: z.number().default(4000),
  MAX_ROLLS: z.number().default(5),
  GAMMA_THRESHOLD: z.number().default(0.05), // Threshold to trigger rebalance
  DELTA_TOLERANCE: z.number().default(0.2), // Max net Delta shift before hedging
  
  // Advanced Risk Parameters
  CAPITAL_BASE: z.number().default(1000000),
  MAX_TRADES_PER_DAY: z.number().default(15),
  DAILY_LOSS_LIMIT: z.number().default(10000), // Max loss for entire day
  DAILY_PROFIT_LOCK: z.number().default(15000), // Lock 70% of profit after hitting this
  MAX_RISK_PER_TRADE_PCT: z.number().default(1), // 1% of capital per trade
  CONSECUTIVE_LOSS_LIMIT: z.number().default(3),
  START_TIME: z.string().default("09:15"),
  END_TIME: z.string().default("15:15"),
  MAX_PORTFOLIO_HEAT: z.number().default(5), // Max aggregate exposure %
  MAX_VEGA_LIMIT: z.number().default(500),
  MAX_DELTA_LIMIT: z.number().default(2.0),
  MIN_CREDIT_PREMIUM: z.number().default(5.0), // Don't sell anything below 5 rupees
  EXPIRY_NO_TRADE_TIME: z.string().default("14:30"), // Stop entering on expiry after 2:30 PM
  BTST_MODE: z.boolean().default(false), // If true, skips auto-square-off for overnight holding
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const safeProcessEnv = typeof process !== 'undefined' ? process.env : {};

const GEMINI_KEY = safeProcessEnv.GEMINI_API_KEY;
const isValidKey = GEMINI_KEY && GEMINI_KEY !== 'MY_GEMINI_API_KEY' && GEMINI_KEY.length > 10;

export const config: Config = {
  KITE_API_KEY: safeProcessEnv.KITE_API_KEY,
  KITE_API_SECRET: safeProcessEnv.KITE_API_SECRET,
  KITE_ACCESS_TOKEN: safeProcessEnv.KITE_ACCESS_TOKEN,
  GEMINI_API_KEY: isValidKey ? GEMINI_KEY : undefined,
  DATA_SOURCE: 'MOCK',
  EXECUTION_MODE: 'PAPER',
  AUTO_MODE: false, // SAFETY: always starts OFF — must be explicitly enabled via UI or /toggle-auto-mode
  TRADING_SYMBOL: 'NIFTY',
  LOT_SIZE: 65,
  SL_RUPEES: 2000,
  TARGET_RUPEES: 4000,
  MAX_ROLLS: 5,
  GAMMA_THRESHOLD: 0.05,
  DELTA_TOLERANCE: 0.8,
  
  // Risk Defaults
  CAPITAL_BASE: 1000000,
  MAX_TRADES_PER_DAY: 15,
  DAILY_LOSS_LIMIT: 10000,
  DAILY_PROFIT_LOCK: 15000,
  MAX_RISK_PER_TRADE_PCT: 1,
  CONSECUTIVE_LOSS_LIMIT: 3,
  START_TIME: "09:15",
  END_TIME: "15:15",
  MAX_PORTFOLIO_HEAT: 5,
  MAX_VEGA_LIMIT: 500,
  MAX_DELTA_LIMIT: 2.0,
  MIN_CREDIT_PREMIUM: 5.0,
  EXPIRY_NO_TRADE_TIME: "14:30",
  BTST_MODE: false,
  TELEGRAM_BOT_TOKEN: safeProcessEnv.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: safeProcessEnv.TELEGRAM_CHAT_ID,
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

export const updateConfig = (newConfig: Partial<Config>) => {
  Object.assign(config, newConfig);
};

/**
 * Strike interval (points between adjacent strikes) per underlying.
 * Used everywhere Math.round(spot / 50) * 50 appeared — now symbol-aware.
 * NIFTY: 50 | BANKNIFTY: 100 | FINNIFTY: 50 | MIDCPNIFTY: 25
 */
export const STRIKE_STEP: Record<string, number> = {
  NIFTY:      50,
  BANKNIFTY:  100,
  FINNIFTY:   50,
  MIDCPNIFTY: 25,
};

/** Returns the correct strike step for the currently configured TRADING_SYMBOL. */
export function getStrikeStep(): number {
  return STRIKE_STEP[config.TRADING_SYMBOL] ?? 50;
}
