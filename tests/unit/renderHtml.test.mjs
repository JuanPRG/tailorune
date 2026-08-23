import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResumeHtml } from '../../extension/engine/renderHtml.js';

function sampleModel() {
  return {
    name: 'José García',
    contact: 'Toronto, ON\njose@example.com',
    summary: 'A summary.',
    skills: { heading: 'SKILLS', lines: ['SQL, Python'] },
    sections: [
      { kind: 'experience', heading: 'EXPERIENCE', entries: [{ title: 'Engineer', meta: 'Jan 2023 - Present', bullets: ['Did a thing.'] }] },
      { kind: 'education', heading: 'EDUCATION', lines: ['Diploma, Seneca'] },
    ],
  };
}

test('renderResumeHtml includes every field and preserves Unicode', () => {
  const html = renderResumeHtml(sampleModel());
  assert.match(html, /José García/);
  assert.match(html, /jose@example\.com/);
  assert.match(html, /Did a thing\./);
  assert.match(html, /Diploma, Seneca/);
});

test('renderResumeHtml escapes HTML-significant characters in resume content (XSS boundary)', () => {
  const model = sampleModel();
  model.summary = '<script>alert(1)</script> & "quoted"';
  const html = renderResumeHtml(model);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear unescaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('renderResumeHtml includes the headers-and-footers print hint', () => {
  const html = renderResumeHtml(sampleModel());
  assert.match(html, /Headers and footers/);
});

test('renderResumeHtml sets @page margin to 0.75in, matching the verified DOCX/print template', () => {
  const html = renderResumeHtml(sampleModel());
  assert.match(html, /@page\s*\{\s*size:\s*letter;\s*margin:\s*0\.75in/);
});

test('renderResumeHtml omits the skills block entirely when there are no skills', () => {
  const model = sampleModel();
  model.skills = null;
  const html = renderResumeHtml(model);
  assert.ok(!html.includes('<h2>SKILLS</h2>'));
});
