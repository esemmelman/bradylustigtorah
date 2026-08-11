"use strict";

const APP_VERSION = "1.4.0";
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
const targetType = document.querySelector("#targetType");
const phraseField = document.querySelector("#phraseField");
const phraseText = document.querySelector("#phraseText");
const playback = document.querySelector("#studioPlayback");
const status = document.querySelector("#studioStatus");
const recordButton = document.querySelector("#recordButton");
const stopButton = document.querySelector("#stopButton");
const saveButton = document.querySelector("#saveButton");
const deleteButton = document.querySelector("#deleteButton");
const audioToggle = document.querySelector("#audioToggle");
const levelFill = document.querySelector("#levelFill");
const levelMeter = document.querySelector(".level-meter");
let activeAudio;
let mediaRecorder;
let meterAudioContext;
let levelAnimation;
let recordingChunks = [];
let recordingBlob;
let previewUrl;
let audioEnabled = true;

document.querySelector(".version").textContent = `v${APP_VERSION}`;

const fontToggles = [...document.querySelectorAll(".font-toggle")];
fontToggles.forEach(toggle => toggle.addEventListener("click", () => {
  const enabled = !document.body.classList.contains("torah-font");
  document.body.classList.toggle("torah-font", enabled);
  fontToggles.forEach(button => {
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = `Torah font: ${enabled ? "On" : "Off"}`;
  });
}));

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

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function startLevelMeter(stream) {
  meterAudioContext = new AudioContext();
  const source = meterAudioContext.createMediaStreamSource(stream);
  const analyser = meterAudioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const update = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / samples.length);
    const level = Math.min(100, Math.round(rms * 320));
    levelFill.style.width = `${level}%`;
    levelMeter.setAttribute("aria-valuenow", String(level));
    levelAnimation = requestAnimationFrame(update);
  };
  update();
}

function stopLevelMeter() {
  cancelAnimationFrame(levelAnimation);
  meterAudioContext?.close().catch(() => {});
  meterAudioContext = undefined;
  levelFill.style.width = "0";
  levelMeter.setAttribute("aria-valuenow", "0");
}

async function normalizeRecording(blob) {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
    }
    if (!peak) return blob;
    const gain = Math.min(4, 0.9 / peak);
    return audioBufferToWav(buffer, gain);
  } finally {
    await context.close();
  }
}

function audioBufferToWav(buffer, gain) {
  const channels = buffer.numberOfChannels;
  const frameCount = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frameCount * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame] * gain));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([output], { type: "audio/wav" });
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("danger", isError);
}

function currentKey() {
  return phraseKey(select.value, phraseText.value);
}

function recordingVerseNumber() {
  return targetType.value === "verse-number";
}

function phraseIsValid() {
  const phrase = normalizePhrase(phraseText.value);
  return phrase && verseParagraphs.get(select.value).text.includes(phrase);
}

function detectPhraseVerse() {
  const phrase = normalizePhrase(phraseText.value);
  if (!phrase) return false;
  if (verseParagraphs.get(select.value).text.includes(phrase)) return true;
  const match = [...verseParagraphs].find(([, verse]) => verse.text.includes(phrase));
  if (!match) return false;
  select.value = match[0];
  return true;
}

function refreshPreview() {
  if (recordingBlob) {
    deleteButton.textContent = "Discard recording";
    deleteButton.disabled = false;
    return;
  }
  if (recordingVerseNumber()) {
    playback.src = verseUrls.get(select.value) || "";
    deleteButton.textContent = "Delete number audio";
    deleteButton.disabled = !verseUrls.has(select.value);
  } else {
    const key = currentKey();
    playback.src = phraseUrls.get(key) || "";
    deleteButton.textContent = "Delete phrase";
    deleteButton.disabled = !phraseRecords.has(key);
  }
}

function resetPhraseState() {
  recordingBlob = undefined;
  saveButton.disabled = true;
  phraseField.hidden = recordingVerseNumber();
  refreshPreview();
  if (recordingVerseNumber()) {
    setStatus(`Ready to record the spoken number Genesis ${select.value}.`);
  } else {
    const hasText = Boolean(normalizePhrase(phraseText.value));
    const valid = phraseIsValid();
    setStatus(hasText ? (valid ? `Phrase found in Genesis ${select.value}. Ready to record.` : "Phrase not found. Copy an exact phrase from one of the displayed verses.") : "", hasText && !valid);
  }
}

audioToggle.addEventListener("click", () => {
  audioEnabled = !audioEnabled;
  audioToggle.setAttribute("aria-pressed", String(audioEnabled));
  audioToggle.textContent = `Audio: ${audioEnabled ? "On" : "Off"}`;
  if (!audioEnabled) activeAudio?.pause();
});

document.querySelector("#openStudio").addEventListener("click", () => {
  if (!dialog.open) dialog.show();
});
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
targetType.addEventListener("change", resetPhraseState);
phraseText.addEventListener("input", () => {
  detectPhraseVerse();
  resetPhraseState();
});

recordButton.addEventListener("click", async () => {
  if (!recordingVerseNumber() && !phraseIsValid()) {
    setStatus("Paste an exact phrase from the selected verse before recording.", true);
    return;
  }
  try {
    recordButton.disabled = true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
        channelCount: 1
      }
    });
    startLevelMeter(stream);
    for (let count = 3; count > 0; count -= 1) {
      setStatus(`Recording starts in ${count}… Watch the microphone level.`);
      await wait(1000);
    }
    recordingChunks = [];
    recordingBlob = undefined;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data.size) recordingChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", async () => {
      const rawBlob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      setStatus("Normalizing volume…");
      try {
        recordingBlob = await normalizeRecording(rawBlob);
      } catch (error) {
        console.info(`Normalization unavailable: ${error.message}`);
        recordingBlob = rawBlob;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(recordingBlob);
      playback.src = previewUrl;
      saveButton.disabled = false;
      refreshPreview();
      stream.getTracks().forEach(track => track.stop());
      stopLevelMeter();
      setStatus(recordingVerseNumber()
        ? `Genesis ${select.value} recording ready. Play it back, then save or record again.`
        : "Phrase recording ready. Play it back, then save or record again.");
    });
    mediaRecorder.start();
    stopButton.disabled = false;
    setStatus(recordingVerseNumber() ? `Recording Genesis ${select.value}…` : "Recording phrase…");
  } catch (error) {
    recordButton.disabled = false;
    stopLevelMeter();
    setStatus(`Microphone unavailable: ${error.message}`, true);
  }
});

stopButton.addEventListener("click", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  recordButton.disabled = false;
  stopButton.disabled = true;
});

saveButton.addEventListener("click", async () => {
  if (!recordingBlob || (!recordingVerseNumber() && !phraseIsValid())) return;
  try {
    saveButton.disabled = true;
    setStatus("Saving…");
    if (recordingVerseNumber()) {
      await useStore(VERSE_STORE, "readwrite", store => store.put(recordingBlob, select.value));
    } else {
      const text = normalizePhrase(phraseText.value);
      const key = phraseKey(select.value, text);
      await useStore(PHRASE_STORE, "readwrite", store => store.put({ verseId: select.value, text, blob: recordingBlob }, key));
    }
    recordingBlob = undefined;
    await refreshAudio();
    setStatus(recordingVerseNumber()
      ? `Number audio saved. Hover over ${select.value} to play it.`
      : "Phrase saved. Hover over any highlighted word in the phrase to play it.");
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
  if (recordingVerseNumber()) {
    if (!verseUrls.has(select.value) || !confirm(`Delete the number audio for Genesis ${select.value}?`)) return;
    await useStore(VERSE_STORE, "readwrite", store => store.delete(select.value));
  } else {
    const key = currentKey();
    if (!phraseRecords.has(key) || !confirm(`Delete this phrase recording?`)) return;
    await useStore(PHRASE_STORE, "readwrite", store => store.delete(key));
  }
  await refreshAudio();
  setStatus(recordingVerseNumber() ? "Number recording deleted." : "Phrase recording deleted.");
});

dialog.addEventListener("close", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
});

const dragHandle = document.querySelector("#studioDragHandle");
dragHandle.addEventListener("pointerdown", event => {
  const rect = dialog.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  dragHandle.setPointerCapture(event.pointerId);

  const move = moveEvent => {
    const maxLeft = Math.max(0, window.innerWidth - dialog.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - 48);
    dialog.style.inset = `${Math.min(Math.max(0, moveEvent.clientY - offsetY), maxTop)}px auto auto ${Math.min(Math.max(0, moveEvent.clientX - offsetX), maxLeft)}px`;
  };
  const stop = () => {
    dragHandle.removeEventListener("pointermove", move);
    dragHandle.removeEventListener("pointerup", stop);
    dragHandle.removeEventListener("pointercancel", stop);
  };
  dragHandle.addEventListener("pointermove", move);
  dragHandle.addEventListener("pointerup", stop);
  dragHandle.addEventListener("pointercancel", stop);
});

refreshAudio().catch(error => setStatus(`Audio storage unavailable: ${error.message}`, true));
