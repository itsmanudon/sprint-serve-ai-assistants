// Spend-capped cost/latency measurement for the customer meal assistant.
// Dependency-free. Sends a fixed set of multi-turn conversations to
// POST {base}/assistant/customer/turn and writes a markdown report.
// Logs carry counts and status only - never prompts, replies or menu text.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GUARD_ESTIMATE_USD = 0.05; // projected cost of the first turn, before any is seen
const MAX_MESSAGES = 10;
const REQUEST_TIMEOUT_MS = 120_000;

// --- pure helpers -----------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** USD cost of one turn. Cached tokens are billed at the cached rate, never twice. */
export function costUsd(usage, prices) {
  const input = num(usage?.inputTokens);
  const output = num(usage?.outputTokens);
  const cached = num(usage?.cachedTokens);
  const uncached = Math.max(0, input - cached);
  return (
    (uncached * prices.priceIn) / 1e6 +
    (cached * prices.priceCached) / 1e6 +
    (output * prices.priceOut) / 1e6
  );
}

/** True when spending one more turn (at the max per-turn cost seen, or the guard estimate) passes the cap. */
export function wouldExceed(spentUsd, maxTurnUsd, maxUsd) {
  const projected = maxTurnUsd > 0 ? maxTurnUsd : GUARD_ESTIMATE_USD;
  return spentUsd + projected > maxUsd;
}

/** Nearest-rank percentile. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** rows: { scenario, turn, usd, modelCalls, latencyMs, waitMs } - waitMs is the client wall-clock around the request. */
export function summarize(rows, usdInr) {
  const perTurnUsd = rows.map((r) => r.usd);
  const byScenario = new Map();
  for (const r of rows) byScenario.set(r.scenario, (byScenario.get(r.scenario) ?? 0) + r.usd);
  const perConvUsd = [...byScenario.values()];
  const dist = (values) => {
    const p50Usd = percentile(values, 50);
    const p90Usd = percentile(values, 90);
    return { p50Usd, p90Usd, p50Inr: p50Usd * usdInr, p90Inr: p90Usd * usdInr };
  };
  const latencies = rows.map((r) => r.latencyMs);
  const waits = rows.map((r) => num(r.waitMs));
  const totalUsd = perTurnUsd.reduce((a, b) => a + b, 0);
  return {
    turns: rows.length,
    conversations: byScenario.size,
    perTurn: dist(perTurnUsd),
    perConversation: dist(perConvUsd),
    meanModelCalls: rows.length ? rows.reduce((a, r) => a + r.modelCalls, 0) / rows.length : 0,
    latency: { p50Ms: percentile(latencies, 50), p90Ms: percentile(latencies, 90) },
    wait: { p50Ms: percentile(waits, 50), p90Ms: percentile(waits, 90) },
    totalUsd,
    totalInr: totalUsd * usdInr,
  };
}

/** Per-turn quality detail from a response's data. Values are markdown-safe single-line text. */
export function turnDetail(data) {
  const md = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  const p = data?.proposal;
  const items = Array.isArray(p?.items) ? p.items : [];
  return {
    outcome: p ? 'proposal' : 'clarify',
    reply: md(String(data?.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)),
    items: items.map((i) => `${md(i.name)} x${i.quantity}`).join(', '),
    total: p?.quote?.total ?? '',
    withinBudget: p ? (p.withinBudget ?? '') : '',
  };
}

/** Mimic the PWA: send the latest proposal back as the cart. */
export function cartFromProposal(proposal) {
  if (!proposal || !Array.isArray(proposal.items) || proposal.items.length === 0) return undefined;
  return proposal.items.map((i) => ({
    menuItemId: i.menuItemId,
    variantId: i.variantId ?? null,
    selectedOptions: i.selectedOptions ?? [],
    quantity: i.quantity,
  }));
}

export function parseArgs(argv) {
  const a = {
    base: 'http://localhost:3000/api/v1',
    slug: 'demo',
    priceIn: 1.25,
    priceOut: 4.25,
    priceCached: 0.15,
    usdInr: 88,
    maxUsd: 1,
    out: undefined,
    label: 'baseline',
    reasoning: 'unspecified',
    model: 'muse-spark-1.3',
    dryRun: false,
  };
  const numeric = {
    '--price-in': 'priceIn',
    '--price-out': 'priceOut',
    '--price-cached': 'priceCached',
    '--usd-inr': 'usdInr',
    '--max-usd': 'maxUsd',
  };
  const text = { '--base': 'base', '--slug': 'slug', '--out': 'out', '--label': 'label', '--reasoning': 'reasoning', '--model': 'model' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k in numeric) {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid value for ${k}`);
      a[numeric[k]] = v;
    } else if (k in text) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${k}`);
      a[text[k]] = v;
    } else throw new Error(`Unknown argument ${k}`);
  }
  return a;
}

const usd4 = (v) => `$${v.toFixed(4)}`;
const inr2 = (v) => `Rs ${v.toFixed(2)}`;

export function renderReport({ args, date, rows, notes, summary, skipped = [] }) {
  const L = [];
  L.push(`# Assistant cost measurement - ${args.label}`, '');
  L.push(`- Date: ${date}`, `- Model: ${args.model}`, `- Base URL: ${args.base}`, `- Tenant slug: ${args.slug}`);
  L.push(
    `- Prices (USD per 1M tokens): input ${args.priceIn}, output ${args.priceOut}, cached ${args.priceCached}`,
    `- Reasoning effort: ${args.reasoning ?? 'unspecified'} (informational; the backend reads ASSISTANT_REASONING_EFFORT)`,
    `- USD/INR: ${args.usdInr}`,
    `- Spend cap: ${usd4(args.maxUsd)}`,
    '',
    '## Per turn',
    '',
    '| Scenario | Turn | Calls | Input | Output | Cached | Model ms | Guest wait ms | USD | INR | Outcome | Items | Total | Within budget | Reply |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    L.push(
      `| ${r.scenario} | ${r.turn} | ${r.modelCalls} | ${r.inputTokens} | ${r.outputTokens} | ${r.cachedTokens} | ${r.latencyMs} | ${r.waitMs ?? ''} | ${usd4(r.usd)} | ${inr2(r.usd * args.usdInr)} | ${r.outcome ?? ''} | ${r.items ?? ''} | ${r.total ?? ''} | ${r.withinBudget ?? ''} | ${r.reply ?? ''} |`,
    );
  }
  for (const s of skipped) L.push(`| ${s.scenario} | ${s.turn} | - | - | - | - | - | - | - | - | ${s.outcome} | | | | |`);
  L.push('', '## Summary', '');
  L.push(`- Turns: ${summary.turns} across ${summary.conversations} conversations`);
  L.push(
    `- Per turn: p50 ${usd4(summary.perTurn.p50Usd)} (${inr2(summary.perTurn.p50Inr)}), p90 ${usd4(summary.perTurn.p90Usd)} (${inr2(summary.perTurn.p90Inr)})`,
  );
  L.push(
    `- Per conversation: p50 ${usd4(summary.perConversation.p50Usd)} (${inr2(summary.perConversation.p50Inr)}), p90 ${usd4(summary.perConversation.p90Usd)} (${inr2(summary.perConversation.p90Inr)})`,
  );
  L.push(`- Mean model calls per turn: ${summary.meanModelCalls.toFixed(2)}`);
  L.push(`- Model time: p50 ${Math.round(summary.latency.p50Ms)} ms, p90 ${Math.round(summary.latency.p90Ms)} ms`);
  L.push(`- Guest wait (client wall-clock): p50 ${Math.round(summary.wait.p50Ms)} ms, p90 ${Math.round(summary.wait.p90Ms)} ms`);
  L.push('', '## Total spend', '', `${usd4(summary.totalUsd)} (${inr2(summary.totalInr)}) of cap ${usd4(args.maxUsd)}`);
  if (notes.length) {
    L.push('', '## Notes', '', ...notes.map((n) => `- ${n}`));
  }
  return L.join('\n') + '\n';
}

// --- runner -----------------------------------------------------------------

function buildBody(messages, cart, constraints) {
  const body = { messages };
  if (cart) body.cart = cart;
  if (constraints) body.constraints = constraints;
  return body;
}

async function postTurn(args, body) {
  const res = await fetch(`${args.base}/assistant/customer/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tenant-Slug': args.slug,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body: status alone is recorded */
  }
  return { status: res.status, json };
}

/** Runs all scenarios under the spend cap. `send` is injectable for tests. */
export async function run(args, scenarios, send = postTurn) {
  const rows = [];
  const notes = [];
  const skipped = [];
  let spent = 0;
  let maxTurnUsd = 0;
  let aborted = false;

  outer: for (const sc of scenarios) {
    const messages = [];
    let cart;
    let constraints;
    for (let t = 0; t < sc.turns.length; t++) {
      if (wouldExceed(spent, maxTurnUsd, args.maxUsd)) {
        notes.push(`stopped: budget (before ${sc.id} turn ${t + 1}; spent ${usd4(spent)}, cap ${usd4(args.maxUsd)})`);
        aborted = true;
        break outer;
      }
      messages.push({ role: 'user', content: sc.turns[t] });
      if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
      let resp;
      const startedAt = Date.now();
      try {
        resp = await send(args, buildBody(messages, cart, constraints));
      } catch (err) {
        // A timeout does not prove no cost: charge the projected amount to stay under the cap.
        spent += maxTurnUsd > 0 ? maxTurnUsd : GUARD_ESTIMATE_USD;
        notes.push(`${sc.id} turn ${t + 1}: request failed (${err?.name ?? 'error'}); conversation skipped`);
        skipped.push({ scenario: sc.id, turn: t + 1, outcome: err?.name ?? 'error' });
        continue outer;
      }
      const waitMs = Date.now() - startedAt;
      if (resp.status === 429 || resp.status === 503 || !resp.json?.success) {
        // The request reached the server, so model calls may have been billed even though
        // no usage came back (a 503 after calls): charge the projected amount like a timeout.
        spent += maxTurnUsd > 0 ? maxTurnUsd : GUARD_ESTIMATE_USD;
        const code = resp.json?.code ? ` ${resp.json.code}` : '';
        notes.push(`${sc.id} turn ${t + 1}: HTTP ${resp.status}${code}; conversation skipped`);
        skipped.push({ scenario: sc.id, turn: t + 1, outcome: resp.json?.code ?? `HTTP ${resp.status}` });
        continue outer;
      }
      const data = resp.json.data;
      const usage = data?.debug?.usage;
      if (!usage) {
        notes.push(`aborted: response has no data.debug.usage (assistant debug flag is off?) at ${sc.id} turn ${t + 1}`);
        aborted = true;
        break outer;
      }
      const usd = costUsd(usage, args);
      spent += usd;
      maxTurnUsd = Math.max(maxTurnUsd, usd);
      rows.push({
        scenario: sc.id,
        turn: t + 1,
        modelCalls: num(usage.modelCalls),
        inputTokens: num(usage.inputTokens),
        outputTokens: num(usage.outputTokens),
        cachedTokens: num(usage.cachedTokens),
        latencyMs: num(usage.latencyMs),
        waitMs,
        usd,
        ...turnDetail(data),
      });
      messages.push({ role: 'assistant', content: typeof data.reply === 'string' ? data.reply : '' });
      cart = cartFromProposal(data.proposal) ?? cart;
      constraints = data.constraints ?? constraints;
      console.log(`${sc.id} turn ${t + 1}: calls=${num(usage.modelCalls)} ${usd4(usd)} spent=${usd4(spent)}`);
    }
  }
  return { rows, notes, skipped, aborted, spent };
}

function dryRun(args, scenarios) {
  console.log(`DRY RUN - nothing is sent. POST ${args.base}/assistant/customer/turn  X-Tenant-Slug: ${args.slug}`);
  console.log(
    `Prices in/out/cached: ${args.priceIn}/${args.priceOut}/${args.priceCached} USD per 1M; USD/INR ${args.usdInr}; cap ${usd4(args.maxUsd)}`,
  );
  for (const sc of scenarios) {
    sc.turns.forEach((message, i) => {
      const constraints =
        i === 0 ? 'none (first turn)' : 'echo of previous reply constraints (+ cart from latest proposal)';
      console.log(`- scenario=${sc.id} turn=${i + 1} message=${JSON.stringify(message)} constraints=${constraints}`);
    });
  }
  console.log('Dry run complete: no requests sent and no report file written.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const scenarios = JSON.parse(readFileSync(resolve(here, 'assistant-measure.scenarios.json'), 'utf8'));
  if (args.dryRun) return dryRun(args, scenarios);
  if (!args.out) throw new Error('--out is required (unless --dry-run)');

  const { rows, notes, skipped, aborted } = await run(args, scenarios);
  const summary = summarize(rows, args.usdInr);
  const report = renderReport({ args, date: new Date().toISOString().slice(0, 10), rows, notes, summary, skipped });
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), report);
  console.log(`Report written to ${args.out}; total ${usd4(summary.totalUsd)}`);
  if (aborted) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`assistant-measure failed: ${err.message}`);
    process.exit(1);
  });
}
