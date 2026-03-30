import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const COMPANIES = [
  { id: 'supabase', name: 'Supabase', website: 'https://supabase.com', docs: 'https://supabase.com/docs' },
  { id: 'neon', name: 'Neon', website: 'https://neon.tech', docs: 'https://neon.tech/docs' },
  { id: 'pinecone', name: 'Pinecone', website: 'https://www.pinecone.io', docs: 'https://docs.pinecone.io' },
  { id: 'databricks', name: 'Databricks', website: 'https://www.databricks.com', docs: 'https://docs.databricks.com' },
  { id: 'redis', name: 'Redis', website: 'https://redis.io', docs: 'https://redis.io/docs/latest/' },
  { id: 'clickhouse', name: 'ClickHouse', website: 'https://clickhouse.com', docs: 'https://clickhouse.com/docs' },
  { id: 'mongodb', name: 'MongoDB', website: 'https://www.mongodb.com', docs: 'https://www.mongodb.com/docs' },
  { id: 'couchbase', name: 'Couchbase', website: 'https://www.couchbase.com', docs: 'https://docs.couchbase.com' }
];

const CRITERIA = [
  {
    id: 'llms_txt',
    name: 'llms.txt',
    weight: 3
  },
  {
    id: 'mcp_server',
    name: 'MCP Server',
    weight: 3
  },
  {
    id: 'robots_txt_ai_optimization',
    name: 'robots.txt AI Optimization',
    weight: 3
  },
  {
    id: 'llms_full_txt',
    name: 'llms-full.txt',
    weight: 2
  },
  {
    id: 'markdown_native_docs',
    name: 'Markdown-Native Docs',
    weight: 2
  },
  {
    id: 'structured_faq_jsonld',
    name: 'Structured FAQ (JSON-LD)',
    weight: 2
  },
  {
    id: 'html_parse_efficiency',
    name: 'HTML Parse Efficiency',
    weight: 1
  },
  {
    id: 'live_agent_environment',
    name: 'Live Agent Environment',
    weight: 1
  },
  {
    id: 'training_data_surface',
    name: 'Training Data Surface',
    weight: 1
  }
];

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
}

function encryptJson({ json, password }) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(json), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: 310000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

async function openaiJson({ apiKey, model, schemaHint, prompt }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            'You are an expert at evaluating AI/product discoverability for developer platforms.',
            'Return ONLY valid JSON and strictly follow the requested shape.'
          ].join('\n')
        },
        {
          role: 'user',
          content: `${schemaHint}\n\n${prompt}`
        }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI request failed: ${res.status} ${res.statusText}\n${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse JSON from OpenAI. Content:\n${content}`);
  }
}

function validateScores(companyId, obj) {
  if (!obj || typeof obj !== 'object') throw new Error(`Invalid JSON object for ${companyId}`);
  if (!Array.isArray(obj.criteria)) throw new Error(`Missing criteria array for ${companyId}`);
  const criteriaById = new Map(CRITERIA.map(c => [c.id, c]));

  for (const item of obj.criteria) {
    if (!item || typeof item !== 'object') throw new Error(`Invalid criteria item for ${companyId}`);
    if (!criteriaById.has(item.id)) throw new Error(`Unknown criteria id for ${companyId}: ${item.id}`);
    if (typeof item.score !== 'number' || item.score < 0 || item.score > 10) {
      throw new Error(`Invalid score for ${companyId}/${item.id}: ${item.score}`);
    }
    if (typeof item.analysis !== 'string') throw new Error(`Missing analysis for ${companyId}/${item.id}`);
    if (!Array.isArray(item.advice)) throw new Error(`Missing advice for ${companyId}/${item.id}`);
    if (!Array.isArray(item.evidence)) throw new Error(`Missing evidence for ${companyId}/${item.id}`);
  }

  return obj;
}

function computeTotals(companyReport) {
  const weights = new Map(CRITERIA.map(c => [c.id, c.weight]));
  const weighted = companyReport.criteria.reduce((acc, c) => {
    const w = weights.get(c.id) ?? 0;
    return acc + (c.score * w);
  }, 0);

  const weightSum = CRITERIA.reduce((a, c) => a + c.weight, 0);
  const total10 = weightSum === 0 ? 0 : weighted / weightSum;
  return {
    totalScore10: Math.round(total10 * 100) / 100,
    totalScore100: Math.round(total10 * 10 * 100) / 100
  };
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const apiKey = requiredEnv('OPENAI_API_KEY');
  const reportPassword = requiredEnv('REPORT_PASSWORD');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const schemaHint = `Return JSON in this exact shape:\n{\n  "criteria": [\n    {"id": "<criteria_id>", "score": <0-10 number>, "analysis": "...", "evidence": ["..."], "advice": ["..."]}\n  ],\n  "overallSummary": "..."\n}`;

  const allCompanyReports = [];

  for (const company of COMPANIES) {
    const prompt = [
      `Evaluate AI Machine Discoverability for ${company.name}.`,
      `Focus on how well automated agents and LLM-based systems can discover, parse, and operate on ${company.name} from public web signals and agent interfaces.`,
      `Consider BOTH marketing site and documentation, plus agent-facing artifacts when relevant:`,
      `- Website: ${company.website}`,
      `- Docs: ${company.docs}`,
      '',
      'Score each criteria id from 0-10.',
      'For each criterion include:',
      '- analysis: what likely exists / how strong it is',
      '- evidence: high-level signals or likely URLs to check',
      '- advice: concrete next improvements',
      'If you are uncertain, say so in analysis and give a verification step in evidence.',
      'Be consistent across companies and focus on actionability.',
      '',
      `Criteria IDs (must include all): ${CRITERIA.map(c => c.id).join(', ')}`
    ].join('\n');

    const json = await openaiJson({ apiKey, model, schemaHint, prompt });
    const validated = validateScores(company.id, json);
    const totals = computeTotals(validated);

    allCompanyReports.push({
      company,
      criteria: validated.criteria,
      overallSummary: validated.overallSummary,
      ...totals
    });
  }

  const couchbase = allCompanyReports.find(r => r.company.id === 'couchbase');
  const couchbaseAdviceSchema = `Return JSON in this exact shape:\n{\n  "topFindings": ["..."],\n  "nextBestActions": [\n    {"title": "...", "impact": "high|medium|low", "effort": "high|medium|low", "why": "...", "how": ["..."]}\n  ],\n  "criteriaSpecificPlan": [\n    {"criteriaId": "<criteria_id>", "whatToDo": ["..."], "howToValidate": ["..."]}\n  ],\n  "measurements": ["..."]\n}`;

  const couchbaseAdvicePrompt = [
    'Given this Couchbase scorecard, propose the most salient next improvements for AI Machine Discoverability.',
    'Prioritize critical criteria (weight ×3) first, then high (×2), then standard (×1).',
    'Give advice that is actionable in 2-6 weeks and prioritizes highest impact.',
    '',
    `Couchbase totals: ${JSON.stringify({ totalScore10: couchbase?.totalScore10, totalScore100: couchbase?.totalScore100 })}`,
    `Criteria definitions: ${JSON.stringify(CRITERIA)}`,
    `Couchbase criteria: ${JSON.stringify(couchbase?.criteria ?? [])}`
  ].join('\n');

  const couchbaseAdvice = await openaiJson({
    apiKey,
    model,
    schemaHint: couchbaseAdviceSchema,
    prompt: couchbaseAdvicePrompt
  });

  const report = {
    generatedAt: nowIso(),
    model,
    criteria: CRITERIA,
    companies: allCompanyReports.sort((a, b) => b.totalScore10 - a.totalScore10),
    couchbaseAdvice
  };

  const encrypted = encryptJson({ json: report, password: reportPassword });

  const outDir = path.join(process.cwd(), 'docs', 'data');
  await fs.mkdir(outDir, { recursive: true });

  await fs.writeFile(path.join(outDir, 'report.encrypted.json'), JSON.stringify(encrypted, null, 2), 'utf8');

  // Metadata for UI
  await fs.writeFile(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        generatedAt: report.generatedAt,
        model: report.model,
        companies: report.companies.map(c => ({ id: c.company.id, name: c.company.name, totalScore10: c.totalScore10, totalScore100: c.totalScore100 })),
        reportSha256: sha256Hex(JSON.stringify(encrypted))
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`Wrote encrypted report to ${path.join(outDir, 'report.encrypted.json')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
