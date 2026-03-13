const { useState, useCallback, useEffect, useRef } = React;

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

/* ═══ DEFAULT PORTFOLIO ═══ */
const DEFAULT_STOCKS = [
  { ticker: "GLW", name: "Corning", cost: 2909.54, sector: "Optical / Connectivity", sensitivity: "high", moat: "narrow", sell: 2, type: "capex" },
  { ticker: "GEV", name: "GE Vernova", cost: 3809.39, sector: "Power / Energy", sensitivity: "medium", moat: "medium", sell: 5, type: "capex" },
  { ticker: "MOD", name: "Modine", cost: 3140.22, sector: "Data Center Cooling", sensitivity: "very high", moat: "narrow", sell: 1, type: "capex" },
  { ticker: "VRT", name: "Vertiv", cost: 3530.49, sector: "Data Center Cooling", sensitivity: "high", moat: "medium", sell: 3, type: "capex" },
  { ticker: "NVDA", name: "NVIDIA", cost: 3174.0, sector: "AI GPUs / Chips", sensitivity: "high", moat: "wide", sell: 6, type: "capex" },
  { ticker: "AVGO", name: "Broadcom", cost: 2647.0, sector: "ASICs / Networking", sensitivity: "high", moat: "wide", sell: 7, type: "capex" },
  { ticker: "ASML", name: "ASML", cost: 2476.0, sector: "Semiconductor Equipment", sensitivity: "medium", moat: "wide", sell: 8, type: "capex" },
  { ticker: "MU", name: "Micron", cost: 3483.0, sector: "Memory / HBM", sensitivity: "high", moat: "medium", sell: 4, type: "capex" },
];

const DEFAULT_TICKERS = DEFAULT_STOCKS.map(s => s.ticker);

const CAL = [
  { d: "04. Mär", e: "Broadcom Q1 FY2026 Earnings", c: true },
  { d: "10. Mär", e: "TSMC Feb-Umsatzzahlen", c: false },
  { d: "15. Apr", e: "TSMC Q1 2026 Earnings", c: true },
  { d: "23. Apr", e: "Alphabet Q1 Earnings – CapEx Watch", c: true },
  { d: "29. Apr", e: "Microsoft Q3 FY2026 Earnings", c: true },
  { d: "30. Apr", e: "Meta Q1 / Amazon Q1 Earnings", c: true },
  { d: "27. Mai", e: "NVIDIA Q1 FY2027 Earnings", c: true },
  { d: "27. Mai", e: "Modine Q4 FY2026 Earnings", c: false },
];

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

async function callAPI(user, sys, useSearch, maxTokens) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Kein API-Key gesetzt. Bitte in den Einstellungen hinterlegen.");
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens || 1000,
    system: sys,
    messages: [{ role: "user", content: user }],
  };
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
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
  if (!r.ok) throw new Error(`API ${r.status}: ${r.statusText}`);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

async function doSearch(query) {
  try {
    const raw = await callAPI(
      `Search for: "${query}"\nAfter searching, respond ONLY with a JSON object (no backticks, no markdown, no citations, no HTML tags):\n{"summary":"2-3 plain text sentences summarizing findings","sentiment":"bullish|bearish|neutral","keyPoints":["point1","point2"],"confidence":0.8}\n\nIMPORTANT: The summary and keyPoints must be plain text only. No HTML, no <cite> tags, no markdown.`,
      "Financial research analyst. Use web_search to find data. Then respond with ONLY a raw JSON object. Plain text values only — no HTML tags, no citations, no markdown formatting. No text before or after the JSON.",
      true
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

async function doAnalyze(allData, stockList) {
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
  try {
    const raw = await callAPI(
      `Portfolio: CapEx-Aktien: ${capexTickers}${otherInfo ? ". Andere: " + otherInfo : ""}
Daten: ${JSON.stringify(compact)}

Antworte NUR mit validem JSON. Kein Markdown, keine Backticks, kein Text davor oder danach:
{"overallStatus":"green","explanation":"1-2 Sätze deutsch","capexTrend":"accelerating","alerts":[{"name":"CapEx-Wende","status":"green","detail":"deutsch"},{"name":"TSMC-Trend","status":"green","detail":"deutsch"},{"name":"DRAM-Preise","status":"green","detail":"deutsch"},{"name":"Bewertungsrisiko","status":"yellow","detail":"deutsch"},{"name":"Insider-Aktivität","status":"green","detail":"deutsch"},{"name":"NVIDIA-Guidance","status":"green","detail":"deutsch"}],"risks":["deutsch1","deutsch2","deutsch3"],"action":"deutsch","nextEvent":"deutsch"}

overallStatus: green=klar, yellow=1-2 Warnungen, orange=3+, red=bestätigte Kürzungen.
capexTrend: accelerating/stable/decelerating/contracting. Immer 6 alerts. Alles deutsch.`,
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

async function doTimingAnalysis(priceData, stockList) {
  const stockInfo = stockList.map(s => `${s.ticker} (${s.name}, Sektor: ${s.sector}, Kaufpreis: €${s.cost.toFixed(0)})`).join("; ");
  try {
    const raw = await callAPI(
      `Du analysierst Kurs-Timing für ein Portfolio. Aktien: ${stockInfo}

Aktuelle Kursdaten: ${JSON.stringify(priceData)}

Für JEDE Aktie: Bewerte ob der aktuelle Kurs eine Nachkaufgelegenheit, Halteposition, oder Gewinnmitnahme-Kandidat ist.

Antworte NUR mit validem JSON:
{"summary":"1-2 Sätze Gesamteinschätzung deutsch","stocks":[{"ticker":"XXX","action":"nachkaufen|halten|teilverkauf","signal":"strong_buy|buy|hold|take_profit|sell","reason":"1 Satz deutsch","fromHigh":"Abstand vom Hoch in %","momentum":"positiv|neutral|negativ"}],"dcaAdvice":"Empfehlung deutsch","opportunityScore":7}

opportunityScore: 1-10 (1=alles teuer, 10=alles im Ausverkauf). Alle Texte deutsch.`,
      "Du bist ein technischer Analyst und Timing-Experte. NUR valides JSON. Kein Markdown. Keine Backticks.",
      false,
      2500
    );
    const j = extractJSON(raw);
    if (j && j.stocks) {
      if (j.summary) j.summary = cleanText(j.summary);
      if (j.dcaAdvice) j.dcaAdvice = cleanText(j.dcaAdvice);
      if (j.stocks) j.stocks = j.stocks.map(s => ({ ...s, reason: cleanText(s.reason) }));
      return j;
    }
    return null;
  } catch { return null; }
}

/* ═══ COLORS ═══ */
const X = { green: "#22c55e", yellow: "#eab308", orange: "#f97316", red: "#ef4444", purple: "#a78bfa", indigo: "#6366f1", cyan: "#22d3ee" };

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

/* ═══ SETTINGS COMPONENT ═══ */
function Settings({ onClose }) {
  const [key, setKey] = useState(getApiKey());
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const saveKey = () => { setApiKey(key); setTestResult({ ok: true, msg: "Gespeichert!" }); };

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
  const resetPortfolio = () => { if (confirm("Portfolio auf Standard zurücksetzen?")) { const saved = loadData(); if (saved) { saved.stocks = DEFAULT_STOCKS; saveData(saved); } else { saveData({ stocks: DEFAULT_STOCKS }); } location.reload(); } };

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
      React.createElement("div", { style: { borderTop: "1px solid #1e293b", paddingTop: 16 } },
        React.createElement("div", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 10 } }, "Gefahrenzone"),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
          React.createElement("button", { onClick: resetData, style: btn(`${X.orange}22`, X.orange) }, "Daten zurücksetzen"),
          React.createElement("button", { onClick: resetPortfolio, style: btn(`${X.red}22`, X.red) }, "Portfolio zurücksetzen")
        )
      )
    )
  );
}

/* ═══ API KEY SETUP SCREEN ═══ */
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
  const [tab, setTab] = useState("overview");
  const [stocks, setStocks] = useState(DEFAULT_STOCKS);
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
  const [busyTiming, setBusyTiming] = useState(false);
  const [timingStep, setTimingStep] = useState("");
  const [dataLoaded, setDataLoaded] = useState(false);

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
      if (saved.lastRun) setLastRun(new Date(saved.lastRun));
      if (saved.logs) setLogs(saved.logs);
    }
    setDataLoaded(true);
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
  const [filling, setFilling] = useState(false);

  const canAutofill = addTicker.trim().length > 0 || addName.trim().length > 0;

  const autofill = useCallback(async () => {
    const input = addTicker.trim() || addName.trim();
    if (!input) return;
    setFilling(true);
    try {
      const raw = await callAPI(
        `Identify the stock for: "${input}" (could be ticker OR company name). Respond ONLY with raw JSON, no backticks:\n{"ticker":"SYMBOL","name":"Full Company Name","sector":"short sector description","type":"capex|other","sensitivity":"very high|high|medium|low","moat":"wide|medium|narrow"}\n\nRules:\n- type "capex" = revenue depends on hyperscaler AI CapEx\n- type "other" = NOT primarily CapEx dependent\n- sensitivity = reaction to AI infra spending\n- moat: wide=monopoly, medium=strong, narrow=many competitors`,
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
    const payload = { stocks, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, lastRun: lastRun?.toISOString(), logs, ...overrides };
    saveData(payload);
  }, [stocks, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, lastRun, logs]);

  const addStock = useCallback(() => {
    if (!addTicker.trim() || !addName.trim()) return;
    const newStock = {
      ticker: addTicker.toUpperCase().trim(), name: addName.trim(),
      cost: parseFloat(addCost) || 0, sector: addSector.trim() || "Sonstige",
      sensitivity: addSens, moat: addMoat, sell: stocks.length + 1, type: addType,
    };
    setStocks(prev => {
      const updated = [...prev, newStock];
      saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, lastRun: lastRun?.toISOString(), logs });
      return updated;
    });
    setAddTicker(""); setAddName(""); setAddSector(""); setAddCost(""); setAddType("other"); setAddSens("low"); setAddMoat("medium");
    setShowAdd(false);
  }, [addTicker, addName, addSector, addCost, addType, addSens, addMoat, stocks.length, capex, tsmc, dram, nvidia, positions, insider, analysis, timing, lastRun, logs]);

  const removeStock = useCallback((ticker) => {
    setStocks(prev => {
      const updated = prev.filter(s => s.ticker !== ticker);
      setPositions(prevPos => {
        const newPos = { ...prevPos }; delete newPos[ticker];
        saveData({ stocks: updated, capex, tsmc, dram, nvidia, positions: newPos, insider, analysis, timing, lastRun: lastRun?.toISOString(), logs });
        return newPos;
      });
      return updated;
    });
  }, [capex, tsmc, dram, nvidia, insider, analysis, timing, lastRun, logs]);

  /* ═══ RESEARCH ═══ */
  const run = useCallback(async () => {
    setBusy(true); setPct(0);
    setCapex([]); setTsmc(null); setDram(null); setNvidia(null);
    setPositions({}); setInsider(null); setAnalysis(null); setTiming(null); setLogs([]);
    addLog("Recherche gestartet…");

    const jobs = [
      { k: "capex", l: "Alphabet CapEx", q: "Alphabet Google capital expenditure 2026 guidance latest" },
      { k: "capex", l: "Meta CapEx", q: "Meta Platforms capex 2026 data center spending" },
      { k: "capex", l: "Microsoft CapEx", q: "Microsoft Azure capital expenditure 2026 guidance" },
      { k: "capex", l: "Amazon CapEx", q: "Amazon AWS capex 2026 data center guidance" },
      { k: "tsmc", l: "TSMC Umsätze", q: "TSMC monthly revenue latest 2026" },
      { k: "dram", l: "DRAM Preise", q: "DRAM spot price trend 2026 memory" },
      { k: "nvidia", l: "NVIDIA Guidance", q: "NVIDIA earnings revenue guidance 2026 data center" },
    ];

    for (const s of stocks) {
      if (s.type === "capex") {
        jobs.push({ k: "pos", l: s.name, q: `${s.name} ${s.ticker} stock earnings news 2026 ${s.sector}`, t: s.ticker });
      } else {
        jobs.push({ k: "pos", l: s.name, q: `${s.name} ${s.ticker} stock earnings outlook 2026 ${s.sector} analysis`, t: s.ticker });
      }
    }
    jobs.push({ k: "insider", l: "Insider-Verkäufe", q: `insider selling ${stocks.map(s => s.ticker).slice(0, 6).join(" ")} 2026` });

    const total = jobs.length + 3;
    let lCapex = [], lTsmc = null, lDram = null, lNvidia = null, lPos = {}, lInsider = null;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      setStepName(job.l);
      addLog("→ " + job.l);
      const result = await doSearch(job.q);
      addLog("  ✓ " + job.l + ": " + result.sentiment);

      if (job.k === "capex") { lCapex = [...lCapex, { label: job.l, ...result }]; setCapex([...lCapex]); }
      else if (job.k === "tsmc") { lTsmc = result; setTsmc(result); }
      else if (job.k === "dram") { lDram = result; setDram(result); }
      else if (job.k === "nvidia") { lNvidia = result; setNvidia(result); }
      else if (job.k === "pos") { lPos = { ...lPos, [job.t]: result }; setPositions({ ...lPos }); }
      else if (job.k === "insider") { lInsider = result; setInsider(result); }
      setPct(Math.round(((i + 1) / total) * 100));
    }

    setStepName("Gesamtanalyse…");
    addLog("→ Gesamtanalyse…");
    const allData = { capex: lCapex, tsmc: lTsmc, dram: lDram, nvidia: lNvidia, positions: lPos, insider: lInsider };
    const ana = await doAnalyze(allData, stocks);
    setAnalysis(ana);
    addLog("✓ Status: " + (ana?.overallStatus || "?"));
    setPct(Math.round(((jobs.length + 1) / total) * 100));

    setStepName("Kurs-Analyse…");
    addLog("→ Kurs-Recherche für Timing…");
    const priceResults = {};
    for (const s of stocks) {
      const pr = await doSearch(`${s.ticker} ${s.name} stock price today 52 week high low performance 2026`);
      priceResults[s.ticker] = { sentiment: pr.sentiment, summary: (pr.summary || "").slice(0, 200) };
    }
    addLog("  ✓ Kursdaten für " + stocks.length + " Aktien");
    setPct(Math.round(((jobs.length + 2) / total) * 100));

    setStepName("Timing-Bewertung…");
    addLog("→ Timing-Bewertung…");
    const tim = await doTimingAnalysis(priceResults, stocks);
    setTiming(tim);
    addLog("✓ Timing: Score " + (tim?.opportunityScore || "?") + "/10");

    const now = new Date();
    setPct(100); setLastRun(now); setBusy(false);

    setLogs(prevLogs => {
      saveData({ stocks, capex: lCapex, tsmc: lTsmc, dram: lDram, nvidia: lNvidia, positions: lPos, insider: lInsider, analysis: ana, timing: tim, lastRun: now.toISOString(), logs: prevLogs });
      return prevLogs;
    });
  }, [addLog, stocks]);

  /* ═══ INDEPENDENT TIMING ═══ */
  const runTiming = useCallback(async () => {
    setBusyTiming(true);
    setTimingStep("Kursdaten…");
    const priceResults = {};
    for (let i = 0; i < stocks.length; i++) {
      const s = stocks[i];
      setTimingStep(`${s.ticker} Kurs…`);
      const pr = await doSearch(`${s.ticker} ${s.name} stock price today 52 week high low performance 2026`);
      priceResults[s.ticker] = { sentiment: pr.sentiment, summary: (pr.summary || "").slice(0, 200) };
    }
    setTimingStep("Timing-Bewertung…");
    const tim = await doTimingAnalysis(priceResults, stocks);
    setTiming(tim);
    setBusyTiming(false);
    setTimingStep("");
    try {
      const existing = loadData();
      const merged = { ...(existing || {}), timing: tim, stocks };
      saveData(merged);
    } catch {}
  }, [stocks]);

  // Derived
  const total = stocks.reduce((s, p) => s + p.cost, 0);
  const capexStocks = stocks.filter(s => s.type === "capex");
  const otherStocks = stocks.filter(s => s.type === "other");
  const bySell = [...capexStocks].sort((a, b) => a.sell - b.sell);
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
  ];

  const TABS = [["overview", "Überblick"], ["capex", "CapEx"], ["positions", "Positionen"], ["timing", "Timing"], ["alerts", "Alerts"], ["playbook", "Playbook"], ["calendar", "Kalender"]];
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
          React.createElement("button", { onClick: () => setShowSettings(true), style: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18, padding: 4 } }, "⚙")
        )
      ),

      /* ── BUTTON ── */
      React.createElement("button", { onClick: run, disabled: busy, style: {
        width: "100%", padding: 11, marginTop: 10, marginBottom: 4, borderRadius: 10, border: "none",
        cursor: busy ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit",
        background: busy ? "#1e293b" : `linear-gradient(135deg,${X.indigo},#8b5cf6)`,
        color: busy ? "#64748b" : "#fff", boxShadow: busy ? "none" : `0 4px 14px ${X.indigo}33`,
      } }, busy ? `⟳ ${stepName} — ${pct}%` : `▶  Live-Recherche starten (${stocks.length} Positionen)`),

      busy && React.createElement("div", { style: { marginTop: 6, marginBottom: 6 } },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 3 } },
          React.createElement("span", { style: { fontSize: 11, color: "#94a3b8" } }, stepName),
          React.createElement("span", { className: "m", style: { fontSize: 11, color: X.indigo } }, `${pct}%`)
        ),
        React.createElement("div", { style: { height: 4, background: "#1e293b", borderRadius: 2, overflow: "hidden" } },
          React.createElement("div", { style: { height: "100%", width: `${pct}%`, borderRadius: 2, background: `linear-gradient(90deg,${X.indigo},${X.purple})`, transition: "width .4s" } })
        )
      ),

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
            { l: "Investiert", v: `€${total.toLocaleString("de-DE", { maximumFractionDigits: 0 })}`, s: `${stocks.length} Pos.` },
            { l: "CapEx-Trend", v: hasData ? (trMap[analysis.capexTrend] || "—") : "—", c: hasData ? (analysis.capexTrend === "accelerating" ? X.green : analysis.capexTrend === "stable" ? X.yellow : X.red) : "#64748b", s: hasData ? "Live" : "" },
            { l: "Status", v: hasData ? stMap[analysis.overallStatus] : "—", c: hasData ? X[analysis.overallStatus] : "#64748b", s: hasData ? (analysis.nextEvent || "").slice(0, 32) : "" },
          ].map((c, i) =>
            React.createElement("div", { key: i, style: { background: "#111827", borderRadius: 12, padding: "12px 11px", border: "1px solid #1e293b", minWidth: 0, overflow: "hidden" } },
              React.createElement("div", { style: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 } }, c.l),
              React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: c.c || "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.v),
              c.s && React.createElement("div", { style: { fontSize: 10, color: "#475569", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.s)
            )
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
          return React.createElement("div", { key: pos.ticker, style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 13, marginBottom: 8 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 9 } },
                React.createElement("div", { className: "m", style: { width: 32, height: 32, borderRadius: 7, background: "#1e293b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: X.purple } }, pos.ticker),
                React.createElement("div", null,
                  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, pos.name),
                    React.createElement(TypeBadge, { type: "capex" })
                  ),
                  React.createElement("div", { style: { fontSize: 10, color: "#64748b" } }, `${pos.sector} · Sensitivität: `, React.createElement("span", { style: { color: sensColor(pos.sensitivity) } }, pos.sensitivity), ` · Moat: ${moatLabel(pos.moat)}`)
                )
              ),
              React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                React.createElement("div", { style: { textAlign: "right" } },
                  React.createElement("div", { className: "m", style: { fontSize: 12, fontWeight: 600 } }, `€${pos.cost.toLocaleString("de-DE", { maximumFractionDigits: 0 })}`),
                  pr && React.createElement(BDG, { s: pr.sentiment })
                ),
                !DEFAULT_TICKERS.includes(pos.ticker) && React.createElement("button", { onClick: () => removeStock(pos.ticker), style: { background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 14, padding: 2 } }, "✕")
              )
            ),
            pr && React.createElement("div", { style: { fontSize: 11, color: "#94a3b8", lineHeight: 1.6, marginTop: 9, paddingTop: 9, borderTop: "1px solid #1e293b" } }, pr.summary)
          );
        }),

        /* Other Stocks */
        otherStocks.length > 0 && React.createElement(React.Fragment, null,
          React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: X.cyan, marginBottom: 6, marginTop: 14, textTransform: "uppercase", letterSpacing: ".06em" } }, `Andere Positionen (${otherStocks.length})`),
          otherStocks.map(pos => {
            const pr = positions[pos.ticker];
            return React.createElement("div", { key: pos.ticker, style: { background: "#111827", borderRadius: 12, border: `1px solid ${X.cyan}22`, padding: 13, marginBottom: 8 } },
              React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 9 } },
                  React.createElement("div", { className: "m", style: { width: 32, height: 32, borderRadius: 7, background: `${X.cyan}15`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: X.cyan } }, pos.ticker),
                  React.createElement("div", null,
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                      React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, pos.name),
                      React.createElement(TypeBadge, { type: "other" })
                    ),
                    React.createElement("div", { style: { fontSize: 10, color: "#64748b" } }, `${pos.sector} · Moat: ${moatLabel(pos.moat)}`)
                  )
                ),
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  React.createElement("div", { style: { textAlign: "right" } },
                    React.createElement("div", { className: "m", style: { fontSize: 12, fontWeight: 600 } }, `€${pos.cost.toLocaleString("de-DE", { maximumFractionDigits: 0 })}`),
                    pr && React.createElement(BDG, { s: pr.sentiment })
                  ),
                  React.createElement("button", { onClick: () => removeStock(pos.ticker), style: { background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 14, padding: 2 } }, "✕")
                )
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
        React.createElement("button", { onClick: runTiming, disabled: busyTiming || busy, style: {
          width: "100%", padding: 10, marginBottom: 12, borderRadius: 10, border: "none",
          cursor: (busyTiming || busy) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit",
          background: (busyTiming || busy) ? "#1e293b" : `linear-gradient(135deg,${X.cyan}cc,${X.indigo})`,
          color: (busyTiming || busy) ? "#64748b" : "#fff",
          boxShadow: (busyTiming || busy) ? "none" : `0 4px 14px ${X.cyan}22`,
        } }, busyTiming ? `⟳ ${timingStep}` : "⚡  Timing aktualisieren"),

        timing ? React.createElement(React.Fragment, null,
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
                s.fromHigh && React.createElement("span", null, "Vom Hoch: ", React.createElement("span", { style: { color: col } }, s.fromHigh)),
                s.momentum && React.createElement("span", null, "Momentum: ", React.createElement("span", { style: { color: s.momentum === "positiv" ? X.green : s.momentum === "negativ" ? X.red : X.yellow } }, s.momentum))
              )
            );
          })
        ) : React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", padding: 28, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 28, marginBottom: 10 } }, "⚡"),
          React.createElement("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 5 } }, "Starte die Live-Recherche"),
          React.createElement("div", { style: { fontSize: 12, color: "#64748b" } }, "Claude analysiert aktuelle Kurse und bewertet Timing-Chancen für jede Position.")
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
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: X.purple, marginBottom: 8 } }, "Verkaufspriorität (CapEx-Positionen)"),
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "0 0 5px", borderBottom: "1px solid #1e293b44", marginBottom: 2 } },
            React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", width: 40 } }, "Prio"),
            React.createElement("span", { className: "m", style: { fontSize: 9, color: "#475569", width: 34 } }, "Ticker"),
            React.createElement("span", { style: { fontSize: 9, color: "#475569", flex: 1 } }, "Name"),
            React.createElement("span", { style: { fontSize: 9, color: "#475569", width: 60, textAlign: "right" } }, "Sensitivität"),
            React.createElement("span", { style: { fontSize: 9, color: "#475569", width: 50, textAlign: "right" } }, "Moat")
          ),
          bySell.map((p, i) =>
            React.createElement("div", { key: p.ticker, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: i < bySell.length - 1 ? "1px solid #1e293b22" : "none" } },
              React.createElement("span", { className: "m", style: { fontSize: 10, fontWeight: 700, color: i < 3 ? X.red : i < 5 ? X.yellow : X.green, width: 40 } }, i < 3 ? "Zuerst" : i < 5 ? "Dann" : "Zuletzt"),
              React.createElement("span", { className: "m", style: { fontSize: 10, fontWeight: 700, color: X.purple, width: 34 } }, p.ticker),
              React.createElement("span", { style: { fontSize: 11, color: "#94a3b8", flex: 1 } }, p.name),
              React.createElement("span", { style: { fontSize: 10, color: sensColor(p.sensitivity), width: 60, textAlign: "right" } }, p.sensitivity),
              React.createElement("span", { style: { fontSize: 10, color: p.moat === "wide" ? X.green : p.moat === "medium" ? X.yellow : X.red, width: 50, textAlign: "right" } }, moatLabel(p.moat))
            )
          )
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
        React.createElement("p", { style: { fontSize: 12, color: "#94a3b8", marginBottom: 12 } }, "Kritische Earnings-Termine für die CapEx-Trajectory."),
        React.createElement("div", { style: { background: "#111827", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden" } },
          CAL.map((ev, i) =>
            React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", padding: "9px 12px", gap: 9, borderBottom: i < CAL.length - 1 ? "1px solid #1e293b22" : "none" } },
              React.createElement("span", { className: "m", style: { width: 50, fontSize: 11, fontWeight: 600, color: ev.c ? X.purple : "#64748b", flexShrink: 0 } }, ev.d),
              React.createElement("span", { style: { flex: 1, fontSize: 12, color: ev.c ? "#e2e8f0" : "#94a3b8" } }, ev.e),
              ev.c && React.createElement("span", { style: { fontSize: 8, padding: "2px 6px", borderRadius: 10, background: `${X.indigo}22`, color: X.purple, fontWeight: 700 } }, "KRITISCH")
            )
          )
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
