// Quality evaluation for the customer meal assistant. Runs scripted conversations
// against the local backend under the same hard spend cap as assistant-measure.mjs and
// checks every answer for hard-limit violations (exit 1) and grounding/tone warnings.
// Logs carry counts and status only - never prompts, replies or menu text.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { costUsd, wouldExceed, cartFromProposal, parseArgs, GUARD_ESTIMATE_USD } from './assistant-measure.mjs';

const MAX_MESSAGES = 10;
const REQUEST_TIMEOUT_MS = 120_000;

const usd4 = (v) => `$${v.toFixed(4)}`;
const md = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

// --- pure helpers -----------------------------------------------------------

/** id -> { name, isVeg, containsEgg, category } from the public menu response. */
export function buildMenuIndex(menuJson) {
  const index = new Map();
  const categories = Array.isArray(menuJson?.data) ? menuJson.data : (menuJson?.data?.categories ?? menuJson?.categories ?? []);
  for (const cat of categories) {
    for (const item of cat.items ?? []) {
      index.set(item.id, {
        name: item.name,
        isVeg: item.isVeg === true,
        containsEgg: item.containsEgg === true,
        category: cat.name ?? '',
        role: cat.assistantRole ?? null,
      });
    }
  }
  return index;
}

/** Throws when the menu has no items, so every id would look unknown. */
export function assertMenuIndex(index) {
  if (!index || index.size === 0) {
    throw new Error('menu index is empty: GET /menu/customer returned no items for this tenant (wrong slug or unexpected response shape)');
  }
}

const ABBREVIATIONS = /\b(rs|approx|e\.g|i\.e)\./gi;

export function countSentences(text) {
  return String(text ?? '')
    .replace(ABBREVIATIONS, (m) => m.slice(0, -1))
    .replace(/\bNo\.(\s*\d)/g, 'No$1')
    .split(/[.!?]+(?=\s|$)/)
    .filter((s) => s.trim().length > 0).length;
}

/** Share of letters that are ASCII; 1 when there are no letters. */
export function asciiLetterRatio(text) {
  const letters = String(text ?? '').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 1;
  const ascii = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  return ascii / letters.length;
}

export function proposalTotal(proposal) {
  if (!proposal) return null;
  const t = proposal.combinedQuote?.total ?? proposal.quote?.total;
  return typeof t === 'number' ? t : null;
}

const PERSONA = /\b(i am a chef|i'm a chef|as a human|as an ai language model)\b/i;
const ALLERGEN_CLAIM = /allergen[- ]free|allergy[- ]free|safe for/i;
const HINGLISH = /\b(hai|khana|aap|aapke|kya|liye|logon|nahi|aur)\b/i;

/**
 * Checks one answer. hard => release blocker (exit 1); soft => warning.
 * input: { reply, proposal, constraints, menuIndex, expect, prevTotal, cheaper }
 */
export function checkTurn({ reply, proposal, constraints = {}, menuIndex, expect = {}, prevTotal = null, cheaper = false }) {
  const hard = [];
  const soft = [];
  const text = String(reply ?? '');
  const items = Array.isArray(proposal?.items) ? proposal.items : [];

  for (const line of items) {
    const known = menuIndex.get(line.menuItemId);
    if (!known) {
      hard.push(`unknown item id ${line.menuItemId}`);
      continue;
    }
    if (constraints.vegetarian && (!known.isVeg || known.containsEgg)) {
      hard.push(`vegetarian violated by ${known.name}`);
    }
    if (constraints.noEgg && known.containsEgg) hard.push(`no-egg violated by ${known.name}`);
  }

  if (proposal && typeof constraints.budget === 'number') {
    const within = proposal.combinedQuote?.withinBudget ?? proposal.withinBudget;
    if (within === false) hard.push(`over budget (withinBudget=false, budget ${constraints.budget})`);
  }

  if (expect.allergy) {
    if (ALLERGEN_CLAIM.test(text)) hard.push('allergy reply makes an allergen-free/safe claim');
    if (!/confirm/i.test(text)) hard.push('allergy reply does not ask the guest to confirm');
  }

  if (expect.offTopic) {
    if (proposal) hard.push('off-topic ask got a proposal');
    if (countSentences(text) > 2) soft.push('off-topic redirect longer than 2 sentences');
  }

  if (cheaper) {
    const total = proposalTotal(proposal);
    if (total !== null && prevTotal !== null && total > prevTotal) {
      hard.push(`total rose on a cheaper edit (${prevTotal} -> ${total})`);
    }
  }

  if (!expect.offTopic && countSentences(text) > 3) soft.push('reply longer than 3 sentences');
  if (asciiLetterRatio(text) < 0.9) soft.push('reply is not English (ASCII letter ratio < 0.9)');
  if (PERSONA.test(text)) soft.push('persona claim (human/chef/AI-model phrasing)');
  if ((text.match(/estimat/gi) ?? []).length > 1) soft.push('estimate phrase repeated in one reply');
  if (expect.english && HINGLISH.test(text)) soft.push('Hinglish words in reply');

  if (expect.mainIfAvailable) {
    // Owner-set category roles when the menu payload carries them, else the category-name heuristic.
    const rolesRecorded = [...menuIndex.values()].some((m) => m.role);
    const isMain = (m) => (rolesRecorded ? m?.role === 'MAIN' : /main/i.test(m?.category ?? ''));
    const menuHasMain = [...menuIndex.values()].some(isMain);
    const hasMain = items.some((l) => isMain(menuIndex.get(l.menuItemId)));
    // 'hard' makes a missing main a release blocker for that case; true only warns.
    if (menuHasMain && !hasMain) (expect.mainIfAvailable === 'hard' ? hard : soft).push('proposal has no main although the menu has one');
  }

  return { hard, soft };
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
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Tenant-Slug': args.slug },
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

export async function fetchMenu(args) {
  const res = await fetch(`${args.base}/menu/customer?restaurant=${encodeURIComponent(args.slug)}`, {
    headers: { 'X-Tenant-Slug': args.slug },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`menu request failed (HTTP ${res.status})`);
  return res.json();
}

/** Runs all cases under the spend cap. `send` is injectable for tests. */
export async function runEval(args, cases, menuIndex, send = postTurn) {
  const results = [];
  const notes = [];
  let spent = 0;
  let maxTurnUsd = 0;
  let aborted = false;

  for (const c of cases) {
    const result = { id: c.id, status: 'pass', hard: [], soft: [], turns: [] };
    results.push(result);
    if (aborted) {
      result.status = 'not-run';
      continue;
    }
    const expect = c.expect ?? {};
    const messages = [];
    let cart;
    let constraints = c.constraints;
    let prevTotal = null;

    for (let t = 0; t < c.turns.length; t++) {
      if (wouldExceed(spent, maxTurnUsd, args.maxUsd)) {
        notes.push(`stopped: budget (before ${c.id} turn ${t + 1}; spent ${usd4(spent)}, cap ${usd4(args.maxUsd)})`);
        aborted = true;
        if (t === 0) result.status = 'not-run';
        break;
      }
      messages.push({ role: 'user', content: c.turns[t] });
      if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
      let resp;
      try {
        resp = await send(args, buildBody(messages, cart, constraints));
      } catch (err) {
        spent += maxTurnUsd > 0 ? maxTurnUsd : GUARD_ESTIMATE_USD;
        result.hard.push(`turn ${t + 1}: request failed (${err?.name ?? 'error'})`);
        break;
      }
      if (resp.status === 429 || resp.status === 503 || !resp.json?.success) {
        spent += maxTurnUsd > 0 ? maxTurnUsd : GUARD_ESTIMATE_USD;
        result.hard.push(`turn ${t + 1}: HTTP ${resp.status}${resp.json?.code ? ` ${resp.json.code}` : ''}`);
        break;
      }
      const data = resp.json.data;
      const usage = data?.debug?.usage;
      if (!usage) {
        notes.push(`aborted: response has no data.debug.usage (assistant debug flag is off?) at ${c.id} turn ${t + 1}`);
        aborted = true;
        result.status = 'not-run';
        break;
      }
      const usd = costUsd(usage, args);
      spent += usd;
      maxTurnUsd = Math.max(maxTurnUsd, usd);

      const echoed = data.constraints ?? {};
      const effective = {
        vegetarian: echoed.vegetarian ?? c.constraints?.vegetarian,
        noEgg: echoed.noEgg ?? c.constraints?.noEgg,
        budget: echoed.budget ?? c.constraints?.budget,
      };
      const verdict = checkTurn({
        reply: data.reply,
        proposal: data.proposal,
        constraints: effective,
        menuIndex,
        expect,
        prevTotal,
        cheaper: (expect.cheaperOnTurns ?? []).includes(t + 1),
      });
      result.hard.push(...verdict.hard.map((h) => `turn ${t + 1}: ${h}`));
      result.soft.push(...verdict.soft.map((s) => `turn ${t + 1}: ${s}`));
      const total = proposalTotal(data.proposal);
      result.turns.push({
        user: c.turns[t],
        reply: String(data.reply ?? ''),
        items: (data.proposal?.items ?? []).map((i) => `${i.name} x${i.quantity}`).join(', '),
        total,
      });
      if (total !== null) prevTotal = total;
      messages.push({ role: 'assistant', content: typeof data.reply === 'string' ? data.reply : '' });
      cart = cartFromProposal(data.proposal) ?? cart;
      constraints = data.constraints ?? constraints;
      console.log(`${c.id} turn ${t + 1}: ${usd4(usd)} spent=${usd4(spent)} hard=${verdict.hard.length} soft=${verdict.soft.length}`);
    }
    if (result.status !== 'not-run') result.status = result.hard.length ? 'fail' : 'pass';
  }
  return { results, notes, aborted, spent };
}

// --- report -----------------------------------------------------------------

export function renderEvalReport({ args, date, results, notes, spent }) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const warned = results.filter((r) => r.status === 'pass' && r.soft.length).length;
  const label = { pass: 'PASS', fail: 'FAIL', 'not-run': 'NOT RUN' };
  const L = [`# Assistant quality evaluation - ${args.label}`, ''];
  L.push(`- Date: ${date}`, `- Base URL: ${args.base}`, `- Tenant slug: ${args.slug}`, `- Spend cap: ${usd4(args.maxUsd)}`, '');
  L.push('## Cases', '', '| Case | Result | Hard failures | Warnings |', '|---|---|---|---|');
  for (const r of results) {
    const name = r.status === 'pass' && r.soft.length ? 'PASS (warnings)' : label[r.status];
    L.push(`| ${r.id} | ${name} | ${md(r.hard.join('; '))} | ${md(r.soft.join('; '))} |`);
  }
  L.push('', '## Summary', '');
  L.push(`- ${count('pass')} passed (${warned} with warnings), ${count('fail')} failed, ${count('not-run')} not run, of ${results.length} cases`);
  L.push('', '## Conversations', '');
  for (const r of results) {
    if (!r.turns.length) continue;
    L.push(`### ${r.id}`, '');
    r.turns.forEach((t, i) => {
      L.push(`${i + 1}. Guest: ${md(t.user)}`);
      L.push(`   - Reply: ${md(t.reply)}`);
      if (t.items) L.push(`   - Proposal: ${md(t.items)}${t.total !== null ? ` (total ${t.total})` : ''}`);
    });
    L.push('');
  }
  L.push('## Total spend', '', `${usd4(spent)} of cap ${usd4(args.maxUsd)}`);
  if (notes.length) L.push('', '## Notes', '', ...notes.map((n) => `- ${n}`));
  return L.join('\n') + '\n';
}

/** Writes an abort report and returns true when the menu index is empty. */
export function abortOnEmptyMenu({ args, date, out, menuIndex }) {
  try {
    assertMenuIndex(menuIndex);
    return false;
  } catch (err) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), renderEvalReport({ args, date, results: [], notes: [`aborted: ${err.message}`], spent: 0 }));
    console.error(`assistant-eval aborted: ${err.message}`);
    return true;
  }
}

// --- CLI --------------------------------------------------------------------

/** Splits the eval-only flags from the shared ones parseArgs understands. */
export function splitEvalArgs(argv) {
  const rest = [];
  let casesPath;
  let ack = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cases') {
      casesPath = argv[++i];
      if (casesPath === undefined) throw new Error('Missing value for --cases');
    } else if (argv[i] === '--with-setup-acknowledged') ack = true;
    else rest.push(argv[i]);
  }
  return { rest, casesPath, ack };
}

/**
 * Loads a case file (default: the shipped one). Cases marked requiresSetup need
 * manual SQL first, so they are skipped unless the operator acknowledged setup.
 */
export function loadCases(casesPath, { ack = false, cwd = process.cwd(), defaultPath } = {}) {
  const file = casesPath ? resolve(cwd, casesPath) : defaultPath;
  let all;
  try {
    all = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read cases file ${file}: ${err.code === 'ENOENT' ? 'not found' : err.message}`);
  }
  if (!Array.isArray(all)) throw new Error(`cases file ${file} must contain a JSON array`);
  const cases = all.filter((c) => ack || !c.requiresSetup);
  const skipped = all.filter((c) => !ack && c.requiresSetup).map((c) => c.id);
  return { cases, skipped };
}

function dryRun(args, cases, skipped = []) {
  console.log(`DRY RUN - nothing is sent. GET ${args.base}/menu/customer ; POST ${args.base}/assistant/customer/turn  X-Tenant-Slug: ${args.slug}`);
  console.log(`Prices in/out/cached: ${args.priceIn}/${args.priceOut}/${args.priceCached} USD per 1M; USD/INR ${args.usdInr}; cap ${usd4(args.maxUsd)}`);
  for (const c of cases) {
    c.turns.forEach((message, i) => {
      const chips = i === 0 ? JSON.stringify(c.constraints ?? {}) : 'echo of previous reply constraints (+ cart from latest proposal)';
      console.log(`- case=${c.id} turn=${i + 1} message=${JSON.stringify(message)} constraints=${chips}`);
    });
  }
  for (const id of skipped) console.log(`- case=${id} requires setup (skipped; pass --with-setup-acknowledged after running its setupSql)`);
  console.log('Dry run complete: no requests sent and no report file written.');
}

async function main() {
  const { rest, casesPath, ack } = splitEvalArgs(process.argv.slice(2));
  const args = parseArgs(rest);
  const here = dirname(fileURLToPath(import.meta.url));
  const { cases, skipped } = loadCases(casesPath, { ack, defaultPath: resolve(here, 'assistant-eval.cases.json') });
  if (args.dryRun) return dryRun(args, cases, skipped);
  if (skipped.length) console.log(`skipping cases that require setup: ${skipped.join(', ')}`);

  const date = new Date().toISOString().slice(0, 10);
  const out = args.out ?? resolve(here, '..', 'docs', 'evals', `${date}-${args.label}.md`);
  const menuIndex = buildMenuIndex(await fetchMenu(args));
  console.log(`menu items indexed: ${menuIndex.size}`);
  if (abortOnEmptyMenu({ args, date, out, menuIndex })) process.exit(1);
  const { results, notes, aborted, spent } = await runEval(args, cases, menuIndex);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), renderEvalReport({ args, date, results, notes, spent }));
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`Report written to ${out}; ${failed} failed; total ${usd4(spent)}`);
  if (failed) process.exitCode = 1;
  else if (aborted) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`assistant-eval failed: ${err.message}`);
    process.exit(1);
  });
}
