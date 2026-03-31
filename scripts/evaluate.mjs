import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FETCH_TIMEOUT_MS = 20000;
const MAX_TEXT_BYTES = 250_000;

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

async function fetchText(url, { maxBytes = MAX_TEXT_BYTES } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'AIDiscoveryBot/1.0 (+https://github.com)'
      }
    });

    const finalUrl = res.url || url;
    const contentType = res.headers.get('content-type') || '';

    const buf = Buffer.from(await res.arrayBuffer());
    const sliced = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    const text = sliced.toString('utf8');

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: finalUrl,
      contentType,
      bytes: buf.length,
      truncated: buf.length > maxBytes,
      text
    };
  } finally {
    clearTimeout(t);
  }
}

function extractCandidateLinks(html, baseUrl) {
  const out = new Set();
  const patterns = [
    /href\s*=\s*"([^"]+)"/gi,
    /href\s*=\s*'([^']+)'/gi
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = (m[1] || '').trim();
      if (!raw) continue;
      if (raw.startsWith('javascript:')) continue;
      if (raw.startsWith('#')) continue;
      try {
        out.add(new URL(raw, baseUrl).toString());
      } catch {
        // ignore
      }
    }
  }

  // Also scan raw HTML for explicit absolute URLs.
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    const u = (m[0] || '').trim();
    if (!u) continue;
    try {
      out.add(new URL(u).toString());
    } catch {
      // ignore
    }
  }

  return Array.from(out);
}

function isLlmsArtifactUrl(u) {
  const lower = u.toLowerCase();
  return lower.endsWith('/llms.txt') || lower.endsWith('/llms-full.txt') || lower.includes('llms.txt') || lower.includes('llms-full.txt');
}

function summarizeTextFile(text) {
  const lines = text.split(/\r?\n/);
  return {
    lineCount: lines.length,
    head: lines.slice(0, 40).join('\n')
  };
}

async function discoverLlmsArtifactsControl({ websiteUrl, docsUrl }) {
  const sources = [websiteUrl, docsUrl].filter(Boolean);
  const discovered = {
    llms_txt: { discoveredFrom: [], candidates: [], fetched: [] },
    llms_full_txt: { discoveredFrom: [], candidates: [], fetched: [] }
  };

  for (const src of sources) {
    let page;
    try {
      page = await fetchText(src);
    } catch (e) {
      console.error(`[control][llms] failed to fetch landing page: ${src} :: ${String(e?.message || e)}`);
      discovered.llms_txt.discoveredFrom.push({ url: src, ok: false, error: String(e?.message || e) });
      discovered.llms_full_txt.discoveredFrom.push({ url: src, ok: false, error: String(e?.message || e) });
      continue;
    }

    const baseUrl = page.url || src;
    discovered.llms_txt.discoveredFrom.push({ url: baseUrl, ok: page.ok, status: page.status });
    discovered.llms_full_txt.discoveredFrom.push({ url: baseUrl, ok: page.ok, status: page.status });

    if (!page.ok || !page.text) continue;

    const links = extractCandidateLinks(page.text, baseUrl).filter(isLlmsArtifactUrl);
    for (const u of links) {
      const lower = u.toLowerCase();
      if (lower.includes('llms-full.txt')) discovered.llms_full_txt.candidates.push(u);
      if (lower.includes('llms.txt') && !lower.includes('llms-full.txt')) discovered.llms_txt.candidates.push(u);
    }
  }

  // Dedup candidates preserving order.
  for (const key of ['llms_txt', 'llms_full_txt']) {
    const seen = new Set();
    discovered[key].candidates = discovered[key].candidates.filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  }

  for (const key of ['llms_txt', 'llms_full_txt']) {
    for (const u of discovered[key].candidates) {
      try {
        const file = await fetchText(u, { maxBytes: 200_000 });
        const summary = file.text ? summarizeTextFile(file.text) : { lineCount: 0, head: '' };
        if (!file.ok) {
          console.warn(`[control][llms] fetched candidate not ok: ${file.status} ${file.statusText} :: ${file.url || u}`);
        }
        discovered[key].fetched.push({
          url: file.url || u,
          ok: file.ok,
          status: file.status,
          contentType: file.contentType,
          bytes: file.bytes,
          truncated: file.truncated,
          lineCount: summary.lineCount,
          head: summary.head
        });
      } catch (e) {
        console.error(`[control][llms] failed to fetch candidate: ${u} :: ${String(e?.message || e)}`);
        discovered[key].fetched.push({ url: u, ok: false, error: String(e?.message || e) });
      }
    }
  }

  return discovered;
}

async function openaiResponsesJson({ apiKey, model, tools, schemaName, schema, prompt }) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      tools,
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          schema,
          strict: true
        }
      },
      input: prompt
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Responses request failed: ${res.status} ${res.statusText}\n${text}`);
  }

  const data = await res.json();
  const outputText = data?.output_text;
  if (!outputText) throw new Error('OpenAI Responses returned empty output_text');

  try {
    return JSON.parse(outputText);
  } catch (e) {
    throw new Error(`Failed to parse JSON from OpenAI Responses. Content:\n${outputText}`);
  }
}

async function discoverLlmsArtifactsAi({ apiKey, model, companyName, websiteUrl, docsUrl }) {
  const schema = {
    type: 'object',
    properties: {
      llms_txt: {
        type: 'object',
        properties: {
          exists: { type: 'boolean' },
          url: { type: 'string' },
          how_found: { type: 'string' },
          spec_compliant: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
          score: { type: 'number' }
        },
        required: ['exists', 'url', 'how_found', 'spec_compliant', 'issues', 'score'],
        additionalProperties: false
      },
      llms_full_txt: {
        type: 'object',
        properties: {
          exists: { type: 'boolean' },
          url: { type: 'string' },
          how_found: { type: 'string' },
          spec_compliant: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
          score: { type: 'number' }
        },
        required: ['exists', 'url', 'how_found', 'spec_compliant', 'issues', 'score'],
        additionalProperties: false
      }
    },
    required: ['llms_txt', 'llms_full_txt'],
    additionalProperties: false
  };

  const prompt = [
    `You are simulating an agent trying to discover LLM entrypoint artifacts for ${companyName} without being handed the URLs.`,
    `Starting points:`,
    `- Website: ${websiteUrl}`,
    `- Docs: ${docsUrl}`,
    '',
    'Task:',
    '- Determine whether an official llms.txt exists for this company.',
    '- Determine whether an official llms-full.txt exists for this company.',
    '- Use web search to find the most canonical URL(s) if they exist.',
    '- Assess basic spec compliance and note any issues (format, scope, stale links, unclear doc roots, etc.).',
    '',
    'Output requirements:',
    '- If you cannot confirm existence, set exists=false and url="" and explain briefly in how_found.',
    '- Use how_found to describe the discovery path (query + which result or which page linked it).',
    '- Use score as your quality score from 0-10 for the artifact itself (not the whole company).'
  ].join('\n');

  return openaiResponsesJson({
    apiKey,
    model,
    tools: [{ type: 'web_search_preview' }],
    schemaName: 'llms_artifact_discovery',
    schema,
    prompt
  });
}

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
  const responsesModel = process.env.OPENAI_RESPONSES_MODEL || 'gpt-4o';

  const schemaHint = `Return JSON in this exact shape:\n{\n  "criteria": [\n    {"id": "<criteria_id>", "score": <0-10 number>, "analysis": "...", "evidence": ["..."], "advice": ["..."]}\n  ],\n  "overallSummary": "..."\n}`;

  const allCompanyReports = [];

  for (const company of COMPANIES) {
    console.log(`\n=== ${company.name} (${company.id}) ===`);
    const controlDiscovery = await discoverLlmsArtifactsControl({ websiteUrl: company.website, docsUrl: company.docs });
    console.log(`[control][llms] llms.txt candidates: ${JSON.stringify(controlDiscovery.llms_txt.candidates)}`);
    console.log(`[control][llms] llms-full.txt candidates: ${JSON.stringify(controlDiscovery.llms_full_txt.candidates)}`);

    let aiDiscovery = null;
    let aiDiscoveryError = null;
    try {
      aiDiscovery = await discoverLlmsArtifactsAi({
        apiKey,
        model: responsesModel,
        companyName: company.name,
        websiteUrl: company.website,
        docsUrl: company.docs
      });
      console.log(`[ai][llms] results: ${JSON.stringify(aiDiscovery)}`);
    } catch (e) {
      aiDiscoveryError = String(e?.message || e);
      console.error(`[ai][llms] error: ${aiDiscoveryError}`);
    }

    const prompt = [
      `Evaluate AI Machine Discoverability for ${company.name}.`,
      `Focus on how well automated agents and LLM-based systems can discover, parse, and operate on ${company.name} from public web signals and agent interfaces.`,
      `Consider BOTH marketing site and documentation, plus agent-facing artifacts when relevant:`,
      `- Website: ${company.website}`,
      `- Docs: ${company.docs}`,
      '',
      'Experiments (ground truth / control + AI):',
      'Control discovery = link-based discovery from the Website/Docs landing pages, then fetch discovered URLs.',
      `Control llms.txt candidates: ${JSON.stringify(controlDiscovery.llms_txt.candidates)}`,
      `Control llms.txt fetched: ${JSON.stringify(controlDiscovery.llms_txt.fetched.map(x => ({ url: x.url, ok: x.ok, status: x.status, bytes: x.bytes, lineCount: x.lineCount, contentType: x.contentType })))}`,
      `Control llms-full.txt candidates: ${JSON.stringify(controlDiscovery.llms_full_txt.candidates)}`,
      `Control llms-full.txt fetched: ${JSON.stringify(controlDiscovery.llms_full_txt.fetched.map(x => ({ url: x.url, ok: x.ok, status: x.status, bytes: x.bytes, lineCount: x.lineCount, contentType: x.contentType })))}`,
      `AI discovery (web search) results: ${aiDiscovery ? JSON.stringify(aiDiscovery) : `null (error: ${aiDiscoveryError || 'unknown'})`}`,
      '',
      'Score each criteria id from 0-10.',
      'For each criterion include:',
      '- analysis: what likely exists / how strong it is',
      '- evidence: verification steps and concrete URLs',
      '- advice: concrete next improvements',
      'If you are uncertain, say so in analysis and give a verification step in evidence.',
      'Be consistent across companies and focus on actionability.',
      '',
      'Special requirements for llms_txt and llms_full_txt:',
      '- Evidence MUST include the specific URLs found by the experiments above (control and/or AI), or explicitly state "not found" and list what was checked.',
      '- Do not list generic product or docs landing pages as evidence for llms_txt/llms_full_txt unless they directly link to the artifact.',
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
      experiments: {
        llmsArtifacts: {
          control: controlDiscovery,
          ai: aiDiscovery,
          aiError: aiDiscoveryError
        }
      },
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
