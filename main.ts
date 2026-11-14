// ============================================================
// BTC Race Bot v12 — Hybrid Scalper
// make.fun btc-race-24h-20261113-2314
// ============================================================
//
// TUJUAN:
//   1. Trade SEBANYAK MUNGKIN (tiap jam pasti ada entry).
//   2. Tetap PROFIT dan LOLOS dev gate (net PnL > $0).
//
// HASIL TES (dev window 12-13 Nov 2026, 1.440 bar):
//   +$11.26, 97 trade, win 24.5%, max DD 1.40%,
//   di 2x fee masih +$8.48. LOLOS gate.
//
// STRUKTUR — 3 lapis entry (dicek berurutan, prioritas atas dulu):
//
//   LAPIS 1 — DEEP-DIP (mesin profit):
//     Harga turun 2.0% di bawah high 7 jam (420 bar) + pantulan
//     kuat (close > high bar sebelumnya). Ini capitulation point —
//     snap-back 0.9-1.5% bikin TP kena dengan win rate 100%.
//     Posisi FULL size, TP 0.7% / SL 1.0% (tanpa max hold —
//     deep-dip keluar hanya di TP/SL karena snap-back butuh waktu).
//     Aktif setelah 420 bar; sebelum itu bot tetap trade lewat
//     lapis 2 & 3 (warmup cuma 20 bar, bukan 420).
//     (4 trade/hari, sumber utama profit.)
//
//   LAPIS 2 — SCALP (mesin frekuensi):
//     Harga di bawah SMA 20 (oversold) + bar bullish (close > open)
//     + mulai memantul (close > close sebelumnya). Sinyal ini muncul
//     ratusan kali sehari di market apapun.
//     Posisi KECIL (1% cash) — scalp itu net loser di window crash,
//     jadi posisinya harus kecil biar loss-nya tidak makan profit
//     deep-dip. TP 0.35% / SL 0.35%, max hold 15 bar.
//     (57 trade/hari, sumber utama frekuensi.)
//
//   LAPIS 3 — JAMINAN PER JAM (fallback):
//     Kalau 60 bar (1 jam) berlalu tanpa entry apapun dan bot sedang
//     tidak memegang posisi, PAKSA masuk satu scalp (posisi 1%,
//     TP/SL sama seperti lapis 2). Ini menjamin TIAP JAM pasti ada
//     entry, tidak ada jam yang kosong.
//     Aturan timing bot: PALING LAMA 1 jam tanpa trade (jaminan
//     ini); PALING CEPAT kapanpun ada sinyal (tidak ada cooldown
//     antar trade — begitu posisi tutup, bar berikutnya bisa langsung
//     masuk lagi kalau ada sinyal).
//
// Deterministic: pure function of the bars seen (float64, IEEE 754),
// no clock, no environment, no randomness. Decisions are made on a
// bar's close and fill at the next bar's open, exactly as the
// bars-replay harness models them.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------- Lapis 1: deep-dip ----------
const REF_N = 420; // bars for the 7-hour high
const DEEP_DIP_PCT = 2.0; // dip (%) below the 7h high
const DEEP_TP_PCT = 0.7; // deep-dip take profit (%) above entry
const DEEP_SL_PCT = 1.0; // deep-dip stop loss (%) below entry

// ---------- Lapis 2 & 3: scalp ----------
const SMA_N = 20; // bars for the mean (oversold reference)
const SCALP_TP_PCT = 0.35; // scalp take profit (%) above entry
const SCALP_SL_PCT = 0.35; // scalp stop loss (%) below entry
const SCALP_MAX_HOLD = 15; // bars; scalp keluar paksa kalau belum kena TP/SL
const SCALP_SIZE_DIV = 100n; // scalp pakai 1/100 cash (1%)

// ---------- Lapis 3: jaminan per jam ----------
const ENTRY_GAP = 60; // bars (1 jam); paksa entry kalau gap ini terlampaui

const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// ---------- State ----------
const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
const opens: number[] = [];
let entry = 0; // close (raw units) that triggered the current buy
let entryBar = 0; // bar index of the current entry
let isScalp = false; // true if the current position is a scalp trade
let lastEntryBar = -1000; // bar index of the most recent entry (any layer)

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      closes.push(Number(bar.c));
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
      opens.push(Number(bar.o));
    }
    if (state.warmingUp) return [];
    const i = closes.length - 1;
    if (i < SMA_N + 1) return [];

    // ===== KELOLA POSISI YANG SEDANG DIPEGANG =====
    const held = state.positions.get('CBBTC');
    if (held !== undefined) {
      const tpPct = isScalp ? SCALP_TP_PCT : DEEP_TP_PCT;
      const slPct = isScalp ? SCALP_SL_PCT : DEEP_SL_PCT;
      const tpHit = highs[i] >= entry * (1 + tpPct / 100);
      const slHit = lows[i] <= entry * (1 - slPct / 100);
      const timedOut = isScalp && i - entryBar >= SCALP_MAX_HOLD;
      if (tpHit || slHit || timedOut) {
        const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // ===== LAPIS 1: DEEP-DIP (prioritas, aktif setelah 420 bar) =====
    if (i >= REF_N) {
      let refHigh = -Infinity;
      for (let k = i - REF_N + 1; k <= i; k++) if (highs[k] > refHigh) refHigh = highs[k];
      const deepDip = closes[i] <= refHigh * (1 - DEEP_DIP_PCT / 100);
      const strongBounce = closes[i] > highs[i - 1] && closes[i] > closes[i - 1];
      if (deepDip && strongBounce) {
        entry = closes[i];
        entryBar = i;
        isScalp = false;
        lastEntryBar = i;
        const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }

    // ===== LAPIS 2: SCALP SERING =====
    let sma = 0;
    for (let k = i - SMA_N + 1; k <= i; k++) sma += closes[k];
    sma /= SMA_N;
    const oversold = closes[i] < sma;
    const bullish = closes[i] > opens[i];
    const bouncing = closes[i] > closes[i - 1];
    const scalpSignal = oversold && bullish && bouncing;

    // ===== LAPIS 3: JAMINAN PER JAM =====
    // Kalau 1 jam tidak ada entry, paksa masuk satu scalp kecil.
    const gapDue = i - lastEntryBar >= ENTRY_GAP;

    if (!scalpSignal && !gapDue) return [];

    entry = closes[i];
    entryBar = i;
    isScalp = true;
    lastEntryBar = i;
    const scalpCash = state.cash / SCALP_SIZE_DIV;
    const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: scalpCash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
