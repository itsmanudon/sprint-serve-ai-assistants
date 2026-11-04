#!/usr/bin/env node
/**
 * Local stand-in for the assistant's model API (OpenAI-compatible
 * chat completions), for laptop end-to-end runs before a real key exists.
 *
 * It is deliberately dumb and deterministic: it reads the limits, remaining
 * budget, cart and menu snapshot that customer.prompt/customer.service put in the system prompt,
 * proposes straight from the snapshot in one call (or, when the snapshot is missing or truncated,
 * calls search_menu → propose_meal; the server quotes on propose), and
 * reacts to a few edit phrases ("cheaper", "less spicy", "dessert"). The
 * backend still validates and prices everything, so the stub exercises the real
 * server rules — it cannot place orders or bypass a limit.
 *
 *   node backend/scripts/assistant-model-stub.mjs            # port 4010
 *   STUB_PORT=4011 STUB_DELAY_MS=0 node backend/scripts/assistant-model-stub.mjs
 *
 * Point the backend at it (backend/.env, then restart the backend):
 *   ASSISTANT_ENABLED=true
 *   ASSISTANT_MODEL_API_KEY=local-stub
 *   ASSISTANT_MODEL_BASE_URL=http://host.docker.internal:4010/v1
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4010);
const DELAY_MS = Number(process.env.STUB_DELAY_MS ?? 800);
let callSeq = 0;

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

function readContext(system) {
  const limits = parseJson(system.match(/Limits agreed so far: (\{.*?\})\.(?:\n|$)/)?.[1] ?? '{}', {});
  const remaining = system.match(/Remaining budget: ₹([\d.]+)/)?.[1];
  const overBudget = /at or over the ₹/.test(system);
  const cart = parseJson(system.match(/Cart on screen: (\[.*\])\.(?:\n|$)/)?.[1] ?? '[]', []);
  const budget = remaining ? Number(remaining) : (limits.budget ?? null);
  return {
    limits,
    budget,
    overBudget,
    cart,
    snapshot: readSnapshot(system),
    snapshotTruncated: /Menu truncated; use search_menu/.test(system),
  };
}

/**
 * Dishes from the system prompt's menu snapshot, shaped like search_menu hits:
 * "id | name | category | price | diet | spice | serves | prep | popular | featured | pairs | role[ | choices required…]".
 */
function readSnapshot(system) {
  const lines = system.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Menu snapshot ('));
  if (start < 0) return [];
  const items = [];
  for (const row of lines.slice(start + 1)) {
    const cols = row.split(' | ');
    if (cols.length < 12) break;
    const [id, name, category, price, diet, spice] = cols;
    const variants = [...price.matchAll(/₹([\d.]+) \(variantId ([^)]+)\)/g)].map((m) => ({
      id: m[2],
      price: Number(m[1]),
    }));
    items.push({
      id,
      name,
      category,
      diet,
      spice,
      startingPrice: variants.length ? Math.min(...variants.map((v) => v.price)) : Number(price.replace('₹', '')),
      variants,
      hasRequiredChoices: cols.length > 12,
    });
  }
  return items;
}

const toolCall = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: `stub_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ],
});
const text = (content) => ({ role: 'assistant', content });

const line = (item, quantity = 1) => ({
  menuItemId: item.id,
  ...(item.variants?.length
    ? { variantId: [...item.variants].sort((a, b) => a.price - b.price)[0].id }
    : {}),
  quantity,
});
const unit = (item) =>
  item.variants?.length ? Math.min(...item.variants.map((v) => v.price)) : item.startingPrice;

/** One dish per category, cheapest-first when asked, trimmed to the budget (≈5% GST). */
function chooseLines(items, { people, budget, cheaper }) {
  const usable = items.filter((i) => !i.hasRequiredChoices);
  const ordered = cheaper ? [...usable].sort((a, b) => unit(a) - unit(b)) : usable;
  const picked = [];
  const seen = new Set();
  for (const item of ordered) {
    if (picked.length >= Math.min(people + 1, 6)) break;
    if (seen.has(item.category)) continue;
    seen.add(item.category);
    picked.push(item);
  }
  let lines = picked.map((i) => ({ item: i, l: line(i, people >= 4 && picked.length < 4 ? 2 : 1) }));
  const cost = () => lines.reduce((s, x) => s + unit(x.item) * x.l.quantity * 1.05, 0);
  while (budget && lines.length > 1 && cost() > budget) {
    lines.sort((a, b) => unit(b.item) - unit(a.item));
    lines.shift();
  }
  return lines;
}

function respond(messages) {
  const system = messages[0]?.content ?? '';
  const ctx = readContext(system);
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const ask = (messages[lastUser]?.content ?? '').toLowerCase();
  const turn = messages.slice(lastUser + 1);
  const people = Number(ctx.limits.people ?? 2);
  const cheaper = /cheaper|budget|less money/.test(ask);
  const dessert = /dessert|sweet/.test(ask);

  const proposeMeal = (items) =>
    toolCall('propose_meal', {
      reply: `Here is a meal for ${people} from this menu${ctx.budget ? ' that fits your budget' : ''}. Tap an edit below to change it.`,
      constraints: ctx.limits,
      items,
      suggestions: ['Swap a dish', 'Add a drink'],
    });

  function mealFrom(items) {
    if (!items.length) return text('I could not find dishes on this menu that fit those limits. Try removing a chip.');
    let lines;
    if (dessert && ctx.cart.length) {
      const pick = items.find((i) => !i.hasRequiredChoices);
      lines = [...ctx.cart.map(({ menuItemId, variantId, selectedOptions, quantity }) => ({ menuItemId, variantId, selectedOptions, quantity })), ...(pick ? [line(pick)] : [])];
    } else {
      lines = chooseLines(items, { people, budget: ctx.budget, cheaper }).map((x) => x.l);
    }
    if (!lines.length) return text('Every dish that fits needs a choice I cannot make for you. Please pick from the menu.');
    return proposeMeal(lines);
  }

  if (!turn.length) {
    if (ctx.overBudget) return text('Your cart already uses up the whole budget, so I have not added anything. Remove the budget chip if you would like more.');
    if (/^(hi|hello|hey)\b/.test(ask)) return text('Hi! Tell me how many people are eating and any food preferences, and I will put a meal together.');
    // One call, like a real model with the snapshot: filter it and propose directly.
    if (ctx.snapshot.length && !ctx.snapshotTruncated) {
      const veg = ctx.limits.vegetarian;
      return mealFrom(
        ctx.snapshot.filter(
          (i) =>
            (!veg || i.diet === 'veg') &&
            (!(veg || ctx.limits.noEgg) || i.diet !== 'egg') &&
            (!/less spicy|mild/.test(ask) || ['-', 'MILD'].includes(i.spice)) &&
            (!dessert || /dessert|sweet/i.test(`${i.category} ${i.name}`))
        )
      );
    }
    return toolCall('search_menu', {
      ...(dessert ? { query: 'dessert' } : {}),
      ...(ctx.limits.vegetarian ? { vegetarianOnly: true } : {}),
      ...(ctx.limits.noEgg || ctx.limits.vegetarian ? { excludeEgg: true } : {}),
      ...(/less spicy|mild/.test(ask) ? { maxSpice: 'MILD' } : {}),
      limit: 15,
    });
  }

  const last = turn[turn.length - 1];
  const prevCall = turn[turn.length - 2]?.tool_calls?.[0];
  const result = parseJson(last.content ?? '', null);
  const prevArgs = parseJson(prevCall?.function?.arguments ?? '{}', {});

  if (prevCall?.function?.name === 'search_menu') {
    return mealFrom(Array.isArray(result) ? result : []);
  }

  const lines = prevArgs.items ?? [];
  const dropOne = () => lines.slice(0, -1);

  if (prevCall?.function?.name === 'propose_meal' && result?.error) {
    // The server priced it and pushed back (usually over budget): drop the last line and propose again.
    return lines.length > 1
      ? proposeMeal(dropOne())
      : text(`I could not build a meal within those limits (${result.error}).`);
  }

  return text('Sorry, I lost track there. Could you say that again?');
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'stub' }] }));
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = parseJson(raw, {});
      const message = respond(body.messages ?? []);
      const kind = message.tool_calls?.[0]?.function?.name ?? 'text';
      console.log(`${new Date().toISOString()}  ${kind}`);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `stub-${callSeq}`,
            object: 'chat.completion',
            model: body.model ?? 'stub',
            choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
        );
      }, DELAY_MS);
    });
  })
  .listen(PORT, () => console.log(`assistant model stub listening on http://localhost:${PORT}/v1`));
