"use strict";

const APP_VERSION = "1.1.2";
const DB_NAME = "miketz-audio-studio";
const VERSE_STORE = "recordings";
const PHRASE_STORE = "phrases";
const verseButtons = [...document.querySelectorAll(".verse-number")];
const verseParagraphs = new Map();
const phraseRecords = new Map();
const phraseUrls = new Map();
const verseUrls = new Map();
const dialog = document.querySelector("#studioDialog");
const lock = document.querySelector("#studioLock");
const controls = document.querySelector("#studioControls");
const select = document.querySelector("#verseSelect");
const phraseText = document.querySelector("#phraseText");
const playback = document.querySelector("#studioPlayback");
const status = document.querySelector("#studioStatus");
const recordButton = document.querySelector("#recordButton");
const stopButton = document.querySelector("#stopButton");
const saveButton = document.querySelector("#saveButton");
const deleteButton = document.querySelector("#deleteButton");
const audioToggle = document.querySelector("#audioToggle");
let activeAudio;
let mediaRecorder;
let recordingChunks = [];
let recordingBlob;
let previewUrl;
let audioEnabled = true;

document.querySelector(".version").textContent = `v${APP_VERSION}`;

verseButtons.forEach(button => {
  const id = button.textContent.trim();
  const paragraph = button.closest("p");
  const text = [...paragraph.childNodes]
    .filter(node => node !== button)
    .map(node => node.textContent)
    .join("");
  button.dataset.audioId = id;
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("aria-label", `Play Genesis ${id}`);
  verseParagraphs.set(id, { paragraph, button, text });
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `Genesis ${id}`;
  select.append(option);
  button.addEventListener("mouseenter", () => playUrl(verseUrls.get(id)));
  button.addEventListener("focus", () => playUrl(verseUrls.get(id)));
});

function normalizePhrase(value) {
  return value.trim().replace(/\s+/g, " ");
}

function phraseKey(verseId, text) {
  return `${verseId}::${normalizePhrase(text)}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VERSE_STORE)) db.createObjectStore(VERSE_STORE);
      if (!db.objectStoreNames.contains(PHRASE_STORE)) db.createObjectStore(PHRASE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useStore(storeName, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function getAllRecords(storeName) {
  const keys = await useStore(storeName, "readonly", store => store.getAllKeys());
  const records = [];
  for (const key of keys) records.push([String(key), await useStore(storeName, "readonly", store => store.get(key))]);
  return records;
}

async function refreshAudio() {
  verseUrls.forEach(URL.revokeObjectURL);
  phraseUrls.forEach(URL.revokeObjectURL);
  verseUrls.clear();
  phraseUrls.clear();
  phraseRecords.clear();

  for (const [key, blob] of await getAllRecords(VERSE_STORE)) verseUrls.set(key, URL.createObjectURL(blob));
  for (const [key, record] of await getAllRecords(PHRASE_STORE)) {
    if (!record?.blob || !record?.verseId || !record?.text) continue;
    phraseRecords.set(key, record);
    phraseUrls.set(key, URL.createObjectURL(record.blob));
  }
  verseButtons.forEach(button => button.classList.toggle("has-audio", verseUrls.has(button.dataset.audioId)));
  renderAllPhrases();
  refreshPreview();
}

function renderAllPhrases() {
  for (const [verseId, verse] of verseParagraphs) {
    const records = [...phraseRecords.entries()]
      .filter(([, record]) => record.verseId === verseId)
      .map(([key, record]) => ({ key, ...record, start: verse.text.indexOf(record.text) }))
      .filter(record => record.start >= 0)
      .sort((a, b) => a.start - b.start);
    verse.paragraph.replaceChildren(verse.button);
    let cursor = 0;
    records.forEach((record, colorIndex) => {
      if (record.start < cursor) return;
      verse.paragraph.append(document.createTextNode(verse.text.slice(cursor, record.start)));
      const phrase = document.createElement("span");
      phrase.className = `phrase phrase-color-${colorIndex % 4}`;
      phrase.textContent = record.text;
      phrase.tabIndex = 0;
      phrase.setAttribute("role", "button");
      phrase.setAttribute("aria-label", `Play phrase: ${record.text}`);
      phrase.addEventListener("mouseenter", () => playUrl(phraseUrls.get(record.key)));
      phrase.addEventListener("focus", () => playUrl(phraseUrls.get(record.key)));
      verse.paragraph.append(phrase);
      cursor = record.start + record.text.length;
    });
    verse.paragraph.append(document.createTextNode(verse.text.slice(cursor)));
  }
}

function playUrl(url) {
  if (!audioEnabled || !url) return;
  activeAudio?.pause();
  activeAudio = new Audio(url);
  activeAudio.play().catch(() => {});
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("danger", isError);
}

function currentKey() {
  return phraseKey(select.value, phraseText.value);
}

function phraseIsValid() {
  const phrase = normalizePhrase(phraseText.value);
  return phrase && verseParagraphs.get(select.value).text.includes(phrase);
}

function refreshPreview() {
  const key = currentKey();
  if (recordingBlob) {
    deleteButton.textContent = "Discard recording";
    deleteButton.disabled = false;
    return;
  }
  playback.src = phraseUrls.get(key) || "";
  deleteButton.textContent = "Delete phrase";
  deleteButton.disabled = !phraseRecords.has(key);
}

function resetPhraseState() {
  recordingBlob = undefined;
  saveButton.disabled = true;
  refreshPreview();
  setStatus(phraseText.value && !phraseIsValid() ? "Paste an exact phrase from the selected verse." : "", Boolean(phraseText.value && !phraseIsValid()));
}

audioToggle.addEventListener("click", () => {
  audioEnabled = !audioEnabled;
  audioToggle.setAttribute("aria-pressed", String(audioEnabled));
  audioToggle.textContent = `Audio: ${audioEnabled ? "On" : "Off"}`;
  if (!audioEnabled) activeAudio?.pause();
});

document.querySelector("#openStudio").addEventListener("click", () => dialog.showModal());
document.querySelector("#closeStudio").addEventListener("click", () => dialog.close());
document.querySelector("#unlockForm").addEventListener("submit", event => {
  event.preventDefault();
  const error = document.querySelector("#lockError");
  if (document.querySelector("#studioCode").value !== dialog.dataset.accessCode) {
    error.textContent = "Incorrect access code.";
    return;
  }
  error.textContent = "";
  lock.hidden = true;
  controls.hidden = false;
  setStatus("Studio unlocked. Copy words from a verse and paste them into the phrase box.");
});

select.addEventListener("change", () => {
  phraseText.value = "";
  resetPhraseState();
});
phraseText.addEventListener("input", resetPhraseState);

recordButton.addEventListener("click", async () => {
  if (!phraseIsValid()) {
    setStatus("Paste an exact phrase from the selected verse before recording.", true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    recordingBlob = undefined;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data.size) recordingChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      recordingBlob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(recordingBlob);
      playback.src = previewUrl;
      saveButton.disabled = false;
      refreshPreview();
      stream.getTracks().forEach(track => track.stop());
      setStatus("Phrase recording ready. Play it back, then save or record again.");
    });
    mediaRecorder.start();
    recordButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Recording phrase…");
  } catch (error) {
    setStatus(`Microphone unavailable: ${error.message}`, true);
  }
});

stopButton.addEventListener("click", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  recordButton.disabled = false;
  stopButton.disabled = true;
});

saveButton.addEventListener("click", async () => {
  if (!recordingBlob || !phraseIsValid()) return;
  const text = normalizePhrase(phraseText.value);
  const key = phraseKey(select.value, text);
  try {
    saveButton.disabled = true;
    setStatus("Saving…");
    await useStore(PHRASE_STORE, "readwrite", store => store.put({ verseId: select.value, text, blob: recordingBlob }, key));
    recordingBlob = undefined;
    await refreshAudio();
    setStatus("Phrase saved. Click any highlighted word in the phrase to play it.");
  } catch (error) {
    saveButton.disabled = false;
    setStatus(error.message, true);
  }
});

deleteButton.addEventListener("click", async () => {
  if (recordingBlob) {
    recordingBlob = undefined;
    saveButton.disabled = true;
    refreshPreview();
    setStatus("Unsaved recording discarded.");
    return;
  }
  const key = currentKey();
  if (!phraseRecords.has(key) || !confirm(`Delete this phrase recording?`)) return;
  await useStore(PHRASE_STORE, "readwrite", store => store.delete(key));
  await refreshAudio();
  setStatus("Phrase recording deleted.");
});

dialog.addEventListener("close", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
});

refreshAudio().catch(error => setStatus(`Audio storage unavailable: ${error.message}`, true));
