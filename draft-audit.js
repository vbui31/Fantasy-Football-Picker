const DB_NAME = "war-room-draft-ledger";
const STORE_NAME = "drafts";
const FALLBACK_KEY = "war-room-draft-ledger-v1";

const safeText = (value, fallback, max = 240) => {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, max);
};

export function createDraftId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function settingsFingerprint(settings = {}) {
  const slots = settings.rosterSlots || {};
  return [settings.gradeVersion || "unversioned", settings.scoring?.id || "ppr", settings.teams, settings.rounds, settings.draftFormat || "snake", settings.tePremium || 0,
    ...["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DST"].map((key) => slots[key] || 0)].join(":");
}

export function validateExternalGradeResponse(payload, teamCount) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("External grader returned an invalid JSON object.");
  if (!String(payload.provider || "").trim() || !String(payload.modelVersion || "").trim() || !String(payload.methodology || "").trim()) throw new Error("External grader must identify its provider, model version, and methodology.");
  const provider = safeText(payload.provider, "External grader", 80);
  const modelVersion = safeText(payload.modelVersion, "unspecified", 80);
  const methodology = safeText(payload.methodology, "No methodology supplied.", 500);
  const gradedAt = Number.isFinite(Date.parse(payload.gradedAt)) ? new Date(payload.gradedAt).toISOString() : new Date().toISOString();
  if (!Array.isArray(payload.teams) || payload.teams.length !== teamCount) throw new Error(`External grader must return exactly ${teamCount} team grades.`);
  const seen = new Set();
  const teams = payload.teams.map((entry) => {
    const team = Number(entry?.team);
    const score = Number(entry?.score);
    const confidence = entry?.confidence == null ? null : Number(entry.confidence);
    if (!Number.isInteger(team) || team < 0 || team >= teamCount || seen.has(team)) throw new Error("External grader returned duplicate or invalid team IDs.");
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("External scores must be numbers from 0 to 100.");
    if (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new Error("External confidence must be between 0 and 1.");
    seen.add(team);
    const explanation = (Array.isArray(entry.explanation) ? entry.explanation : [entry.explanation]).filter(Boolean).slice(0, 8).map((value) => safeText(value, "", 240));
    return { team, score, grade: safeText(entry.grade, "—", 8), confidence, explanation };
  });
  const sourceUrls = (Array.isArray(payload.sourceUrls) ? payload.sourceUrls : []).filter((url) => {
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  }).slice(0, 8);
  return { provider, modelVersion, methodology, gradedAt, teams, sourceUrls };
}

export function historicalCalibration(score, history = [], settings = {}, excludeId = null) {
  const fingerprint = settingsFingerprint(settings);
  const comparable = history.filter((entry) => entry.id !== excludeId && entry.status === "complete" && entry.settingsFingerprint === fingerprint && Number.isFinite(entry.userScore)).map((entry) => entry.userScore);
  if (!Number.isFinite(score) || !comparable.length) return { sampleSize: comparable.length, percentile: null, mean: null, standardDeviation: null };
  const mean = comparable.reduce((sum, value) => sum + value, 0) / comparable.length;
  const variance = comparable.reduce((sum, value) => sum + (value - mean) ** 2, 0) / comparable.length;
  const below = comparable.filter((value) => value < score).length;
  const equal = comparable.filter((value) => value === score).length;
  return { sampleSize: comparable.length, percentile: (below + equal * .5) / comparable.length, mean, standardDeviation: Math.sqrt(variance) };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function fallbackEntries() {
  try { const value = JSON.parse(localStorage.getItem(FALLBACK_KEY)); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

export async function putDraftLog(entry) {
  const clean = { ...entry, updatedAt: new Date().toISOString() };
  try {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(clean);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  } catch {
    const entries = fallbackEntries().filter((item) => item.id !== clean.id);
    entries.push(clean);
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(entries.slice(-500)));
  }
  return clean;
}

export async function getDraftLogs() {
  try {
    const database = await openDatabase();
    const entries = await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return fallbackEntries().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
}
