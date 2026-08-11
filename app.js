"use strict";

const APP_VERSION = "1.0.0";
const DB_NAME = "miketz-audio-studio";
const STORE_NAME = "recordings";
const verseButtons = [...document.querySelectorAll(".verse-number")];
const dialog = document.querySelector("#studioDialog");
const lock = document.querySelector("#studioLock");
const controls = document.querySelector("#studioControls");
const select = document.querySelector("#verseSelect");
const playback = document.querySelector("#studioPlayback");
const status = document.querySelector("#studioStatus");
const recordButton = document.querySelector("#recordButton");
const stopButton = document.querySelector("#stopButton");
const saveButton = document.querySelector("#saveButton");
const deleteButton = document.querySelector("#deleteButton");
const audioToggle = document.querySelector("#audioToggle");
const audioUrls = new Map();
let activeAudio;
let mediaRecorder;
let recordingChunks = [];
let recordingBlob;
let previewUrl;
let audioEnabled = true;

document.querySelector(".version").textContent = `v${APP_VERSION}`;

verseButtons.forEach(button => {
  const id = button.textContent.trim();
  button.dataset.audioId = id;
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("aria-label", `Play Genesis ${id}`);
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `Genesis ${id}`;
  select.append(option);
  button.addEventListener("click", () => playVerse(id));
  button.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      playVerse(id);
    }
  });
});

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useStore(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function refreshAudio() {
  audioUrls.forEach(url => URL.revokeObjectURL(url));
  audioUrls.clear();
  const keys = await useStore("readonly", store => store.getAllKeys());
  for (const key of keys) {
    const blob = await useStore("readonly", store => store.get(key));
    audioUrls.set(String(key), URL.createObjectURL(blob));
  }
  verseButtons.forEach(button => button.classList.toggle("has-audio", audioUrls.has(button.dataset.audioId)));
  refreshPreview();
}

function playVerse(id) {
  if (!audioEnabled) return;
  const url = audioUrls.get(id);
  if (!url) return;
  activeAudio?.pause();
  activeAudio = new Audio(url);
  activeAudio.play().catch(() => {});
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("danger", isError);
}

function refreshPreview() {
  if (recordingBlob) {
    deleteButton.textContent = "Discard recording";
    deleteButton.disabled = false;
    return;
  }
  playback.src = audioUrls.get(select.value) || "";
  deleteButton.textContent = "Delete audio";
  deleteButton.disabled = !audioUrls.has(select.value);
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
  setStatus("Studio unlocked.");
});

select.addEventListener("change", () => {
  recordingBlob = undefined;
  saveButton.disabled = true;
  refreshPreview();
  setStatus("");
});

recordButton.addEventListener("click", async () => {
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
      setStatus("Recording ready. Play it back, then save or record again.");
    });
    mediaRecorder.start();
    recordButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Recording…");
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
  if (!recordingBlob) return;
  try {
    saveButton.disabled = true;
    setStatus("Saving…");
    await useStore("readwrite", store => store.put(recordingBlob, select.value));
    recordingBlob = undefined;
    await refreshAudio();
    setStatus("Recording saved in this browser.");
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
  if (!audioUrls.has(select.value) || !confirm(`Delete the recording for Genesis ${select.value}?`)) return;
  await useStore("readwrite", store => store.delete(select.value));
  await refreshAudio();
  setStatus("Recording deleted.");
});

dialog.addEventListener("close", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
});

refreshAudio().catch(error => setStatus(`Audio storage unavailable: ${error.message}`, true));
