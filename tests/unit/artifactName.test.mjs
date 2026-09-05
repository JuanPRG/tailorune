// artifactName.test.mjs — the name on the file the user actually sends out.
//
// Two hard limits meet here. Applicant tracking systems truncate or reject
// long filenames, and a person tailoring for three companies in an afternoon
// needs to tell the three files apart. Every case below is one or the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactName } from '../../extension/engine/artifactName.js';

/** A fixed date, so the stamp in every expectation is stable. */
const AT = new Date(2026, 8, 5, 14, 30).getTime();
const name = (opts) => artifactName({ kind: 'resume', ext: '.docx', at: AT, ...opts });

test('the name says who, where and when', () => {
  assert.equal(
    name({ candidateName: 'Juan Rivera', employer: 'Acme Corp' }),
    'Juan_Rivera_Acme_Corp_Resume_0905.docx',
  );
});

test('cover letters are labelled Cover, and the word "tailored" is gone', () => {
  const n = name({ candidateName: 'Juan Rivera', employer: 'Acme Corp', kind: 'cover', ext: '.pdf' });
  assert.equal(n, 'Juan_Rivera_Acme_Corp_Cover_0905.pdf');
  assert.doesNotMatch(n, /tailored/i);
});

test('a run names its resume and its cover letter for the same moment', () => {
  // They are rendered seconds apart; one started at 23:59:58 must not hand
  // the user two files stamped different days.
  const at = new Date(2026, 8, 5, 23, 59, 58).getTime();
  const args = { candidateName: 'Juan Rivera', employer: 'Acme', at };
  assert.equal(
    artifactName({ ...args, kind: 'resume', ext: '.docx' }).slice(-9),
    artifactName({ ...args, kind: 'cover', ext: '.docx' }).slice(-9),
  );
});

test('two employers on the same day produce different names', () => {
  assert.notEqual(
    name({ candidateName: 'Juan Rivera', employer: 'Acme Corp' }),
    name({ candidateName: 'Juan Rivera', employer: 'Northwind' }),
  );
});

// --- ASCII, because the destination is an upload form ----------------------

test('accents are stripped rather than escaped', () => {
  assert.equal(
    name({ candidateName: 'José García', employer: 'Nestlé' }),
    'Jose_Garcia_Nestle_Resume_0905.docx',
  );
});

test('letters NFKD cannot decompose are transliterated, not dropped', () => {
  // "Łukasz" came out as "Ukasz". Mangling someone's name on the file they
  // are about to send an employer is a bad way to be short.
  assert.match(name({ candidateName: 'Łukasz Kowalski' }), /^Lukasz_Kowalski_/);
  assert.match(name({ candidateName: 'Ana Muñoz', employer: 'Ørsted' }), /_Orsted_/);
  assert.match(name({ candidateName: 'Jürgen Weiß' }), /^Jurgen_Weiss_/);
});

test('every byte of every name is plain ASCII', () => {
  for (const candidateName of ['Łukasz', 'José', 'Ana Muñoz', '陳大文', 'Ægir Þór']) {
    const out = name({ candidateName, employer: 'Ørsted Æ/S' });
    for (const ch of out) {
      assert.ok(ch.codePointAt(0) < 128, `non-ASCII ${JSON.stringify(ch)} in ${out}`);
    }
    assert.doesNotMatch(out, /[^A-Za-z0-9_.]/, out);
  }
});

test('a name with nothing ASCII left still yields a usable file', () => {
  const out = name({ candidateName: '陳大文', employer: '株式会社' });
  assert.equal(out, 'Resume_0905.docx');
});

// --- short, because ATS parsers are the audience ---------------------------

test('long names are cut at a word boundary, never mid-word', () => {
  // "Northwind_Sys" reads like corruption; dropping the word that would not
  // fit reads like a choice. Assert it word by word rather than by pattern --
  // a substring check calls the legitimately-kept "International" a truncated
  // "Interna".
  const candidateName = 'Bartholomew Fitzgerald Wellington';
  const employer = 'International Business Machines';
  const out = name({ candidateName, employer });

  const whole = new Set([...`${candidateName} ${employer}`.split(' '), 'Resume', '0905']);
  for (const part of out.replace('.docx', '').split('_')) {
    assert.ok(whole.has(part), `"${part}" is not a whole word from the input: ${out}`);
  }
  assert.ok(out.length <= 60, `${out.length} chars`);
});

test('a leading "The" is dropped so the identifying word survives', () => {
  // "The New York Times" would otherwise cap at "The_New_York".
  assert.match(name({ candidateName: 'Ana Diaz', employer: 'The New York Times' }), /_New_York_Times_/);
});

test('no name stays under the cap regardless of how long the inputs are', () => {
  const out = name({
    candidateName: 'Maximilian Alexander Konstantin von Habsburg-Lothringen',
    employer: 'Pricewaterhousecoopers International Limited Partnership',
    kind: 'cover',
  });
  assert.ok(out.length <= 60, `${out.length} chars: ${out}`);
});

// --- the fields are frequently missing -------------------------------------

test('a missing employer leaves a name that still works', () => {
  assert.equal(name({ candidateName: 'Juan Rivera' }), 'Juan_Rivera_Resume_0905.docx');
  assert.equal(name({ candidateName: 'Juan Rivera', employer: '   ' }), 'Juan_Rivera_Resume_0905.docx');
});

test('missing everything still names a file, and never a bare extension', () => {
  for (const args of [{}, { candidateName: null, employer: undefined }, { candidateName: '!!!' }]) {
    const out = name(args);
    assert.equal(out, 'Resume_0905.docx');
    assert.ok(!out.startsWith('.') && !out.startsWith('_'), out);
  }
});

test('the stamp is zero-padded, so names sort', () => {
  const out = name({ candidateName: 'Juan Rivera', at: new Date(2026, 0, 7).getTime() });
  assert.match(out, /_0107\.docx$/);
});
