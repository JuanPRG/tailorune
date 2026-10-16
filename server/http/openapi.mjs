// server/http/openapi.mjs — the document Muse reads to build its client.
//
// M0 showed Muse builds its connector from this file and nothing else, so
// these descriptions ARE the agent's instructions. Kept short: every word here
// is read on every connector build.

const CONSTRAINT_FIELDS = {
  resume_notes: { type: 'string', maxLength: 800, description: 'Style guidance for the resume rewrite.' },
  cover_letter_notes: { type: 'string', maxLength: 800, description: 'Style guidance for the letter.' },
  preserve_points: { type: 'string', maxLength: 600, description: 'Points to keep.' },
  resume_density: { enum: ['concise', 'standard', 'detailed'] },
  keyword_alignment: { enum: ['light', 'balanced'] },
  emphasis_areas: {
    type: 'array',
    items: { enum: ['customer_facing', 'technical', 'leadership', 'operations', 'sales', 'project_management', 'data', 'process_improvement'] },
  },
  cover_letter_length: { enum: ['short', 'standard', 'long'] },
  cover_letter_tone: { enum: ['direct', 'warm', 'confident', 'formal'] },
};

const envelope = (data) => ({
  type: 'object',
  properties: { ok: { type: 'boolean' }, data, error: { type: ['string', 'null'] } },
});
const idParam = (name) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const bearer = [{ bearer: [] }];

const file = {
  type: 'object',
  properties: {
    kind: { enum: ['resume', 'resume_pdf', 'cover_letter', 'cover_letter_pdf'] },
    name: { type: 'string' },
    url: { type: 'string', description: 'GET with the same Bearer token. Expires after 24h.' },
    content_base64: { type: 'string', description: 'Only with ?inline=base64.' },
  },
};

const run = {
  type: 'object',
  properties: {
    run_id: { type: 'string' },
    status: { enum: ['queued', 'running', 'retrying', 'done', 'failed'] },
    attempts: { type: 'integer' },
    result: {
      type: ['object', 'null'],
      properties: {
        job: { type: 'object' },
        resume: { type: 'object', description: 'status, word_count, warnings, errors.' },
        cover_letter: {
          type: ['object', 'null'],
          description: 'status "failed" (with error) when only the letter could not be written; the resume '
            + 'files are still there. POST the same request again later to get the letter.',
        },
        cover_letter_text: { type: ['string', 'null'], description: 'Letter body as plain text, for form fields.' },
        files: { type: 'array', items: file },
        cached: { type: 'boolean', description: 'True when an identical earlier run was returned.' },
      },
    },
    error: { type: ['object', 'null'], properties: { kind: { type: 'string' }, message: { type: 'string' } } },
  },
};

export function openApiDocument(origin) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tailorune',
      version: '1.0.0',
      description: 'Tailors a stored resume and writes a cover letter for one job posting. '
        + 'Upload a resume once, then start runs by resume_id. Names, employers, titles, dates and '
        + 'education are copied unchanged; only wording is rewritten.',
    },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: bearer,
    paths: {
      '/v1/resumes': {
        post: {
          operationId: 'uploadResume',
          summary: 'Store a resume. Send text for .txt, content_base64 for .docx/.pdf (max 2 MB).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['filename'],
                  additionalProperties: false,
                  properties: {
                    filename: { type: 'string', description: 'Must end in .txt, .docx or .pdf.' },
                    text: { type: 'string' },
                    content_base64: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Stored.', content: { 'application/json': { schema: envelope({ type: 'object', properties: { resume_id: { type: 'string' }, name: { type: 'string' }, word_count: { type: 'integer' } } }) } } } },
        },
        get: { operationId: 'listResumes', summary: 'List stored resumes.', responses: { 200: { description: 'Resumes.' } } },
      },
      '/v1/resumes/{resume_id}': {
        delete: {
          operationId: 'deleteResume',
          summary: 'Delete a resume and every run, file and audit record made from it.',
          parameters: [idParam('resume_id')],
          responses: { 204: { description: 'Deleted.' } },
        },
      },
      '/v1/runs': {
        post: {
          operationId: 'startRun',
          summary: 'Tailor a resume for a job. Returns 202 with run_id; poll getRun. '
            + 'Set wait (seconds, max 120) to get the finished run in this response instead. '
            + 'An identical earlier request returns that run (cached: true).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['resume_id', 'job_title', 'employer', 'job_text'],
                  additionalProperties: false,
                  properties: {
                    resume_id: { type: 'string' },
                    job_title: { type: 'string' },
                    employer: { type: 'string' },
                    job_text: { type: 'string', description: 'The full job description.' },
                    constraints: { type: 'object', additionalProperties: false, properties: CONSTRAINT_FIELDS },
                    cover_letter: { type: 'boolean', default: true },
                    judge: { type: 'boolean', default: false, description: 'One extra model call to review the rewrite.' },
                    wait: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Finished within wait, or cached.', content: { 'application/json': { schema: envelope(run) } } },
            202: { description: 'Queued. Poll getRun.', content: { 'application/json': { schema: envelope(run) } } },
            429: { description: 'Daily run limit reached. See Retry-After.' },
          },
        },
      },
      '/v1/runs/{run_id}': {
        get: {
          operationId: 'getRun',
          summary: 'A run and, once done, its result. ?inline=base64 adds file bytes.',
          parameters: [idParam('run_id'), { name: 'inline', in: 'query', schema: { enum: ['base64'] } }],
          responses: { 200: { description: 'The run.', content: { 'application/json': { schema: envelope(run) } } } },
        },
      },
      '/v1/runs/{run_id}/audit': {
        get: {
          operationId: 'getRunAudit',
          summary: 'Inputs, outputs and models of a finished run, kept 12 months.',
          parameters: [idParam('run_id')],
          responses: { 200: { description: 'The audit record.' } },
        },
      },
      '/v1/files/{file_token}': {
        get: {
          operationId: 'downloadFile',
          summary: 'Download a generated .docx or .pdf. Use the url from a run result.',
          parameters: [idParam('file_token')],
          responses: { 200: { description: 'The file.' }, 404: { description: 'Unknown or expired.' } },
        },
      },
    },
  };
}
