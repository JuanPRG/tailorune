// popup/popup.js — the entire UI for Phase 2's vertical slice: paste a
// resume and a job description, tailor, get a .docx in Downloads.
//
// No bundling needed: this file only imports store.js (a relative,
// dependency-free module) plus the ambient `chrome` global — no bare npm
// specifiers, so MV3's native ES module loading handles it directly.

import { getSettings, setSettings } from '../engine/store.js';

const els = {
  resumeText: document.getElementById('resumeText'),
  resumeFile: document.getElementById('resumeFile'),
  jobDescription: document.getElementById('jobDescription'),
  provider: document.getElementById('provider'),
  modelName: document.getElementById('modelName'),
  apiKey: document.getElementById('apiKey'),
  tailorBtn: document.getElementById('tailorBtn'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
};

async function restoreSettings() {
  const settings = await getSettings();
  if (!settings) return;
  if (settings.provider) els.provider.value = settings.provider;
  if (settings.model) els.modelName.value = settings.model;
  if (settings.apiKey) els.apiKey.value = settings.apiKey;
}

function setStatus(text) {
  els.status.textContent = text;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

async function onTailorClick() {
  const resumeText = els.resumeText.value.trim();
  const jobDescription = els.jobDescription.value.trim();
  const providerId = els.provider.value;
  const modelName = els.modelName.value.trim();
  const apiKey = els.apiKey.value.trim();
  const file = els.resumeFile.files[0];

  if (!resumeText && !file) { setStatus('Paste your resume or upload a file first.'); return; }
  if (!jobDescription) { setStatus('Paste the job description first.'); return; }
  if (!apiKey) { setStatus('Enter an API key first.'); return; }

  let resumeFileBase64;
  let resumeFileExt;
  if (file) {
    resumeFileExt = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    resumeFileBase64 = await readFileAsBase64(file);
  }

  await setSettings({ provider: providerId, model: modelName, apiKey });

  els.tailorBtn.disabled = true;
  setStatus('Tailoring... this can take up to a minute.');
  els.result.textContent = '';

  // llmBaseUrlOverride is a debug/testing affordance only: point at any
  // OpenAI-compatible endpoint (a local model, or a test double) instead of
  // the selected provider's real host. Normal usage never sets this --
  // Chrome always opens default_popup with no query string.
  const baseUrlOverride = new URLSearchParams(location.search).get('llmBaseUrlOverride') || undefined;

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'sw',
      type: 'tailor:run',
      payload: { resumeText, resumeFileBase64, resumeFileExt, jobDescription, providerId, apiKey, modelName, baseUrlOverride },
    });
    els.result.textContent = JSON.stringify(response);
    if (response && response.ok) {
      setStatus(`Done — ${response.wordCount} words. Check your Downloads folder.`);
    } else {
      setStatus(`Failed: ${(response && response.error) || 'unknown error'}`);
    }
  } catch (err) {
    setStatus(`Failed: ${err && err.message ? err.message : err}`);
    els.result.textContent = JSON.stringify({ ok: false, error: String(err) });
  } finally {
    els.tailorBtn.disabled = false;
  }
}

els.tailorBtn.addEventListener('click', onTailorClick);
restoreSettings();
