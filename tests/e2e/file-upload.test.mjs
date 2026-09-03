// file-upload.test.mjs — Phase 5 slice: upload a real .docx or .pdf resume
// through the actual popup file input (not pasted text), and prove the same
// locked-field/tailored-content guarantees hold through extraction too.
//
// Uses the user's own real resume.docx and its PDF export as fixtures
// (tests/fixtures/resumes/juan-rivera.{docx,pdf}) rather than synthetic
// files, per the standing instruction to use the user's core resumes as
// test material, not migrated user data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BROWSER } from './browser.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { startMockLlmServer } from './mockLlmServer.mjs';
import { getExtensionServiceWorker, docxTextOf, waitForCompletedDownload, fillApiKey } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

const MOCKED_SUMMARY = 'TAILORED SUMMARY via uploaded file.';
const MOCKED_BULLETS = ['TAILORED BULLET A.', 'TAILORED BULLET B.'];

async function runUploadScenario(t, fixtureFilename) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-upload-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });

  const mockLlm = await startMockLlmServer(() => ({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: MOCKED_SUMMARY,
          entries: Array.from({ length: 6 }, (_, index) => ({ index, bullets: MOCKED_BULLETS })),
        }),
      },
    }],
  }));

  t.after(async () => {
    await context.close();
    await mockLlm.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const sw = await getExtensionServiceWorker(context);
  const extensionId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html?llmBaseUrlOverride=${encodeURIComponent(mockLlm.url)}`);

  await page.setInputFiles('#resumeFile', path.resolve(__dirname, '../fixtures/resumes', fixtureFilename));
  await page.fill('#jobDescription', 'Seeking a backend engineer experienced with Python and AWS.');
  await page.selectOption('#provider', 'gemini');
  await fillApiKey(page);
  await page.uncheck('#includeCoverLetter');
  await page.click('#tailorBtn');

  await page.waitForFunction(() => {
    const el = document.getElementById('result');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 20000 });

  const resultJson = JSON.parse(await page.textContent('#result'));
  assert.equal(resultJson.ok, true, `expected ok:true for ${fixtureFilename}, got ${JSON.stringify(resultJson)}`);

  const resumeDownload = resultJson.downloads.find((d) => d.kind === 'resume');
  const downloadItem = await waitForCompletedDownload(sw, resumeDownload.downloadId);
  const buffer = readFileSync(downloadItem.filename);
  const text = await docxTextOf(buffer);

  assert.ok(text.includes(MOCKED_SUMMARY), `tailored summary missing for ${fixtureFilename}`);
  assert.ok(text.includes('Juan Rivera'), `locked name missing for ${fixtureFilename}`);
  assert.ok(text.includes('Seneca Polytechnic'), `locked education missing for ${fixtureFilename}`);
}

test('uploading a real .docx resume (with Word-native bulleted lists) tailors correctly end to end', async (t) => {
  await runUploadScenario(t, 'juan-rivera.docx');
});

test('uploading a real .pdf resume tailors correctly end to end', async (t) => {
  await runUploadScenario(t, 'juan-rivera.pdf');
});
