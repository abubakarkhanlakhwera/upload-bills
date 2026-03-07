(() => {
  if (window.__wbAutomationLoaded) {
    return;
  }
  window.__wbAutomationLoaded = true;

  const ALLOWED_FILE_RE = /\.(csv|xlsx|xls)$/i;
  const LOG_LIMIT = 500;

  const state = {
    running: false,
    timerId: null,
    intervalMs: 0,
    nextRunAt: 0,
    files: [],
    nextIndex: 0,
    uploadCount: 0,
    lastFile: "-",
    busy: false
  };

  function deserializeFile(fileLike) {
    if (fileLike instanceof File) {
      return fileLike;
    }

    if (!fileLike || !Array.isArray(fileLike.bytes)) {
      return null;
    }

    const bytes = new Uint8Array(fileLike.bytes);
    return new File([bytes], fileLike.name || "upload.csv", {
      type: fileLike.type || "application/octet-stream",
      lastModified: Number(fileLike.lastModified || Date.now())
    });
  }

  function sendStatusUpdate() {
    chrome.storage.local.set({
      uploadStatus: {
        running: state.running,
        intervalMs: state.intervalMs,
        nextRunAt: state.nextRunAt,
        selectedFiles: state.files.length,
        nextIndex: state.nextIndex,
        uploadCount: state.uploadCount,
        lastFile: state.lastFile,
        updatedAt: Date.now()
      }
    });
  }

  async function loadStoredState() {
    const data = await chrome.storage.local.get(["uploadCount", "lastFile"]);
    state.uploadCount = Number(data.uploadCount || 0);
    state.lastFile = data.lastFile || "-";
    sendStatusUpdate();
  }

  async function appendUploadLog(entry) {
    const data = await chrome.storage.local.get(["uploadLogs"]);
    const logs = Array.isArray(data.uploadLogs) ? data.uploadLogs : [];
    logs.push({
      at: new Date().toISOString(),
      ...entry
    });

    if (logs.length > LOG_LIMIT) {
      logs.splice(0, logs.length - LOG_LIMIT);
    }

    await chrome.storage.local.set({ uploadLogs: logs });
  }

  function getUploadInputCandidates() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) {
      return [];
    }

    const scored = inputs.map((input) => {
      const accept = (input.getAttribute("accept") || "").toLowerCase();
      let score = 0;

      if (accept.includes("csv")) {
        score += 2;
      }
      if (accept.includes("xls") || accept.includes("xlsx") || accept.includes("excel")) {
        score += 2;
      }
      if (input.multiple) {
        score += 1;
      }

      return { input, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((item) => item.input);
  }

  function findUploadButton() {
    const candidates = Array.from(
      document.querySelectorAll('button, input[type="button"], input[type="submit"]')
    );

    for (const element of candidates) {
      const text = (element.textContent || element.value || "").trim().toLowerCase();
      if (text.includes("upload file") || text === "upload") {
        return element;
      }
    }

    for (const element of candidates) {
      const text = (element.textContent || element.value || "").trim().toLowerCase();
      if (text.includes("upload")) {
        return element;
      }
    }

    return null;
  }

  function setInputFiles(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitForUploadButtonEnabled(button, timeoutMs = 1200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!button.disabled) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return !button.disabled;
  }

  async function prepareUploadInput(file, uploadButton) {
    const inputCandidates = getUploadInputCandidates();
    if (!inputCandidates.length) {
      return false;
    }

    for (const input of inputCandidates) {
      setInputFiles(input, file);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const ready = await waitForUploadButtonEnabled(uploadButton, 1200);
      if (ready) {
        return true;
      }
    }

    return false;
  }

  async function uploadOnce() {
    if (state.busy || !state.files.length) {
      return { ok: false, message: "No selected files or uploader busy." };
    }

    state.busy = true;

    try {
      const uploadBtn = findUploadButton();
      if (!uploadBtn) {
        const message = "Upload button not found on this page.";
        await appendUploadLog({ status: "error", file: null, message });
        return { ok: false, message };
      }

      const file = state.files[state.nextIndex];
      if (!file) {
        const message = "No file available at current index.";
        await appendUploadLog({ status: "error", file: null, message });
        return { ok: false, message };
      }

      let readyToUpload = !uploadBtn.disabled;
      if (!readyToUpload) {
        readyToUpload = await prepareUploadInput(file, uploadBtn);
      }

      if (!readyToUpload) {
        const message = "Upload button stayed disabled after trying page file inputs.";
        await appendUploadLog({ status: "error", file: file.name, message });
        return { ok: false, message };
      }

      if (typeof uploadBtn.click === "function") {
        uploadBtn.click();
      } else {
        uploadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      state.lastFile = file.name;
      state.uploadCount += 1;
      state.nextIndex = (state.nextIndex + 1) % state.files.length;

      await chrome.storage.local.set({
        uploadCount: state.uploadCount,
        lastFile: state.lastFile
      });
      await appendUploadLog({ status: "success", file: file.name, message: "Uploaded" });
      sendStatusUpdate();

      return { ok: true, message: `Uploaded: ${file.name}` };
    } catch (err) {
      const message = err?.message || "Upload failed.";
      await appendUploadLog({ status: "error", file: null, message });
      return { ok: false, message };
    } finally {
      state.busy = false;
    }
  }

  function stopScheduler() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    state.running = false;
    state.nextRunAt = 0;
    sendStatusUpdate();
  }

  function startScheduler(intervalMs) {
    stopScheduler();
    state.intervalMs = intervalMs;
    state.running = true;
    state.nextRunAt = Date.now() + intervalMs;

    state.timerId = setInterval(() => {
      state.nextRunAt = Date.now() + intervalMs;
      sendStatusUpdate();
      uploadOnce();
    }, intervalMs);

    sendStatusUpdate();
  }

  function setFiles(files) {
    const safeFiles = files
      .map(deserializeFile)
      .filter(Boolean)
      .filter((file) => ALLOWED_FILE_RE.test(file.name));

    state.files = safeFiles;
    state.nextIndex = 0;
    sendStatusUpdate();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "START_AUTOMATION") {
      const incomingFiles = Array.isArray(message.files) ? message.files : [];
      const intervalMs = Number(message.intervalMs || 0);

      if (!incomingFiles.length) {
        sendResponse({ ok: false, message: "No files provided." });
        return;
      }
      if (!intervalMs || intervalMs < 1000) {
        sendResponse({ ok: false, message: "Minimum interval is 1 second." });
        return;
      }

      setFiles(incomingFiles);
      if (!state.files.length) {
        sendResponse({ ok: false, message: "No valid CSV/Excel files after decoding." });
        return;
      }

      startScheduler(intervalMs);
      uploadOnce().then((firstResult) => {
        if (!firstResult.ok) {
          stopScheduler();
          sendResponse({ ok: false, message: `First upload failed: ${firstResult.message}` });
          return;
        }
        sendResponse({ ok: true, message: "Automation started." });
      });
      return true;
    }

    if (message.type === "STOP_AUTOMATION") {
      stopScheduler();
      sendResponse({ ok: true, message: "Automation stopped." });
      return;
    }

    if (message.type === "UPLOAD_NOW") {
      if (Array.isArray(message.files) && message.files.length) {
        setFiles(message.files);
      }
      uploadOnce().then(sendResponse);
      return true;
    }

    if (message.type === "RESET_COUNT") {
      state.uploadCount = 0;
      chrome.storage.local.set({ uploadCount: 0 });
      sendStatusUpdate();
      sendResponse({ ok: true, message: "Upload count reset." });
      return;
    }

    if (message.type === "GET_STATUS") {
      sendResponse({
        ok: true,
        status: {
          running: state.running,
          intervalMs: state.intervalMs,
          nextRunAt: state.nextRunAt,
          selectedFiles: state.files.length,
          nextIndex: state.nextIndex,
          uploadCount: state.uploadCount,
          lastFile: state.lastFile
        }
      });
    }
  });

  loadStoredState();
})();
