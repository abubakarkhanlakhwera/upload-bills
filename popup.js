const fileInput = document.getElementById("fileInput");
const folderInput = document.getElementById("folderInput");
const fileSummary = document.getElementById("fileSummary");
const intervalValueInput = document.getElementById("intervalValue");
const intervalUnitInput = document.getElementById("intervalUnit");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const uploadNowBtn = document.getElementById("uploadNowBtn");
const resetCountBtn = document.getElementById("resetCountBtn");
const exportLogsBtn = document.getElementById("exportLogsBtn");
const clearLogsBtn = document.getElementById("clearLogsBtn");
const statusText = document.getElementById("statusText");
const uploadCountText = document.getElementById("uploadCount");
const lastFileText = document.getElementById("lastFile");
const nextUploadText = document.getElementById("nextUpload");
const stopOnCloseInput = document.getElementById("stopOnClose");
const keepRunningInput = document.getElementById("keepRunning");
const messageText = document.getElementById("message");

let selectedFiles = [];
let latestStatus = {
  running: false,
  uploadCount: 0,
  lastFile: "-",
  nextRunAt: 0
};
let countdownTimerId = null;

function isStopOnCloseEnabled() {
  return Boolean(stopOnCloseInput?.checked);
}

async function saveCloseBehaviorSettings() {
  await chrome.storage.local.set({
    stopOnClose: Boolean(stopOnCloseInput?.checked)
  });
}

function syncCloseBehaviorFromStopOnClose() {
  if (!stopOnCloseInput || !keepRunningInput) {
    return;
  }
  keepRunningInput.checked = !stopOnCloseInput.checked;
}

function syncCloseBehaviorFromKeepRunning() {
  if (!stopOnCloseInput || !keepRunningInput) {
    return;
  }
  stopOnCloseInput.checked = !keepRunningInput.checked;
}

const allowedExt = /\.(csv|xlsx|xls)$/i;

function setMessage(text, isError = false) {
  messageText.textContent = text;
  messageText.style.color = isError ? "#b91c1c" : "#1d4ed8";
}

function formatRemaining(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSec = Math.ceil(safeMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function updateCountdownText() {
  if (!latestStatus.running || !latestStatus.nextRunAt) {
    nextUploadText.textContent = "-";
    return;
  }

  nextUploadText.textContent = formatRemaining(latestStatus.nextRunAt - Date.now());
}

function getIntervalMs() {
  const value = Number(intervalValueInput.value);
  const unit = intervalUnitInput.value;

  if (!Number.isFinite(value) || value < 1) {
    return null;
  }

  if (unit === "seconds") {
    return value * 1000;
  }
  if (unit === "minutes") {
    return value * 60 * 1000;
  }
  if (unit === "hours") {
    return value * 60 * 60 * 1000;
  }
  return null;
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function stopOnPopupClose() {
  if (!isStopOnCloseEnabled()) {
    return;
  }

  try {
    await sendToActiveTab({ type: "STOP_AUTOMATION" });
  } catch (_err) {
    // Ignore close-time stop failures.
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "GET_STATUS" });
    return;
  } catch (_err) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function sendToActiveTab(payload) {
  const tabId = await getActiveTabId();
  if (!tabId) {
    throw new Error("No active tab found.");
  }

  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, payload);
}

function mergeFiles(incoming) {
  const map = new Map();

  for (const file of [...selectedFiles, ...incoming]) {
    if (!allowedExt.test(file.name)) {
      continue;
    }

    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!map.has(key)) {
      map.set(key, file);
    }
  }

  selectedFiles = [...map.values()];
  renderFileSummary();
}

async function serializeFiles(files) {
  const out = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    out.push({
      name: file.name,
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
      size: file.size,
      bytes: Array.from(new Uint8Array(buffer))
    });
  }
  return out;
}

function renderFileSummary() {
  if (!selectedFiles.length) {
    fileSummary.textContent = "No files selected";
    startBtn.disabled = true;
    return;
  }

  const previewNames = selectedFiles.slice(0, 2).map((f) => f.name).join(", ");
  const extra = selectedFiles.length > 2 ? ` +${selectedFiles.length - 2} more` : "";
  fileSummary.textContent = `${selectedFiles.length} file(s): ${previewNames}${extra}`;
  startBtn.disabled = false;
}

function setStatus(status) {
  latestStatus = {
    running: Boolean(status.running),
    uploadCount: Number(status.uploadCount || 0),
    lastFile: status.lastFile || "-",
    nextRunAt: Number(status.nextRunAt || 0)
  };

  statusText.textContent = status.running ? "Running" : "Stopped";
  uploadCountText.textContent = String(status.uploadCount ?? 0);
  lastFileText.textContent = status.lastFile || "-";
  updateCountdownText();
}

async function refreshStatus() {
  try {
    const result = await sendToActiveTab({ type: "GET_STATUS" });
    if (result?.ok) {
      setStatus(result.status);
      return;
    }
  } catch (_err) {
    // Ignore tab message failures below and show storage fallback.
  }

  const data = await chrome.storage.local.get(["uploadCount", "lastFile", "uploadStatus"]);
  const status = data.uploadStatus || {
    running: false,
    uploadCount: Number(data.uploadCount || 0),
    lastFile: data.lastFile || "-",
    nextRunAt: Number(data.uploadStatus?.nextRunAt || 0)
  };
  setStatus(status);
}

async function startAutomation() {
  if (!selectedFiles.length) {
    setMessage("Select at least one CSV/Excel file.", true);
    return;
  }

  const intervalMs = getIntervalMs();
  if (!intervalMs || intervalMs < 1000) {
    setMessage("Interval must be at least 1 second.", true);
    return;
  }

  try {
    setMessage("Preparing file data...");
    const serializedFiles = await serializeFiles(selectedFiles);

    const result = await sendToActiveTab({
      type: "START_AUTOMATION",
      files: serializedFiles,
      intervalMs
    });

    if (!result?.ok) {
      setMessage(result?.message || "Failed to start automation.", true);
      return;
    }

    setMessage("Automation started.");
    await refreshStatus();
  } catch (err) {
    setMessage(err?.message || "Failed to start automation.", true);
  }
}

async function stopAutomation() {
  try {
    const result = await sendToActiveTab({ type: "STOP_AUTOMATION" });
    setMessage(result?.message || "Automation stopped.");
    await refreshStatus();
  } catch (_err) {
    setMessage("Could not connect to the page tab.", true);
  }
}

async function uploadNow() {
  if (!selectedFiles.length) {
    setMessage("Select at least one CSV/Excel file first.", true);
    return;
  }

  try {
    setMessage("Preparing file data...");
    const serializedFiles = await serializeFiles(selectedFiles);

    const result = await sendToActiveTab({
      type: "UPLOAD_NOW",
      files: serializedFiles
    });
    if (!result?.ok) {
      setMessage(result?.message || "Upload now failed.", true);
      return;
    }
    setMessage(result.message || "Uploaded.");
    await refreshStatus();
  } catch (_err) {
    setMessage("Could not connect to the page tab.", true);
  }
}

async function resetCount() {
  try {
    const result = await sendToActiveTab({ type: "RESET_COUNT" });
    setMessage(result?.message || "Count reset.");
    await refreshStatus();
  } catch (_err) {
    await chrome.storage.local.set({ uploadCount: 0, lastFile: "-" });
    setMessage("Count reset from local storage.");
    await refreshStatus();
  }
}

function downloadTextFile(fileName, text, mimeType = "application/json") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportLogs() {
  const data = await chrome.storage.local.get(["uploadLogs"]);
  const logs = Array.isArray(data.uploadLogs) ? data.uploadLogs : [];

  if (!logs.length) {
    setMessage("No logs available yet.", true);
    return;
  }

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const fileName = `water-bills-upload-logs-${stamp}.json`;
  downloadTextFile(fileName, JSON.stringify(logs, null, 2));
  setMessage(`Exported ${logs.length} logs.`);
}

async function clearLogs() {
  const ok = window.confirm("Delete all stored upload logs?");
  if (!ok) {
    return;
  }

  await chrome.storage.local.set({ uploadLogs: [] });
  setMessage("Upload logs cleared.");
}

fileInput.addEventListener("change", () => {
  mergeFiles(Array.from(fileInput.files || []));
});

folderInput.addEventListener("change", () => {
  mergeFiles(Array.from(folderInput.files || []));
});

startBtn.addEventListener("click", startAutomation);
stopBtn.addEventListener("click", stopAutomation);
uploadNowBtn.addEventListener("click", uploadNow);
resetCountBtn.addEventListener("click", resetCount);
exportLogsBtn.addEventListener("click", exportLogs);
clearLogsBtn.addEventListener("click", clearLogs);

intervalValueInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ intervalValue: intervalValueInput.value });
});

intervalUnitInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ intervalUnit: intervalUnitInput.value });
});

stopOnCloseInput.addEventListener("change", async () => {
  syncCloseBehaviorFromStopOnClose();
  await saveCloseBehaviorSettings();
});

keepRunningInput.addEventListener("change", async () => {
  syncCloseBehaviorFromKeepRunning();
  await saveCloseBehaviorSettings();
});

window.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["intervalValue", "intervalUnit", "stopOnClose"]);
  if (data.intervalValue) {
    intervalValueInput.value = String(data.intervalValue);
  }
  if (data.intervalUnit) {
    intervalUnitInput.value = String(data.intervalUnit);
  }
  if (typeof data.stopOnClose === "boolean") {
    stopOnCloseInput.checked = data.stopOnClose;
  }
  syncCloseBehaviorFromStopOnClose();

  renderFileSummary();
  await refreshStatus();

  countdownTimerId = setInterval(() => {
    updateCountdownText();
  }, 1000);
});

window.addEventListener("beforeunload", () => {
  stopOnPopupClose();
  if (countdownTimerId) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
});
