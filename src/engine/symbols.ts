/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Symbol registry. The engine is single-symbol-at-a-time; this table holds the
 * per-index constants the rest of the codebase used to hardcode for NIFTY.
 *
 * Add a new symbol by appending an entry — strike step, lot size, instrument
 * tokens, OI-scaling factor, baseline spot for warm-up, etc. all live here.
 */

export type SymbolKey = 'NIFTY' | 'SENSEX';

export interface SymbolSpec {
  key: SymbolKey;
  displayName: string;
  exchange: 'NSE' | 'BSE';
  optionExchange: 'NFO' | 'BFO';
  // Instrument tokens — used to read ticks from the Kite stream.
  // null for the VIX of indices that don't have a dedicated VIX (we proxy INDIA VIX).
  spotToken: number;
  vixToken: number | null;
  lotSize: number;
  strikeStep: number;
  // Tradingsymbol prefix used to filter the Kite instruments dump for this index.
  // Must be an exact prefix match — we additionally reject FINNIFTY/MIDCPNIFTY/etc.
  symbolPrefix: string;
  excludePrefixes: string[];
  // OI threshold scaling — NIFTY's per-strike OI is ~1.0×, SENSEX ~0.3×.
  // Strategy code reads `s.oiScale` and multiplies its absolute thresholds.
  oiScale: number;
  // Daily-range expectancy scaling — used to size wings, SL caps, etc.
  // NIFTY: 1.0; SENSEX moves ~4× the points (higher absolute level).
  pointScale: number;
  // Cap on SL in points for buying strategies (was hardcoded 65 for NIFTY).
  buyingSLCap: number;
  // Mock baseline (only used in MOCK data mode for warm-up).
  mockBaseline: number;
}

export const SYMBOL_SPECS: Record<SymbolKey, SymbolSpec> = {
  NIFTY: {
    key: 'NIFTY',
    displayName: 'Nifty 50',
    exchange: 'NSE',
    optionExchange: 'NFO',
    spotToken: 256265,
    vixToken: 264969,
    lotSize: 75,
    strikeStep: 50,
    symbolPrefix: 'NIFTY',
    excludePrefixes: ['NIFTYIT', 'NIFTYP', 'NIFTYM', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'],
    oiScale: 1.0,
    pointScale: 1.0,
    buyingSLCap: 65,
    mockBaseline: 24000,
  },
  SENSEX: {
    key: 'SENSEX',
    displayName: 'BSE Sensex',
    exchange: 'BSE',
    optionExchange: 'BFO',
    // Sensex spot instrument token on BSE — populated by the server at boot
    // from the instruments dump. We carry 265 as a placeholder; the server
    // resolves the live value when BFO data is fetched.
    spotToken: 265,
    vixToken: 264969, // Use INDIA VIX as proxy — no dedicated SENSEX VIX index.
    lotSize: 20,
    strikeStep: 100,
    symbolPrefix: 'SENSEX',
    excludePrefixes: ['SENSEX50'],
    oiScale: 0.3,
    pointScale: 4.0,
    buyingSLCap: 250,
    mockBaseline: 78000,
  },
};

export const DEFAULT_SYMBOL: SymbolKey = 'NIFTY';

export function getSpec(key: SymbolKey): SymbolSpec {
  return SYMBOL_SPECS[key] || SYMBOL_SPECS[DEFAULT_SYMBOL];
}

export function isValidSymbol(key: string): key is SymbolKey {
  return key in SYMBOL_SPECS;
}
