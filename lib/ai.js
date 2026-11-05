// AI assistant features powered by Claude (official Anthropic SDK). Enabled when ANTHROPIC_API_KEY is set.
const { bad } = require('./util');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const enabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
let client;
function getClient() {
  if (!enabled()) bad('AI is not configured — set ANTHROPIC_API_KEY on the server', 501);
  if (!client) { const Anthropic = require('@anthropic-ai/sdk').default; client = new Anthropic(); }
  return client;
}

// One structured call: returns the parsed JSON object matching `schema`.
async function ask(system, prompt, schema) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema');
  let res;
  try {
    res = await getClient().beta.messages.parse({
      model: MODEL, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', // reroute on a safety-classifier decline
      output_config: { effort: 'medium', format: jsonSchemaOutputFormat(schema) },
      system, messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) bad('AI is misconfigured (invalid API key)', 502);
    if (e instanceof Anthropic.RateLimitError) bad('AI is busy — try again in a moment', 503);
    if (e instanceof Anthropic.APIError) bad(`AI request failed (${e.status})`, 502);
    throw e;
  }
  if (res.stop_reason === 'refusal') bad('The AI declined this request', 422);
  if (!res.parsed_output) bad('AI returned an unexpected response', 502);
  return res.parsed_output;
}

const SYSTEM = 'You are a sales assistant inside a CRM. Be concise, specific and practical. Never invent facts that are not in the provided CRM data; if information is missing, say so.';
const obj = (props, req = Object.keys(props)) => ({ type: 'object', properties: props, required: req, additionalProperties: false });

function draftEmail({ sender, contact, company, deal, recent, instructions }) {
  return ask(SYSTEM + ' Write plain-text sales emails: short, human, no hype, one clear call to action, signed with the sender name.',
    `Draft an email from ${sender.name} to ${contact.name}${contact.title ? ` (${contact.title})` : ''}${company ? ` at ${company.name}` : ''}.
Goal / instructions from the rep: ${instructions || 'a helpful follow-up that moves the conversation forward'}
${deal ? `Related deal: ${deal.title}, value ${deal.value}, stage ${deal.stage_name}.` : ''}
Recent interactions (newest first):
${recent || '(none)'}`,
    obj({ subject: { type: 'string' }, body: { type: 'string' } }));
}
function summarize({ kind, record, recent }) {
  return ask(SYSTEM, `Summarize this ${kind} for a sales rep, assess risk, and recommend concrete next steps.
Record: ${JSON.stringify(record)}
Timeline (newest first):
${recent || '(no activity yet)'}`,
    obj({ summary: { type: 'string' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] }, risk_reason: { type: 'string' }, next_steps: { type: 'array', items: { type: 'string' } } }));
}
function enrichCompany({ name, domain, pageText }) {
  return ask(SYSTEM, `From this company's homepage text, extract firmographics. Company: ${name} (${domain}).
Homepage text:
${pageText.slice(0, 15000)}`,
    obj({ industry: { type: 'string' }, size: { type: 'string', description: 'Employee range estimate like 1-10, 11-50, 51-200, 201-1000, 1000+ or unknown' },
      description: { type: 'string', description: 'One or two sentences on what they do' } }));
}
function summarizeCall({ notes }) {
  return ask(SYSTEM, `Turn these raw call notes into a clean call summary with action items.\n${notes}`,
    obj({ summary: { type: 'string' }, action_items: { type: 'array', items: { type: 'string' } } }));
}

module.exports = { enabled, draftEmail, summarize, enrichCompany, summarizeCall, MODEL };
