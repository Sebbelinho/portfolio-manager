const { useState, useCallback, useEffect, useRef } = React;

/* ═══ BUILD INFO ═══ */
const BUILD_TIMESTAMP = "18.03.2026, 00:42 Uhr";

/* ═══ HELPERS ═══ */
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const API_DELAY = 15000;

/* ═══ STORAGE ═══ */
const STORE_KEY = "portfolio-monitor-v4";
const API_KEY_KEY = "portfolio-monitor-apikey";

function saveData(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { console.error("Save error:", e); }
}

function loadData() {
  try {
    const r = localStorage.getItem(STORE_KEY);
    if (!r) return null;
    const d = JSON.parse(r);
    if (d && d.analysis && typeof d.analysis.explanation === "string") {
      const ex = d.analysis.explanation;
      if (ex.includes('"overallStatus"') || ex.includes('"capexTrend"') || ex.startsWith("```") || ex.startsWith("{")) {
        d.analysis = null;
      }
    }
    return d;
  } catch { return null; }
}

function getApiKey() { return localStorage.getItem(API_KEY_KEY) || ""; }
function setApiKey(key) { localStorage.setItem(API_KEY_KEY, key); }

const FINNHUB_KEY_KEY = "portfolio-monitor-finnhubkey";
function getFmpKey() { return localStorage.getItem(FINNHUB_KEY_KEY) || ""; }
function setFmpKey(key) { localStorage.setItem(FINNHUB_KEY_KEY, key); }

const FRED_KEY_KEY = "portfolio-monitor-fredkey";
function getFredKey() { return localStorage.getItem(FRED_KEY_KEY) || ""; }
function setFredKey(key) { localStorage.setItem(FRED_KEY_KEY, key); }

const FRED_PROXY_KEY = "portfolio-monitor-fredproxy";
function getFredProxy() { return localStorage.getItem(FRED_PROXY_KEY) || ""; }
function setFredProxy(url) { localStorage.setItem(FRED_PROXY_KEY, url); }
function fredProxyUrl() {
  const custom = getFredProxy();
  if (custom) return custom.replace(/\/+$/, "") + "/fred";
  return "/fred-proxy";
}

async function fetchEurUsdRate() {
  // Primär: ECB-Referenzkurs (kostenlos, kein Key nötig)
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?from=USD&to=EUR");
    const data = await r.json();
    if (data?.rates?.EUR) return data.rates.EUR;
  } catch (e) { console.error("EUR/USD fetch error:", e); }
  return null;
}

/* ═══ FRED API (Macro-Daten) ═══ */
const FRED_SERIES = {
  fedFundsRate: "FEDFUNDS",
  treasury2y: "DGS2",
  treasury10y: "DGS10",
  cpiYoy: "CPIAUCSL",
  corePce: "PCEPILFE",
  gdp: "GDP",
  unemployment: "UNRATE",
};

async function fetchFredSeries(seriesId, fredKey, limit = 2) {
  const url = `${fredProxyUrl()}?series_id=${seriesId}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FRED ${seriesId}: ${r.status}`);
  const data = await r.json();
  return (data.observations || []).map(o => ({ date: o.date, value: o.value !== "." ? parseFloat(o.value) : null })).filter(o => o.value !== null);
}

async function fetchFredData() {
  const fredKey = getFredKey();
  if (!fredKey) return null;
  const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts, label: "FRED Macro-Daten", status: "pending", fred: true, tokens: 0 });
  const dbIdx = _debugLog.length - 1;
  try {
    const results = {};
    const entries = Object.entries(FRED_SERIES);
    // Fetch all series in parallel
    const fetched = await Promise.all(entries.map(([key, sid]) => fetchFredSeries(sid, fredKey).then(obs => [key, obs]).catch(() => [key, []])));
    for (const [key, obs] of fetched) {
      if (obs.length > 0) {
        results[key] = { current: obs[0].value, date: obs[0].date, previous: obs.length > 1 ? obs[1].value : null, previousDate: obs.length > 1 ? obs[1].date : null };
      }
    }
    // Derived: Yield Spread
    if (results.treasury10y && results.treasury2y) {
      results.yieldSpread = { current: +(results.treasury10y.current - results.treasury2y.current).toFixed(2), status: (results.treasury10y.current - results.treasury2y.current) > 0.5 ? "normal" : (results.treasury10y.current - results.treasury2y.current) > 0 ? "flat" : "inverted" };
    }
    // CPI YoY: FRED gives index level, we compute YoY change from current vs 12 months ago
    // For simplicity, we'll fetch 13 observations to compute YoY
    if (fredKey) {
      try {
        const cpiObs = await fetchFredSeries("CPIAUCSL", fredKey, 13);
        if (cpiObs.length >= 13) {
          const cpiYoy = ((cpiObs[0].value - cpiObs[12].value) / cpiObs[12].value * 100);
          results.cpiYoy = { ...results.cpiYoy, yoy: +cpiYoy.toFixed(1) };
        }
        const pceObs = await fetchFredSeries("PCEPILFE", fredKey, 13);
        if (pceObs.length >= 13) {
          const pceYoy = ((pceObs[0].value - pceObs[12].value) / pceObs[12].value * 100);
          results.corePce = { ...results.corePce, yoy: +pceYoy.toFixed(1) };
        }
      } catch {}
    }
    const parts = [];
    if (results.fedFundsRate) parts.push(`Fed ${results.fedFundsRate.current}%`);
    if (results.yieldSpread) parts.push(`Spread ${results.yieldSpread.current}%`);
    if (results.unemployment) parts.push(`Unemp ${results.unemployment.current}%`);
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "ok", code: 200, label: `FRED: ${parts.join(" | ")}` };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return results;
  } catch (e) {
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return null;
  }
}

/* ═══ VIX + Sektor-ETFs via Finnhub ═══ */
// VIXY = VIX-Proxy-ETF (ProShares), da Finnhub Free kein ^VIX unterstützt
const MARKET_TICKERS = { vix: "VIXY", xlk: "XLK", smh: "SMH", spy: "SPY" };

async function fetchMarketIndicators() {
  const token = getFmpKey();
  if (!token) return null;
  const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts, label: "VIX + Sektor-ETFs", status: "pending", fmp: true, tokens: 0 });
  const dbIdx = _debugLog.length - 1;
  try {
    const results = {};
    const failed = [];
    for (const [key, symbol] of Object.entries(MARKET_TICKERS)) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${token}`);
        const q = await r.json();
        if (q && q.c && q.c > 0) {
          results[key] = { price: q.c, change: q.d, changePct: q.dp, prevClose: q.pc };
        } else {
          failed.push(`${symbol}(keine Daten)`);
        }
      } catch (e) {
        failed.push(`${symbol}(${e.message})`);
      }
    }
    const parts = [];
    if (results.vix) parts.push(`VIX ${results.vix.price}`);
    if (results.xlk) parts.push(`XLK ${results.xlk.changePct > 0 ? "+" : ""}${results.xlk.changePct?.toFixed(1)}%`);
    if (results.smh) parts.push(`SMH ${results.smh.changePct > 0 ? "+" : ""}${results.smh.changePct?.toFixed(1)}%`);
    if (failed.length > 0) parts.push(`⚠ ${failed.join(", ")}`);
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: failed.length > 0 && parts.length === failed.length ? "error" : "ok", code: 200, label: `Markt: ${parts.join(" | ")}` };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return results;
  } catch (e) {
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return null;
  }
}

async function fetchStockData(tickers) {
  const token = getFmpKey();
  if (!token) return {};
  const results = {};
  for (const ticker of tickers) {
    const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    debugPush({ ts, label: `${ticker} (quote + metrics)`, status: "pending", fmp: true, tokens: 0 });
    const dbIdx = _debugLog.length - 1;
    try {
      const [quoteRes, metricsRes, recoRes, earningsRes] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${token}`),
        fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${token}`),
        fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${token}`),
        fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${token}`),
      ]);
      const q = await quoteRes.json();
      const metricsData = await metricsRes.json();
      const m = metricsData?.metric || {};
      const recoData = await recoRes.json();
      const earningsData = await earningsRes.json();

      if (q && q.c && q.c > 0) {
        const fmpVal = (v) => (v !== null && v !== undefined && v !== "NULL" && v !== "" && !isNaN(v)) ? Number(v) : null;
        let yearHigh = fmpVal(m["52WeekHigh"]);
        const yearLow = fmpVal(m["52WeekLow"]);
        // Fallback: wenn Kurs über 52wH liegt, ist das 52wH offensichtlich falsch
        if (yearHigh && q.c > yearHigh) yearHigh = q.c;

        // Analyst consensus (latest entry)
        const reco = Array.isArray(recoData) && recoData.length > 0 ? recoData[0] : null;
        const consensus = reco ? { strongBuy: reco.strongBuy || 0, buy: reco.buy || 0, hold: reco.hold || 0, sell: reco.sell || 0, strongSell: reco.strongSell || 0 } : null;
        let consensusLabel = null;
        if (consensus) {
          const total = consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell;
          if (total > 0) {
            const score = (consensus.strongBuy * 5 + consensus.buy * 4 + consensus.hold * 3 + consensus.sell * 2 + consensus.strongSell * 1) / total;
            consensusLabel = score >= 4.5 ? "Strong Buy" : score >= 3.5 ? "Buy" : score >= 2.5 ? "Hold" : score >= 1.5 ? "Sell" : "Strong Sell";
          }
        }

        // Earnings surprises (last 4 quarters)
        const earningsArr = Array.isArray(earningsData) ? earningsData.slice(0, 4) : [];
        const surprises = earningsArr.map(e => fmpVal(e.surprisePercent)).filter(v => v !== null);
        const beatCount = surprises.filter(v => v > 0).length;
        const avgSurprise = surprises.length > 0 ? surprises.reduce((a, b) => a + b, 0) / surprises.length : null;

        const entry = {
          price: q.c,
          yearHigh,
          yearLow,
          change: q.d,
          changePct: q.dp,
          marketCap: fmpVal(m.marketCapitalization),
          fromHigh: yearHigh ? ((1 - q.c / yearHigh) * 100).toFixed(1) : null,
          peRatio: fmpVal(m.peBasicExclExtraTTM) ?? fmpVal(m.peNormalizedAnnual),
          forwardPE: fmpVal(m.peNormalizedAnnual),
          pegRatio: fmpVal(m.pegAnnual),
          pbRatio: fmpVal(m.pbAnnual),
          dividendYield: fmpVal(m.dividendYieldIndicatedAnnual),
          revenueGrowth: fmpVal(m.revenueGrowthQuarterlyYoy),
          netProfitMargin: fmpVal(m.netProfitMarginTTM),
          operatingMargin: fmpVal(m.operatingMarginTTM),
          consensus,
          consensusLabel,
          beatCount,
          avgSurprise: avgSurprise !== null ? Math.round(avgSurprise * 100) / 100 : null,
        };
        const missing = ["peRatio", "pegRatio", "yearHigh"].filter(k => entry[k] === null || entry[k] === undefined);
        if (missing.length > 0) console.warn(`Finnhub ${ticker}: fehlende Kennzahlen: ${missing.join(", ")}`);
        const parts = [`$${q.c}`];
        if (yearHigh !== null) parts.push(`52wH $${yearHigh}`);
        if (entry.peRatio !== null) parts.push(`P/E ${entry.peRatio.toFixed(1)}`);
        if (entry.pegRatio !== null) parts.push(`PEG ${entry.pegRatio.toFixed(2)}`);
        if (consensusLabel) parts.push(consensusLabel);
        if (beatCount > 0) parts.push(`${beatCount}/4 beats`);
        if (missing.length > 0) parts.push(`⚠${missing.length} fehlend`);
        _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "ok", code: 200, label: `${ticker}: ${parts.join(" | ")}` };
        _debugListeners.forEach(fn => fn([..._debugLog]));
        results[ticker] = entry;
      } else {
        _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: quoteRes.status, detail: "Keine Kursdaten" };
        _debugListeners.forEach(fn => fn([..._debugLog]));
      }
    } catch (e) {
      _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
      _debugListeners.forEach(fn => fn([..._debugLog]));
    }
  }
  return results;
}

async function verify52WeekHighs(stockData) {
  const tickers = Object.keys(stockData);
  if (tickers.length === 0) return stockData;
  const tickerList = tickers.map(t => `${t}: Finnhub=$${stockData[t].yearHigh ?? "n/a"}`).join(", ");
  const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts, label: `52wH Verifizierung: ${tickers.length} Ticker`, status: "pending", search: true, tokens: 500 });
  const dbIdx = _debugLog.length - 1;
  try {
    const raw = await callAPI(
      `Look up the current 52-week high price (in USD) for each of these stocks: ${tickers.join(", ")}.

Current Finnhub values for reference (may be stale/incorrect): ${tickerList}

Respond ONLY with raw JSON, no backticks:
{"highs":{"TICKER":123.45}}
Include ALL tickers. Use the actual 52-week high from current market data.`,
      "Financial data analyst. Use web_search to find accurate 52-week high prices. Respond with ONLY raw JSON.",
      true,
      500
    );
    const j = extractJSON(raw);
    if (j && j.highs) {
      const corrections = [];
      const updated = { ...stockData };
      for (const [ticker, newHigh] of Object.entries(j.highs)) {
        if (updated[ticker] && typeof newHigh === "number" && newHigh > 0) {
          const old = updated[ticker].yearHigh;
          if (old === null || Math.abs(newHigh - old) / (old || 1) > 0.02) {
            corrections.push(`${ticker}: $${old ?? "n/a"}→$${newHigh}`);
            updated[ticker] = {
              ...updated[ticker],
              yearHigh: newHigh,
              fromHigh: ((1 - updated[ticker].price / newHigh) * 100).toFixed(1),
            };
          }
        }
      }
      _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "ok", code: 200, label: corrections.length > 0
        ? `52wH korrigiert: ${corrections.join(", ")}`
        : `52wH verifiziert: alle ${tickers.length} Werte korrekt` };
      _debugListeners.forEach(fn => fn([..._debugLog]));
      return updated;
    }
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: "Kein gültiges JSON" };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return stockData;
  } catch (e) {
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return stockData;
  }
}

async function fetchInsiderData(tickers) {
  const token = getFmpKey();
  if (!token) return {};
  const results = {};
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  for (const ticker of tickers) {
    const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    debugPush({ ts, label: `${ticker} Insider`, status: "pending", fmp: true, tokens: 0 });
    const dbIdx = _debugLog.length - 1;
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&token=${token}`);
      const data = await r.json();
      const txns = (data?.data || []).filter(t => t.transactionDate >= cutoff);
      const sells = txns.filter(t => t.change < 0);
      const buys = txns.filter(t => t.change > 0);
      const sellVolume = sells.reduce((s, t) => s + Math.abs(t.change) * (t.transactionPrice || 0), 0);
      const buyVolume = buys.reduce((s, t) => s + t.change * (t.transactionPrice || 0), 0);
      results[ticker] = {
        totalSells: sells.length,
        totalBuys: buys.length,
        sellVolume: Math.round(sellVolume),
        buyVolume: Math.round(buyVolume),
      };
      const label = `${ticker}: ${sells.length} Verkäufe${sellVolume > 0 ? ` ($${(sellVolume/1e6).toFixed(1)}M)` : ""}, ${buys.length} Käufe`;
      _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "ok", code: 200, label };
      _debugListeners.forEach(fn => fn([..._debugLog]));
    } catch (e) {
      _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
      _debugListeners.forEach(fn => fn([..._debugLog]));
    }
  }
  return results;
}

// Hyperscaler-Ticker für CapEx-Trajectory (immer im Kalender + als "kritisch" markiert)
const HYPERSCALER_TICKERS = ["GOOGL", "META", "MSFT", "AMZN", "TSM"];

async function fetchEarningsCalendar(token, portfolioTickers) {
  if (!token) return [];
  const today = new Date();
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10);
  const allTickers = [...new Set([...portfolioTickers, ...HYPERSCALER_TICKERS])];
  const criticalTickers = new Set(allTickers);
  const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts, label: `Earnings-Kalender: ${allTickers.length} Ticker (${from} → ${to})`, status: "pending", fmp: true, tokens: 0 });
  const dbIdx = _debugLog.length - 1;
  try {
    const results = await Promise.all(allTickers.map(async (sym) => {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${sym}&from=${from}&to=${to}&token=${token}`);
        const data = await r.json();
        return (data?.earningsCalendar || []).map(e => ({ ...e, _sym: sym }));
      } catch { return []; }
    }));
    const all = results.flat();
    const filtered = all.map(e => {
      const d = new Date(e.date);
      const day = String(d.getDate()).padStart(2, "0");
      const months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
      return {
        d: `${day}. ${months[d.getMonth()]}`,
        e: `${e.symbol} Q${e.quarter} FY${e.year} Earnings`,
        c: criticalTickers.has(e.symbol),
        date: e.date,
        epsEstimate: e.epsEstimate,
        revenueEstimate: e.revenueEstimate,
      };
    }).sort((a, b) => a.date.localeCompare(b.date));
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "ok", code: 200, label: `Earnings: ${filtered.length} Termine gefunden (${allTickers.length} Ticker abgefragt)` };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return filtered;
  } catch (e) {
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return [];
  }
}

const PH = [
  { n: "Grün", co: "#22c55e", i: "✦", t: "Alle Indikatoren positiv, CapEx steigt", a: "DCA fortsetzen, volle Exposition halten" },
  { n: "Gelb", co: "#eab308", i: "◈", t: "1–2 Warnsignale, gemischte Datenlage", a: "DCA pausieren, riskanteste Positionen evaluieren, Stop-Losses setzen" },
  { n: "Orange", co: "#f97316", i: "◆", t: "≥3 Warnsignale, CapEx-Plateau", a: "Schwächste Positionen -50%, in defensive Werte umschichten" },
  { n: "Rot", co: "#ef4444", i: "▲", t: "CapEx-Kürzungen bei ≥2 Hyperscalern", a: "Nur Wide-Moat-Positionen halten, Rest liquidieren, Welt-ETF" },
];

/* ═══ API ═══ */
function stripTags(str) {
  if (!str) return str;
  return str.replace(/<\/?[^>]+>/gi, "").replace(/\s{2,}/g, " ").trim();
}

function extractJSON(raw) {
  if (!raw) return null;
  let s = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  s = stripTags(s).trim();
  const firstBrace = s.indexOf("{");
  if (firstBrace > 0) s = s.slice(firstBrace);
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace >= 0 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.replace(/\n/g, " ")); } catch {}
  try { return JSON.parse(s.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")); } catch {}
  return null;
}

function cleanText(s) {
  if (!s) return s;
  return s.replace(/<\/?[^>]+(>|$)/g, "").replace(/\s{2,}/g, " ").trim();
}

/* ═══ DEBUG LOG ═══ */
let _debugListeners = [];
let _debugLog = [];
function debugPush(entry) {
  _debugLog.push({ ...entry, _t: Date.now() });
  _debugListeners.forEach(fn => fn([..._debugLog]));
}
function debugClear() { _debugLog = []; _debugListeners.forEach(fn => fn([])); }
function debugSaveToServer(stocks, finnhubData, eurUsdRate) {
  const plDiag = stocks.map(s => {
    const fhd = finnhubData[s.ticker];
    const price = fhd?.price;
    const pps = s.pricePerShare;
    const pl = (price && pps && eurUsdRate) ? (((price * eurUsdRate) - pps) / pps * 100).toFixed(1) + "%" : null;
    return {
      ticker: s.ticker, pricePerShare: pps || null, currentPriceUsd: price || null,
      eurUsdRate: eurUsdRate || null, currentPriceEur: price && eurUsdRate ? +(price * eurUsdRate).toFixed(2) : null,
      pl, missing: [!pps && "pricePerShare", !price && "finnhubPrice", !eurUsdRate && "eurUsdRate"].filter(Boolean),
    };
  });
  const payload = { timestamp: new Date().toISOString(), debugLog: _debugLog, performanceDiag: plDiag };
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
}
function useDebugLog() {
  const [log, setLog] = React.useState(_debugLog);
  React.useEffect(() => { _debugListeners.push(setLog); return () => { _debugListeners = _debugListeners.filter(f => f !== setLog); }; }, []);
  return log;
}

async function callAPI(user, sys, useSearch, maxTokens) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Kein API-Key gesetzt. Bitte in den Einstellungen hinterlegen.");
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens || 1000,
    temperature: 0,
    system: sys,
    messages: [{ role: "user", content: user }],
  };
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const label = useSearch ? user.slice(0, 60) : (sys || "").slice(0, 40);
  const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts, label, status: "pending", search: !!useSearch, tokens: maxTokens || 1000 });
  const idx = _debugLog.length - 1;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      _debugLog[idx] = { ..._debugLog[idx], status: "error", code: r.status, detail: r.statusText };
      _debugListeners.forEach(fn => fn([..._debugLog]));
      throw new Error(`API ${r.status}: ${r.statusText}`);
    }
    const d = await r.json();
    _debugLog[idx] = { ..._debugLog[idx], status: "ok", code: 200 };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  } catch (e) {
    if (_debugLog[idx].status === "pending") {
      _debugLog[idx] = { ..._debugLog[idx], status: "error", code: 0, detail: e.message };
      _debugListeners.forEach(fn => fn([..._debugLog]));
    }
    throw e;
  }
}

async function doSearch(query, maxTok) {
  try {
    const raw = await callAPI(
      `Search: "${query}"\nRespond ONLY with raw JSON, no backticks/HTML:\n{"summary":"2-3 sentences","sentiment":"bullish|bearish|neutral","keyPoints":["point1","point2"],"confidence":0.8}`,
      "Financial analyst. Use web_search, then respond with ONLY raw JSON. No HTML, no markdown, no text outside JSON.",
      true,
      maxTok || 500
    );
    const j = extractJSON(raw);
    if (j && j.summary) {
      j.summary = cleanText(j.summary);
      if (j.keyPoints) j.keyPoints = j.keyPoints.map(p => cleanText(String(p)));
      return j;
    }
    return { summary: cleanText(raw || "Keine Ergebnisse").slice(0, 350), sentiment: "neutral", keyPoints: [], confidence: 0.3 };
  } catch (e) {
    return { summary: "Fehler: " + e.message, sentiment: "neutral", keyPoints: [], confidence: 0 };
  }
}

async function doMultiSearch(query, keys) {
  try {
    const keyList = keys.map(k => `"${k}"`).join(", ");
    const raw = await callAPI(
      `Search: "${query}"\nRespond ONLY with raw JSON for each topic (${keyList}), no backticks/HTML:\n{${keys.map(k => `"${k}":{"summary":"2-3 sentences","sentiment":"bullish|bearish|neutral","keyPoints":["point1"],"confidence":0.8}`).join(",")}}`,
      "Financial analyst. Use web_search, then respond with ONLY raw JSON. No HTML, no markdown, no text outside JSON.",
      true,
      Math.min(400 * keys.length, 1200)
    );
    const j = extractJSON(raw);
    if (j) {
      const results = {};
      for (const k of keys) {
        if (j[k] && j[k].summary) {
          j[k].summary = cleanText(j[k].summary);
          if (j[k].keyPoints) j[k].keyPoints = j[k].keyPoints.map(p => cleanText(String(p)));
          results[k] = j[k];
        } else {
          results[k] = { summary: "Keine Daten", sentiment: "neutral", keyPoints: [], confidence: 0.2 };
        }
      }
      return results;
    }
    return Object.fromEntries(keys.map(k => [k, { summary: "Parsing fehlgeschlagen", sentiment: "neutral", keyPoints: [], confidence: 0.2 }]));
  } catch (e) {
    return Object.fromEntries(keys.map(k => [k, { summary: "Fehler: " + e.message, sentiment: "neutral", keyPoints: [], confidence: 0 }]));
  }
}

async function doAnalyze(allData, stockList, fmpData, insiderDataMap, macroData, marketData, capexImpactData, timingData) {
  const capexTickers = stockList.filter(s => s.type === "capex").map(s => s.ticker).join(", ");
  const otherInfo = stockList.filter(s => s.type === "other").map(s => `${s.ticker} (${s.sector})`).join(", ");
  const compact = {};
  if (allData.capex) compact.capex = allData.capex.map(c => ({ label: c.label, sentiment: c.sentiment, summary: (c.summary || "").slice(0, 150) }));
  if (allData.tsmc) compact.tsmc = { sentiment: allData.tsmc.sentiment, summary: (allData.tsmc.summary || "").slice(0, 150) };
  if (allData.dram) compact.dram = { sentiment: allData.dram.sentiment, summary: (allData.dram.summary || "").slice(0, 150) };
  if (allData.nvidia) compact.nvidia = { sentiment: allData.nvidia.sentiment, summary: (allData.nvidia.summary || "").slice(0, 150) };
  if (allData.positions) {
    compact.positions = {};
    for (const [k, v] of Object.entries(allData.positions)) {
      compact.positions[k] = { sentiment: v.sentiment, summary: (v.summary || "").slice(0, 100) };
    }
  }
  if (allData.insider) compact.insider = { sentiment: allData.insider.sentiment, summary: (allData.insider.summary || "").slice(0, 150) };

  let fmpBlock = "";
  if (fmpData && Object.keys(fmpData).length > 0) {
    const peVals = Object.values(fmpData).map(d => d.peRatio).filter(v => v !== null);
    const pegVals = Object.values(fmpData).map(d => d.pegRatio).filter(v => v !== null);
    const avgPE = peVals.length > 0 ? (peVals.reduce((a, b) => a + b, 0) / peVals.length).toFixed(1) : "n/a";
    const avgPEG = pegVals.length > 0 ? (pegVals.reduce((a, b) => a + b, 0) / pegVals.length).toFixed(2) : "n/a";

    const lines = Object.entries(fmpData).map(([t, d]) => {
      let line = `${t}: Kurs=$${d.price}, 52wHoch=$${d.yearHigh ?? "n/a"}, ` +
        `P/E=${d.peRatio ?? "n/a"}, PEG=${d.pegRatio ?? "n/a"}, ` +
        `Umsatzwachstum=${d.revenueGrowth != null ? (d.revenueGrowth * 100).toFixed(1) + "%" : "n/a"}, Nettomarge=${d.netProfitMargin != null ? (d.netProfitMargin * 100).toFixed(1) + "%" : "n/a"}`;
      if (d.consensusLabel) line += `, Konsens=${d.consensusLabel}(${d.consensus.buy}Buy/${d.consensus.hold}Hold/${d.consensus.sell}Sell)`;
      if (d.beatCount != null) line += `, Earnings=${d.beatCount}/4 beats${d.avgSurprise != null ? ` (avg ${d.avgSurprise > 0 ? "+" : ""}${d.avgSurprise}%)` : ""}`;
      return line;
    });
    fmpBlock = `\n\nFundamentaldaten (exakte Zahlen, als Fakten verwenden):\nPortfolio-Durchschnitt: P/E=${avgPE}, PEG=${avgPEG}\n${lines.join("\n")}`;
  }

  // Insider-Daten (strukturiert aus Finnhub)
  let insiderBlock = "";
  if (insiderDataMap && Object.keys(insiderDataMap).length > 0) {
    const insLines = Object.entries(insiderDataMap).map(([t, d]) =>
      `${t}: ${d.totalSells} Verkäufe ($${(d.sellVolume/1e6).toFixed(1)}M), ${d.totalBuys} Käufe ($${(d.buyVolume/1e6).toFixed(1)}M) — letzte 90 Tage`
    );
    insiderBlock = `\n\nInsider-Transaktionen (exakte Daten):\n${insLines.join("\n")}`;
  }

  // Sektor-Konzentration
  const sectorCounts = {};
  stockList.forEach(s => { sectorCounts[s.sector] = (sectorCounts[s.sector] || 0) + 1; });
  const concBlock = `\n\nPortfolio-Konzentration: ${Object.entries(sectorCounts).map(([s, c]) => `${s}: ${c}/${stockList.length}`).join(", ")}`;

  // Macro-Kontext (FRED + VIX + Sektor)
  let macroBlock = "";
  if (macroData) {
    const parts = [];
    if (macroData.fedFundsRate) parts.push(`Fed Funds Rate: ${macroData.fedFundsRate.current}%`);
    if (macroData.treasury2y) parts.push(`Treasury 2Y: ${macroData.treasury2y.current}%`);
    if (macroData.treasury10y) parts.push(`Treasury 10Y: ${macroData.treasury10y.current}%`);
    if (macroData.yieldSpread) parts.push(`Yield Spread (10Y-2Y): ${macroData.yieldSpread.current}% (${macroData.yieldSpread.status})`);
    if (macroData.cpiYoy?.yoy != null) parts.push(`CPI YoY: ${macroData.cpiYoy.yoy}%`);
    if (macroData.corePce?.yoy != null) parts.push(`Core PCE YoY: ${macroData.corePce.yoy}%`);
    if (macroData.gdp) parts.push(`GDP: ${macroData.gdp.current}`);
    if (macroData.unemployment) parts.push(`Arbeitslosenquote: ${macroData.unemployment.current}%`);
    macroBlock = `\n\nMakroökonomische Daten (FRED, exakte Zahlen):\n${parts.join("\n")}`;
  }
  let marketBlock = "";
  if (marketData) {
    const parts = [];
    if (marketData.vix) parts.push(`VIX: ${marketData.vix.price} (${marketData.vix.changePct > 0 ? "+" : ""}${marketData.vix.changePct?.toFixed(1)}%)`);
    if (marketData.xlk) parts.push(`XLK (Tech-ETF): $${marketData.xlk.price} (${marketData.xlk.changePct > 0 ? "+" : ""}${marketData.xlk.changePct?.toFixed(1)}%)`);
    if (marketData.smh) parts.push(`SMH (Halbleiter-ETF): $${marketData.smh.price} (${marketData.smh.changePct > 0 ? "+" : ""}${marketData.smh.changePct?.toFixed(1)}%)`);
    if (marketData.spy) parts.push(`SPY (S&P 500): $${marketData.spy.price} (${marketData.spy.changePct > 0 ? "+" : ""}${marketData.spy.changePct?.toFixed(1)}%)`);
    marketBlock = `\n\nMarktindikatoren (Finnhub, exakte Daten):\n${parts.join("\n")}`;
  }

  let capexImpactBlock = "";
  if (capexImpactData) {
    const cParts = [`Impact: ${capexImpactData.impact} — ${capexImpactData.summary}`];
    if (capexImpactData.guidance_changes) cParts.push(`Guidance-Änderungen: ${capexImpactData.guidance_changes}`);
    if (capexImpactData.winners?.length) cParts.push(`Winners: ${capexImpactData.winners.map(w => `${w.ticker}: ${w.reason}`).join("; ")}`);
    if (capexImpactData.losers?.length) cParts.push(`Losers: ${capexImpactData.losers.map(l => `${l.ticker}: ${l.reason}`).join("; ")}`);
    capexImpactBlock = `\n\nHyperscaler Earnings & CapEx-Implikation:\n${cParts.join("\n")}`;
  }

  let timingBlock = "";
  if (timingData?.stocks) {
    const tLines = timingData.stocks.map(s => `${s.ticker}: ${s.signal} (${s.action}) — ${s.reason}`);
    timingBlock = `\n\nTiming-Bewertung (Opportunity Score: ${timingData.opportunityScore || "?"}/10):\n${tLines.join("\n")}`;
    if (timingData.dcaAdvice) timingBlock += `\nDCA-Empfehlung: ${timingData.dcaAdvice}`;
  }

  try {
    const raw = await callAPI(
      `Portfolio: CapEx-Aktien: ${capexTickers}${otherInfo ? ". Andere: " + otherInfo : ""}
Daten: ${JSON.stringify(compact)}${fmpBlock}${insiderBlock}${concBlock}${macroBlock}${marketBlock}${capexImpactBlock}${timingBlock}

Antworte NUR mit validem JSON. Kein Markdown, keine Backticks, kein Text davor oder danach:
{"overallStatus":"green","explanation":"1-2 Sätze deutsch","capexTrend":"accelerating","alerts":[{"name":"CapEx-Wende","status":"green","detail":"deutsch"},{"name":"TSMC-Trend","status":"green","detail":"deutsch"},{"name":"DRAM-Preise","status":"green","detail":"deutsch"},{"name":"Bewertungsrisiko","status":"yellow","detail":"deutsch"},{"name":"Insider-Aktivität","status":"green","detail":"deutsch"},{"name":"NVIDIA-Guidance","status":"green","detail":"deutsch"},{"name":"Zinsumfeld","status":"green","detail":"deutsch"},{"name":"Marktbreite","status":"green","detail":"deutsch"}],"risks":["deutsch1","deutsch2","deutsch3"],"action":"deutsch","nextEvent":"deutsch"}

overallStatus: green=klar, yellow=1-2 Warnungen, orange=3+, red=bestätigte Kürzungen.
capexTrend: accelerating/stable/decelerating/contracting. Immer 8 alerts. Alles deutsch.
Nutze die Fundamentaldaten für Bewertungsrisiko (P/E, PEG vs. Portfolio-Durchschnitt). Nutze Insider-Daten für Insider-Alert. Berücksichtige Klumpenrisiko bei der Risikoeinschätzung.
Nutze die Makro-Daten für Zinsumfeld-Alert: grün=stabile/fallende Zinsen, gelb=hawkish Signale, rot=aktives Tightening. Nutze VIX + Sektor-ETFs für Marktbreite-Alert: grün=niedrige Vola + Tech stark, gelb=erhöhte Vola, rot=VIX>30 oder Tech deutlich schwächer als S&P.`,
      "Du bist ein Portfolio-Stratege. Antworte NUR mit validem JSON. Kein Markdown. Keine Backticks. Kein Text.",
      false,
      2000
    );
    const j = extractJSON(raw);
    if (j && j.overallStatus) {
      if (j.explanation) j.explanation = cleanText(j.explanation);
      if (j.action) j.action = cleanText(j.action);
      if (j.nextEvent) j.nextEvent = cleanText(j.nextEvent);
      if (j.alerts) j.alerts = j.alerts.map(a => ({ ...a, detail: cleanText(a.detail), name: cleanText(a.name) }));
      if (j.risks) j.risks = j.risks.map(r => cleanText(String(r)));
      return j;
    }
    return { overallStatus: "yellow", explanation: "Analyse konnte nicht strukturiert werden.", capexTrend: "stable", alerts: [{ name: "Parsing", status: "yellow", detail: "JSON-Parsing fehlgeschlagen. Bitte erneut versuchen." }], risks: ["Automatische Analyse fehlgeschlagen"], action: "Einzelergebnisse prüfen", nextEvent: "—" };
  } catch (e) {
    return { overallStatus: "yellow", explanation: "Fehler: " + e.message, capexTrend: "stable", alerts: [{ name: "API-Fehler", status: "red", detail: "Erneut versuchen." }], risks: ["Analyse nicht verfügbar"], action: "Erneut versuchen", nextEvent: "—" };
  }
}

async function doTimingAnalysis(priceData, stockList, fmpData, insiderDataMap, macroData, marketData, extraBudget, dcaMonths, eurUsdRate, capexImpactData) {
  const totalInvested = stockList.reduce((sum, s) => sum + s.cost, 0);
  const stockInfo = stockList.map(s => {
    const pctOfPortfolio = totalInvested > 0 ? (s.cost / totalInvested * 100).toFixed(1) : "0";
    let info = `${s.ticker} (${s.name}, Sektor: ${s.sector}, Investiert: €${s.cost.toFixed(2)}, Anteil: ${pctOfPortfolio}%`;
    if (s.pricePerShare && fmpData[s.ticker]?.price && eurUsdRate) {
      const curEur = fmpData[s.ticker].price * eurUsdRate;
      const curValue = curEur * (s.cost / s.pricePerShare);
      const plPct = ((curEur - s.pricePerShare) / s.pricePerShare * 100).toFixed(1);
      info += `, Ø Kaufpreis: €${s.pricePerShare.toFixed(2)}, Aktuell: €${curEur.toFixed(2)}, Aktueller Wert: €${curValue.toFixed(2)}, P/L: ${plPct}%`;
    }
    if (s.sensitivity) info += `, Sens: ${s.sensitivity}`;
    if (s.moat) info += `, Moat: ${s.moat}`;
    return info + ")";
  }).join("; ");

  let fmpBlock = "";
  if (fmpData && Object.keys(fmpData).length > 0) {
    const lines = Object.entries(fmpData).map(([t, d]) => {
      let line = `${t}: Kurs=$${d.price}, 52wHoch=$${d.yearHigh}, AbstandVomHoch=${d.fromHigh}%, ` +
        `P/E=${d.peRatio ?? "n/a"}, PEG=${d.pegRatio ?? "n/a"}`;
      if (d.consensusLabel) line += `, Konsens=${d.consensusLabel}`;
      if (d.beatCount != null) line += `, Earnings ${d.beatCount}/4 beats`;
      return line;
    });
    fmpBlock = `\n\nExakte Marktdaten (verwende diese Zahlen, NICHT schätzen):\n${lines.join("\n")}`;
  }

  let insiderBlock = "";
  if (insiderDataMap && Object.keys(insiderDataMap).length > 0) {
    const insLines = Object.entries(insiderDataMap).map(([t, d]) =>
      `${t}: ${d.totalSells} Insider-Verkäufe ($${(d.sellVolume/1e6).toFixed(1)}M), ${d.totalBuys} Käufe — 90 Tage`
    );
    insiderBlock = `\n\nInsider-Transaktionen:\n${insLines.join("\n")}`;
  }

  // Macro context for timing
  let macroTimingBlock = "";
  if (macroData || marketData) {
    const parts = [];
    if (macroData?.fedFundsRate) parts.push(`Fed Funds Rate: ${macroData.fedFundsRate.current}%`);
    if (macroData?.yieldSpread) parts.push(`Yield Spread: ${macroData.yieldSpread.current}% (${macroData.yieldSpread.status})`);
    if (macroData?.cpiYoy?.yoy != null) parts.push(`CPI YoY: ${macroData.cpiYoy.yoy}%`);
    if (marketData?.vix) parts.push(`VIX: ${marketData.vix.price}`);
    if (marketData?.xlk && marketData?.spy) {
      const relPerf = (marketData.xlk.changePct - marketData.spy.changePct).toFixed(1);
      parts.push(`Tech vs S&P: ${relPerf > 0 ? "+" : ""}${relPerf}%`);
    }
    if (marketData?.smh && marketData?.spy) {
      const relPerf = (marketData.smh.changePct - marketData.spy.changePct).toFixed(1);
      parts.push(`Semis vs S&P: ${relPerf > 0 ? "+" : ""}${relPerf}%`);
    }
    macroTimingBlock = `\n\nMakro-Kontext (exakte Daten, als Fakten verwenden):\n${parts.join("\n")}`;
  }

  let capexImpactBlock = "";
  if (capexImpactData) {
    const parts2 = [`Gesamt: ${capexImpactData.impact} — ${capexImpactData.summary}`];
    if (capexImpactData.guidance_changes) parts2.push(`Guidance: ${capexImpactData.guidance_changes}`);
    if (capexImpactData.winners?.length) parts2.push(`Winners: ${capexImpactData.winners.map(w => `${w.ticker}: ${w.reason}`).join("; ")}`);
    if (capexImpactData.losers?.length) parts2.push(`Losers: ${capexImpactData.losers.map(l => `${l.ticker}: ${l.reason}`).join("; ")}`);
    capexImpactBlock = `\n\nCapEx-Implikation (aktuelle Hyperscaler-Earnings & Guidance-Änderungen):\n${parts2.join("\n")}`;
  }

  try {
    const raw = await callAPI(
      `Du analysierst Kurs-Timing für ein Portfolio.
Gesamt investiert: €${totalInvested.toFixed(2)} in ${stockList.length} Positionen.
Gleichgewichtung wäre ${(100 / stockList.length).toFixed(1)}% pro Position.

Aktien: ${stockInfo}

Aktuelle Kursdaten: ${JSON.stringify(priceData)}${fmpBlock}${insiderBlock}${macroTimingBlock}${capexImpactBlock}

Für JEDE Aktie: Bewerte ob der aktuelle Kurs eine Nachkaufgelegenheit, Halteposition, oder Gewinnmitnahme-Kandidat ist.
${extraBudget > 0 ? `\nSONDER-VERMÖGEN: €${extraBudget.toFixed(2)} verfügbar für DCA-unabhängige Nachkäufe über ${dcaMonths || 12} Monate.\nEmpfehle konkrete Nachkäufe NUR wenn aktuell wirklich attraktive Gelegenheiten bestehen. Das Budget muss NICHT sofort ausgegeben werden — es kann über den gesamten Zeitraum verteilt werden, zu Beginn, am Ende, oder alles auf einmal, je nach Marktlage. Leeres Array [] wenn aktuell nichts attraktiv genug ist.` : ""}

Antworte NUR mit validem JSON:
{"summary":"1-2 Sätze Gesamteinschätzung deutsch","stocks":[{"ticker":"XXX","action":"nachkaufen|halten|teilverkauf","signal":"strong_buy|buy|hold|take_profit|sell","reason":"1 Satz deutsch","fromHigh":"Abstand vom Hoch in %","momentum":"positiv|neutral|negativ"}],"dcaAdvice":"Empfehlung deutsch","opportunityScore":7${extraBudget > 0 ? ',"extraAllocations":[{"ticker":"XXX","amount":500,"reason":"1 Satz deutsch","detail":"3-5 Sätze Begründung deutsch"}],"noExtraReason":"1 Satz warum keine Sonder-Nachkäufe empfohlen werden (nur wenn extraAllocations leer)"' : ""},"rebalanceTrades":[{"fromTicker":"AAA","toTicker":"BBB","amount":500,"reason":"1 Satz deutsch","detail":"3-5 Sätze Begründung deutsch"}],"noRebalanceReason":"1 Satz warum keine Umschichtungen nötig sind (nur wenn rebalanceTrades leer)","takeProfits":[{"ticker":"XXX","amount":500,"reason":"1 Satz deutsch","detail":"3-5 Sätze Begründung deutsch"}],"noTakeProfitReason":"1 Satz warum keine Gewinnmitnahmen empfohlen werden (nur wenn takeProfits leer)"}

WICHTIG: Übernimm fromHigh exakt aus den Marktdaten oben. Nicht selbst schätzen.
Berücksichtige Insider-Verkäufe als Warnsignal (viele Verkäufe = vorsichtiger bei Nachkauf-Empfehlung).
Berücksichtige den Makro-Kontext: VIX>30 = Angst = tendenziell gute Kaufgelegenheit. Invertierte Yield Curve = Rezessionsrisiko = vorsichtiger. Tech schwächer als S&P = Sektor-Rotation = Warnsignal.
opportunityScore: 1-10 (1=alles teuer, 10=alles im Ausverkauf).
rebalanceTrades: Umschichtungen nur wenn deutlich übergewichtete Positionen vorhanden UND untergewichtete attraktiver bewertet sind. Kann leer [] sein.
takeProfits: Gewinnmitnahmen NUR empfehlen wenn das Gesamtportfolio sich in einem Abwärtstrend befindet oder bärisches Sentiment vorherrscht (Makro-Indikatoren negativ, breiter Markt schwächelt). Bei bullischem Sentiment stattdessen Umschichtung in rebalanceTrades vorschlagen (von überhitzter Position in attraktivere umschichten). Kann leer [] sein.
${extraBudget > 0 ? `extraAllocations: Sonder-Nachkäufe nur bei echten Gelegenheiten. Kann leer [] sein.
WICHTIG zur Budgetdisziplin: Das Sonder-Vermögen beträgt €${extraBudget.toFixed(2)} über ${dcaMonths || 12} Monate. Einzelne Nachkäufe sollten max. 10-15% des Gesamttopfs betragen, es sei denn es liegt ein extremer Ausverkauf vor (Opportunity Score ≥8). Die Gesamtsumme aller extraAllocations darf max. 20-25% des Topfs ausmachen — das Budget soll über den Zeitraum verteilt bleiben. In der "detail"-Begründung MUSS erklärt werden warum die vorgeschlagene Summe in Relation zum Gesamttopf (€${extraBudget.toFixed(2)}) gerechtfertigt ist.` : ""}
REVALIDIERUNG: Prüfe alle Vorschläge (extraAllocations, rebalanceTrades, takeProfits) nochmals kritisch bevor du antwortest. Frage dich: Ist die Summe verhältnismäßig? Ist der Zeitpunkt wirklich günstig genug? Würde ein erfahrener Portfolio-Manager diesen Trade so machen? Wenn nicht, reduziere oder entferne den Vorschlag.
Alle Texte deutsch.`,
      "Du bist ein technischer Analyst und Timing-Experte mit Erfahrung in Portfolio-Management. NUR valides JSON. Kein Markdown. Keine Backticks.",
      false,
      3000
    );
    const j = extractJSON(raw);
    if (j && j.stocks) {
      if (j.summary) j.summary = cleanText(j.summary);
      if (j.dcaAdvice) j.dcaAdvice = cleanText(j.dcaAdvice);
      if (j.stocks) j.stocks = j.stocks.map(s => ({ ...s, reason: cleanText(s.reason) }));
      if (j.extraAllocations) j.extraAllocations = j.extraAllocations.map(a => ({ ...a, reason: cleanText(a.reason), detail: a.detail ? cleanText(a.detail) : null }));
      if (j.rebalanceTrades) j.rebalanceTrades = j.rebalanceTrades.map(t => ({ ...t, reason: cleanText(t.reason), detail: t.detail ? cleanText(t.detail) : null }));
      if (j.takeProfits) j.takeProfits = j.takeProfits.map(t => ({ ...t, reason: cleanText(t.reason), detail: t.detail ? cleanText(t.detail) : null }));
      return j;
    }
    return null;
  } catch { return null; }
}

async function doSellPriority(stockList, fmpData, analysisData, timingData, insiderDataMap, eurUsdRate) {
  const stockInfo = stockList.map(s => {
    let info = `${s.ticker} (${s.name}, Sektor: ${s.sector}, Sensitivität: ${s.sensitivity}, Moat: ${s.moat}, Investiert: €${s.cost.toFixed(2)}`;
    if (s.purchaseDate) {
      const months = Math.round((Date.now() - new Date(s.purchaseDate).getTime()) / (30.44 * 86400000));
      info += `, Erstkauf: ${s.purchaseDate} (${months}M)`;
    }
    if (s.pricePerShare && fmpData[s.ticker]?.price && eurUsdRate) {
      const curEur = fmpData[s.ticker].price * eurUsdRate;
      const plPct = ((curEur - s.pricePerShare) / s.pricePerShare * 100).toFixed(1);
      info += `, Ø Kaufpreis: €${s.pricePerShare.toFixed(2)}, P/L: ${plPct}%`;
    }
    if (s.purchases?.length > 0) info += `, ${s.purchases.length} Nachkäufe`;
    return info + ")";
  }).join("\n");

  let fmpBlock = "";
  if (fmpData && Object.keys(fmpData).length > 0) {
    const lines = Object.entries(fmpData).map(([t, d]) => {
      let line = `${t}: Kurs=$${d.price}, AbstandVomHoch=${d.fromHigh ?? "n/a"}%, ` +
        `P/E=${d.peRatio ?? "n/a"}, PEG=${d.pegRatio ?? "n/a"}, Marge=${d.netProfitMargin != null ? (d.netProfitMargin * 100).toFixed(1) + "%" : "n/a"}`;
      if (d.consensusLabel) line += `, Konsens=${d.consensusLabel}`;
      if (d.beatCount != null) line += `, Earnings ${d.beatCount}/4 beats`;
      return line;
    });
    fmpBlock = `\nMarktdaten:\n${lines.join("\n")}`;
  }

  let insiderBlock = "";
  if (insiderDataMap && Object.keys(insiderDataMap).length > 0) {
    const insLines = Object.entries(insiderDataMap).map(([t, d]) =>
      `${t}: ${d.totalSells} Verkäufe ($${(d.sellVolume/1e6).toFixed(1)}M), ${d.totalBuys} Käufe — 90 Tage`
    );
    insiderBlock = `\nInsider-Transaktionen:\n${insLines.join("\n")}`;
  }

  let contextBlock = "";
  if (analysisData) contextBlock += `\nAnalyse-Status: ${analysisData.overallStatus}, CapEx-Trend: ${analysisData.capexTrend}`;
  if (timingData?.stocks) {
    const timLines = timingData.stocks.map(s => `${s.ticker}: ${s.signal}, ${s.reason}`);
    contextBlock += `\nTiming:\n${timLines.join("\n")}`;
  }

  try {
    const raw = await callAPI(
      `Erstelle eine Verkaufspriorität für ALLE Aktien im Portfolio.
Welche Aktie sollte bei einer Krise/Korrektur ZUERST verkauft werden (Prio 1) und welche ZULETZT?

Kriterien für hohe Verkaufspriorität (zuerst verkaufen):
- Schmaler Moat, hohe Bewertung (P/E, PEG), hohe Sensitivität
- Negatives Momentum, weit vom Hoch entfernt
- Schwache Fundamentaldaten
- Hoher unrealisierter Gewinn bei kurzer Haltedauer (Gewinnmitnahme erwägen)
- Viele Nachkäufe in kurzer Zeit (Klumpenrisiko)

Kriterien für niedrige Verkaufspriorität (zuletzt verkaufen):
- Breiter Moat, faire Bewertung, geringe Sensitivität
- Marktführer mit dauerhaften Wettbewerbsvorteilen
- Position im Verlust bei guten Fundamentaldaten (Erholung abwarten)

Aktien:\n${stockInfo}${fmpBlock}${insiderBlock}${contextBlock}

Antworte NUR mit validem JSON:
{"priority":[{"ticker":"XXX","rank":1,"reason":"1 Satz deutsch"}],"summary":"1-2 Sätze Gesamteinschätzung deutsch"}

rank: 1 = zuerst verkaufen, höchste Zahl = zuletzt verkaufen. ALLE Aktien müssen enthalten sein. Alle Texte deutsch.`,
      "Du bist ein Portfolio-Risikomanager. NUR valides JSON. Kein Markdown. Keine Backticks.",
      false,
      2000
    );
    const j = extractJSON(raw);
    if (j && j.priority) {
      j.priority = j.priority.map(p => ({ ...p, reason: cleanText(p.reason) }));
      if (j.summary) j.summary = cleanText(j.summary);
      return j;
    }
    return null;
  } catch { return null; }
}

async function doDCAPlan(stockList, totalBudget, months, extraBudget, fmpData, insiderDataMap, timingData, analysisData, macroData, marketData, eurUsdRate, capexImpactData) {
  const ts0 = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts: ts0, label: `DCA-Plan Start: ${stockList.length} Aktien, Budget €${totalBudget}, ${months}M`, status: "pending", tokens: 0 });
  const startIdx = _debugLog.length - 1;
  const stockInfo = stockList.map(s => {
    let info = `${s.ticker} (${s.name}, Sektor: ${s.sector}, Typ: ${s.type === "capex" ? "AI-Infrastruktur" : "Andere"}, Sensitivität: ${s.sensitivity}, Moat: ${s.moat}, Investiert: €${s.cost.toFixed(2)}`;
    if (s.purchaseDate) {
      const mo = Math.round((Date.now() - new Date(s.purchaseDate).getTime()) / (30.44 * 86400000));
      info += `, Haltedauer: ${mo}M`;
    }
    if (s.pricePerShare && fmpData[s.ticker]?.price && eurUsdRate) {
      const curEur = fmpData[s.ticker].price * eurUsdRate;
      const plPct = ((curEur - s.pricePerShare) / s.pricePerShare * 100).toFixed(1);
      info += `, Ø Kaufpreis: €${s.pricePerShare.toFixed(2)}, Aktuell: €${curEur.toFixed(2)}, P/L: ${plPct}%`;
    }
    if (s.purchases?.length > 0) info += `, ${s.purchases.length} Nachkäufe (Σ €${s.purchases.reduce((a, p) => a + p.amount, 0).toFixed(2)})`;
    return info + ")";
  }).join("\n");

  let fmpBlock = "";
  if (fmpData && Object.keys(fmpData).length > 0) {
    const lines = Object.entries(fmpData).map(([t, d]) => {
      let line = `${t}: Kurs=$${d.price}, 52wH=$${d.yearHigh ?? "n/a"}, AbstandVomHoch=${d.fromHigh ?? "n/a"}%, ` +
        `P/E=${d.peRatio ?? "n/a"}, PEG=${d.pegRatio ?? "n/a"}, Marge=${d.netProfitMargin != null ? (d.netProfitMargin * 100).toFixed(1) + "%" : "n/a"}`;
      if (d.consensusLabel) line += `, Konsens=${d.consensusLabel}`;
      if (d.beatCount != null) line += `, Earnings ${d.beatCount}/4 beats`;
      return line;
    });
    fmpBlock = `\n\nMarktdaten:\n${lines.join("\n")}`;
  }

  let insiderBlock = "";
  if (insiderDataMap && Object.keys(insiderDataMap).length > 0) {
    const insLines = Object.entries(insiderDataMap).map(([t, d]) =>
      `${t}: ${d.totalSells} Verkäufe ($${(d.sellVolume/1e6).toFixed(1)}M), ${d.totalBuys} Käufe`
    );
    insiderBlock = `\n\nInsider-Transaktionen (90 Tage):\n${insLines.join("\n")}`;
  }

  let macroBlock = "";
  if (macroData) {
    const parts = [];
    if (macroData.fedFundsRate) parts.push(`Fed Funds Rate: ${macroData.fedFundsRate.value}%`);
    if (macroData.yieldSpread != null) parts.push(`Yield Spread (10Y-2Y): ${Number(macroData.yieldSpread).toFixed(2)}%`);
    if (macroData.cpiYoy) parts.push(`CPI YoY: ${macroData.cpiYoy.value}%`);
    if (macroData.unemployment) parts.push(`Arbeitslosigkeit: ${macroData.unemployment.value}%`);
    if (parts.length > 0) macroBlock = `\n\nMakro-Kontext:\n${parts.join("\n")}`;
  }

  let timingBlock = "";
  if (timingData?.stocks) {
    const lines = timingData.stocks.map(s => `${s.ticker}: Signal=${s.signal}, ${s.reason}`);
    timingBlock = `\n\nTiming-Signale:\n${lines.join("\n")}`;
    if (timingData.opportunityScore) timingBlock += `\nOpportunity Score: ${timingData.opportunityScore}/10`;
  }

  let analysisBlock = "";
  if (analysisData) {
    analysisBlock = `\n\nAnalyse-Status: ${analysisData.overallStatus || "n/a"}, CapEx-Trend: ${analysisData.capexTrend || "n/a"}`;
  }

  let capexImpactBlock = "";
  if (capexImpactData) {
    const cParts = [`Impact: ${capexImpactData.impact} — ${capexImpactData.summary}`];
    if (capexImpactData.guidance_changes) cParts.push(`Guidance-Änderungen: ${capexImpactData.guidance_changes}`);
    if (capexImpactData.winners?.length) cParts.push(`CapEx-Winners: ${capexImpactData.winners.map(w => `${w.ticker} (${w.reason})`).join(", ")}`);
    if (capexImpactData.losers?.length) cParts.push(`CapEx-Losers: ${capexImpactData.losers.map(l => `${l.ticker} (${l.reason})`).join(", ")}`);
    capexImpactBlock = `\n\nAktuelle CapEx-Implikation (Hyperscaler-Earnings & Guidance):\n${cParts.join("\n")}`;
  }

  const totalInvested = stockList.reduce((s, st) => s + st.cost, 0);
  const remainingBudget = Math.max(0, totalBudget - totalInvested);
  const monthlyBudget = (remainingBudget / months).toFixed(2);

  const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  debugPush({ ts, label: `DCA-Plan: €${remainingBudget.toFixed(0)} über ${months}M (€${monthlyBudget}/M)${extraBudget > 0 ? ` + €${extraBudget.toFixed(0)} Sonder` : ""}`, status: "pending", search: false, tokens: 3000 });
  const dbIdx = _debugLog.length - 1;

  try {
    const raw = await callAPI(
      `Du erstellst einen Dollar-Cost-Averaging (DCA) Plan für ein Portfolio.

BUDGET & ZEITRAUM:
- Ziel-Allokation (gesamt): €${totalBudget.toFixed(2)}
- Bereits investiert: €${totalInvested.toFixed(2)}
- Verbleibendes Budget: €${remainingBudget.toFixed(2)}
- Zeitraum: ${months} Monate
- Monatliches Budget: €${monthlyBudget}

PORTFOLIO:
${stockInfo}${fmpBlock}${insiderBlock}${macroBlock}${timingBlock}${analysisBlock}${capexImpactBlock}

AUFGABE:
Erstelle einen konkreten, monatlichen DCA-Plan. Berücksichtige:
1. Aktuelle Bewertung (P/E, PEG, Abstand vom Hoch) — unterbewertete Aktien stärker gewichten
2. Bisherige Investmenthöhe — untergewichtete Positionen aufbauen, übergewichtete reduzieren
3. Timing-Signale (strong_buy/buy → mehr, hold → normal, take_profit/sell → weniger/pausieren)
4. Moat & Sensitivität — breiter Moat + niedrige Sensitivität = höherer Basisanteil
5. Insider-Aktivität — viele Insider-Käufe = positiv, viele Verkäufe = vorsichtiger
6. Makro-Umfeld — Zinsumfeld und Marktlage einbeziehen
7. CapEx-Implikation — Winners stärker gewichten, Losers reduzieren, Guidance-Änderungen berücksichtigen
7. Sektor-Diversifikation — Klumpenrisiko vermeiden
8. Umschichtungen: Wenn Positionen deutlich übergewichtet sind und gleichzeitig untergewichtete Positionen attraktiver bewertet sind, schlage konkrete Umschichtungen vor (Verkauf X € von Aktie A → Kauf Aktie B). Nur vorschlagen wenn es wirklich sinnvoll ist — nicht erzwingen. Das Array kann leer [] sein.

Antworte NUR mit validem JSON:
{"summary":"2-3 Sätze Gesamtstrategie deutsch","monthlyTotal":${monthlyBudget},"months":${months},"plan":[{"ticker":"XXX","name":"Name","monthlyAmount":100,"percentage":10,"reason":"1 Satz deutsch","detail":"3-5 Sätze ausführliche Begründung deutsch: Bewertung, Timing, Gewichtung, Risiko, Makro-Einfluss","priority":"hoch|mittel|niedrig"}],"rebalanceTrades":[{"fromTicker":"AAA","toTicker":"BBB","amount":500,"reason":"1 Satz deutsch","detail":"3-5 Sätze Begründung deutsch"}],"warnings":["Warnung1 deutsch"],"rebalanceHints":["Hinweis1 deutsch"]}

monthlyAmount = Euro-Betrag pro Monat. percentage = Anteil am Monatsbudget. Die Summe aller monthlyAmount MUSS exakt €${monthlyBudget} ergeben.
WICHTIG zu rebalanceTrades: Nur vorschlagen wenn eine Position DEUTLICH übergewichtet ist UND eine untergewichtete Position attraktiver bewertet ist. fromTicker=Verkauf, toTicker=Kauf, amount=Euro-Betrag der Umschichtung. Das Array kann leer [] sein wenn keine Umschichtung sinnvoll ist.
Alle Texte auf Deutsch.`,
      "Du bist ein erfahrener Portfolio-Manager und professioneller Aktienhändler mit über 20 Jahren Erfahrung im institutionellen Asset Management. Du spezialisierst dich auf systematische DCA-Strategien für Growth- und Technologie-Portfolios. Deine Empfehlungen sind datengetrieben, präzise und berücksichtigen sowohl Fundamental- als auch Makro-Faktoren. NUR valides JSON. Kein Markdown. Keine Backticks.",
      false,
      3000
    );
    const j = extractJSON(raw);
    if (j && j.plan) {
      if (j.summary) j.summary = cleanText(j.summary);
      j.plan = j.plan.map(p => ({ ...p, reason: cleanText(p.reason), detail: p.detail ? cleanText(p.detail) : null }));
      if (j.warnings) j.warnings = j.warnings.map(cleanText);
      if (j.rebalanceHints) j.rebalanceHints = j.rebalanceHints.map(cleanText);
      if (j.rebalanceTrades) j.rebalanceTrades = j.rebalanceTrades.map(t => ({ ...t, reason: cleanText(t.reason), detail: t.detail ? cleanText(t.detail) : null }));
      _debugLog[startIdx] = { ..._debugLog[startIdx], status: "ok" };
      _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "ok", code: 200, label: `DCA-Plan: ${j.plan.length} Positionen${j.rebalanceTrades?.length ? `, ${j.rebalanceTrades.length} Umschichtungen` : ""}, €${monthlyBudget}/M` };
      _debugListeners.forEach(fn => fn([..._debugLog]));
      const ts2 = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      j.plan.forEach(p => {
        const prioIcon = p.priority === "hoch" ? "▲" : p.priority === "mittel" ? "▶" : "▼";
        debugPush({ ts: ts2, label: `${prioIcon} ${p.ticker}: €${p.monthlyAmount?.toFixed(2)}/M (${p.percentage}%) — ${p.reason}`, status: "ok", code: 200, tokens: 0 });
      });
      if (j.rebalanceTrades?.length > 0) {
        j.rebalanceTrades.forEach(t => {
          debugPush({ ts: ts2, label: `⇄ ${t.fromTicker} → ${t.toTicker}: €${t.amount?.toFixed(2)} — ${t.reason}`, status: "ok", code: 200, tokens: 0 });
        });
      }
      return j;
    }
    _debugLog[startIdx] = { ..._debugLog[startIdx], status: "error", detail: "Kein gültiger Plan" };
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: "Kein gültiger Plan in Antwort" };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return null;
  } catch (e) {
    _debugLog[startIdx] = { ..._debugLog[startIdx], status: "error", detail: e.message };
    _debugLog[dbIdx] = { ..._debugLog[dbIdx], status: "error", code: 0, detail: e.message };
    _debugListeners.forEach(fn => fn([..._debugLog]));
    return null;
  }
}

/* ═══ COLORS ═══ */
const X = { green: "#22c55e", yellow: "#eab308", orange: "#f97316", red: "#ef4444", purple: "#a78bfa", indigo: "#6366f1", cyan: "#22d3ee" };

/* ═══ HYPERSCALER EARNINGS BANNER ═══ */
const EARNINGS_STORE_KEY = "portfolio-monitor-earnings-dates";
const HYPERSCALERS = ["MSFT", "GOOGL", "AMZN", "META"];
const HYPERSCALER_NAMES = { MSFT: "Microsoft", GOOGL: "Alphabet", AMZN: "Amazon", META: "Meta" };

function getDefaultEarningsDates() {
  const now = new Date();
  const y = now.getFullYear();
  // Typische Earnings-Fenster: Ende Jan, Ende Apr, Ende Jul, Ende Okt
  const windows = [
    { month: 0, day: 29 }, // Q4 → Ende Januar
    { month: 3, day: 30 }, // Q1 → Ende April
    { month: 6, day: 30 }, // Q2 → Ende Juli
    { month: 9, day: 29 }, // Q3 → Ende Oktober
  ];
  // Finde das nächste Fenster für jeden Hyperscaler (leicht versetzt)
  const offsets = { MSFT: 0, GOOGL: 0, AMZN: 1, META: 0 };
  const result = {};
  for (const ticker of HYPERSCALERS) {
    let found = false;
    for (const yr of [y, y + 1]) {
      for (const w of windows) {
        const d = new Date(yr, w.month, w.day + (offsets[ticker] || 0));
        if (d > now) {
          result[ticker] = { date: d.toISOString().slice(0, 10), confirmed: false, reported: false };
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }
  return result;
}

function loadEarningsDates() {
  try {
    const raw = localStorage.getItem(EARNINGS_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Prüfe ob Daten noch aktuell sind (nicht alle in der Vergangenheit + reported)
      const allPast = Object.values(parsed).every(v => v.reported || new Date(v.date) < new Date(Date.now() - 14 * 86400000));
      if (allPast) return getDefaultEarningsDates();
      return parsed;
    }
  } catch {}
  return getDefaultEarningsDates();
}

function saveEarningsDates(data) {
  try { localStorage.setItem(EARNINGS_STORE_KEY, JSON.stringify(data)); } catch {}
}

function daysUntil(dateStr) {
  const target = new Date(dateStr + "T23:59:59");
  const now = new Date();
  return Math.ceil((target - now) / 86400000);
}

function earningsPhase(dates) {
  const allReported = Object.values(dates).every(v => v.reported);
  if (allReported) return "allReported";
  const days = Object.values(dates).filter(v => !v.reported).map(v => daysUntil(v.date));
  const minDays = Math.min(...days);
  if (minDays <= 0) return "jetzt";
  if (minDays <= 7) return "jetzt";
  if (minDays <= 14) return "bald";
  if (minDays <= 30) return "aufmerksamkeit";
  return "ruhig";
}

const PHASE_STYLES = {
  ruhig: { bg: "#6366f108", border: "#6366f122", accent: "#6366f1", label: "Earnings-Radar" },
  aufmerksamkeit: { bg: "#eab30812", border: "#eab30844", accent: "#eab308", label: "Earnings bald" },
  bald: { bg: "#f9731618", border: "#f9731655", accent: "#f97316", label: "Earnings nahen!" },
  jetzt: { bg: "#ef444422", border: "#ef444466", accent: "#ef4444", label: "Earnings-Woche!" },
  allReported: { bg: "#ef444428", border: "#ef444488", accent: "#ef4444", label: "Analyse fällig!" },
};

async function searchEarningsDates(currentDates) {
  const tickers = Object.keys(currentDates).filter(t => !currentDates[t].reported);
  const names = tickers.map(t => HYPERSCALER_NAMES[t]).join(", ");
  const raw = await callAPI(
    `Search for the exact upcoming quarterly earnings report dates for these companies: ${names}.
Find the specific date (day, month, year) for each company's next earnings report.

Respond ONLY with raw JSON, no backticks:
{"dates":[{"ticker":"MSFT","date":"2026-04-29","name":"Microsoft"},{"ticker":"GOOGL","date":"2026-04-29","name":"Alphabet"},{"ticker":"AMZN","date":"2026-04-30","name":"Amazon"},{"ticker":"META","date":"2026-04-29","name":"Meta"}]}

Use format YYYY-MM-DD. Only include companies that have confirmed dates. If a date is not confirmed yet, use your best estimate and add "estimated":true.`,
    "Financial analyst. Use web_search to find upcoming earnings dates. Respond with ONLY raw JSON.",
    true,
    500
  );
  const j = extractJSON(raw);
  if (j && j.dates && Array.isArray(j.dates)) {
    const updated = { ...currentDates };
    for (const entry of j.dates) {
      if (updated[entry.ticker]) {
        updated[entry.ticker] = {
          ...updated[entry.ticker],
          date: entry.date,
          confirmed: !entry.estimated,
        };
      }
    }
    return updated;
  }
  return null;
}

function EarningsBanner({ dates, onUpdate, busy }) {
  const [searching, setSearching] = React.useState(false);
  const phase = earningsPhase(dates);
  const ps = PHASE_STYLES[phase];
  const allReported = phase === "allReported";
  const canSearch = phase === "aufmerksamkeit" || phase === "bald" || phase === "jetzt";

  const handleSearch = async () => {
    setSearching(true);
    try {
      const updated = await searchEarningsDates(dates);
      if (updated) onUpdate(updated);
    } catch (e) { console.error("Earnings search error:", e); }
    setSearching(false);
  };

  const handleMarkReported = (ticker) => {
    const updated = { ...dates, [ticker]: { ...dates[ticker], reported: true } };
    onUpdate(updated);
  };

  const handleReset = () => {
    onUpdate(getDefaultEarningsDates());
  };

  const sorted = Object.entries(dates).sort((a, b) => new Date(a[1].date) - new Date(b[1].date));
  const anyConfirmed = Object.values(dates).some(v => v.confirmed);
  const allConfirmed = Object.values(dates).filter(v => !v.reported).every(v => v.confirmed);

  return React.createElement("div", {
    style: {
      background: ps.bg, border: `1px solid ${ps.border}`, borderRadius: 10,
      padding: "10px 14px", marginTop: 8, marginBottom: 4,
      transition: "all 0.4s ease",
    }
  },
    // Header-Zeile
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        React.createElement("span", { style: {
          display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: ps.accent,
          boxShadow: `0 0 8px ${ps.accent}66`,
          animation: (phase === "jetzt" || allReported) ? "pulse 1.5s infinite" : "none",
        } }),
        React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: ps.accent, textTransform: "uppercase", letterSpacing: ".05em" } }, ps.label),
        // Bestätigungs-Status
        !allReported && React.createElement("span", { style: {
          fontSize: 9, padding: "2px 7px", borderRadius: 8,
          background: allConfirmed ? `${X.green}18` : anyConfirmed ? `${X.yellow}18` : `${X.indigo}12`,
          border: `1px solid ${allConfirmed ? X.green : anyConfirmed ? X.yellow : X.indigo}33`,
          color: allConfirmed ? X.green : anyConfirmed ? X.yellow : "#64748b",
          fontWeight: 600,
        } }, allConfirmed ? "✓ Bestätigt" : anyConfirmed ? "◐ Teilw. bestätigt" : "~ Geschätzt")
      ),
      allReported && React.createElement("button", {
        onClick: handleReset,
        style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 10, padding: 2, fontFamily: "inherit" }
      }, "↻ Reset")
    ),

    // Hyperscaler-Zeilen
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 } },
      sorted.map(([ticker, info]) => {
        const days = daysUntil(info.date);
        const isReported = info.reported;
        const isPast = days <= 0;
        let dayColor = "#64748b";
        let dayText = `${days}d`;
        if (isReported) { dayColor = X.green; dayText = "✓"; }
        else if (isPast) { dayColor = X.orange; dayText = "fällig"; }
        else if (days <= 7) { dayColor = X.red; dayText = `${days}d`; }
        else if (days <= 14) { dayColor = X.orange; dayText = `${days}d`; }
        else if (days <= 30) { dayColor = X.yellow; dayText = `${days}d`; }

        return React.createElement("div", {
          key: ticker,
          style: {
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "5px 8px", borderRadius: 6,
            background: isReported ? `${X.green}08` : isPast ? `${X.orange}10` : "#0f172a44",
            border: `1px solid ${isReported ? X.green + "22" : "#1e293b"}`,
            opacity: isReported ? 0.6 : 1,
          }
        },
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
            React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: "#e2e8f0", whiteSpace: "nowrap" } }, ticker),
            React.createElement("span", { style: { fontSize: 9, color: "#64748b" } },
              new Date(info.date).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })
            ),
            info.confirmed && React.createElement("span", { style: { fontSize: 8, color: X.green }, title: "Termin per Web-Suche bestätigt" }, "✓")
          ),
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: dayColor, fontFamily: "'JetBrains Mono',monospace" } }, dayText),
            !isReported && isPast && React.createElement("button", {
              onClick: () => handleMarkReported(ticker),
              style: { background: `${X.green}18`, border: `1px solid ${X.green}33`, borderRadius: 4, color: X.green, fontSize: 8, padding: "2px 5px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }
            }, "✓ reported")
          )
        );
      })
    ),

    // "Termine verifizieren" Button — nur in aufmerksamkeit/bald/jetzt Phase
    canSearch && React.createElement("div", { style: { marginTop: 8 } },
      React.createElement("button", {
        onClick: handleSearch, disabled: searching || busy,
        style: {
          width: "100%", padding: 7, borderRadius: 6, border: "none", cursor: searching ? "wait" : "pointer",
          fontSize: 10, fontWeight: 700, fontFamily: "inherit",
          background: `${ps.accent}22`, color: ps.accent,
          opacity: searching || busy ? 0.5 : 1,
        }
      }, searching ? "⟳ Suche läuft…" : "🔍 Termine verifizieren")
    )
  );
}

/* ═══ SMALL COMPONENTS ═══ */
function BDG({ s }) {
  const m = { bullish: [X.green, "BULLISCH"], bearish: [X.red, "BÄRISCH"], neutral: [X.yellow, "NEUTRAL"] };
  const [c, l] = m[s] || m.neutral;
  return React.createElement("span", { style: { fontSize: 9, padding: "2px 8px", borderRadius: 10, background: `${c}18`, border: `1px solid ${c}44`, color: c, fontWeight: 700, letterSpacing: ".05em", whiteSpace: "nowrap" } }, l);
}

function RCard({ t, d }) {
  if (!d) return null;
  return React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 15, marginBottom: 8 } },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 8 } },
      React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, t),
      React.createElement(BDG, { s: d.sentiment })
    ),
    React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", lineHeight: 1.7, margin: 0 } }, d.summary)
  );
}

function TypeBadge({ type }) {
  const isCapex = type === "capex";
  return React.createElement("span", { style: { fontSize: 8, padding: "2px 6px", borderRadius: 8, background: isCapex ? `${X.indigo}22` : `${X.cyan}22`, color: isCapex ? X.purple : X.cyan, fontWeight: 700, letterSpacing: ".04em" } }, isCapex ? "CAPEX" : "ANDERE");
}

const sensColor = s => s === "very high" ? X.red : s === "high" ? X.orange : s === "medium" ? X.yellow : s === "low" ? X.green : "#64748b";
const moatLabel = m => m === "wide" ? "Breit" : m === "medium" ? "Mittel" : m === "narrow" ? "Schmal" : m || "—";

function calcPL(stock, currentPriceUsd, eurUsdRate) {
  if (!currentPriceUsd || !stock.pricePerShare || !eurUsdRate) return null;
  // Aktuellen USD-Kurs in EUR umrechnen
  const currentPriceEur = currentPriceUsd * eurUsdRate;
  // Alle Preise in EUR — Initiale Anteile
  const nachkaufSum = (stock.purchases || []).reduce((s, p) => s + p.amount, 0);
  const initialCost = stock.cost - nachkaufSum;
  let totalShares = stock.pricePerShare > 0 ? initialCost / stock.pricePerShare : 0;
  let totalInvested = initialCost;
  for (const p of (stock.purchases || [])) {
    if (p.pricePerShare && p.pricePerShare > 0) {
      totalShares += p.amount / p.pricePerShare;
    }
    totalInvested += p.amount;
  }
  if (totalShares <= 0) return null;
  const avgCost = totalInvested / totalShares;
  const currentValue = currentPriceEur * totalShares;
  const plPct = ((currentPriceEur - avgCost) / avgCost) * 100;
  return { plPct, avgCost, totalShares, totalInvested, currentValue };
}

function holdingDuration(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  const months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (months >= 12) return `${Math.floor(months / 12)}J ${months % 12}M`;
  return `${months}M`;
}

/* ═══ SETTINGS COMPONENT ═══ */
function Settings({ onClose }) {
  const [key, setKey] = useState(getApiKey());
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [fmpKey, setFmpKeyState] = useState(getFmpKey());
  const [fmpResult, setFmpResult] = useState(null);
  const [fredKeyState, setFredKeyState] = useState(getFredKey());
  const [fredResult, setFredResult] = useState(null);
  const [fredProxyState, setFredProxyState] = useState(getFredProxy());

  const saveKey = () => { setApiKey(key); setTestResult({ ok: true, msg: "Gespeichert!" }); };
  const saveFmpKey = () => { setFmpKey(fmpKey); setFmpResult({ ok: true, msg: "Gespeichert!" }); };
  const testFmp = async () => {
    setFmpResult(null);
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${fmpKey}`);
      const d = await r.json();
      if (d && d.c && d.c > 0) { setFmpKey(fmpKey); setFmpResult({ ok: true, msg: `OK — AAPL: $${d.c}` }); }
      else { setFmpResult({ ok: false, msg: "Ungültiger API-Key oder keine Daten" }); }
    } catch (e) { setFmpResult({ ok: false, msg: "Fehler: " + e.message }); }
  };

  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }),
      });
      if (r.ok) { setTestResult({ ok: true, msg: "Verbindung erfolgreich!" }); setApiKey(key); }
      else { const d = await r.json().catch(() => null); setTestResult({ ok: false, msg: `Fehler ${r.status}: ${d?.error?.message || r.statusText}` }); }
    } catch (e) { setTestResult({ ok: false, msg: "Verbindung fehlgeschlagen: " + e.message }); }
    setTesting(false);
  };

  const resetData = () => { if (confirm("Alle Recherche-Daten löschen?")) { localStorage.removeItem(STORE_KEY); location.reload(); } };

  const inp = { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", fontSize: 13, color: "#e2e8f0", width: "100%", fontFamily: "'JetBrains Mono', monospace" };
  const btn = (bg, col) => ({ padding: "9px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, background: bg, color: col, fontFamily: "inherit", width: "100%" });

  return React.createElement("div", { style: { position: "fixed", inset: 0, background: "#0a0e1acc", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 } },
    React.createElement("div", { style: { background: "#111827", borderRadius: 16, border: "1px solid #1e293b", padding: 24, maxWidth: 440, width: "100%", maxHeight: "90vh", overflowY: "auto" } },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 } },
        React.createElement("h2", { style: { fontSize: 18, fontWeight: 700, margin: 0 } }, "Einstellungen"),
        React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18 } }, "✕")
      ),
      React.createElement("div", { style: { marginBottom: 20 } },
        React.createElement("label", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 6, display: "block" } }, "Anthropic API Key"),
        React.createElement("input", { type: "password", value: key, onChange: e => setKey(e.target.value), placeholder: "sk-ant-...", style: inp }),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 } },
          React.createElement("button", { onClick: saveKey, style: btn(X.indigo, "#fff") }, "Speichern"),
          React.createElement("button", { onClick: testConnection, disabled: testing || !key, style: btn(testing ? "#1e293b" : `${X.cyan}22`, testing ? "#475569" : X.cyan) }, testing ? "⟳ Teste…" : "Verbindung testen")
        ),
        testResult && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: testResult.ok ? X.green : X.red, padding: "6px 10px", borderRadius: 8, background: testResult.ok ? `${X.green}15` : `${X.red}15` } }, testResult.msg)
      ),
      React.createElement("div", { style: { marginBottom: 20, borderTop: "1px solid #1e293b", paddingTop: 16 } },
        React.createElement("label", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 6, display: "block" } }, "Finnhub API Key (Fundamentaldaten)"),
        React.createElement("div", { style: { fontSize: 10, color: "#475569", marginBottom: 8 } }, "Kostenlos auf finnhub.io — liefert exakte Kurse, 52w-High/Low, P/E, PEG"),
        React.createElement("input", { type: "password", value: fmpKey, onChange: e => setFmpKeyState(e.target.value), placeholder: "Finnhub API Key…", style: inp }),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 } },
          React.createElement("button", { onClick: saveFmpKey, style: btn(X.indigo, "#fff") }, "Speichern"),
          React.createElement("button", { onClick: testFmp, disabled: !fmpKey, style: btn(fmpKey ? `${X.cyan}22` : "#1e293b", fmpKey ? X.cyan : "#475569") }, "Testen")
        ),
        fmpResult && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: fmpResult.ok ? X.green : X.red, padding: "6px 10px", borderRadius: 8, background: fmpResult.ok ? `${X.green}15` : `${X.red}15` } }, fmpResult.msg)
      ),
      React.createElement("div", { style: { marginBottom: 20, borderTop: "1px solid #1e293b", paddingTop: 16 } },
        React.createElement("label", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 6, display: "block" } }, "FRED API (Makro-Daten)"),
        React.createElement("div", { style: { fontSize: 10, color: "#475569", marginBottom: 8 } }, "Kostenlos auf fred.stlouisfed.org — Zinsen, Yield Curve, CPI, GDP, Arbeitsmarkt"),
        /* Proxy URL zuerst */
        React.createElement("div", { style: { marginBottom: 12 } },
          React.createElement("label", { style: { fontSize: 11, color: "#64748b", marginBottom: 4, display: "block" } }, "1. FRED Proxy URL (Cloudflare Worker)"),
          React.createElement("div", { style: { fontSize: 10, color: "#475569", marginBottom: 6 } }, "Leer = lokaler Proxy (nur PC). Für Handy/PWA: Cloudflare Worker URL eintragen und speichern."),
          React.createElement("input", { value: fredProxyState, onChange: e => setFredProxyState(e.target.value), placeholder: "https://dein-worker.dein-name.workers.dev", style: inp }),
          React.createElement("button", { onClick: () => { setFredProxy(fredProxyState); setFredResult({ ok: true, msg: "Proxy-URL gespeichert!" }); }, style: { ...btn(`${X.indigo}22`, X.purple), marginTop: 8 } }, "Proxy speichern"),
          !getFredProxy() && location.protocol === "https:" && React.createElement("div", { style: { marginTop: 6, fontSize: 10, color: X.orange, padding: "6px 10px", borderRadius: 8, background: `${X.orange}15` } }, "Keine Proxy-URL gespeichert. Auf Mobilgeräten wird eine Cloudflare Worker URL benötigt, damit FRED-Abfragen funktionieren.")
        ),
        /* API Key danach */
        React.createElement("label", { style: { fontSize: 11, color: "#64748b", marginBottom: 4, display: "block" } }, "2. FRED API Key"),
        React.createElement("input", { type: "password", value: fredKeyState, onChange: e => setFredKeyState(e.target.value), placeholder: "FRED API Key…", style: inp }),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 } },
          React.createElement("button", { onClick: () => { setFredKey(fredKeyState); setFredResult({ ok: true, msg: "Gespeichert!" }); }, style: btn(X.indigo, "#fff") }, "Speichern"),
          React.createElement("button", { onClick: async () => {
            if (!getFredProxy() && location.protocol === "https:") { setFredResult({ ok: false, msg: "Bitte zuerst Proxy-URL eintragen und speichern (Schritt 1)." }); return; }
            setFredResult(null);
            try {
              const r = await fetch(`${fredProxyUrl()}?series_id=FEDFUNDS&api_key=${fredKeyState}&file_type=json&sort_order=desc&limit=1`);
              const d = await r.json();
              if (d?.observations?.[0]) { setFredKey(fredKeyState); setFredResult({ ok: true, msg: `OK — Fed Funds: ${d.observations[0].value}%` }); }
              else { setFredResult({ ok: false, msg: "Ungültiger API-Key oder keine Daten" }); }
            } catch (e) { setFredResult({ ok: false, msg: "Fehler: " + e.message }); }
          }, disabled: !fredKeyState, style: btn(fredKeyState ? `${X.cyan}22` : "#1e293b", fredKeyState ? X.cyan : "#475569") }, "Testen")
        ),
        fredResult && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: fredResult.ok ? X.green : X.red, padding: "6px 10px", borderRadius: 8, background: fredResult.ok ? `${X.green}15` : `${X.red}15` } }, fredResult.msg)
      ),
      React.createElement("div", { style: { borderTop: "1px solid #1e293b", paddingTop: 16, marginBottom: 20 } },
        React.createElement("div", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 4 } }, "Portfolio Export / Import"),
        React.createElement("div", { style: { fontSize: 10, color: "#475569", marginBottom: 10 } }, "Exportiert alle Aktien mit Käufen, Nachkäufen, Preisen und Metadaten als JSON-Datei."),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
          React.createElement("button", { onClick: () => {
            const saved = loadData();
            const exportData = { _version: 1, _exported: new Date().toISOString(), stocks: saved?.stocks || [] };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url; a.download = `portfolio_${new Date().toISOString().slice(0,10)}.json`; a.click();
            URL.revokeObjectURL(url);
          }, style: btn(`${X.green}22`, X.green) }, "Export (.json)"),
          React.createElement("button", { onClick: () => {
            const input = document.createElement("input"); input.type = "file"; input.accept = ".json";
            input.onchange = (ev) => {
              const file = ev.target.files[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const data = JSON.parse(e.target.result);
                  const importStocks = data.stocks;
                  if (!Array.isArray(importStocks) || importStocks.length === 0) { alert("Keine gültigen Aktien-Daten in der Datei gefunden."); return; }
                  const valid = importStocks.every(s => s.ticker && s.name);
                  if (!valid) { alert("Ungültiges Format: Jede Aktie braucht mindestens ticker und name."); return; }
                  if (!confirm(`${importStocks.length} Aktien importieren?\n\n${importStocks.map(s => `${s.ticker} (${s.name})`).join("\n")}\n\nVorhandene Aktien werden überschrieben.`)) return;
                  const saved = loadData() || {};
                  saved.stocks = importStocks;
                  localStorage.setItem(STORE_KEY, JSON.stringify(saved));
                  location.reload();
                } catch (err) { alert("Fehler beim Import: " + err.message); }
              };
              reader.readAsText(file);
            };
            input.click();
          }, style: btn(`${X.cyan}22`, X.cyan) }, "Import (.json)")
        )
      ),
      React.createElement("div", { style: { borderTop: "1px solid #1e293b", paddingTop: 16 } },
        React.createElement("div", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 10 } }, "Gefahrenzone"),
        React.createElement("button", { onClick: resetData, style: btn(`${X.orange}22`, X.orange) }, "Daten zurücksetzen")
      )
    )
  );
}

/* ═══ API KEY SETUP SCREEN ═══ */
/* ═══ DEBUG PANEL ═══ */
function DebugPanel({ active }) {
  const log = useDebugLog();
  const endRef = useRef(null);
  const [manualOpen, setManualOpen] = useState(false);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [log.length]);
  const hasErrors = log.some(l => l.status === "error");
  const hasPending = log.some(l => l.status === "pending");
  // Auto-öffnen bei Aktivität oder Fehlern
  const autoOpen = active || hasErrors || hasPending;
  const isOpen = autoOpen || manualOpen;
  const errorCount = log.filter(l => l.status === "error").length;
  if (!isOpen) return React.createElement("div", { style: { display: "flex", justifyContent: "center", marginTop: 6 } },
    React.createElement("button", { onClick: () => setManualOpen(true), style: {
      background: "none", border: `1px solid ${errorCount > 0 ? X.red + "44" : "#1e293b"}`, borderRadius: 6, cursor: "pointer",
      padding: "3px 10px", fontSize: 9, color: errorCount > 0 ? X.red : "#475569", fontFamily: "inherit",
    } }, log.length > 0 ? `Debug (${log.length} Calls${errorCount > 0 ? `, ${errorCount} Fehler` : ""})` : "Debug")
  );
  if (log.length === 0 && isOpen) return React.createElement("div", { style: { background: "#0d1117", border: "1px solid #1e293b", borderRadius: 10, padding: 12, marginTop: 10 } },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      React.createElement("span", { style: { fontSize: 11, color: "#475569" } }, "Keine API-Calls seit letztem Reload"),
      React.createElement("button", { onClick: () => setManualOpen(false), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 } }, "✕")
    )
  );
  const statCol = { ok: X.green, error: X.red, pending: X.yellow };
  const statLabel = { ok: "✓", error: "✕", pending: "⟳" };
  return React.createElement("div", { style: { background: "#0d1117", border: "1px solid #1e293b", borderRadius: 10, padding: 12, marginTop: 10, maxHeight: 220, overflowY: "auto" } },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
      React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, `API Debug (${log.length} Calls)`),
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        errorCount > 0 && React.createElement("span", { className: "m", style: { fontSize: 10, color: X.red } }, `${errorCount} Fehler`),
        !autoOpen && React.createElement("button", { onClick: () => setManualOpen(false), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 } }, "✕")
      )
    ),
    log.map((entry, i) =>
      React.createElement("div", { key: i, style: { display: "flex", alignItems: "flex-start", gap: 6, padding: "3px 0", borderBottom: i < log.length - 1 ? "1px solid #1e293b22" : "none" } },
        React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", flexShrink: 0, width: 52 } }, entry.ts),
        React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: statCol[entry.status], flexShrink: 0, width: 12 } }, statLabel[entry.status]),
        React.createElement("span", { style: { fontSize: 10, color: entry.status === "error" ? X.red : "#94a3b8", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          entry.status === "error" ? `${entry.code} ${entry.detail || ""} — ${entry.label}` : entry.label
        ),
        entry.search && React.createElement("span", { style: { fontSize: 8, padding: "1px 4px", borderRadius: 4, background: `${X.cyan}22`, color: X.cyan, flexShrink: 0 } }, "WEB"),
        entry.fmp && React.createElement("span", { style: { fontSize: 8, padding: "1px 4px", borderRadius: 4, background: `${X.green}22`, color: X.green, flexShrink: 0 } }, "FH"),
        entry.fred && React.createElement("span", { style: { fontSize: 8, padding: "1px 4px", borderRadius: 4, background: `${X.orange}22`, color: X.orange, flexShrink: 0 } }, "FRED"),
        React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", flexShrink: 0 } }, entry.code || "…")
      )
    ),
    React.createElement("div", { ref: endRef })
  );
}

function SetupScreen({ onDone }) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const test = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }),
      });
      if (r.ok) { setApiKey(key); setResult({ ok: true }); setTimeout(() => onDone(), 500); }
      else { const d = await r.json().catch(() => null); setResult({ ok: false, msg: `Fehler ${r.status}: ${d?.error?.message || r.statusText}` }); }
    } catch (e) { setResult({ ok: false, msg: e.message }); }
    setTesting(false);
  };

  const inp = { background: "#0f172a", border: "1px solid #334155", borderRadius: 10, padding: "12px 14px", fontSize: 14, color: "#e2e8f0", width: "100%", fontFamily: "'JetBrains Mono', monospace" };

  return React.createElement("div", { style: { minHeight: "100vh", background: "#0a0e1a", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 } },
    React.createElement("div", { style: { background: "#111827", borderRadius: 20, border: "1px solid #1e293b", padding: 32, maxWidth: 420, width: "100%", textAlign: "center" } },
      React.createElement("div", { style: { width: 56, height: 56, borderRadius: 14, background: `linear-gradient(135deg,${X.indigo},${X.purple})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 16px" } }, "◉"),
      React.createElement("h1", { style: { fontSize: 22, fontWeight: 700, marginBottom: 6, color: "#e2e8f0" } }, "AI Infrastructure Monitor"),
      React.createElement("p", { style: { fontSize: 13, color: "#64748b", marginBottom: 24, lineHeight: 1.6 } }, "Portfolio-Analyse & CapEx-Frühwarnsystem powered by Claude AI"),
      React.createElement("div", { style: { textAlign: "left", marginBottom: 16 } },
        React.createElement("label", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 6, display: "block" } }, "Anthropic API Key"),
        React.createElement("input", { type: "password", value: key, onChange: e => setKey(e.target.value), placeholder: "sk-ant-api03-...", style: inp }),
        React.createElement("p", { style: { fontSize: 10, color: "#475569", marginTop: 6 } }, "Dein Key wird nur lokal gespeichert und nie an andere Server gesendet.")
      ),
      React.createElement("button", { onClick: test, disabled: testing || !key.trim(), style: {
        width: "100%", padding: 13, borderRadius: 10, border: "none", cursor: testing || !key.trim() ? "not-allowed" : "pointer",
        fontSize: 14, fontWeight: 700, fontFamily: "inherit",
        background: testing || !key.trim() ? "#1e293b" : `linear-gradient(135deg,${X.indigo},#8b5cf6)`,
        color: testing || !key.trim() ? "#475569" : "#fff",
      } }, testing ? "⟳ Verbindung wird getestet…" : "Verbindung testen & Starten"),
      result && React.createElement("div", { style: { marginTop: 12, fontSize: 12, color: result.ok ? X.green : X.red, padding: "8px 12px", borderRadius: 8, background: result.ok ? `${X.green}15` : `${X.red}15` } }, result.ok ? "Verbindung erfolgreich!" : result.msg)
    )
  );
}

/* ═══ MAIN APP ═══ */
function App() {
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [showSettings, setShowSettings] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [tab, setTab] = useState("overview");
  const [stocks, setStocks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [stepName, setStepName] = useState("");
  const [lastRun, setLastRun] = useState(null);
  const [logs, setLogs] = useState([]);
  const [exAlert, setExAlert] = useState(null);

  const [capex, setCapex] = useState([]);
  const [tsmc, setTsmc] = useState(null);
  const [dram, setDram] = useState(null);
  const [nvidia, setNvidia] = useState(null);
  const [positions, setPositions] = useState({});
  const [insider, setInsider] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [timing, setTiming] = useState(null);
  const [finnhubData, setFinnhubData] = useState({});
  const [eurUsdRate, setEurUsdRate] = useState(null);
  const [earningsCal, setEarningsCal] = useState([]);
  const [insiderData, setInsiderData] = useState({});
  const [sellPriority, setSellPriority] = useState(null);
  const [sellPrioLastRun, setSellPrioLastRun] = useState(null);
  const [busySellPrio, setBusySellPrio] = useState(false);
  const [busyTiming, setBusyTiming] = useState(false);
  const cancelRef = useRef(false);
  const [timingStep, setTimingStep] = useState("");
  const [dataLoaded, setDataLoaded] = useState(false);
  const [macro, setMacro] = useState(null);
  const [marketIndicators, setMarketIndicators] = useState(null);
  const [dcaPlan, setDcaPlan] = useState(null);
  const [busyDca, setBusyDca] = useState(false);
  const [dcaBudget, setDcaBudget] = useState("");
  const [dcaMonths, setDcaMonths] = useState("12");
  const [dcaExtra, setDcaExtra] = useState("");
  const [dcaDetail, setDcaDetail] = useState(null);
  const [capexImpact, setCapexImpact] = useState(null);
  const [dcaIncorporatesCapex, setDcaIncorporatesCapex] = useState(false);
  const [busyVerify, setBusyVerify] = useState(false);
  const [earningsDates, setEarningsDates] = useState(() => loadEarningsDates());
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  const updateEarningsDates = useCallback((newDates) => {
    setEarningsDates(newDates);
    saveEarningsDates(newDates);
  }, []);

  useEffect(() => {
    const saved = loadData();
    if (saved) {
      if (saved.stocks) setStocks(saved.stocks);
      if (saved.capex) setCapex(saved.capex);
      if (saved.tsmc) setTsmc(saved.tsmc);
      if (saved.dram) setDram(saved.dram);
      if (saved.nvidia) setNvidia(saved.nvidia);
      if (saved.positions) setPositions(saved.positions);
      if (saved.insider) setInsider(saved.insider);
      if (saved.analysis) setAnalysis(saved.analysis);
      if (saved.timing) setTiming(saved.timing);
      if (saved.finnhubData) setFinnhubData(saved.finnhubData);
      if (saved.insiderData) setInsiderData(saved.insiderData);
      if (saved.sellPriority) setSellPriority(saved.sellPriority);
      if (saved.sellPrioLastRun) setSellPrioLastRun(new Date(saved.sellPrioLastRun));
      if (saved.lastRun) setLastRun(new Date(saved.lastRun));
      if (saved.logs) setLogs(saved.logs);
      if (saved.macro) setMacro(saved.macro);
      if (saved.marketIndicators) setMarketIndicators(saved.marketIndicators);
      if (saved.dcaPlan) setDcaPlan(saved.dcaPlan);
      if (saved.dcaBudget) setDcaBudget(saved.dcaBudget);
      if (saved.dcaMonths) setDcaMonths(saved.dcaMonths);
      if (saved.dcaExtra) setDcaExtra(saved.dcaExtra);
      if (saved.capexImpact) setCapexImpact(saved.capexImpact);
    }
    setDataLoaded(true);
    // Earnings-Kalender + EUR/USD-Kurs laden
    const fhKey = getFmpKey();
    const portfolioTickers = (saved?.stocks || []).map(s => s.ticker);
    if (fhKey) {
      if (portfolioTickers.length > 0) {
        fetchEarningsCalendar(fhKey, portfolioTickers).then(cal => { if (cal.length > 0) setEarningsCal(cal); });
        fetchStockData(portfolioTickers).then(data => { if (data && Object.keys(data).length > 0) setFinnhubData(prev => ({ ...prev, ...data })); }).catch(() => {});
      }
      fetchEurUsdRate().then(rate => { if (rate) setEurUsdRate(rate); }).catch(() => {});
    }
  }, []);

  // Add stock form
  const [showAdd, setShowAdd] = useState(false);
  const [addTicker, setAddTicker] = useState("");
  const [addName, setAddName] = useState("");
  const [addSector, setAddSector] = useState("");
  const [addCost, setAddCost] = useState("");
  const [addType, setAddType] = useState("other");
  const [addSens, setAddSens] = useState("low");
  const [addMoat, setAddMoat] = useState("medium");
  const [addPricePerShare, setAddPricePerShare] = useState("");
  const [addDate, setAddDate] = useState(new Date().toISOString().slice(0, 10));
  const [filling, setFilling] = useState(false);
  const [nachkaufTicker, setNachkaufTicker] = useState(null);
  const [nachkaufBetrag, setNachkaufBetrag] = useState("");
  const [nachkaufPPS, setNachkaufPPS] = useState("");
  const [nachkaufDate, setNachkaufDate] = useState(new Date().toISOString().slice(0, 10));
  const [infoTicker, setInfoTicker] = useState(null);
  const [showDashInfo, setShowDashInfo] = useState(false);
  const [editPPS, setEditPPS] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editCost, setEditCost] = useState("");
  const [editingInitial, setEditingInitial] = useState(null);
  const [editingNachkauf, setEditingNachkauf] = useState(null);
  const [editNkAmount, setEditNkAmount] = useState("");
  const [editNkPPS, setEditNkPPS] = useState("");
  const [editNkDate, setEditNkDate] = useState("");
  const [keyWarning, setKeyWarning] = useState(null);

  const checkKeys = useCallback(() => {
    const missing = [];
    if (!getApiKey()) missing.push("Anthropic API Key");
    if (!getFmpKey()) missing.push("Finnhub API Key");
    if (!getFredKey()) missing.push("FRED API Key");
    if (missing.length > 0) {
      setKeyWarning(missing);
      return false;
    }
    setKeyWarning(null);
    return true;
  }, []);

  const canAutofill = addTicker.trim().length > 0 || addName.trim().length > 0;

  const autofill = useCallback(async () => {
    const input = addTicker.trim() || addName.trim();
    if (!input) return;
    setFilling(true);
    try {
      const raw = await callAPI(
        `Stock: "${input}" (ticker or name). Raw JSON only:\n{"ticker":"SYM","name":"Name","sector":"sector","type":"capex|other","sensitivity":"very high|high|medium|low","moat":"wide|medium|narrow"}\ncapex=company whose revenue significantly depends on AI/data center capital expenditure (GPUs, networking, cooling, memory, fiber optics, power infrastructure, semiconductor equipment). other=not CapEx dependent. sensitivity=how much revenue depends on CapEx spending cycles. moat: wide=monopoly/near-monopoly, narrow=many competitors`,
        "Financial analyst. Respond ONLY raw JSON. No markdown. No backticks. No explanation.",
        false
      );
      const j = extractJSON(raw);
      if (j) {
        if (j.ticker) setAddTicker(j.ticker);
        if (j.name) setAddName(j.name);
        if (j.sector) setAddSector(j.sector);
        if (j.type === "capex" || j.type === "other") setAddType(j.type);
        if (["very high", "high", "medium", "low"].includes(j.sensitivity)) setAddSens(j.sensitivity);
        if (["wide", "medium", "narrow"].includes(j.moat)) setAddMoat(j.moat);
      }
    } catch (e) { console.error("Autofill error:", e); }
    setFilling(false);
  }, [addTicker, addName]);

  const addLog = useCallback((m) => {
    const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLogs(p => [...p.slice(-40), `${ts} ${m}`]);
  }, []);

  const persistAll = useCallback((overrides = {}) => {
    const payload = { stocks, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, lastRun: lastRun?.toISOString(), logs, macro, marketIndicators, dcaPlan, dcaBudget, dcaMonths, dcaExtra, capexImpact, ...overrides };
    saveData(payload);
  }, [stocks, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, lastRun, logs, macro, marketIndicators, dcaPlan, dcaBudget, dcaMonths, dcaExtra, capexImpact]);

  const addStock = useCallback(() => {
    if (!addTicker.trim() || !addName.trim()) return;
    const pps = parseFloat(addPricePerShare) || 0;
    const newStock = {
      ticker: addTicker.toUpperCase().trim(), name: addName.trim(),
      cost: parseFloat(addCost) || 0, pricePerShare: pps, purchaseDate: addDate,
      sector: addSector.trim() || "Sonstige",
      sensitivity: addSens, moat: addMoat, sell: stocks.length + 1, type: addType,
    };
    setStocks(prev => {
      const updated = [...prev, newStock];
      saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun: lastRun?.toISOString(), logs, dcaPlan, dcaBudget, dcaMonths, dcaExtra });
      return updated;
    });
    setAddTicker(""); setAddName(""); setAddSector(""); setAddCost(""); setAddPricePerShare(""); setAddDate(new Date().toISOString().slice(0, 10)); setAddType("other"); setAddSens("low"); setAddMoat("medium");
    setShowAdd(false);
  }, [addTicker, addName, addSector, addCost, addPricePerShare, addDate, addType, addSens, addMoat, stocks.length, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, lastRun, logs]);

  const removeStock = useCallback((ticker) => {
    setStocks(prev => {
      const updated = prev.filter(s => s.ticker !== ticker);
      setPositions(prevPos => {
        const newPos = { ...prevPos }; delete newPos[ticker];
        saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions: newPos, insider, analysis, timing, finnhubData, lastRun: lastRun?.toISOString(), logs });
        return newPos;
      });
      return updated;
    });
  }, [capex, tsmc, dram, nvidia, insider, analysis, timing, finnhubData, lastRun, logs]);

  const updateStock = useCallback((ticker, fields) => {
    setStocks(prev => {
      const updated = prev.map(s => s.ticker === ticker ? { ...s, ...fields } : s);
      saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun: lastRun?.toISOString(), logs, dcaPlan, dcaBudget, dcaMonths, dcaExtra });
      return updated;
    });
  }, [capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun, logs]);

  const addNachkauf = useCallback((ticker, betrag, pps, date) => {
    const amount = parseFloat(betrag);
    const pricePS = parseFloat(pps);
    if (!amount || amount <= 0 || !pricePS || pricePS <= 0) return;
    setStocks(prev => {
      const updated = prev.map(s => s.ticker === ticker ? { ...s, cost: s.cost + amount, purchases: [...(s.purchases || []), { amount, pricePerShare: pricePS, date: date || new Date().toISOString().slice(0, 10) }] } : s);
      saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun: lastRun?.toISOString(), logs, dcaPlan, dcaBudget, dcaMonths, dcaExtra });
      return updated;
    });
    setNachkaufTicker(null);
    setNachkaufBetrag("");
    setNachkaufPPS("");
    setNachkaufDate(new Date().toISOString().slice(0, 10));
  }, [capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun, logs]);

  const updateNachkauf = useCallback((ticker, idx, fields) => {
    setStocks(prev => {
      const updated = prev.map(s => {
        if (s.ticker !== ticker || !s.purchases) return s;
        const oldP = s.purchases[idx];
        const newP = { ...oldP, ...fields };
        const newPurchases = s.purchases.map((p, i) => i === idx ? newP : p);
        const costDiff = (newP.amount || 0) - (oldP.amount || 0);
        return { ...s, cost: s.cost + costDiff, purchases: newPurchases };
      });
      saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun: lastRun?.toISOString(), logs, dcaPlan, dcaBudget, dcaMonths, dcaExtra });
      return updated;
    });
    setEditingNachkauf(null);
  }, [capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun, logs]);

  const removeNachkauf = useCallback((ticker, idx) => {
    setStocks(prev => {
      const updated = prev.map(s => {
        if (s.ticker !== ticker || !s.purchases) return s;
        const removed = s.purchases[idx];
        return { ...s, cost: s.cost - (removed.amount || 0), purchases: s.purchases.filter((_, i) => i !== idx) };
      });
      saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun: lastRun?.toISOString(), logs, dcaPlan, dcaBudget, dcaMonths, dcaExtra });
      return updated;
    });
  }, [capex, tsmc, dram, nvidia, positions, insider, analysis, timing, finnhubData, insiderData, lastRun, logs]);

  /* ═══ RESEARCH ═══ */
  const cancelResearch = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const run = useCallback(async () => {
    cancelRef.current = false;
    setBusy(true); setPct(0); debugClear();
    setCapex([]); setTsmc(null); setDram(null); setNvidia(null);
    setPositions({}); setInsider(null); setAnalysis(null); setTiming(null); setLogs([]);
    setMacro(null); setMarketIndicators(null);
    addLog("Recherche gestartet…");

    const check = () => { if (cancelRef.current) { addLog("⛔ Abgebrochen."); setBusy(false); return true; } return false; };
    let lCapex = [], lTsmc = null, lDram = null, lNvidia = null, lPos = {}, lInsider = null;
    let lMacro = null, lMarket = null;
    let step = 0;
    // Total: 1 Finnhub + 1 Macro + 2 capex + 2 indicators + N positions + 1 analysis + 1 timing + 2 earnings-deep
    const hasFmp = !!getFmpKey();
    const hasFred = !!getFredKey();
    const total = (hasFmp ? 1 : 0) + (hasFred || hasFmp ? 1 : 0) + 2 + 2 + stocks.length + 1 + 1 + 2;

    const advance = (label) => { step++; setStepName(label); setPct(Math.round((step / total) * 100)); };

    // Phase 0: Finnhub Fundamentaldaten + Insider laden
    let fmpData = {};
    let lInsiderData = {};
    if (hasFmp) {
      if (check()) return;
      advance("Fundamentaldaten (Finnhub)");
      addLog("→ Fundamentaldaten + Insider laden (Finnhub)…");
      const [stockDataResult, insiderResult] = await Promise.all([
        fetchStockData(stocks.map(s => s.ticker)),
        fetchInsiderData(stocks.map(s => s.ticker)),
      ]);
      fmpData = stockDataResult;
      lInsiderData = insiderResult;
      setFinnhubData(fmpData);
      setInsiderData(lInsiderData);
      const count = Object.keys(fmpData).length;
      addLog(`  ✓ ${count}/${stocks.length} Aktien geladen`);
      for (const [t, d] of Object.entries(fmpData)) {
        const missing = ["peRatio", "pegRatio", "yearHigh"].filter(k => d[k] === null || d[k] === undefined);
        if (missing.length > 0) addLog(`  ⚠ ${t}: fehlend: ${missing.join(", ")}`);
      }
      const insiderSells = Object.entries(lInsiderData).filter(([, d]) => d.totalSells > 0);
      if (insiderSells.length > 0) addLog(`  ⚠ Insider-Verkäufe: ${insiderSells.map(([t, d]) => `${t}(${d.totalSells})`).join(", ")}`);

      // 52-Wochen-Hochs über Web-Suche verifizieren
      if (check()) return;
      addLog("→ 52-Wochen-Hochs verifizieren…");
      fmpData = await verify52WeekHighs(fmpData);
      setFinnhubData(fmpData);
    }

    // Phase 0.5: Macro-Daten (FRED + VIX/ETFs)
    if (hasFred || hasFmp) {
      if (check()) return;
      advance("Makro-Daten (FRED + VIX)");
      addLog("→ Makro-Daten laden…");
      const [fredResult, marketResult] = await Promise.all([
        hasFred ? fetchFredData() : Promise.resolve(null),
        hasFmp ? fetchMarketIndicators() : Promise.resolve(null),
      ]);
      lMacro = fredResult;
      lMarket = marketResult;
      if (lMacro) setMacro(lMacro);
      if (lMarket) setMarketIndicators(lMarket);
      const parts = [];
      if (lMacro?.fedFundsRate) parts.push(`Fed ${lMacro.fedFundsRate.current}%`);
      if (lMacro?.yieldSpread) parts.push(`Yield ${lMacro.yieldSpread.status}`);
      if (lMarket?.vix) parts.push(`VIX ${lMarket.vix.price}`);
      addLog(`  ✓ Makro: ${parts.length > 0 ? parts.join(", ") : "keine Daten"}`);
    }

    // Phase 1: CapEx — 2 calls instead of 4
    if (check()) return;
    advance("Alphabet + Meta CapEx");
    addLog("→ Alphabet + Meta CapEx");
    const capex1 = await doMultiSearch("Alphabet Google Meta Platforms capital expenditure capex 2026 data center spending guidance", ["Alphabet CapEx", "Meta CapEx"]);
    lCapex.push({ label: "Alphabet CapEx", ...capex1["Alphabet CapEx"] }, { label: "Meta CapEx", ...capex1["Meta CapEx"] });
    setCapex([...lCapex]);
    addLog("  ✓ Alphabet: " + capex1["Alphabet CapEx"].sentiment + ", Meta: " + capex1["Meta CapEx"].sentiment);

    if (check()) return;
    await delay(API_DELAY);
    advance("Microsoft + Amazon CapEx");
    addLog("→ Microsoft + Amazon CapEx");
    const capex2 = await doMultiSearch("Microsoft Azure Amazon AWS capital expenditure capex 2026 data center guidance", ["Microsoft CapEx", "Amazon CapEx"]);
    lCapex.push({ label: "Microsoft CapEx", ...capex2["Microsoft CapEx"] }, { label: "Amazon CapEx", ...capex2["Amazon CapEx"] });
    setCapex([...lCapex]);
    addLog("  ✓ Microsoft: " + capex2["Microsoft CapEx"].sentiment + ", Amazon: " + capex2["Amazon CapEx"].sentiment);

    // Phase 2: Leading indicators — 2 calls instead of 3
    if (check()) return;
    await delay(API_DELAY);
    advance("TSMC + DRAM");
    addLog("→ TSMC + DRAM");
    const indicators = await doMultiSearch("TSMC monthly revenue 2026 DRAM spot price trend memory", ["TSMC", "DRAM"]);
    lTsmc = indicators["TSMC"]; setTsmc(lTsmc);
    lDram = indicators["DRAM"]; setDram(lDram);
    addLog("  ✓ TSMC: " + lTsmc.sentiment + ", DRAM: " + lDram.sentiment);

    if (check()) return;
    await delay(API_DELAY);
    advance("NVIDIA Guidance");
    addLog("→ NVIDIA Guidance");
    lNvidia = await doSearch("NVIDIA earnings revenue guidance 2026 data center");
    setNvidia(lNvidia);
    addLog("  ✓ NVIDIA: " + lNvidia.sentiment);

    // Phase 3: Positions + Price — 1 call per stock
    for (let i = 0; i < stocks.length; i++) {
      if (check()) return;
      await delay(API_DELAY);
      const s = stocks[i];
      advance(s.name);
      addLog("→ " + s.name);
      const query = s.type === "capex"
        ? `${s.name} ${s.ticker} stock earnings news price 52-week high low 2026 ${s.sector}`
        : `${s.name} ${s.ticker} stock earnings outlook price performance 2026 ${s.sector}`;
      const result = await doSearch(query);
      lPos = { ...lPos, [s.ticker]: result };
      setPositions({ ...lPos });
      addLog("  ✓ " + s.name + ": " + result.sentiment);
    }

    // Insider-Daten als Zusammenfassung bereitstellen
    lInsider = hasFmp && Object.keys(lInsiderData).length > 0
      ? { sentiment: Object.values(lInsiderData).some(d => d.totalSells > 3) ? "bearish" : Object.values(lInsiderData).every(d => d.totalSells === 0) ? "bullish" : "neutral",
          summary: Object.entries(lInsiderData).map(([t, d]) => `${t}: ${d.totalSells} Verkäufe ($${(d.sellVolume/1e6).toFixed(1)}M), ${d.totalBuys} Käufe`).join("; ") }
      : lInsider;
    setInsider(lInsider);

    // Phase 4: Hyperscaler Earnings Deep-Dive
    if (check()) return;
    await delay(API_DELAY);
    advance("Earnings-Ergebnisse Hyperscaler");
    addLog("→ Hyperscaler Earnings + Guidance-Änderungen");
    const earningsDeep = await doMultiSearch(
      "Microsoft Alphabet Google Amazon Meta latest quarterly earnings results revenue guidance capex spending change 2026",
      ["Earnings Results", "CapEx Guidance Changes"]
    );
    addLog("  ✓ Earnings: " + earningsDeep["Earnings Results"].sentiment + ", Guidance: " + earningsDeep["CapEx Guidance Changes"].sentiment);

    // Phase 5: CapEx-Implikation für Portfolio
    if (check()) return;
    await delay(API_DELAY);
    advance("CapEx-Portfolio-Implikation");
    addLog("→ CapEx-Implikation für Portfolio…");
    const earningsResultsSummary = earningsDeep["Earnings Results"].summary + " | Guidance: " + earningsDeep["CapEx Guidance Changes"].summary;
    const capexSummary = lCapex.map(c => `${c.label}: ${c.sentiment} — ${c.summary}`).join("\n");
    const portfolioList = stocks.map(s => `${s.ticker} (${s.name}, ${s.sector})`).join(", ");
    const capexImpactRaw = await callAPI(
      `Basierend auf den neuesten Hyperscaler-Earnings und CapEx-Guidance-Änderungen:

EARNINGS & GUIDANCE:
${earningsResultsSummary}

CAPEX-DATEN:
${capexSummary}

PORTFOLIO:
${portfolioList}

Bewerte die konkreten Auswirkungen der aktuellen CapEx-Entwicklung auf jede Portfolio-Position.
Antworte NUR mit validem JSON:
{"summary":"3-4 Sätze Gesamteinschätzung deutsch","impact":"positive|negative|neutral","winners":[{"ticker":"XXX","reason":"1 Satz deutsch"}],"losers":[{"ticker":"XXX","reason":"1 Satz deutsch"}],"guidance_changes":"2-3 Sätze zu relevanten Guidance-Änderungen deutsch"}`,
      "Du bist ein erfahrener Analyst für AI-Infrastruktur-Investments. Bewerte CapEx-Implikationen präzise. NUR valides JSON.",
      false,
      800
    );
    let lCapexImpact = null;
    try {
      const parsed = extractJSON(capexImpactRaw);
      if (parsed && parsed.summary) {
        parsed.summary = cleanText(parsed.summary);
        if (parsed.guidance_changes) parsed.guidance_changes = cleanText(parsed.guidance_changes);
        if (parsed.winners) parsed.winners = parsed.winners.map(w => ({ ...w, reason: cleanText(w.reason) }));
        if (parsed.losers) parsed.losers = parsed.losers.map(l => ({ ...l, reason: cleanText(l.reason) }));
        lCapexImpact = parsed;
      }
    } catch {}
    setCapexImpact(lCapexImpact);
    setDcaIncorporatesCapex(false);
    addLog("✓ CapEx-Implikation: " + (lCapexImpact?.impact || "?"));

    // Phase 6: Timing analysis — includes earnings deep-dive + capex impact data
    if (check()) return;
    await delay(API_DELAY);
    advance("Timing-Bewertung");
    addLog("→ Timing-Bewertung…");
    const priceData = {};
    for (const [ticker, data] of Object.entries(lPos)) {
      priceData[ticker] = { sentiment: data.sentiment, summary: (data.summary || "").slice(0, 200) };
    }
    const tim = await doTimingAnalysis(priceData, stocks, fmpData, lInsiderData, lMacro, lMarket, parseFloat(dcaExtra) || 0, parseInt(dcaMonths) || 12, eurUsdRate, lCapexImpact);
    setTiming(tim);
    addLog("✓ Timing: Score " + (tim?.opportunityScore || "?") + "/10");

    // Phase 7: Gesamtanalyse — am Ende, bezieht ALLE Erkenntnisse ein
    if (check()) return;
    await delay(API_DELAY);
    advance("Gesamtanalyse");
    addLog("→ Gesamtanalyse…");
    const allData = { capex: lCapex, tsmc: lTsmc, dram: lDram, nvidia: lNvidia, positions: lPos, insider: lInsider };
    const ana = await doAnalyze(allData, stocks, fmpData, lInsiderData, lMacro, lMarket, lCapexImpact, tim);
    setAnalysis(ana);
    addLog("✓ Status: " + (ana?.overallStatus || "?"));

    const now = new Date();
    setPct(100); setLastRun(now); setBusy(false);
    debugSaveToServer(stocks, fmpData, eurUsdRate);

    setLogs(prevLogs => {
      saveData({ stocks, capex: lCapex, tsmc: lTsmc, dram: lDram, nvidia: lNvidia, positions: lPos, insider: lInsider, analysis: ana, timing: tim, finnhubData: fmpData, insiderData: lInsiderData, macro: lMacro, marketIndicators: lMarket, lastRun: now.toISOString(), logs: prevLogs, dcaPlan, dcaBudget, dcaMonths, dcaExtra, capexImpact: lCapexImpact });
      return prevLogs;
    });
  }, [addLog, stocks]);

  /* ═══ INDEPENDENT TIMING ═══ */
  const runTiming = useCallback(async () => {
    setBusyTiming(true); debugClear();
    setTimingStep("Kursdaten…");

    // Macro + Finnhub-Daten laden
    let fmpData = {};
    let lInsiderData = {};
    let lMacro = null, lMarket = null;
    if (getFmpKey()) {
      setTimingStep("Fundamentaldaten + Insider + Makro…");
      const [stockDataResult, insiderResult, fredResult, marketResult] = await Promise.all([
        fetchStockData(stocks.map(s => s.ticker)),
        fetchInsiderData(stocks.map(s => s.ticker)),
        getFredKey() ? fetchFredData() : Promise.resolve(null),
        fetchMarketIndicators(),
      ]);
      fmpData = stockDataResult;
      lInsiderData = insiderResult;
      lMacro = fredResult;
      lMarket = marketResult;
      // 52wH verifizieren
      setTimingStep("52-Wochen-Hochs verifizieren…");
      fmpData = await verify52WeekHighs(fmpData);
      setFinnhubData(fmpData);
      setInsiderData(lInsiderData);
      if (lMacro) setMacro(lMacro);
      if (lMarket) setMarketIndicators(lMarket);
    }

    const priceResults = {};
    for (let i = 0; i < stocks.length; i++) {
      const s = stocks[i];
      setTimingStep(`${s.ticker} Kurs…`);
      if (i > 0) await delay(API_DELAY);
      const pr = await doSearch(`${s.ticker} ${s.name} stock price 52-week high low 2026`);
      priceResults[s.ticker] = { sentiment: pr.sentiment, summary: (pr.summary || "").slice(0, 200) };
    }
    await delay(API_DELAY);
    setTimingStep("Timing-Bewertung…");
    const tim = await doTimingAnalysis(priceResults, stocks, fmpData, lInsiderData, lMacro, lMarket, parseFloat(dcaExtra) || 0, parseInt(dcaMonths) || 12, eurUsdRate, capexImpact);
    setTiming(tim);
    setBusyTiming(false);
    setTimingStep("");
    debugSaveToServer(stocks, fmpData, eurUsdRate);
    try {
      const existing = loadData();
      const merged = { ...(existing || {}), timing: tim, finnhubData: fmpData, insiderData: lInsiderData, macro: lMacro, marketIndicators: lMarket, stocks };
      saveData(merged);
    } catch {}
  }, [stocks]);

  /* ═══ SELL PRIORITY UPDATE ═══ */
  const runSellPriority = useCallback(async () => {
    setBusySellPrio(true);
    const prio = await doSellPriority(stocks, finnhubData, analysis, timing, insiderData, eurUsdRate);
    if (prio) {
      setSellPriority(prio);
      const now = new Date();
      setSellPrioLastRun(now);
      try {
        const existing = loadData();
        const merged = { ...(existing || {}), sellPriority: prio, sellPrioLastRun: now.toISOString(), stocks };
        saveData(merged);
      } catch {}
    }
    setBusySellPrio(false);
  }, [stocks, finnhubData, analysis, timing]);

  // Derived
  const totalInvested = stocks.reduce((s, p) => s + p.cost, 0);
  const hasPLData = stocks.some(pos => calcPL(pos, finnhubData[pos.ticker]?.price, eurUsdRate) !== null);
  const totalValue = stocks.reduce((s, pos) => {
    const pl = calcPL(pos, finnhubData[pos.ticker]?.price, eurUsdRate);
    return s + (pl ? pl.currentValue : pos.cost);
  }, 0);
  const totalPL = totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0;
  const incompleteStocks = stocks.filter(s => !s.pricePerShare || !s.purchaseDate);
  const capexStocks = stocks.filter(s => s.type === "capex");
  const otherStocks = stocks.filter(s => s.type === "other");
  const bySell = sellPriority?.priority
    ? sellPriority.priority.sort((a, b) => a.rank - b.rank).map(p => ({ ...stocks.find(s => s.ticker === p.ticker), rank: p.rank, reason: p.reason })).filter(p => p.ticker)
    : [...stocks].sort((a, b) => (a.sell || 99) - (b.sell || 99));
  const hasData = analysis !== null;
  const st = hasData ? analysis.overallStatus : null;
  const stMap = { green: "These intakt", yellow: "Beobachten", orange: "Vorsicht", red: "Handeln" };
  const trMap = { accelerating: "▲ Beschleunigt", stable: "▶ Stabil", decelerating: "▼ Verlangsamt", contracting: "⬇ Kontrahiert" };
  const alertsLive = hasData && analysis.alerts && analysis.alerts.length > 0;
  const alerts = alertsLive ? analysis.alerts : [
    { name: "CapEx-Wende", status: "green", detail: null },
    { name: "TSMC-Abschwung", status: "green", detail: null },
    { name: "DRAM-Preisverfall", status: "green", detail: null },
    { name: "Bewertungs-Stretch", status: "yellow", detail: null },
    { name: "Insider-Selling", status: "yellow", detail: null },
    { name: "NVIDIA-Guidance", status: "green", detail: null },
    { name: "Zinsumfeld", status: "green", detail: null },
    { name: "Marktbreite", status: "green", detail: null },
  ];

  const TABS = [["overview", "Überblick"], ["capex", "CapEx"], ["macro", "Makro"], ["positions", "Positionen"], ["timing", "Timing"], ["dca", "DCA"], ["alerts", "Alerts"], ["playbook", "Playbook"], ["calendar", "Kalender"]];
  const badgeColor = st ? X[st] : "#64748b";
  const badgeText = busy ? "Recherche…" : (hasData ? stMap[st] : "Bereit");

  const inp = { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", fontSize: 12, color: "#e2e8f0", fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" };
  const sel = { ...inp, appearance: "none", cursor: "pointer" };

  if (!hasKey) return React.createElement(SetupScreen, { onDone: () => setHasKey(true) });

  return React.createElement("div", { style: { minHeight: "100vh", background: "#0a0e1a", color: "#e2e8f0", fontFamily: "'DM Sans',system-ui,sans-serif", padding: "16px 10px", boxSizing: "border-box", maxWidth: "100vw", overflow: "hidden" } },
    showSettings && React.createElement(Settings, { onClose: () => setShowSettings(false) }),

    React.createElement("div", { style: { maxWidth: 860, margin: "0 auto", overflow: "hidden" } },

      /* ── HEADER ── */
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 } },
        React.createElement("div", null,
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 9, marginBottom: 3 } },
            React.createElement("div", { style: { width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg,${X.indigo},${X.purple})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700 } }, "◉"),
            React.createElement("h1", { style: { fontSize: 16, fontWeight: 700, margin: 0 } }, "AI Infrastructure Monitor")
          ),
          React.createElement("p", { style: { fontSize: 10, color: "#64748b", margin: 0 } }, "Live via Claude AI · CapEx-Frühwarnsystem")
        ),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          React.createElement("div", { style: { textAlign: "right" } },
            React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 11px", borderRadius: 18, background: `${badgeColor}15`, border: `1px solid ${badgeColor}44` } },
              React.createElement("span", { style: { display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: busy ? X.indigo : badgeColor, boxShadow: `0 0 8px ${(busy ? X.indigo : badgeColor)}55`, animation: busy ? "pulse 1.5s infinite" : "none" } }),
              React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: badgeColor, textTransform: "uppercase", letterSpacing: ".05em" } }, badgeText)
            ),
            lastRun && React.createElement("div", { className: "m", style: { fontSize: 9, color: "#475569", marginTop: 2 } }, `Update: ${lastRun.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}${dataLoaded && !busy ? " (gespeichert)" : ""}`)
          ),
          React.createElement("div", { style: { position: "relative" } },
            React.createElement("button", { onClick: () => setShowInfo(!showInfo), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14, padding: 4 } }, "ⓘ"),
            showInfo && React.createElement("div", { style: { position: "absolute", right: 0, top: 24, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", whiteSpace: "nowrap", zIndex: 100, fontSize: 10, color: "#94a3b8", boxShadow: "0 4px 12px #0008" } },
              React.createElement("span", { style: { color: "#64748b" } }, "Stand: "),
              React.createElement("span", { className: "m", style: { color: "#e2e8f0" } }, BUILD_TIMESTAMP)
            )
          ),
          React.createElement("button", { onClick: () => setShowSettings(true), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18, padding: 4 } }, "⚙")
        )
      ),

      /* ── EARNINGS BANNER ── */
      React.createElement(EarningsBanner, {
        dates: earningsDates,
        onUpdate: updateEarningsDates,
        busy,
      }),

      /* ── MAIN ANALYSIS BUTTON ── */
      (() => {
        const phase = earningsPhase(earningsDates);
        const allReported = phase === "allReported";
        const isUrgent = phase === "jetzt" || allReported;
        const isSoon = phase === "bald";
        const isCalm = phase === "ruhig";
        // Button-Farben nach Phase
        const btnBg = busy ? `linear-gradient(135deg,${X.red},${X.orange})`
          : allReported ? `linear-gradient(135deg,${X.red},${X.orange})`
          : isUrgent ? `linear-gradient(135deg,${X.orange},${X.red})`
          : isSoon ? `linear-gradient(135deg,${X.orange},${X.yellow})`
          : phase === "aufmerksamkeit" ? `linear-gradient(135deg,${X.yellow},${X.orange})`
          : `linear-gradient(135deg,${X.indigo},#8b5cf6)`;
        const btnShadowColor = busy ? X.red
          : allReported ? X.red
          : isUrgent ? X.orange
          : isSoon ? X.orange
          : phase === "aufmerksamkeit" ? X.yellow
          : X.indigo;
        // Phasen-Info
        const phaseHint = allReported ? "Alle Hyperscaler haben reported — Analyse empfohlen!"
          : isUrgent ? "Earnings-Woche läuft — neue Daten verfügbar"
          : isSoon ? "Earnings stehen bevor — Analyse bald sinnvoll"
          : phase === "aufmerksamkeit" ? "Earnings in 2-4 Wochen"
          : "Keine neuen Earnings — letzte Daten noch aktuell";
        const btnLabel = busy ? `⛔ Abbrechen — ${stepName} (${pct}%)`
          : allReported ? `▶  Komplettanalyse starten (${stocks.length} Pos.)`
          : `▶  Komplettanalyse starten (${stocks.length} Pos.)`;
        const handleClick = () => {
          if (busy) { cancelResearch(); return; }
          if (!checkKeys()) return;
          if (isCalm) { setShowRunConfirm(true); return; }
          run();
        };
        return React.createElement(React.Fragment, null,
          React.createElement("button", { onClick: handleClick, style: {
            width: "100%", padding: 11, marginTop: 10, marginBottom: 0, borderRadius: 10, border: "none",
            cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            background: btnBg, color: "#fff", boxShadow: `0 4px 14px ${btnShadowColor}33`,
            animation: allReported ? "earningsPulse 1.2s infinite" : "none",
          } }, btnLabel),
          // Phasen-Hinweis unter dem Button
          !busy && React.createElement("div", { style: { textAlign: "center", fontSize: 9, color: isCalm ? "#475569" : isUrgent || allReported ? X.orange : X.yellow, marginTop: 4, marginBottom: 4 } }, phaseHint),
          // Bestätigungs-Dialog
          showRunConfirm && React.createElement("div", { style: { background: `${X.indigo}12`, border: `1px solid ${X.indigo}44`, borderRadius: 10, padding: "12px 14px", marginTop: 4, marginBottom: 4 } },
            React.createElement("div", { style: { fontSize: 11, color: "#e2e8f0", marginBottom: 8, lineHeight: 1.6 } },
              "Es liegen aktuell keine neuen Hyperscaler-Earnings vor. Die letzte Analyse basiert noch auf aktuellen Daten.",
              React.createElement("br"),
              React.createElement("span", { style: { color: "#94a3b8" } }, "Trotzdem eine Komplettanalyse starten? (verbraucht API-Credits)")
            ),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
              React.createElement("button", { onClick: () => { setShowRunConfirm(false); run(); }, style: { flex: 1, padding: 8, borderRadius: 8, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", background: `linear-gradient(135deg,${X.indigo},#8b5cf6)`, color: "#fff" } }, "▶ Ja, starten"),
              React.createElement("button", { onClick: () => setShowRunConfirm(false), style: { flex: 1, padding: 8, borderRadius: 8, border: `1px solid #334155`, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit", background: "transparent", color: "#94a3b8" } }, "Abbrechen")
            )
          )
        );
      })(),

      busy && React.createElement("div", { style: { marginTop: 6, marginBottom: 6 } },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 3 } },
          React.createElement("span", { style: { fontSize: 11, color: "#94a3b8" } }, stepName),
          React.createElement("span", { className: "m", style: { fontSize: 11, color: X.indigo } }, `${pct}%`)
        ),
        React.createElement("div", { style: { height: 4, background: "#1e293b", borderRadius: 2, overflow: "hidden" } },
          React.createElement("div", { style: { height: "100%", width: `${pct}%`, borderRadius: 2, background: `linear-gradient(90deg,${X.indigo},${X.purple})`, transition: "width .4s" } })
        )
      ),

      /* ── KEY WARNING ── */
      keyWarning && React.createElement("div", { style: { background: `${X.orange}12`, border: `1px solid ${X.orange}44`, borderRadius: 10, padding: "10px 14px", marginTop: 6, marginBottom: 6 } },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 } },
          React.createElement("span", { style: { fontSize: 12, fontWeight: 700, color: X.orange } }, "Fehlende API-Keys"),
          React.createElement("button", { onClick: () => setKeyWarning(null), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 } }, "✕")
        ),
        keyWarning.map((k, i) => React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#e2e8f0", marginBottom: 3 } },
          React.createElement("span", { style: { color: X.red } }, "✕"),
          k
        )),
        React.createElement("button", { onClick: () => { setKeyWarning(null); setShowSettings(true); }, style: { marginTop: 8, width: "100%", padding: 8, borderRadius: 8, border: "none", cursor: "pointer", background: `${X.orange}22`, color: X.orange, fontSize: 11, fontWeight: 700, fontFamily: "inherit" } }, "Einstellungen öffnen")
      ),

      /* ── DEBUG PANEL (bleibt sichtbar bei Fehlern) ── */
      React.createElement(DebugPanel, { active: busy || busyTiming || busyDca }),

      /* ── TABS ── */
      React.createElement("div", { style: { display: "flex", gap: 2, margin: "10px 0 14px", background: "#111827", borderRadius: 10, padding: 3 } },
        TABS.map(([id, label]) =>
          React.createElement("button", { key: id, onClick: () => setTab(id), style: {
            flex: 1, padding: "7px 2px", borderRadius: 8, border: "none", cursor: "pointer",
            fontSize: 10, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
            background: tab === id ? "#1e293b" : "transparent",
            color: tab === id ? "#e2e8f0" : "#64748b",
          } }, `${label}${id === "alerts" && alertsLive ? ` (${analysis.alerts.length})` : ""}${id === "positions" ? ` (${stocks.length})` : ""}`)
        )
      ),

      /* ═══ OVERVIEW ═══ */
      tab === "overview" && React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 14 } },
          [
            { l: hasPLData ? "Portfolio-Wert" : "Investiert", v: `€${(hasPLData ? totalValue : totalInvested).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, s: hasPLData ? `${totalPL >= 0 ? "+" : ""}${totalPL.toFixed(1)}%` : `${stocks.length} Pos.`, c: hasPLData ? (totalPL >= 0 ? X.green : X.red) : "#e2e8f0", info: hasPLData, warn: incompleteStocks.length > 0 },
            { l: "CapEx-Trend", v: hasData ? (trMap[analysis.capexTrend] || "—") : "—", c: hasData ? (analysis.capexTrend === "accelerating" ? X.green : analysis.capexTrend === "stable" ? X.yellow : X.red) : "#64748b", s: hasData ? "Live" : "" },
            { l: "Status", v: hasData ? stMap[analysis.overallStatus] : "—", c: hasData ? X[analysis.overallStatus] : "#64748b", s: hasData ? (analysis.nextEvent || "").slice(0, 32) : "" },
          ].map((c, i) =>
            React.createElement("div", { key: i, style: { background: "#111827", borderRadius: 12, padding: "12px 11px", border: c.warn ? `2px solid ${X.orange}` : "1px solid #1e293b", minWidth: 0, overflow: "hidden", position: "relative" } },
              React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
                  React.createElement("span", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, c.l),
                  c.warn && React.createElement("span", { title: `Unvollständige Daten: ${incompleteStocks.map(s => s.ticker).join(", ")} — Kaufpreis/Aktie oder Kaufdatum fehlt`, style: { color: X.orange, fontSize: 12, cursor: "pointer", animation: "pulse 2s infinite" }, onClick: () => { setTab("positions"); } }, "⚠")
                ),
                c.info && React.createElement("button", { onClick: () => setShowDashInfo(!showDashInfo), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1 } }, "ⓘ")
              ),
              React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: c.c || "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.v),
              c.s && React.createElement("div", { style: { fontSize: 10, color: c.c || "#475569", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.s),
              c.info && showDashInfo && React.createElement("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: 10, zIndex: 10, marginTop: 4, fontSize: 11, color: "#94a3b8" } },
                React.createElement("div", null, `Investiert: €${totalInvested.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
                React.createElement("div", { style: { marginTop: 3 } }, `Aktueller Wert: €${totalValue.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
                React.createElement("div", { style: { marginTop: 3, color: totalPL >= 0 ? X.green : X.red, fontWeight: 600 } }, `P/L: ${totalPL >= 0 ? "+" : ""}${totalPL.toFixed(1)}% (€${(totalValue - totalInvested).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`),
                React.createElement("div", { style: { marginTop: 3 } }, `${stocks.length} Positionen`),
                incompleteStocks.length > 0 && React.createElement("div", { style: { marginTop: 5, paddingTop: 5, borderTop: "1px solid #334155", color: X.orange } },
                  React.createElement("div", { style: { fontWeight: 600, marginBottom: 3 } }, `⚠ ${incompleteStocks.length} Aktien unvollständig:`),
                  incompleteStocks.map(s => React.createElement("div", { key: s.ticker, style: { marginTop: 2 } }, `${s.ticker}: ${[!s.pricePerShare && "Kaufpreis/Aktie", !s.purchaseDate && "Kaufdatum"].filter(Boolean).join(", ")} fehlt`))
                )
              )
            )
          )
        ),
        /* Macro Context Strip on Overview */
        (macro || marketIndicators) && React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 12 } },
          macro?.fedFundsRate && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: "1px solid #1e293b", padding: "8px 10px", textAlign: "center" } },
            React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "Fed Rate"),
            React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${macro.fedFundsRate.current}%`),
            macro.fedFundsRate.previous != null && React.createElement("div", { style: { fontSize: 9, color: macro.fedFundsRate.current > macro.fedFundsRate.previous ? X.orange : macro.fedFundsRate.current < macro.fedFundsRate.previous ? X.green : "#475569" } }, macro.fedFundsRate.current > macro.fedFundsRate.previous ? "▲ Steigend" : macro.fedFundsRate.current < macro.fedFundsRate.previous ? "▼ Fallend" : "▶ Stabil")
          ),
          marketIndicators?.vix && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: `1px solid ${marketIndicators.vix.changePct > 5 ? X.red + "33" : "#1e293b"}`, padding: "8px 10px", textAlign: "center" } },
            React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "VIXY"),
            React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: marketIndicators.vix.changePct > 5 ? X.red : marketIndicators.vix.changePct < -5 ? X.green : "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${marketIndicators.vix.changePct >= 0 ? "+" : ""}${marketIndicators.vix.changePct?.toFixed(1)}%`)
          ),
          macro?.yieldSpread && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: `1px solid ${macro.yieldSpread.status === "inverted" ? X.red + "33" : "#1e293b"}`, padding: "8px 10px", textAlign: "center" } },
            React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "Yield Curve"),
            React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: macro.yieldSpread.status === "inverted" ? X.red : macro.yieldSpread.status === "flat" ? X.yellow : X.green, fontFamily: "'JetBrains Mono', monospace" } }, macro.yieldSpread.status === "inverted" ? "Invertiert" : macro.yieldSpread.status === "flat" ? "Flach" : "Normal")
          ),
          marketIndicators?.xlk && marketIndicators?.spy && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: "1px solid #1e293b", padding: "8px 10px", textAlign: "center" } },
            React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "Tech-Trend"),
            React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: (marketIndicators.xlk.changePct - marketIndicators.spy.changePct) >= 0 ? X.green : X.red, fontFamily: "'JetBrains Mono', monospace" } }, `${(marketIndicators.xlk.changePct - marketIndicators.spy.changePct) >= 0 ? "+" : ""}${(marketIndicators.xlk.changePct - marketIndicators.spy.changePct).toFixed(1)}%`)
          )
        ),

        hasData && React.createElement(React.Fragment, null,
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X[analysis.overallStatus]}33`, padding: 15, marginBottom: 10 } },
            React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X[analysis.overallStatus], marginBottom: 8 } }, "AI-Gesamtanalyse"),
            React.createElement("p", { style: { fontSize: 12, color: "#c8d0dc", lineHeight: 1.7, margin: "0 0 10px" } }, analysis.explanation),
            React.createElement("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 3 } }, "Empfohlene Aktion:"),
            React.createElement("div", { style: { fontSize: 12, color: X.purple, lineHeight: 1.5 } }, analysis.action)
          ),
          analysis.risks?.length > 0 && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 15 } },
            React.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, "Top-Risiken"),
            analysis.risks.map((r, i) => React.createElement("div", { key: i, style: { display: "flex", gap: 6, marginBottom: 5, fontSize: 12, color: "#94a3b8", lineHeight: 1.5 } },
              React.createElement("span", { style: { color: X.orange } }, "▸"), String(r)
            ))
          )
        ),
        !hasData && !busy && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 28, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 28, marginBottom: 10 } }, "◉"),
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 5 } }, "Starte die Live-Recherche"),
          React.createElement("div", { style: { fontSize: 12, color: "#64748b", lineHeight: 1.6 } }, `Claude durchsucht das Web nach CapEx-Daten und analysiert alle ${stocks.length} Positionen.`)
        )
      ),

      /* ═══ CAPEX ═══ */
      tab === "capex" && React.createElement(React.Fragment, null,
        React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 12, lineHeight: 1.6 } }, "CapEx der Hyperscaler. Gleichzeitiger Rückgang bei ≥2 ist das kritischste Signal."),

        /* ── CAPEX IMPACT (Earnings Deep-Dive) ── */
        capexImpact && React.createElement(React.Fragment, null,
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${capexImpact.impact === "positive" ? X.green + "44" : capexImpact.impact === "negative" ? X.red + "44" : X.yellow + "44"}`, padding: 15, marginBottom: 10 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              React.createElement("span", { style: { fontSize: 13, fontWeight: 700 } }, "Earnings-Impact"),
              React.createElement("span", { style: { fontSize: 9, padding: "2px 8px", borderRadius: 10, background: `${capexImpact.impact === "positive" ? X.green : capexImpact.impact === "negative" ? X.red : X.yellow}18`, border: `1px solid ${capexImpact.impact === "positive" ? X.green : capexImpact.impact === "negative" ? X.red : X.yellow}44`, color: capexImpact.impact === "positive" ? X.green : capexImpact.impact === "negative" ? X.red : X.yellow, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" } }, capexImpact.impact === "positive" ? "POSITIV" : capexImpact.impact === "negative" ? "NEGATIV" : "NEUTRAL")
            ),
            React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", lineHeight: 1.7, margin: 0 } }, capexImpact.summary)
          ),

          capexImpact.guidance_changes && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 15, marginBottom: 10 } },
            React.createElement("div", { style: { fontSize: 12, fontWeight: 700, marginBottom: 6, color: X.purple } }, "Guidance-Änderungen"),
            React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", lineHeight: 1.7, margin: 0 } }, capexImpact.guidance_changes)
          ),

          (capexImpact.winners?.length > 0 || capexImpact.losers?.length > 0) && React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 } },
            capexImpact.winners?.length > 0 && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.green}22`, padding: 12 } },
              React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: X.green, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 } }, "Winners"),
              capexImpact.winners.map((w, i) => React.createElement("div", { key: i, style: { fontSize: 11, color: "#e2e8f0", marginBottom: 4 } },
                React.createElement("span", { style: { fontWeight: 700, color: X.green } }, w.ticker), " ", React.createElement("span", { style: { color: "#94a3b8" } }, w.reason)
              ))
            ),
            capexImpact.losers?.length > 0 && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.red}22`, padding: 12 } },
              React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: X.red, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 } }, "Losers"),
              capexImpact.losers.map((l, i) => React.createElement("div", { key: i, style: { fontSize: 11, color: "#e2e8f0", marginBottom: 4 } },
                React.createElement("span", { style: { fontWeight: 700, color: X.red } }, l.ticker), " ", React.createElement("span", { style: { color: "#94a3b8" } }, l.reason)
              ))
            )
          ),

          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.purple, margin: "6px 0 10px", textTransform: "uppercase", letterSpacing: ".06em" } }, "Einzelanalysen")
        ),

        capex.length > 0 ? capex.map((r, i) =>
          React.createElement("div", { key: i, style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 15, marginBottom: 8 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, r.label),
              React.createElement(BDG, { s: r.sentiment })
            ),
            React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", lineHeight: 1.7, margin: 0 } }, r.summary),
            r.keyPoints?.length > 0 && React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 } },
              r.keyPoints.slice(0, 3).map((p, j) => React.createElement("span", { key: j, style: { fontSize: 10, padding: "3px 8px", borderRadius: 6, background: "#1e293b", color: X.purple } }, String(p).slice(0, 70)))
            )
          )
        ) : React.createElement("p", { style: { textAlign: "center", color: "#475569", fontSize: 12, padding: 20 } }, "Recherche starten"),
        React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X.purple, margin: "14px 0 8px" } }, "Leitindikatoren"),
        tsmc && React.createElement(RCard, { t: "TSMC Monatsumsätze", d: tsmc }),
        dram && React.createElement(RCard, { t: "DRAM Spotpreise", d: dram })
      ),

      /* ═══ MAKRO ═══ */
      tab === "macro" && React.createElement(React.Fragment, null,
        React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 12, lineHeight: 1.6 } }, "Makroökonomisches Umfeld — FRED API (deterministische Daten) + VIX/Sektor (Finnhub)."),
        macro ? React.createElement(React.Fragment, null,
          /* Zinsen & Yield Curve */
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.purple, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".06em" } }, "Zinsen & Yield Curve"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 14 } },
            macro.fedFundsRate && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Fed Funds Rate"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${macro.fedFundsRate.current}%`),
              macro.fedFundsRate.previous != null && React.createElement("div", { style: { fontSize: 10, color: macro.fedFundsRate.current > macro.fedFundsRate.previous ? X.red : macro.fedFundsRate.current < macro.fedFundsRate.previous ? X.green : "#64748b", marginTop: 2 } }, `Vorher: ${macro.fedFundsRate.previous}%`)
            ),
            macro.yieldSpread && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${macro.yieldSpread.status === "inverted" ? X.red + "44" : macro.yieldSpread.status === "flat" ? X.yellow + "44" : "#1e293b"}`, padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Yield Spread (10Y-2Y)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: macro.yieldSpread.status === "inverted" ? X.red : macro.yieldSpread.status === "flat" ? X.yellow : X.green, fontFamily: "'JetBrains Mono', monospace" } }, `${macro.yieldSpread.current}%`),
              React.createElement("div", { style: { fontSize: 10, color: macro.yieldSpread.status === "inverted" ? X.red : macro.yieldSpread.status === "flat" ? X.yellow : X.green, marginTop: 2 } }, macro.yieldSpread.status === "inverted" ? "⚠ Invertiert — Rezessionsrisiko" : macro.yieldSpread.status === "flat" ? "◈ Flach — Beobachten" : "✓ Normal")
            ),
            macro.treasury2y && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Treasury 2Y"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${macro.treasury2y.current}%`)
            ),
            macro.treasury10y && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Treasury 10Y"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${macro.treasury10y.current}%`)
            )
          ),

          /* Inflation */
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.orange, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".06em" } }, "Inflation"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 14 } },
            macro.cpiYoy && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "CPI (Verbraucherpreise)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: (macro.cpiYoy.yoy || 0) > 3 ? X.red : (macro.cpiYoy.yoy || 0) > 2.5 ? X.yellow : X.green, fontFamily: "'JetBrains Mono', monospace" } }, macro.cpiYoy.yoy != null ? `${macro.cpiYoy.yoy}% YoY` : `${macro.cpiYoy.current}`),
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginTop: 2 } }, `Stand: ${macro.cpiYoy.date}`)
            ),
            macro.corePce && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Core PCE (Fed-Maß)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: (macro.corePce.yoy || 0) > 3 ? X.red : (macro.corePce.yoy || 0) > 2.5 ? X.yellow : X.green, fontFamily: "'JetBrains Mono', monospace" } }, macro.corePce.yoy != null ? `${macro.corePce.yoy}% YoY` : `${macro.corePce.current}`),
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginTop: 2 } }, `Stand: ${macro.corePce.date}`)
            )
          ),

          /* Wirtschaft */
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.cyan, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".06em" } }, "Wirtschaft"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 14 } },
            macro.gdp && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "GDP (Mrd. $)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${(macro.gdp.current / 1000).toFixed(1)}T`),
              macro.gdp.previous && React.createElement("div", { style: { fontSize: 10, color: macro.gdp.current > macro.gdp.previous ? X.green : X.red, marginTop: 2 } }, `${macro.gdp.current > macro.gdp.previous ? "▲" : "▼"} Vorher: ${(macro.gdp.previous / 1000).toFixed(1)}T`)
            ),
            macro.unemployment && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Arbeitslosenquote"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: macro.unemployment.current > 5 ? X.red : macro.unemployment.current > 4 ? X.yellow : X.green, fontFamily: "'JetBrains Mono', monospace" } }, `${macro.unemployment.current}%`),
              macro.unemployment.previous != null && React.createElement("div", { style: { fontSize: 10, color: macro.unemployment.current > macro.unemployment.previous ? X.red : X.green, marginTop: 2 } }, `Vorher: ${macro.unemployment.previous}%`)
            )
          )
        ) : React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 28, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 28, marginBottom: 10 } }, "📊"),
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 5 } }, getFredKey() ? "Recherche starten für Makro-Daten" : "FRED API Key benötigt"),
          React.createElement("div", { style: { fontSize: 12, color: "#64748b", lineHeight: 1.6 } }, getFredKey() ? "Starte die Live-Recherche, um Zinsen, Yield Curve, Inflation und Arbeitsmarkt zu laden." : "Kostenlos auf fred.stlouisfed.org — in den Einstellungen hinterlegen.")
        ),

        /* VIX + Sektor-ETFs */
        marketIndicators && React.createElement(React.Fragment, null,
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.indigo, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".06em" } }, "Marktindikatoren (Finnhub)"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 14 } },
            marketIndicators.vix && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${marketIndicators.vix.changePct > 10 ? X.red + "44" : marketIndicators.vix.changePct > 5 ? X.yellow + "44" : "#1e293b"}`, padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "VIXY (Volatilität)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `$${marketIndicators.vix.price.toFixed(2)}`),
              React.createElement("div", { style: { fontSize: 10, color: marketIndicators.vix.changePct > 5 ? X.red : marketIndicators.vix.changePct < -5 ? X.green : "#64748b", marginTop: 2 } }, `${marketIndicators.vix.changePct >= 0 ? "+" : ""}${marketIndicators.vix.changePct?.toFixed(1)}% — ${marketIndicators.vix.changePct > 5 ? "Angst steigt" : marketIndicators.vix.changePct < -5 ? "Angst fällt" : "Stabil"}`)
            ),
            marketIndicators.spy && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "S&P 500 (SPY)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `$${marketIndicators.spy.price}`),
              React.createElement("div", { style: { fontSize: 10, color: marketIndicators.spy.changePct >= 0 ? X.green : X.red, marginTop: 2 } }, `${marketIndicators.spy.changePct >= 0 ? "+" : ""}${marketIndicators.spy.changePct?.toFixed(2)}%`)
            ),
            marketIndicators.xlk && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Tech-Sektor (XLK)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `$${marketIndicators.xlk.price}`),
              React.createElement("div", { style: { fontSize: 10, color: marketIndicators.xlk.changePct >= 0 ? X.green : X.red, marginTop: 2 } }, `${marketIndicators.xlk.changePct >= 0 ? "+" : ""}${marketIndicators.xlk.changePct?.toFixed(2)}%`),
              marketIndicators.spy && React.createElement("div", { style: { fontSize: 9, color: (marketIndicators.xlk.changePct - marketIndicators.spy.changePct) >= 0 ? X.green : X.orange, marginTop: 2 } }, `vs S&P: ${(marketIndicators.xlk.changePct - marketIndicators.spy.changePct) >= 0 ? "+" : ""}${(marketIndicators.xlk.changePct - marketIndicators.spy.changePct).toFixed(2)}%`)
            ),
            marketIndicators.smh && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13 } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, "Halbleiter (SMH)"),
              React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `$${marketIndicators.smh.price}`),
              React.createElement("div", { style: { fontSize: 10, color: marketIndicators.smh.changePct >= 0 ? X.green : X.red, marginTop: 2 } }, `${marketIndicators.smh.changePct >= 0 ? "+" : ""}${marketIndicators.smh.changePct?.toFixed(2)}%`),
              marketIndicators.spy && React.createElement("div", { style: { fontSize: 9, color: (marketIndicators.smh.changePct - marketIndicators.spy.changePct) >= 0 ? X.green : X.orange, marginTop: 2 } }, `vs S&P: ${(marketIndicators.smh.changePct - marketIndicators.spy.changePct) >= 0 ? "+" : ""}${(marketIndicators.smh.changePct - marketIndicators.spy.changePct).toFixed(2)}%`)
            )
          )
        )
      ),

      /* ═══ POSITIONS ═══ */
      tab === "positions" && React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
          React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", margin: 0 } }, `${capexStocks.length} CapEx-Positionen${otherStocks.length > 0 ? ` + ${otherStocks.length} Andere` : ""}`),
          React.createElement("button", { onClick: () => setShowAdd(!showAdd), style: {
            padding: "5px 12px", borderRadius: 8, border: `1px solid ${X.indigo}44`, cursor: "pointer",
            background: showAdd ? "#1e293b" : `${X.indigo}15`, color: X.purple, fontSize: 11, fontWeight: 600, fontFamily: "inherit",
          } }, showAdd ? "✕ Schließen" : "+ Aktie hinzufügen")
        ),

        /* Add Stock Form */
        showAdd && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.indigo}33`, padding: 16, marginBottom: 12 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X.purple, marginBottom: 10 } }, "Neue Position hinzufügen"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr auto 2fr", gap: 8, marginBottom: 10 } },
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Ticker"),
              React.createElement("input", { value: addTicker, onChange: e => setAddTicker(e.target.value), placeholder: "z.B. LLY", style: inp })
            ),
            React.createElement("div", { style: { display: "flex", alignItems: "flex-end" } },
              React.createElement("button", { onClick: autofill, disabled: !canAutofill || filling, style: {
                padding: "7px 12px", borderRadius: 8, border: "none", cursor: (!canAutofill || filling) ? "not-allowed" : "pointer",
                background: !canAutofill ? "#0f172a" : filling ? "#1e293b" : `${X.cyan}22`,
                color: !canAutofill ? "#334155" : filling ? "#475569" : X.cyan,
                fontSize: 11, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap",
                opacity: !canAutofill ? 0.35 : 1,
                animation: filling ? "pulse 1.5s infinite" : "none",
              } }, filling ? "⟳ …" : "⚡ Autofill")
            ),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Name"),
              React.createElement("input", { value: addName, onChange: e => setAddName(e.target.value), placeholder: "z.B. Eli Lilly", style: inp })
            )
          ),
          React.createElement("div", { style: { fontSize: 10, color: "#475569", marginBottom: 8, fontStyle: "italic" } }, "Ticker oder Name eingeben, dann ⚡ Autofill — Claude füllt alle Felder automatisch."),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 10 } },
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Sektor / Branche"),
              React.createElement("input", { value: addSector, onChange: e => setAddSector(e.target.value), placeholder: "z.B. Pharma", style: inp })
            ),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Investiert (€)"),
              React.createElement("input", { value: addCost, onChange: e => setAddCost(e.target.value), placeholder: "0", type: "number", style: inp })
            ),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Kaufpreis/Aktie (€)"),
              React.createElement("input", { value: addPricePerShare, onChange: e => setAddPricePerShare(e.target.value), placeholder: "0", type: "number", style: inp })
            ),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Kaufdatum"),
              React.createElement("input", { value: addDate, onChange: e => setAddDate(e.target.value), type: "date", style: inp })
            )
          ),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 } },
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Typ"),
              React.createElement("select", { value: addType, onChange: e => setAddType(e.target.value), style: sel },
                React.createElement("option", { value: "capex" }, "CapEx-abhängig"),
                React.createElement("option", { value: "other" }, "Andere")
              )
            ),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Sensitivität"),
              React.createElement("select", { value: addSens, onChange: e => setAddSens(e.target.value), style: sel },
                React.createElement("option", { value: "very high" }, "Sehr hoch"),
                React.createElement("option", { value: "high" }, "Hoch"),
                React.createElement("option", { value: "medium" }, "Mittel"),
                React.createElement("option", { value: "low" }, "Niedrig")
              )
            ),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 10, color: "#64748b", marginBottom: 3 } }, "Moat"),
              React.createElement("select", { value: addMoat, onChange: e => setAddMoat(e.target.value), style: sel },
                React.createElement("option", { value: "wide" }, "Breit"),
                React.createElement("option", { value: "medium" }, "Mittel"),
                React.createElement("option", { value: "narrow" }, "Schmal")
              )
            )
          ),
          React.createElement("button", { onClick: addStock, disabled: !addTicker.trim() || !addName.trim(), style: {
            width: "100%", padding: 9, borderRadius: 8, border: "none", cursor: "pointer",
            background: (!addTicker.trim() || !addName.trim()) ? "#1e293b" : X.indigo,
            color: (!addTicker.trim() || !addName.trim()) ? "#475569" : "#fff",
            fontSize: 12, fontWeight: 700, fontFamily: "inherit",
          } }, "Hinzufügen")
        ),

        /* CapEx Stocks */
        capexStocks.length > 0 && React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.purple, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".06em" } }, `CapEx-abhängig (${capexStocks.length})`),
        [...capexStocks].sort((a, b) => a.sell - b.sell).map(pos => {
          const pr = positions[pos.ticker];
          const fhd = finnhubData[pos.ticker];
          const pl = calcPL(pos, fhd?.price, eurUsdRate);
          const incomplete = !pos.pricePerShare || !pos.purchaseDate;
          return React.createElement("div", { key: pos.ticker, style: { background: "#111827", borderRadius: 12, border: incomplete ? `2px solid ${X.orange}` : "1px solid #1e293b", padding: 13, marginBottom: 8 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 9, minWidth: 0, flex: 1 } },
                React.createElement("div", { className: "m", style: { width: 32, height: 32, borderRadius: 7, background: "#1e293b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: X.purple, flexShrink: 0 } }, pos.ticker),
                React.createElement("div", { style: { minWidth: 0 } },
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    React.createElement("span", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, pos.name),
                    React.createElement(TypeBadge, { type: "capex" }),
                    (!pos.pricePerShare || !pos.purchaseDate) && React.createElement("span", { title: "Kaufpreis/Aktie oder Kaufdatum fehlt — ⓘ klicken zum Nachtragen", style: { color: X.orange, fontSize: 14, cursor: "pointer", animation: "pulse 2s infinite" }, onClick: () => setInfoTicker(pos.ticker) }, "⚠")
                  ),
                  React.createElement("div", { style: { fontSize: 10, color: "#64748b" } }, `${pos.sector} · Sensitivität: `, React.createElement("span", { style: { color: sensColor(pos.sensitivity) } }, pos.sensitivity), ` · Moat: ${moatLabel(pos.moat)}`)
                )
              ),
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 } },
                React.createElement("div", { style: { textAlign: "right", position: "relative" } },
                  React.createElement("div", { className: "m", style: { fontSize: 12, fontWeight: 600 } }, pl ? `€${pl.currentValue.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `€${pos.cost.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
                  pl && React.createElement("div", { className: "m", style: { fontSize: 11, fontWeight: 600, color: pl.plPct >= 0 ? X.green : X.red } }, `${pl.plPct >= 0 ? "+" : ""}${pl.plPct.toFixed(1)}%`),
                  pr && React.createElement(BDG, { s: pr.sentiment })
                ),
                React.createElement("button", { onClick: () => setInfoTicker(infoTicker === pos.ticker ? null : pos.ticker), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1, display: "flex", alignItems: "center", color: "#64748b", fontSize: 12, flexShrink: 0 } }, "ⓘ"),
                React.createElement("button", { onClick: () => { setNachkaufTicker(nachkaufTicker === pos.ticker ? null : pos.ticker); setNachkaufBetrag(""); }, style: { background: "#6366f122", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1, display: "flex", alignItems: "center", flexShrink: 0 }, dangerouslySetInnerHTML: { __html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' }, title: "Nachkauf" }),
                React.createElement("button", { onClick: () => { if (confirm(`${pos.name} (${pos.ticker}) unwiderruflich aus dem Portfolio löschen?`)) removeStock(pos.ticker); }, style: { background: "#dc262622", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1, display: "flex", alignItems: "center", flexShrink: 0 }, dangerouslySetInnerHTML: { __html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' } })
              )
            ),
            infoTicker === pos.ticker && React.createElement("div", { style: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: 10, marginTop: 8, fontSize: 11, color: "#94a3b8" } },
              pl && React.createElement("div", null, `Gesamt investiert: €${pos.cost.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Ø €${pl.avgCost.toFixed(2)} · ${pl.totalShares.toFixed(2)} Anteile`),
              pl && React.createElement("div", { style: { marginTop: 3, color: pl.plPct >= 0 ? X.green : X.red, fontWeight: 600 } }, `P/L: €${(pl.currentValue - pl.totalInvested).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pl.plPct >= 0 ? "+" : ""}${pl.plPct.toFixed(1)}%)`),
              /* Initialkauf */
              React.createElement("div", { style: { marginTop: 6, paddingTop: 6, borderTop: "1px solid #334155" } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  React.createElement("span", { style: { fontWeight: 600 } }, "Initialkauf"),
                  editingInitial !== pos.ticker
                    ? React.createElement("button", { onClick: () => { setEditingInitial(pos.ticker); setEditCost(String(pos.cost - (pos.purchases || []).reduce((s, p) => s + p.amount, 0))); setEditPPS(String(pos.pricePerShare || "")); setEditDate(pos.purchaseDate || ""); }, style: { background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 10, fontWeight: 600 } }, "Bearbeiten")
                    : null
                ),
                editingInitial === pos.ticker
                  ? React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
                      React.createElement("input", { value: editCost, onChange: e => setEditCost(e.target.value), type: "number", placeholder: "Invest €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 90 } }),
                      React.createElement("input", { value: editPPS, onChange: e => setEditPPS(e.target.value), type: "number", placeholder: "Preis/Aktie €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 100 } }),
                      React.createElement("input", { value: editDate, onChange: e => setEditDate(e.target.value), type: "date", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 120 } }),
                      React.createElement("button", { onClick: () => {
                        const nachkaufSum = (pos.purchases || []).reduce((s, p) => s + p.amount, 0);
                        const upd = {};
                        if (editCost) upd.cost = parseFloat(editCost) + nachkaufSum;
                        if (editPPS) upd.pricePerShare = parseFloat(editPPS);
                        if (editDate) upd.purchaseDate = editDate;
                        if (Object.keys(upd).length > 0) updateStock(pos.ticker, upd);
                        setEditingInitial(null); setEditCost(""); setEditPPS(""); setEditDate("");
                      }, style: { background: "#6366f1", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" } }, "OK"),
                      React.createElement("button", { onClick: () => { setEditingInitial(null); setEditCost(""); setEditPPS(""); setEditDate(""); }, style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 10 } }, "Abbrechen")
                    )
                  : React.createElement("div", { style: { marginTop: 2 } },
                      `${pos.purchaseDate ? new Date(pos.purchaseDate).toLocaleDateString("de-DE") : "?"}: €${((pos.cost || 0) - (pos.purchases || []).reduce((s, p) => s + p.amount, 0)).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} à €${pos.pricePerShare?.toFixed(2) || "?"}`,
                      pos.purchaseDate ? ` (${holdingDuration(pos.purchaseDate)})` : ""
                    )
              ),
              /* Nachkäufe */
              pos.purchases?.length > 0 && React.createElement("div", { style: { marginTop: 6, borderTop: "1px solid #334155", paddingTop: 6 } },
                React.createElement("div", { style: { fontWeight: 600, marginBottom: 3 } }, `${pos.purchases.length} Nachkäufe:`),
                pos.purchases.map((p, i) =>
                  editingNachkauf === `${pos.ticker}-${i}`
                    ? React.createElement("div", { key: i, style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 3 } },
                        React.createElement("input", { value: editNkAmount, onChange: e => setEditNkAmount(e.target.value), type: "number", placeholder: "Betrag €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 90 } }),
                        React.createElement("input", { value: editNkPPS, onChange: e => setEditNkPPS(e.target.value), type: "number", placeholder: "Preis/Aktie €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 100 } }),
                        React.createElement("input", { value: editNkDate, onChange: e => setEditNkDate(e.target.value), type: "date", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 120 } }),
                        React.createElement("button", { onClick: () => { const upd = {}; if (editNkAmount) upd.amount = parseFloat(editNkAmount); if (editNkPPS) upd.pricePerShare = parseFloat(editNkPPS); if (editNkDate) upd.date = editNkDate; updateNachkauf(pos.ticker, i, upd); }, style: { background: "#6366f1", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" } }, "OK"),
                        React.createElement("button", { onClick: () => setEditingNachkauf(null), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 10 } }, "Abb.")
                      )
                    : React.createElement("div", { key: i, style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 } },
                        React.createElement("span", null, `${new Date(p.date).toLocaleDateString("de-DE")}: €${p.amount.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} à €${p.pricePerShare?.toFixed(2) || "?"}`),
                        React.createElement("span", { style: { display: "flex", gap: 4, flexShrink: 0 } },
                          React.createElement("button", { onClick: () => { setEditingNachkauf(`${pos.ticker}-${i}`); setEditNkAmount(String(p.amount)); setEditNkPPS(String(p.pricePerShare || "")); setEditNkDate(p.date || ""); }, style: { background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 10 } }, "✎"),
                          React.createElement("button", { onClick: () => { if (confirm(`Nachkauf vom ${new Date(p.date).toLocaleDateString("de-DE")} löschen?`)) removeNachkauf(pos.ticker, i); }, style: { background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 10 } }, "✕")
                        )
                      )
                )
              )
            ),
            nachkaufTicker === pos.ticker && React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8, padding: "8px 0", borderTop: "1px solid #1e293b" } },
              React.createElement("span", { style: { fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" } }, "Nachkauf"),
              React.createElement("input", { value: nachkaufBetrag, onChange: e => setNachkaufBetrag(e.target.value), type: "number", placeholder: "Betrag €", autoFocus: true, style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 90 } }),
              React.createElement("input", { value: nachkaufPPS, onChange: e => setNachkaufPPS(e.target.value), type: "number", placeholder: "Preis/Aktie €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 110 } }),
              React.createElement("input", { value: nachkaufDate, onChange: e => setNachkaufDate(e.target.value), type: "date", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 120 } }),
              React.createElement("button", { onClick: () => addNachkauf(pos.ticker, nachkaufBetrag, nachkaufPPS, nachkaufDate), style: { background: "#6366f1", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" } }, "OK"),
              React.createElement("button", { onClick: () => setNachkaufTicker(null), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 11 } }, "Abbrechen")
            ),
            pr && React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", lineHeight: 1.6, marginTop: 9, paddingTop: 9, borderTop: "1px solid #1e293b" } }, pr.summary)
          );
        }),

        /* Other Stocks */
        otherStocks.length > 0 && React.createElement(React.Fragment, null,
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.cyan, marginBottom: 6, marginTop: 14, textTransform: "uppercase", letterSpacing: ".06em" } }, `Andere Positionen (${otherStocks.length})`),
          otherStocks.map(pos => {
            const pr = positions[pos.ticker];
            const fhd = finnhubData[pos.ticker];
            const pl = calcPL(pos, fhd?.price, eurUsdRate);
            const incomplete = !pos.pricePerShare || !pos.purchaseDate;
            return React.createElement("div", { key: pos.ticker, style: { background: "#111827", borderRadius: 12, border: incomplete ? `2px solid ${X.orange}` : `1px solid ${X.cyan}22`, padding: 13, marginBottom: 8 } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 9, minWidth: 0, flex: 1 } },
                  React.createElement("div", { className: "m", style: { width: 32, height: 32, borderRadius: 7, background: `${X.cyan}15`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: X.cyan, flexShrink: 0 } }, pos.ticker),
                  React.createElement("div", { style: { minWidth: 0 } },
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                      React.createElement("span", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, pos.name),
                      React.createElement(TypeBadge, { type: "other" }),
                      (!pos.pricePerShare || !pos.purchaseDate) && React.createElement("span", { title: "Kaufpreis/Aktie oder Kaufdatum fehlt — ⓘ klicken zum Nachtragen", style: { color: X.orange, fontSize: 14, cursor: "pointer", animation: "pulse 2s infinite" }, onClick: () => setInfoTicker(pos.ticker) }, "⚠")
                    ),
                    React.createElement("div", { style: { fontSize: 10, color: "#64748b" } }, `${pos.sector} · Moat: ${moatLabel(pos.moat)}`)
                  )
                ),
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 } },
                  React.createElement("div", { style: { textAlign: "right", position: "relative" } },
                    React.createElement("div", { className: "m", style: { fontSize: 12, fontWeight: 600 } }, pl ? `€${pl.currentValue.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `€${pos.cost.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
                    pl && React.createElement("div", { className: "m", style: { fontSize: 11, fontWeight: 600, color: pl.plPct >= 0 ? X.green : X.red } }, `${pl.plPct >= 0 ? "+" : ""}${pl.plPct.toFixed(1)}%`),
                    pr && React.createElement(BDG, { s: pr.sentiment })
                  ),
                  React.createElement("button", { onClick: () => setInfoTicker(infoTicker === pos.ticker ? null : pos.ticker), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1, display: "flex", alignItems: "center", color: "#64748b", fontSize: 12, flexShrink: 0 } }, "ⓘ"),
                  React.createElement("button", { onClick: () => { setNachkaufTicker(nachkaufTicker === pos.ticker ? null : pos.ticker); setNachkaufBetrag(""); }, style: { background: "#6366f122", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1, display: "flex", alignItems: "center", flexShrink: 0 }, dangerouslySetInnerHTML: { __html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' }, title: "Nachkauf" }),
                  React.createElement("button", { onClick: () => { if (confirm(`${pos.name} (${pos.ticker}) unwiderruflich aus dem Portfolio löschen?`)) removeStock(pos.ticker); }, style: { background: "#dc262622", border: "none", cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1, display: "flex", alignItems: "center", flexShrink: 0 }, dangerouslySetInnerHTML: { __html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' } })
                )
              ),
              infoTicker === pos.ticker && React.createElement("div", { style: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: 10, marginTop: 8, fontSize: 11, color: "#94a3b8" } },
                pl && React.createElement("div", null, `Gesamt investiert: €${pos.cost.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Ø €${pl.avgCost.toFixed(2)} · ${pl.totalShares.toFixed(2)} Anteile`),
                pl && React.createElement("div", { style: { marginTop: 3, color: pl.plPct >= 0 ? X.green : X.red, fontWeight: 600 } }, `P/L: €${(pl.currentValue - pl.totalInvested).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pl.plPct >= 0 ? "+" : ""}${pl.plPct.toFixed(1)}%)`),
                React.createElement("div", { style: { marginTop: 6, paddingTop: 6, borderTop: "1px solid #334155" } },
                  React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    React.createElement("span", { style: { fontWeight: 600 } }, "Initialkauf"),
                    editingInitial !== pos.ticker
                      ? React.createElement("button", { onClick: () => { setEditingInitial(pos.ticker); setEditCost(String(pos.cost - (pos.purchases || []).reduce((s, p) => s + p.amount, 0))); setEditPPS(String(pos.pricePerShare || "")); setEditDate(pos.purchaseDate || ""); }, style: { background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 10, fontWeight: 600 } }, "Bearbeiten")
                      : null
                  ),
                  editingInitial === pos.ticker
                    ? React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
                        React.createElement("input", { value: editCost, onChange: e => setEditCost(e.target.value), type: "number", placeholder: "Invest €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 90 } }),
                        React.createElement("input", { value: editPPS, onChange: e => setEditPPS(e.target.value), type: "number", placeholder: "Preis/Aktie €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 100 } }),
                        React.createElement("input", { value: editDate, onChange: e => setEditDate(e.target.value), type: "date", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 120 } }),
                        React.createElement("button", { onClick: () => {
                          const nachkaufSum = (pos.purchases || []).reduce((s, p) => s + p.amount, 0);
                          const upd = {};
                          if (editCost) upd.cost = parseFloat(editCost) + nachkaufSum;
                          if (editPPS) upd.pricePerShare = parseFloat(editPPS);
                          if (editDate) upd.purchaseDate = editDate;
                          if (Object.keys(upd).length > 0) updateStock(pos.ticker, upd);
                          setEditingInitial(null); setEditCost(""); setEditPPS(""); setEditDate("");
                        }, style: { background: "#6366f1", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" } }, "OK"),
                        React.createElement("button", { onClick: () => { setEditingInitial(null); setEditCost(""); setEditPPS(""); setEditDate(""); }, style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 10 } }, "Abbrechen")
                      )
                    : React.createElement("div", { style: { marginTop: 2 } },
                        `${pos.purchaseDate ? new Date(pos.purchaseDate).toLocaleDateString("de-DE") : "?"}: €${((pos.cost || 0) - (pos.purchases || []).reduce((s, p) => s + p.amount, 0)).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} à €${pos.pricePerShare?.toFixed(2) || "?"}`,
                        pos.purchaseDate ? ` (${holdingDuration(pos.purchaseDate)})` : ""
                      )
                ),
                pos.purchases?.length > 0 && React.createElement("div", { style: { marginTop: 6, borderTop: "1px solid #334155", paddingTop: 6 } },
                  React.createElement("div", { style: { fontWeight: 600, marginBottom: 3 } }, `${pos.purchases.length} Nachkäufe:`),
                  pos.purchases.map((p, i) =>
                    editingNachkauf === `${pos.ticker}-${i}`
                      ? React.createElement("div", { key: i, style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 3 } },
                          React.createElement("input", { value: editNkAmount, onChange: e => setEditNkAmount(e.target.value), type: "number", placeholder: "Betrag €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 90 } }),
                          React.createElement("input", { value: editNkPPS, onChange: e => setEditNkPPS(e.target.value), type: "number", placeholder: "Preis/Aktie €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 100 } }),
                          React.createElement("input", { value: editNkDate, onChange: e => setEditNkDate(e.target.value), type: "date", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 11, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 120 } }),
                          React.createElement("button", { onClick: () => { const upd = {}; if (editNkAmount) upd.amount = parseFloat(editNkAmount); if (editNkPPS) upd.pricePerShare = parseFloat(editNkPPS); if (editNkDate) upd.date = editNkDate; updateNachkauf(pos.ticker, i, upd); }, style: { background: "#6366f1", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 10, fontWeight: 700, color: "#fff", cursor: "pointer" } }, "OK"),
                          React.createElement("button", { onClick: () => setEditingNachkauf(null), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 10 } }, "Abb.")
                        )
                      : React.createElement("div", { key: i, style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 } },
                          React.createElement("span", null, `${new Date(p.date).toLocaleDateString("de-DE")}: €${p.amount.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} à €${p.pricePerShare?.toFixed(2) || "?"}`),
                          React.createElement("span", { style: { display: "flex", gap: 4, flexShrink: 0 } },
                            React.createElement("button", { onClick: () => { setEditingNachkauf(`${pos.ticker}-${i}`); setEditNkAmount(String(p.amount)); setEditNkPPS(String(p.pricePerShare || "")); setEditNkDate(p.date || ""); }, style: { background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 10 } }, "✎"),
                            React.createElement("button", { onClick: () => { if (confirm(`Nachkauf vom ${new Date(p.date).toLocaleDateString("de-DE")} löschen?`)) removeNachkauf(pos.ticker, i); }, style: { background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 10 } }, "✕")
                          )
                        )
                  )
                )
              ),
              nachkaufTicker === pos.ticker && React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8, padding: "8px 0", borderTop: "1px solid #1e293b" } },
                React.createElement("span", { style: { fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" } }, "Nachkauf"),
                React.createElement("input", { value: nachkaufBetrag, onChange: e => setNachkaufBetrag(e.target.value), type: "number", placeholder: "Betrag €", autoFocus: true, style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 90 } }),
                React.createElement("input", { value: nachkaufPPS, onChange: e => setNachkaufPPS(e.target.value), type: "number", placeholder: "Preis/Aktie €", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 110 } }),
                React.createElement("input", { value: nachkaufDate, onChange: e => setNachkaufDate(e.target.value), type: "date", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: 120 } }),
                React.createElement("button", { onClick: () => addNachkauf(pos.ticker, nachkaufBetrag, nachkaufPPS, nachkaufDate), style: { background: "#6366f1", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" } }, "OK"),
                React.createElement("button", { onClick: () => setNachkaufTicker(null), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 11 } }, "Abbrechen")
              ),
              pr && React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", lineHeight: 1.6, marginTop: 9, paddingTop: 9, borderTop: "1px solid #1e293b" } }, pr.summary)
            );
          })
        ),

        nvidia && React.createElement(RCard, { t: "NVIDIA Guidance (Detail)", d: nvidia }),
        insider && React.createElement(RCard, { t: "Insider-Aktivitäten", d: insider })
      ),

      /* ═══ TIMING ═══ */
      tab === "timing" && React.createElement(React.Fragment, null,
        React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 10 } }, "Kurs-Timing: Nachkaufen bei Korrekturen, Gewinne mitnehmen bei Überhitzung."),
        React.createElement("button", { onClick: () => { if (checkKeys()) runTiming(); }, disabled: busyTiming || busy, style: {
          width: "100%", padding: 10, marginBottom: 12, borderRadius: 10, border: "none",
          cursor: (busyTiming || busy) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit",
          background: (busyTiming || busy) ? "#1e293b" : `linear-gradient(135deg,${X.cyan}cc,${X.indigo})`,
          color: (busyTiming || busy) ? "#64748b" : "#fff",
          boxShadow: (busyTiming || busy) ? "none" : `0 4px 14px ${X.cyan}22`,
        } }, busyTiming ? `⟳ ${timingStep}` : "⚡  Timing aktualisieren"),

        /* 52wH verifizieren */
        Object.keys(finnhubData).length > 0 && React.createElement("button", {
          onClick: async () => {
            if (!getApiKey()) return;
            setBusyVerify(true);
            try {
              const verified = await verify52WeekHighs(finnhubData);
              setFinnhubData(verified);
              persistAll({ finnhubData: verified });
            } catch (e) { console.error("Verify error:", e); }
            finally { setBusyVerify(false); }
          },
          disabled: busyVerify || busy || busyTiming,
          style: {
            width: "100%", padding: 9, marginBottom: 12, borderRadius: 10,
            border: `1px solid ${X.purple}44`,
            cursor: (busyVerify || busy || busyTiming) ? "not-allowed" : "pointer",
            fontSize: 11, fontWeight: 600, fontFamily: "inherit",
            background: busyVerify ? "#1e293b" : `${X.purple}15`,
            color: busyVerify ? "#64748b" : X.purple,
            opacity: (busy || busyTiming) ? 0.4 : 1,
          }
        }, busyVerify ? "⟳ 52-Wochen-Hochs werden verifiziert…" : "🔍  52-Wochen-Hochs verifizieren (Web-Suche)"),

        timing ? React.createElement(React.Fragment, null,
          /* Macro Context Strip */
          (marketIndicators || macro) && React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 12 } },
            marketIndicators?.vix && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: `1px solid ${marketIndicators.vix.changePct > 5 ? X.red + "33" : "#1e293b"}`, padding: "8px 10px", textAlign: "center" } },
              React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "VIXY"),
              React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: marketIndicators.vix.changePct > 5 ? X.red : marketIndicators.vix.changePct < -5 ? X.green : "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${marketIndicators.vix.changePct >= 0 ? "+" : ""}${marketIndicators.vix.changePct?.toFixed(1)}%`)
            ),
            macro?.yieldSpread && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: `1px solid ${macro.yieldSpread.status === "inverted" ? X.red + "33" : "#1e293b"}`, padding: "8px 10px", textAlign: "center" } },
              React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "Yield"),
              React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: macro.yieldSpread.status === "inverted" ? X.red : macro.yieldSpread.status === "flat" ? X.yellow : X.green, fontFamily: "'JetBrains Mono', monospace" } }, `${macro.yieldSpread.current}%`)
            ),
            marketIndicators?.xlk && marketIndicators?.spy && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: "1px solid #1e293b", padding: "8px 10px", textAlign: "center" } },
              React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "Tech vs S&P"),
              React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: (marketIndicators.xlk.changePct - marketIndicators.spy.changePct) >= 0 ? X.green : X.red, fontFamily: "'JetBrains Mono', monospace" } }, `${(marketIndicators.xlk.changePct - marketIndicators.spy.changePct) >= 0 ? "+" : ""}${(marketIndicators.xlk.changePct - marketIndicators.spy.changePct).toFixed(1)}%`)
            ),
            macro?.fedFundsRate && React.createElement("div", { style: { background: "#111827", borderRadius: 10, border: "1px solid #1e293b", padding: "8px 10px", textAlign: "center" } },
              React.createElement("div", { style: { fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em" } }, "Fed Rate"),
              React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" } }, `${macro.fedFundsRate.current}%`)
            )
          ),

          /* Opportunity Score */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${(timing.opportunityScore >= 7 ? X.green : timing.opportunityScore >= 4 ? X.yellow : X.red) + "33"}`, padding: 15, marginBottom: 10 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
              React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X.cyan } }, "Opportunity Score"),
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                React.createElement("span", { className: "m", style: { fontSize: 22, fontWeight: 700, color: timing.opportunityScore >= 7 ? X.green : timing.opportunityScore >= 4 ? X.yellow : X.red } }, timing.opportunityScore),
                React.createElement("span", { style: { fontSize: 11, color: "#64748b" } }, "/10")
              )
            ),
            React.createElement("div", { style: { height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden", marginBottom: 10 } },
              React.createElement("div", { style: { height: "100%", width: `${(timing.opportunityScore || 0) * 10}%`, borderRadius: 3, background: timing.opportunityScore >= 7 ? X.green : timing.opportunityScore >= 4 ? `linear-gradient(90deg,${X.yellow},${X.orange})` : X.red, transition: "width .4s" } })
            ),
            React.createElement("p", { style: { fontSize: 12, color: "#c8d0dc", lineHeight: 1.7, margin: 0 } }, timing.summary)
          ),

          /* DCA Advice */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.indigo}33`, padding: 15, marginBottom: 12 } },
            React.createElement("div", { style: { fontSize: 12, fontWeight: 700, color: X.purple, marginBottom: 6 } }, "DCA-Empfehlung"),
            React.createElement("p", { style: { fontSize: 12, color: "#c8d0dc", lineHeight: 1.7, margin: 0 } }, timing.dcaAdvice)
          ),

          /* Per-stock timing */
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.cyan, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".06em" } }, "Einzelbewertung"),
          (timing.stocks || []).map(s => {
            const sigCol = { strong_buy: X.green, buy: "#4ade80", hold: X.yellow, take_profit: X.orange, sell: X.red };
            const sigLabel = { strong_buy: "STARK KAUFEN", buy: "KAUFEN", hold: "HALTEN", take_profit: "GEWINNE MITNEHMEN", sell: "VERKAUFEN" };
            const actIcon = { nachkaufen: "▼", halten: "▶", teilverkauf: "▲" };
            const actCol = { nachkaufen: X.green, halten: X.yellow, teilverkauf: X.orange };
            const col = sigCol[s.signal] || X.yellow;
            return React.createElement("div", { key: s.ticker, style: { background: "#111827", borderRadius: 12, border: `1px solid ${col}22`, padding: 13, marginBottom: 7 } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  React.createElement("span", { className: "m", style: { fontSize: 11, fontWeight: 700, color: X.purple } }, s.ticker),
                  React.createElement("span", { style: { fontSize: 9, padding: "2px 8px", borderRadius: 10, background: `${col}18`, border: `1px solid ${col}44`, color: col, fontWeight: 700 } }, sigLabel[s.signal] || s.signal)
                ),
                React.createElement("span", { style: { fontSize: 12, fontWeight: 700, color: actCol[s.action] || X.yellow } }, `${actIcon[s.action] || "▶"} ${s.action}`)
              ),
              React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, s.reason),
              React.createElement("div", { style: { display: "flex", gap: 12, marginTop: 6, fontSize: 10, color: "#64748b" } },
                (finnhubData[s.ticker]?.fromHigh || s.fromHigh) && React.createElement("span", null, "Vom Hoch: ", React.createElement("span", { style: { color: col } }, finnhubData[s.ticker]?.fromHigh ? `-${finnhubData[s.ticker].fromHigh}%` : s.fromHigh)),
                s.momentum && React.createElement("span", null, "Momentum: ", React.createElement("span", { style: { color: s.momentum === "positiv" ? X.green : s.momentum === "negativ" ? X.red : X.yellow } }, s.momentum))
              ),
              finnhubData[s.ticker] && React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 } },
                [
                  ["Kurs", finnhubData[s.ticker].price != null ? `$${finnhubData[s.ticker].price}` : null],
                  ["52W H", finnhubData[s.ticker].yearHigh != null ? `$${finnhubData[s.ticker].yearHigh}` : null],
                  ["P/E", finnhubData[s.ticker].peRatio != null ? finnhubData[s.ticker].peRatio.toFixed(1) : null],
                  ["PEG", finnhubData[s.ticker].pegRatio != null ? finnhubData[s.ticker].pegRatio.toFixed(2) : null],
                ].filter(([, v]) => v !== null).map(([label, val]) =>
                  React.createElement("span", { key: label, className: "m", style: { fontSize: 9, padding: "2px 6px", borderRadius: 6, background: "#1e293b", color: "#94a3b8" } }, `${label} ${val}`)
                )
              )
            );
          }),

          /* Sonder-Nachkäufe */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${timing.extraAllocations?.length > 0 ? X.green + "44" : "#1e293b"}`, overflow: "hidden", marginBottom: 10, marginTop: 4 } },
            React.createElement("div", { style: { padding: "10px 15px", borderBottom: timing.extraAllocations?.length > 0 ? "1px solid #1e293b" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" } },
              React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.green } }, "Sonder-Nachkäufe"),
              timing.extraAllocations?.length > 0 && React.createElement("span", { className: "m", style: { fontSize: 10, color: X.green } }, `Σ €${timing.extraAllocations.reduce((s, a) => s + (a.amount || 0), 0).toFixed(2)}`)
            ),
            timing.extraAllocations?.length > 0 ? timing.extraAllocations.map((a, i) => {
              const expanded = dcaDetail === `tex-${i}`;
              return React.createElement("div", { key: i, style: { padding: "10px 15px", borderBottom: i < timing.extraAllocations.length - 1 ? "1px solid #1e293b22" : "none" } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 } },
                  React.createElement("span", { style: { fontSize: 12, fontWeight: 600 } }, a.ticker),
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { className: "m", style: { fontSize: 13, fontWeight: 700, color: X.green } }, `€${a.amount?.toFixed(2)}`),
                    a.detail && React.createElement("button", { onClick: () => setDcaDetail(expanded ? null : `tex-${i}`), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "3px 5px", borderRadius: 6, color: expanded ? X.green : "#64748b", fontSize: 11, flexShrink: 0 } }, "ⓘ")
                  )
                ),
                React.createElement("div", { style: { fontSize: 10, color: "#94a3b8" } }, a.reason),
                expanded && React.createElement("div", { style: { marginTop: 6, padding: "8px 10px", background: "#0f172a", borderRadius: 8, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, a.detail)
              );
            }) : React.createElement("div", { style: { padding: "10px 15px", fontSize: 11, color: "#475569" } },
              "Kein Handlungsbedarf", timing.noExtraReason && React.createElement("span", { style: { color: "#64748b", marginLeft: 4 } }, `— ${timing.noExtraReason}`)
            )
          ),

          /* Umschichtungen */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${timing.rebalanceTrades?.length > 0 ? X.cyan + "44" : "#1e293b"}`, overflow: "hidden", marginBottom: 10 } },
            React.createElement("div", { style: { padding: "10px 15px", borderBottom: timing.rebalanceTrades?.length > 0 ? "1px solid #1e293b" : "none" } },
              React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.cyan } }, "Umschichtungs-Vorschläge")
            ),
            timing.rebalanceTrades?.length > 0 ? timing.rebalanceTrades.map((t, i) => {
              const expanded = dcaDetail === `trebal-${i}`;
              return React.createElement("div", { key: i, style: { padding: "10px 15px", borderBottom: i < timing.rebalanceTrades.length - 1 ? "1px solid #1e293b22" : "none" } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 } },
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.red } }, t.fromTicker),
                    React.createElement("span", { style: { fontSize: 11, color: X.cyan } }, "→"),
                    React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.green } }, t.toTicker)
                  ),
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { className: "m", style: { fontSize: 13, fontWeight: 700, color: X.cyan } }, `€${t.amount?.toFixed(2)}`),
                    t.detail && React.createElement("button", { onClick: () => setDcaDetail(expanded ? null : `trebal-${i}`), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "3px 5px", borderRadius: 6, color: expanded ? X.cyan : "#64748b", fontSize: 11, flexShrink: 0 } }, "ⓘ")
                  )
                ),
                React.createElement("div", { style: { fontSize: 10, color: "#94a3b8" } }, t.reason),
                expanded && React.createElement("div", { style: { marginTop: 6, padding: "8px 10px", background: "#0f172a", borderRadius: 8, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, t.detail)
              );
            }) : React.createElement("div", { style: { padding: "10px 15px", fontSize: 11, color: "#475569" } },
              "Kein Handlungsbedarf", timing.noRebalanceReason && React.createElement("span", { style: { color: "#64748b", marginLeft: 4 } }, `— ${timing.noRebalanceReason}`)
            )
          ),

          /* Gewinnmitnahmen */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${timing.takeProfits?.length > 0 ? X.orange + "44" : "#1e293b"}`, overflow: "hidden", marginBottom: 10 } },
            React.createElement("div", { style: { padding: "10px 15px", borderBottom: timing.takeProfits?.length > 0 ? "1px solid #1e293b" : "none" } },
              React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.orange } }, "Gewinnmitnahmen")
            ),
            timing.takeProfits?.length > 0 ? timing.takeProfits.map((t, i) => {
              const expanded = dcaDetail === `tprofit-${i}`;
              return React.createElement("div", { key: i, style: { padding: "10px 15px", borderBottom: i < timing.takeProfits.length - 1 ? "1px solid #1e293b22" : "none" } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 } },
                  React.createElement("span", { style: { fontSize: 12, fontWeight: 600 } }, t.ticker),
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { className: "m", style: { fontSize: 13, fontWeight: 700, color: X.orange } }, `€${t.amount?.toFixed(2)}`),
                    t.detail && React.createElement("button", { onClick: () => setDcaDetail(expanded ? null : `tprofit-${i}`), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "3px 5px", borderRadius: 6, color: expanded ? X.orange : "#64748b", fontSize: 11, flexShrink: 0 } }, "ⓘ")
                  )
                ),
                React.createElement("div", { style: { fontSize: 10, color: "#94a3b8" } }, t.reason),
                expanded && React.createElement("div", { style: { marginTop: 6, padding: "8px 10px", background: "#0f172a", borderRadius: 8, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, t.detail)
              );
            }) : React.createElement("div", { style: { padding: "10px 15px", fontSize: 11, color: "#475569" } },
              "Kein Handlungsbedarf", timing.noTakeProfitReason && React.createElement("span", { style: { color: "#64748b", marginLeft: 4 } }, `— ${timing.noTakeProfitReason}`)
            )
          )

        ) : React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 28, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 28, marginBottom: 10 } }, "⚡"),
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 5 } }, "Starte die Live-Recherche"),
          React.createElement("div", { style: { fontSize: 12, color: "#64748b" } }, "Claude analysiert aktuelle Kurse und bewertet Timing-Chancen für jede Position.")
        )
      ),

      /* ═══ DCA ═══ */
      tab === "dca" && React.createElement(React.Fragment, null,
        React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 15, marginBottom: 12 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, "DCA-Plan erstellen"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 } },
            React.createElement("div", null,
              React.createElement("label", { style: { fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 } }, "Ziel-Allokation (€)"),
              React.createElement("input", { value: dcaBudget, onChange: e => setDcaBudget(e.target.value), type: "number", placeholder: "z.B. 12000", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: "100%" } })
            ),
            React.createElement("div", null,
              React.createElement("label", { style: { fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 } }, "Zeitraum (Monate)"),
              React.createElement("input", { value: dcaMonths, onChange: e => setDcaMonths(e.target.value), type: "number", placeholder: "12", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: "100%" } })
            )
          ),
          React.createElement("div", { style: { marginBottom: 10 } },
            React.createElement("label", { style: { fontSize: 10, color: "#64748b", display: "block", marginBottom: 3 } }, "Sonder-Vermögen (€, optional — wird im Timing-Tab genutzt)"),
            React.createElement("input", { value: dcaExtra, onChange: e => setDcaExtra(e.target.value), type: "number", placeholder: "Einmalig für attraktive Gelegenheiten", style: { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", width: "100%" } })
          ),
          dcaBudget && dcaMonths && (() => { const invested = stocks.reduce((s, st) => s + st.cost, 0); const remaining = Math.max(0, parseFloat(dcaBudget) - invested); const monthly = (remaining / parseInt(dcaMonths)).toFixed(2); return React.createElement("div", { className: "m", style: { fontSize: 11, color: "#64748b", marginBottom: 10 } }, `Bereits investiert: €${invested.toLocaleString("de-DE", { minimumFractionDigits: 2 })} · Verbleibend: €${remaining.toLocaleString("de-DE", { minimumFractionDigits: 2 })} → €${monthly}/Monat${dcaExtra ? ` + €${parseFloat(dcaExtra).toFixed(2)} Sonder-Budget` : ""}`); })(),
          React.createElement("button", { onClick: async () => {
            const budget = parseFloat(dcaBudget);
            const mo = parseInt(dcaMonths);
            const extra = parseFloat(dcaExtra) || 0;
            if (!budget || budget <= 0 || !mo || mo <= 0) return;
            if (!checkKeys()) return;
            setBusyDca(true);
            try {
              const plan = await doDCAPlan(stocks, budget, mo, extra, finnhubData, insiderData, timing, analysis, macro, marketIndicators, eurUsdRate, capexImpact);
              setDcaPlan(plan);
              persistAll({ dcaPlan: plan });
            } catch (e) {
              const ts = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
              debugPush({ ts, label: `DCA-Plan Fehler: ${e.message}`, status: "error", code: 0, detail: e.message });
              console.error("DCA Plan error:", e);
            } finally {
              setBusyDca(false);
            }
          }, disabled: busyDca || !dcaBudget || !dcaMonths || stocks.length === 0, style: {
            width: "100%", padding: 11, borderRadius: 10, border: "none", cursor: busyDca ? "default" : "pointer",
            fontSize: 13, fontWeight: 700, fontFamily: "inherit",
            background: busyDca ? "#1e293b" : `linear-gradient(135deg,${X.indigo},#8b5cf6)`, color: busyDca ? "#475569" : "#fff"
          } }, busyDca ? "⟳ Erstelle DCA-Plan…" : "DCA-Plan berechnen"),

          // Blinkender "Neu berechnen" Button nach Komplettanalyse
          capexImpact && dcaPlan && !busyDca && !dcaIncorporatesCapex && React.createElement("button", {
            onClick: async () => {
              const budget = parseFloat(dcaBudget);
              const mo = parseInt(dcaMonths);
              const extra = parseFloat(dcaExtra) || 0;
              if (!budget || budget <= 0 || !mo || mo <= 0) return;
              if (!checkKeys()) return;
              setBusyDca(true);
              try {
                const plan = await doDCAPlan(stocks, budget, mo, extra, finnhubData, insiderData, timing, analysis, macro, marketIndicators, eurUsdRate, capexImpact);
                setDcaPlan(plan);
                setDcaIncorporatesCapex(true);
              } catch (e) { console.error("DCA rebalance error:", e); }
              finally { setBusyDca(false); }
            },
            style: {
              width: "100%", padding: 11, marginTop: 8, borderRadius: 10, border: "none", cursor: "pointer",
              fontSize: 13, fontWeight: 700, fontFamily: "inherit",
              background: `linear-gradient(135deg,${X.red},${X.orange})`, color: "#fff",
              boxShadow: `0 4px 14px ${X.red}33`,
              animation: "earningsPulse 1.2s infinite",
            }
          }, "⚡ DCA auf Basis neuer CapEx-Erkenntnisse neu berechnen")
        ),

        dcaPlan && React.createElement(React.Fragment, null,
          /* Summary */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 15, marginBottom: 8 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 } },
              React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, `DCA-Plan: €${dcaPlan.monthlyTotal?.toFixed(2) || "?"}/Monat × ${dcaPlan.months || "?"} Monate`),
              React.createElement("span", { className: "m", style: { fontSize: 11, color: X.green, fontWeight: 600 } }, `Σ €${((dcaPlan.monthlyTotal || 0) * (dcaPlan.months || 0)).toFixed(2)}`)
            ),
            dcaPlan.rebalanceTrades?.length > 0 && (() => {
              const rebalanceNet = {};
              dcaPlan.rebalanceTrades.forEach(t => {
                rebalanceNet[t.fromTicker] = (rebalanceNet[t.fromTicker] || 0) - t.amount;
                rebalanceNet[t.toTicker] = (rebalanceNet[t.toTicker] || 0) + t.amount;
              });
              const adjustedTotal = dcaPlan.plan.reduce((s, p) => s + (p.monthlyAmount || 0) + (rebalanceNet[p.ticker] || 0), 0);
              return React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, padding: "6px 10px", background: `${X.cyan}11`, borderRadius: 8, border: `1px solid ${X.cyan}22` } },
                React.createElement("span", { style: { fontSize: 11, color: X.cyan } }, "Nach Umschichtung:"),
                React.createElement("span", { className: "m", style: { fontSize: 12, fontWeight: 700, color: X.cyan } }, `€${adjustedTotal.toFixed(2)}/Monat (Σ €${(adjustedTotal * (dcaPlan.months || 0)).toFixed(2)})`)
              );
            })(),
            React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", lineHeight: 1.7, margin: 0 } }, dcaPlan.summary)
          ),

          /* Monthly Plan */
          React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden", marginBottom: 8 } },
            React.createElement("div", { style: { padding: "10px 15px", borderBottom: "1px solid #1e293b" } },
              React.createElement("span", { style: { fontSize: 12, fontWeight: 600 } }, "Monatliche Verteilung")
            ),
            dcaPlan.plan.map((p, i) => {
              const prioCol = p.priority === "hoch" ? X.green : p.priority === "mittel" ? X.yellow : "#64748b";
              const expanded = dcaDetail === `plan-${i}`;
              return React.createElement("div", { key: i, style: { padding: "10px 15px", borderBottom: i < dcaPlan.plan.length - 1 ? "1px solid #1e293b22" : "none" } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 } },
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { style: { fontSize: 12, fontWeight: 600 } }, `${p.ticker}`),
                    React.createElement("span", { style: { fontSize: 10, color: "#64748b" } }, p.name),
                    React.createElement("span", { style: { fontSize: 8, padding: "2px 6px", borderRadius: 8, background: `${prioCol}22`, color: prioCol, fontWeight: 700 } }, p.priority?.toUpperCase())
                  ),
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { className: "m", style: { fontSize: 13, fontWeight: 700, color: X.green } }, `€${p.monthlyAmount?.toFixed(2)}`),
                    p.detail && React.createElement("button", { onClick: () => setDcaDetail(expanded ? null : `plan-${i}`), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "3px 5px", borderRadius: 6, color: expanded ? X.purple : "#64748b", fontSize: 11, flexShrink: 0 } }, "ⓘ")
                  )
                ),
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  React.createElement("span", { style: { fontSize: 10, color: "#94a3b8", flex: 1 } }, p.reason),
                  React.createElement("span", { className: "m", style: { fontSize: 10, color: "#475569", flexShrink: 0, marginLeft: 8 } }, `${p.percentage}%`)
                ),
                expanded && React.createElement("div", { style: { marginTop: 6, padding: "8px 10px", background: "#0f172a", borderRadius: 8, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, p.detail)
              );
            })
          ),

          /* Rebalance Trades */
          dcaPlan.rebalanceTrades?.length > 0 && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.cyan}44`, overflow: "hidden", marginBottom: 8 } },
            React.createElement("div", { style: { padding: "10px 15px", borderBottom: "1px solid #1e293b" } },
              React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.cyan } }, "Umschichtungs-Vorschläge")
            ),
            dcaPlan.rebalanceTrades.map((t, i) => {
              const expanded = dcaDetail === `rebal-${i}`;
              return React.createElement("div", { key: i, style: { padding: "10px 15px", borderBottom: i < dcaPlan.rebalanceTrades.length - 1 ? "1px solid #1e293b22" : "none" } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 } },
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.red } }, t.fromTicker),
                    React.createElement("span", { style: { fontSize: 11, color: X.cyan } }, "→"),
                    React.createElement("span", { style: { fontSize: 12, fontWeight: 600, color: X.green } }, t.toTicker)
                  ),
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { className: "m", style: { fontSize: 13, fontWeight: 700, color: X.cyan } }, `€${t.amount?.toFixed(2)}`),
                    t.detail && React.createElement("button", { onClick: () => setDcaDetail(expanded ? null : `rebal-${i}`), style: { background: "#33415522", border: "none", cursor: "pointer", padding: "3px 5px", borderRadius: 6, color: expanded ? X.cyan : "#64748b", fontSize: 11, flexShrink: 0 } }, "ⓘ")
                  )
                ),
                React.createElement("div", { style: { fontSize: 10, color: "#94a3b8" } }, t.reason),
                expanded && React.createElement("div", { style: { marginTop: 6, padding: "8px 10px", background: "#0f172a", borderRadius: 8, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, t.detail)
              );
            })
          ),

          /* Warnings */
          dcaPlan.warnings?.length > 0 && React.createElement("div", { style: { background: `${X.orange}08`, borderRadius: 12, border: `1px solid ${X.orange}33`, padding: 15, marginBottom: 8 } },
            React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: X.orange, marginBottom: 6 } }, "Hinweise & Warnungen"),
            dcaPlan.warnings.map((w, i) => React.createElement("div", { key: i, style: { fontSize: 11, color: "#94a3b8", marginTop: i > 0 ? 4 : 0 } }, `• ${w}`))
          ),

          /* Rebalance Hints */
          dcaPlan.rebalanceHints?.length > 0 && React.createElement("div", { style: { background: `${X.cyan}08`, borderRadius: 12, border: `1px solid ${X.cyan}33`, padding: 15, marginBottom: 8 } },
            React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: X.cyan, marginBottom: 6 } }, "Rebalancing-Empfehlungen"),
            dcaPlan.rebalanceHints.map((h, i) => React.createElement("div", { key: i, style: { fontSize: 11, color: "#94a3b8", marginTop: i > 0 ? 4 : 0 } }, `• ${h}`))
          )
        ),

        !dcaPlan && !busyDca && stocks.length > 0 && React.createElement("div", { style: { textAlign: "center", padding: 30, color: "#475569" } },
          React.createElement("div", { style: { fontSize: 28, marginBottom: 8 } }, "📊"),
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 5 } }, "DCA-Plan erstellen"),
          React.createElement("div", { style: { fontSize: 12, color: "#64748b" } }, "Budget und Zeitraum eintragen, dann analysiert Claude die optimale monatliche Verteilung.")
        ),

        stocks.length === 0 && React.createElement("div", { style: { textAlign: "center", padding: 30, color: "#475569" } },
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600 } }, "Füge zuerst Aktien zum Portfolio hinzu")
        )
      ),

      /* ═══ ALERTS ═══ */
      tab === "alerts" && React.createElement(React.Fragment, null,
        React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 12 } }, alertsLive ? `${analysis.alerts.length} Live-Alerts aus der Analyse.` : "Starte eine Recherche für Live-Alerts."),
        alerts.map((a, i) =>
          React.createElement("div", { key: i, onClick: () => a.detail && setExAlert(exAlert === i ? null : i), style: {
            background: "#111827", borderRadius: 12, padding: "11px 13px", marginBottom: 7,
            border: `1px solid ${a.status === "green" ? "#1e293b" : (X[a.status] || X.yellow) + "33"}`,
            cursor: a.detail ? "pointer" : "default", opacity: alertsLive ? 1 : 0.4,
          } },
            React.createElement("div", { style: { display: "flex", alignItems: "center" } },
              React.createElement("span", { style: { display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: X[a.status] || "#475569", boxShadow: `0 0 8px ${(X[a.status] || "#475569")}55`, marginRight: 8 } }),
              React.createElement("span", { style: { flex: 1, fontSize: 13, fontWeight: 600 } }, a.name),
              a.detail ? React.createElement("span", { style: { fontSize: 11, color: "#475569", transform: exAlert === i ? "rotate(180deg)" : "none", transition: "transform .2s", display: "inline-block" } }, "▼") : React.createElement("span", { style: { fontSize: 10, color: "#475569" } }, "Keine Daten")
            ),
            exAlert === i && a.detail && React.createElement("div", { style: { marginTop: 9, paddingTop: 9, borderTop: "1px solid #1e293b", fontSize: 12, color: "#94a3b8", lineHeight: 1.7 } }, a.detail)
          )
        ),
        logs.length > 0 && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 14, marginTop: 12 } },
          React.createElement("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 8 } }, "Recherche-Log"),
          React.createElement("div", { className: "m", style: { maxHeight: 160, overflowY: "auto", fontSize: 10, color: "#64748b", lineHeight: 1.8 } },
            logs.map((l, i) => React.createElement("div", { key: i }, l))
          )
        )
      ),

      /* ═══ PLAYBOOK ═══ */
      tab === "playbook" && React.createElement(React.Fragment, null,
        React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 12 } }, "Vordefinierte Handlungsanweisungen — entscheide ", React.createElement("em", null, "vorher"), ", nicht im Moment."),
        PH.map((p, i) => {
          const act = hasData && ((analysis.overallStatus === "green" && i === 0) || (analysis.overallStatus === "yellow" && i === 1) || (analysis.overallStatus === "orange" && i === 2) || (analysis.overallStatus === "red" && i === 3));
          return React.createElement("div", { key: i, style: { background: act ? `${p.co}08` : "#111827", borderRadius: 12, border: `1px solid ${p.co}${act ? "55" : "33"}`, borderLeft: `4px solid ${p.co}`, padding: 13, marginBottom: 7 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 7, marginBottom: 4 } },
              React.createElement("span", { style: { color: p.co, fontSize: 13 } }, p.i),
              React.createElement("span", { style: { fontSize: 13, fontWeight: 700, color: p.co } }, `Phase ${p.n}`),
              act && React.createElement("span", { style: { fontSize: 9, padding: "2px 7px", borderRadius: 10, background: `${p.co}22`, color: p.co, fontWeight: 700, textTransform: "uppercase" } }, "Aktuell")
            ),
            React.createElement("div", { style: { fontSize: 11, color: "#64748b", marginBottom: 3 } }, p.t),
            React.createElement("div", { style: { fontSize: 12, color: "#e2e8f0", fontWeight: 500 } }, p.a)
          );
        }),

        /* Sell Priority */
        React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13, marginTop: 8 } },
          React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X.purple } }, "Verkaufspriorität"),
              sellPrioLastRun && React.createElement("div", { style: { fontSize: 9, color: "#475569", marginTop: 2 } }, `Zuletzt: ${sellPrioLastRun.toLocaleDateString("de-DE")} ${sellPrioLastRun.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`)
            ),
            React.createElement("button", { onClick: runSellPriority, disabled: busySellPrio, style: { background: busySellPrio ? "#1e293b" : `${X.indigo}22`, color: busySellPrio ? "#475569" : X.purple, border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 10, fontWeight: 700, cursor: busySellPrio ? "default" : "pointer" } }, busySellPrio ? "⟳ Analysiere…" : "↻ Aktualisieren")
          ),
          sellPriority?.summary && React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", marginBottom: 8, lineHeight: 1.6 } }, sellPriority.summary),
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "0 0 5px", borderBottom: "1px solid #1e293b44", marginBottom: 2 } },
            React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", width: 22 } }, "#"),
            React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", width: 34 } }, "Ticker"),
            React.createElement("span", { style: { fontSize: 9, color: "#475569", flex: 1 } }, sellPriority ? "Begründung" : "Name"),
            React.createElement("span", { style: { fontSize: 9, color: "#475569", width: 50, textAlign: "right" } }, "Moat")
          ),
          bySell.map((p, i) => {
            const third = Math.ceil(bySell.length / 3);
            const prioColor = i < third ? X.red : i < third * 2 ? X.yellow : X.green;
            return React.createElement("div", { key: p.ticker, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: i < bySell.length - 1 ? "1px solid #1e293b22" : "none" } },
              React.createElement("span", { className: "m", style: { fontSize: 10, fontWeight: 700, color: prioColor, width: 22 } }, i + 1),
              React.createElement("span", { className: "m", style: { fontSize: 10, fontWeight: 700, color: X.purple, width: 34 } }, p.ticker),
              React.createElement("span", { style: { fontSize: 10, color: "#94a3b8", flex: 1 } }, p.reason || p.name),
              React.createElement("span", { style: { fontSize: 10, color: p.moat === "wide" ? X.green : p.moat === "medium" ? X.yellow : X.red, width: 50, textAlign: "right" } }, moatLabel(p.moat))
            );
          })
        ),

        /* Other stocks note */
        otherStocks.length > 0 && React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.cyan}22`, padding: 13, marginTop: 8 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X.cyan, marginBottom: 6 } }, "Andere Positionen"),
          React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", lineHeight: 1.6 } }, "Diese Positionen sind nicht primär CapEx-abhängig und folgen einer eigenen Logik."),
          otherStocks.map(s =>
            React.createElement("div", { key: s.ticker, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", marginTop: 4 } },
              React.createElement("span", { className: "m", style: { fontSize: 10, fontWeight: 700, color: X.cyan, width: 34 } }, s.ticker),
              React.createElement("span", { style: { fontSize: 11, color: "#94a3b8", flex: 1 } }, `${s.name} — ${s.sector}`),
              React.createElement("span", { style: { fontSize: 10, color: s.moat === "wide" ? X.green : s.moat === "medium" ? X.yellow : X.red } }, moatLabel(s.moat))
            )
          )
        )
      ),

      /* ═══ CALENDAR ═══ */
      tab === "calendar" && React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
          React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", margin: 0 } }, earningsCal.length > 0 ? `${earningsCal.length} Earnings-Termine (nächste 120 Tage)` : "Keine Earnings-Termine geladen"),
          React.createElement("button", { onClick: () => { const k = getFmpKey(); const t = stocks.map(s => s.ticker); if (k) fetchEarningsCalendar(k, t).then(cal => setEarningsCal(cal)); }, style: { background: `${X.indigo}22`, color: X.purple, border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" } }, "↻ Aktualisieren")
        ),
        React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden" } },
          earningsCal.length > 0 ? earningsCal.map((ev, i) =>
            React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", padding: "9px 12px", gap: 9, borderBottom: i < earningsCal.length - 1 ? "1px solid #1e293b22" : "none" } },
              React.createElement("span", { className: "m", style: { width: 50, fontSize: 11, fontWeight: 600, color: ev.c ? X.purple : "#64748b", flexShrink: 0 } }, ev.d),
              React.createElement("span", { style: { flex: 1, fontSize: 12, color: ev.c ? "#e2e8f0" : "#94a3b8" } }, ev.e),
              ev.epsEstimate && React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", flexShrink: 0 } }, `EPS est. ${ev.epsEstimate}`),
              ev.c && React.createElement("span", { style: { fontSize: 8, padding: "2px 6px", borderRadius: 10, background: `${X.indigo}22`, color: X.purple, fontWeight: 700 } }, "KRITISCH")
            )
          ) : React.createElement("div", { style: { padding: 20, textAlign: "center", fontSize: 12, color: "#64748b" } }, getFmpKey() ? "Keine Termine gefunden" : "Finnhub API Key in Einstellungen hinterlegen")
        ),
        React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 14, marginTop: 10 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, "Signalwörter in Earnings-Calls"),
          React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", lineHeight: 1.8 } },
            React.createElement("span", { style: { color: X.green, fontWeight: 600 } }, "Bullisch:"), " \"demand exceeds supply\", \"fully booked\", \"raised guidance\", \"unprecedented\"",
            React.createElement("br"), React.createElement("br"),
            React.createElement("span", { style: { color: X.red, fontWeight: 600 } }, "Bärisch:"), " \"optimizing efficiency\", \"rationalizing spend\", \"digestion phase\", \"normalizing\"",
            React.createElement("br"), React.createElement("br"),
            React.createElement("span", { style: { color: X.yellow, fontWeight: 600 } }, "Subtil:"), " CEO betont \"ROI\" statt Wachstum → interner Rechtfertigungsdruck"
          )
        )
      ),

      /* Footer */
      React.createElement("div", { style: { marginTop: 16, padding: "10px 12px", background: "#111827", borderRadius: 10, border: "1px solid #1e293b", fontSize: 10, color: "#475569" } },
        React.createElement("b", { style: { color: "#64748b" } }, "Hinweis:"), " Live via Claude AI mit Web Search. Keine Finanzberatung."
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
