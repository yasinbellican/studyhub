// AI multiple-choice question generation with Claude.
// Needs ANTHROPIC_API_KEY in .env. Set MOCK_AI=1 to test without a key.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Short topic / chapter name this question tests' },
          question: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' }, description: 'Exactly 4 answer options' },
          answer_index: { type: 'integer', description: '0-based index of the correct choice' },
          explanation: { type: 'string', description: 'Why the answer is correct, 1-3 sentences' },
        },
        required: ['topic', 'question', 'choices', 'answer_index', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

function aiAvailable() {
  return !!process.env.ANTHROPIC_API_KEY || process.env.MOCK_AI === '1';
}

function mockQuestions(count) {
  return Array.from({ length: count }, (_, i) => ({
    topic: i % 2 ? 'Mock Topic B' : 'Mock Topic A',
    question: `Mock question #${i + 1}: which option is correct?`,
    choices: ['Option A', 'Option B', 'Option C', 'Option D'],
    answer_index: i % 4,
    explanation: 'This is a mock question (MOCK_AI=1).',
  }));
}

/**
 * material: row from materials table; fileData: Buffer with the uploaded file (or null for text notes)
 * existing: array of existing question strings for this material (to avoid duplicates)
 */
async function generateMCQs({ material, fileData, count = 10, difficulty = 'mixed', focus = '', existing = [] }) {
  if (process.env.MOCK_AI === '1') return mockQuestions(count);
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('AI is not configured. Add ANTHROPIC_API_KEY to the .env file and restart the server.');
    err.status = 503;
    throw err;
  }

  const client = new Anthropic();
  const content = [];

  if (material.kind === 'pdf') {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: fileData.toString('base64') },
      title: material.title,
    });
  } else if (material.kind === 'image') {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: material.mime, data: fileData.toString('base64') },
    });
  } else {
    content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: material.body }, title: material.title });
  }

  let instructions =
    `Create ${count} multiple-choice questions that test understanding of the study material above, so a student can practise until they master it.\n` +
    `- Difficulty: ${difficulty}.\n` +
    `- Each question has exactly 4 plausible choices with one correct answer; vary the position of the correct answer.\n` +
    `- Cover the whole material, not just the start. Prefer conceptual understanding and application over trivia.\n` +
    `- Base every question only on the material. Use the material's own language (if the notes are in Turkish, write in Turkish).\n` +
    `- The topic field should name the chapter/section the question comes from, consistently.`;
  if (focus) instructions += `\n- Focus especially on: ${focus}`;
  if (existing.length) {
    instructions += `\n- Do not repeat these existing questions:\n` + existing.slice(0, 80).map((q) => `  * ${q}`).join('\n');
  }
  content.push({ type: 'text', text: instructions });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: QUESTION_SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    const err = new Error('The AI declined to generate questions for this material.');
    err.status = 422;
    throw err;
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err = new Error('The AI returned an unexpected format. Please try again.');
    err.status = 502;
    throw err;
  }
  return parsed.questions.filter(
    (q) => Array.isArray(q.choices) && q.choices.length >= 2 && q.answer_index >= 0 && q.answer_index < q.choices.length
  );
}

module.exports = { generateMCQs, aiAvailable };
