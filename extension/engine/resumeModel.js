// resumeModel.js — the ResumeModel shape, and pure operations on it.
//
// The model separates LOCKED fields (name, contact, every entry's title/meta,
// the entire education section, skills for this phase) from EDITABLE fields
// (summary, and each experience/project entry's bullets). Locked fields are
// never sent to the LLM (see tailor.js) and are spliced back in verbatim —
// the same anti-fabrication guarantee hirepilot_v4/tailor.py enforces via
// "you are only shown the editable portions" (tailor.py:117-119), except here
// it is architectural: the model the LLM never sees cannot be echoed back
// wrong.
//
// Shape:
// {
//   name: string,
//   contact: string,               // raw lines, joined by "\n" — LOCKED
//   summary: string | null,        // EDITABLE
//   skills: { heading: string, lines: string[] } | null,  // LOCKED (phase 2)
//   sections: Array<
//     | { kind: 'experience'|'projects', heading: string, entries: Entry[] }
//     | { kind: 'education'|'other', heading: string, lines: string[] }     // LOCKED
//   >,
// }
// Entry = { title: string, meta: string|null, bullets: string[] }           // bullets EDITABLE

const WORD_RE = /\S+/g;

export function wordCount(text) {
  if (!text) return 0;
  const m = String(text).match(WORD_RE);
  return m ? m.length : 0;
}

/** Flat text of the whole model, for word-budget counting only — not a render. */
export function modelWordCount(model) {
  let total = wordCount(model.name) + wordCount(model.contact) + wordCount(model.summary);
  if (model.skills) total += wordCount(model.skills.heading) + model.skills.lines.reduce((s, l) => s + wordCount(l), 0);
  for (const section of model.sections) {
    total += wordCount(section.heading);
    if (section.entries) {
      for (const entry of section.entries) {
        total += wordCount(entry.title) + wordCount(entry.meta);
        total += entry.bullets.reduce((s, b) => s + wordCount(b), 0);
      }
    } else {
      total += section.lines.reduce((s, l) => s + wordCount(l), 0);
    }
  }
  return total;
}

/** Every experience/project entry across all sections, in document order, with a stable index. */
export function flattenEditableEntries(model) {
  const out = [];
  for (const section of model.sections) {
    if (!section.entries) continue;
    for (const entry of section.entries) {
      out.push({ index: out.length, title: entry.title, meta: entry.meta, bullets: entry.bullets });
    }
  }
  return out;
}

/**
 * Apply an LLM's tailored content back onto the model. Only `summary` and
 * `entries[].bullets` are accepted from `tailored` — anything else (an
 * attempt to rewrite a title, a date, the name) is ignored, not merely
 * "instructed against". If the LLM hallucinates keys we did not ask for,
 * this function structurally cannot apply them, because it never reads them.
 */
export function applyTailoredContent(model, tailored) {
  const next = structuredClone(model);
  if (typeof tailored.summary === 'string' && tailored.summary.trim()) {
    next.summary = tailored.summary.trim();
  }
  // Number() on the way in: a model that answers with "index": "0" instead of
  // 0 would otherwise miss every lookup, applying nothing and producing output
  // byte-identical to the input -- a silent no-op that looks exactly like a
  // model refusing to rewrite.
  const byIndex = new Map((tailored.entries || []).map((e) => [Number(e.index), e]));
  let flatIndex = 0;
  for (const section of next.sections) {
    if (!section.entries) continue;
    for (const entry of section.entries) {
      const patch = byIndex.get(flatIndex);
      if (patch && Array.isArray(patch.bullets) && patch.bullets.length) {
        entry.bullets = patch.bullets.map((b) => String(b).trim()).filter(Boolean);
      }
      flatIndex += 1;
    }
  }
  return next;
}

/**
 * Bring the model under `budgetWords` by dropping the least-important
 * content first: the last bullet of whichever entry currently has the most
 * bullets, repeated until under budget or nothing left to drop.
 *
 * Replaces hirepilot_v4/render.py's render -> count -> shrink -> re-render
 * loop (render.py:244-280, which can burn 4 real renders and then delete the
 * output on failure) with arithmetic — measured in SPIKE_FINDINGS.md to hold
 * at ~570 words for one page.
 */
export function compactToWordBudget(model, budgetWords, maxIterations = 20) {
  let next = model;
  let iterations = 0;
  while (modelWordCount(next) > budgetWords && iterations < maxIterations) {
    const entries = flattenEditableEntries(next);
    let target = null;
    for (const e of entries) {
      if (e.bullets.length > 0 && (!target || e.bullets.length > target.bullets.length)) target = e;
    }
    if (!target) break; // nothing left we're willing to drop
    next = structuredClone(next);
    let flatIndex = 0;
    outer: for (const section of next.sections) {
      if (!section.entries) continue;
      for (const entry of section.entries) {
        if (flatIndex === target.index) {
          entry.bullets.pop();
          break outer;
        }
        flatIndex += 1;
      }
    }
    iterations += 1;
  }
  return { model: next, wordCount: modelWordCount(next), iterations };
}
