import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BotState } from '../src/state.js';
import { Chat2DeskAPI } from '../src/chat2desk.js';
import { handleTelegramUpdate } from '../src/bot.js';

const tickets = JSON.parse(fs.readFileSync(new URL('./fixtures/tickets-live.json', import.meta.url), 'utf8'));
const requestIdsByClient = JSON.parse(fs.readFileSync(new URL('./fixtures/client-request-ids.json', import.meta.url), 'utf8'));

class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
}

function makeBinding(env) {
  const ctx = { storage: new MemoryStorage() };
  const obj = new BotState(ctx, env);
  return {
    idFromName(name) { return name; },
    get() { return { fetch: (input, init) => obj.fetch(input instanceof Request ? input : new Request(input, init)) }; },
  };
}

function makeClients() {
  const rows = [];
  for (let i = 1; i <= 45; i++) rows.push({ id: 700000000 + i, assigned_name: `Клиент ${i}`, name: `Клиент ${i}`, phone: String(79000000000 + i) });
  rows.splice(31, 0, { id: 769651489, assigned_name: 'ЛЕКС ДЕНТАЛ ФЬЮЧЕРС & Future IT Dent', name: 'ЛЕКС ДЕНТАЛ ФЬЮЧЕРС & Future IT Dent', phone: '[max_bot group] -72572902718176' });
  rows.push({ id: 765518436, assigned_name: 'Стоматология уЗубного', name: 'Стоматология уЗубного', username: 'FID_support', phone: '[tg_user] 79110356923' });
  return rows;
}
const clients = makeClients();

const operators = [
  { id: 322395, online: 0, opened_dialogs: 0, first_name: 'Данила', last_name: 'Ворончихин', role: 'admin' },
  { id: 322416, online: 0, opened_dialogs: 0, first_name: 'Роман', last_name: 'Онюшкин', role: 'supervisor' },
  { id: 322423, online: 0, opened_dialogs: 0, first_name: 'Егор', last_name: 'Латышев', role: 'operator' },
  { id: 322424, online: 0, opened_dialogs: 0, first_name: 'Миртемир', last_name: 'Токтогулов', role: 'operator' },
  { id: 326121, online: 1, opened_dialogs: 3, first_name: 'Видана', last_name: 'Мартынова', role: 'supervisor' },
  { id: 326575, online: 0, opened_dialogs: 0, first_name: 'Эрьян', last_name: 'Муратов', role: 'operator' },
];
const openDialogs = [
  { id: 143279730, state: 'open', operator_id: 326121, last_message: { client_id: 765753263, request_id: 750723494 } },
  { id: 145642303, state: 'open', operator_id: 326121, last_message: { client_id: 768313179, request_id: 750727733 } },
  { id: 146751543, state: 'open', operator_id: 326121, last_message: { client_id: 769605056, request_id: 750759769 } },
];

function messagesFor(clientId) {
  const requestIds = requestIdsByClient[String(clientId)] || [];
  const productionTotals = { '769651489': 4344, '765518436': 497, '768313179': 120 };
  const total = productionTotals[String(clientId)] || requestIds.length;
  if (!requestIds.length) return [];
  return Array.from({ length: total }, (_, i) => ({
    id: 5000000000 + i * 100 + Number(String(clientId).slice(-2)),
    text: `message ${i}`,
    client_id: Number(clientId),
    request_id: requestIds[i % requestIds.length],
    dialog_id: 100000000 + i,
    operator_id: 322416,
    transport: 'telegram',
    type: 'from_client',
    status: 'seen',
  }));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch({ telegramCalls }) {
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = input instanceof URL ? input.href : (typeof input === 'string' ? input : input.url);
    const url = new URL(rawUrl);
    if (url.hostname === 'api.telegram.org') {
      let payload = {};
      try { payload = JSON.parse(init.body || '{}'); } catch {}
      telegramCalls.push({ method: url.pathname.split('/').pop(), payload });
      return jsonResponse({ ok: true, result: true });
    }
    if (url.hostname !== 'api.chat2desk.com') throw new Error(`unexpected fetch ${url}`);

    if (url.pathname === '/v1/tickets') {
      const requested = Number(url.searchParams.get('limit') || 20);
      const limit = Math.min(20, requested); // production contract observed: 20 rows/page
      const offset = Number(url.searchParams.get('offset') || 0);
      const page = tickets.slice(offset, offset + limit);
      return jsonResponse({ data: page, meta: { total: tickets.length, limit, offset }, status: 'success' });
    }
    if (url.pathname === '/v1/clients') {
      const requested = Number(url.searchParams.get('limit') || 20);
      const limit = Math.min(20, requested);
      const offset = Number(url.searchParams.get('offset') || 0);
      // Intentionally ignore name/search params exactly like the live diagnostics.
      return jsonResponse({ data: clients.slice(offset, offset + limit), meta: { total: clients.length, limit, offset }, status: 'success' });
    }
    if (url.pathname === '/v1/operators') {
      return jsonResponse({ data: operators, meta: { total: operators.length, limit: 20, offset: 0 }, status: 'success' });
    }
    if (url.pathname === '/v1/dialogs') {
      const state = url.searchParams.get('state');
      const data = state === 'open' ? openDialogs : [];
      return jsonResponse({ data, meta: { total: data.length, limit: 20, offset: 0 }, status: 'success' });
    }
    if (url.pathname === '/v1/messages') {
      const cid = Number(url.searchParams.get('client_id'));
      const all = messagesFor(cid);
      const requested = Number(url.searchParams.get('limit') || 20);
      const limit = Math.min(20, requested);
      const start = url.searchParams.has('start_id') ? Number(url.searchParams.get('start_id')) : null;
      const eligible = start === null ? all : all.filter((m) => m.id > start);
      const page = eligible.slice(0, limit);
      return jsonResponse({ data: page, meta: { total: all.length, limit }, status: 'success' });
    }
    const m = url.pathname.match(/^\/v1\/clients\/(\d+)\/dialogs$/);
    if (m) return jsonResponse({ data: [], status: 'success' });
    return jsonResponse({ message: 'not_found', status: 'error' }, 404);
  };
}

function makeEnv() {
  const env = {
    CHAT2DESK_API_BASE: 'https://api.chat2desk.com',
    CHAT2DESK_API_TOKEN: 'test-token',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    ADMIN_TELEGRAM_USERNAMES: 'terraktorill,Des_pair',
    OPERATOR_MAP_JSON: JSON.stringify([
      { telegram_username: 'terraktorill', chat2desk_operator_id: 322416, name: 'Роман Онюшкин' },
      { telegram_username: 'Meldori', chat2desk_operator_id: 322423, name: 'Егор Латышев' },
      { telegram_username: 'looking4victims', chat2desk_operator_id: 322424, name: 'Миртемир Токтогулов' },
      { telegram_username: 'Warewarewarewa', chat2desk_operator_id: 326121, name: 'Видана Мартынова' },
      { telegram_username: 'qRainyyy', chat2desk_operator_id: 326575, name: 'Эрьян Муратов' },
      { telegram_username: 'Des_pair', chat2desk_operator_id: 322395, name: 'Данила Ворончихин' },
    ]),
    CLIENT_SEARCH_MAX_RESULTS: '10',
    TICKETS_PER_PAGE: '5',
  };
  env.BOT_STATE = makeBinding(env);
  return env;
}

function lastTelegramText(calls) {
  const relevant = [...calls].reverse().find((c) => c.payload?.text);
  return relevant?.payload?.text || '';
}

function callback(data, messageId = 100) {
  return { callback_query: { id: `cq-${data}`, data, from: { id: 42, username: 'terraktorill' }, message: { message_id: messageId, chat: { id: 42 } } } };
}
function message(text) {
  return { message: { text, from: { id: 42, username: 'terraktorill' }, chat: { id: 42 } } };
}

test('live ticket shape uses string id TICK-N and request_ids', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const api = new Chat2DeskAPI(makeEnv());
  const all = await api.allTickets();
  assert.equal(all.tickets.length, 905);
  const t910 = all.tickets.find((t) => api.ticketId(t) === 'TICK-910');
  assert.ok(t910);
  assert.equal(api.ticketTitle(t910).trim(), 'Вопрос по функционалу');
  assert.ok(api.ticketRequestIds(t910).includes(750702078));
});

test('control client 765518436 resolves exactly six tickets through request_ids', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const api = new Chat2DeskAPI(makeEnv());
  const result = await api.ticketsForClient(765518436);
  assert.deepEqual(result.tickets.map((t) => api.ticketId(t)), ['TICK-906','TICK-819','TICK-445','TICK-226','TICK-225','TICK-91']);
});

test('Lex Dental 769651489 resolves 59 tickets, newest TICK-903', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const api = new Chat2DeskAPI(makeEnv());
  const result = await api.ticketsForClient(769651489);
  assert.equal(result.tickets.length, 59);
  assert.equal(api.ticketId(result.tickets[0]), 'TICK-903');
  assert.equal(api.ticketTitle(result.tickets[0]), 'Копейки в форме распределения баланса');
});

test('ticket number and title search work against full paginated collection', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const api = new Chat2DeskAPI(makeEnv());
  const byNumber = await api.searchTickets('910');
  assert.equal(api.ticketId(byNumber.tickets[0]), 'TICK-910');
  const byTitle = await api.searchTickets('Вопрос по функционалу');
  assert.equal(api.ticketId(byTitle.tickets[0]), 'TICK-910');
});

test('client search does not trust ignored server filters and scans all pages', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const api = new Chat2DeskAPI(makeEnv());
  const result = await api.searchClients('Лекс дентал');
  assert.equal(result.length, 1);
  assert.equal(api.clientId(result[0]), 769651489);
});

test('real bot callback client:765518436 renders six tickets', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const env = makeEnv();
  await handleTelegramUpdate(env, callback('client:765518436'));
  const text = lastTelegramText(calls);
  assert.match(text, /TICK-906/);
  assert.match(text, /Поле кем выдан паспорт неудобное/);
  assert.match(text, /Всего: 6/);
});

test('real bot callback Lex Dental renders 59 total and newest ticket', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const env = makeEnv();
  await handleTelegramUpdate(env, callback('client:769651489'));
  const text = lastTelegramText(calls);
  assert.match(text, /TICK-903/);
  assert.match(text, /Копейки в форме распределения баланса/);
  assert.match(text, /Всего: 59/);
  assert.ok(text.length < 4096);
});

test('real bot ticket search 910 returns TICK-910 title', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const env = makeEnv();
  await handleTelegramUpdate(env, callback('ticket_search'));
  await handleTelegramUpdate(env, message('910'));
  const text = lastTelegramText(calls);
  assert.match(text, /TICK-910/);
  assert.match(text, /Вопрос по функционалу/);
});

test('real bot client search finds Lex Dental beyond first page', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const env = makeEnv();
  await handleTelegramUpdate(env, callback('client_search'));
  await handleTelegramUpdate(env, message('Лекс дентал'));
  const call = [...calls].reverse().find((c) => c.payload?.reply_markup?.inline_keyboard);
  const serialized = JSON.stringify(call?.payload?.reply_markup || {});
  assert.match(serialized, /client:769651489/);
});

test('real bot operators uses live opened_dialogs and online fields', async () => {
  const calls = []; installFetch({ telegramCalls: calls });
  const env = makeEnv();
  await handleTelegramUpdate(env, callback('admin_operators'));
  const text = lastTelegramText(calls);
  assert.match(text, /Видана Мартынова/);
  assert.match(text, /чатов: 3/);
  assert.match(text, /🟢/);
});
