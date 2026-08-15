function first(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) return obj[key];
  }
  return fallback;
}

function asInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object");
  if (Array.isArray(payload?.data)) return payload.data.filter((x) => x && typeof x === "object");
  return [];
}

function metaFrom(payload, fallbackOffset = 0, fallbackLimit = 20) {
  const rows = rowsFrom(payload);
  return {
    total: asInt(payload?.meta?.total),
    limit: asInt(payload?.meta?.limit) || rows.length || fallbackLimit,
    offset: asInt(payload?.meta?.offset) ?? fallbackOffset,
  };
}

function ticketKeyValue(row) {
  if (!row || typeof row !== "object") return null;
  const raw = first(row, ["id", "issue_id", "issueId", "ticket_id", "ticketID", "ticket_number", "ticketNumber", "number"], null);
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  return text || null;
}

function looksLikeTicket(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const key = ticketKeyValue(row);
  if (!key) return false;
  return row.summary !== undefined || row.description !== undefined || row.request_ids !== undefined || row.requests !== undefined;
}

function entityId(row, keys) {
  return asInt(first(row, keys, null));
}

export function dataList(payload) {
  return rowsFrom(payload);
}

export class Chat2DeskAPI {
  constructor(env) {
    this.env = env;
    this.base = String(env.CHAT2DESK_API_BASE || "https://api.chat2desk.com").replace(/\/$/, "");
    this.token = env.CHAT2DESK_API_TOKEN;
    if (!this.token) throw new Error("CHAT2DESK_API_TOKEN не задан");
  }

  async get(path, params = {}, optional = false) {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { headers: { Authorization: this.token, Accept: "application/json" } });
    const text = await response.text();
    if (optional && [400, 404, 405, 422].includes(response.status)) return null;
    if (!response.ok) throw new Error(`Chat2Desk GET ${url.pathname}: HTTP ${response.status} ${text.slice(0, 700)}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Chat2Desk GET ${url.pathname}: не JSON: ${text.slice(0, 500)}`); }
  }

  stateStub() {
    if (!this.env?.BOT_STATE) return null;
    return this.env.BOT_STATE.get(this.env.BOT_STATE.idFromName("global"));
  }

  async gatewayOffsetCollection(path, query = {}, options = {}) {
    const requestedLimit = Number(options.requestedLimit || 200);
    const chunkPages = Number(options.chunkPages || 18);
    const cacheTtlMs = Number(options.cacheTtlMs || 300000);
    const stub = this.stateStub();

    if (!stub) {
      const all = [];
      let offset = 0;
      for (let guard = 0; guard < 500; guard += 1) {
        const payload = await this.get(path, { ...query, limit: requestedLimit, offset });
        const rows = rowsFrom(payload);
        const meta = metaFrom(payload, offset, requestedLimit);
        all.push(...rows);
        if ((meta.total !== null && meta.offset + rows.length >= meta.total) || rows.length < meta.limit) break;
        const next = meta.offset + meta.limit;
        if (next <= offset) throw new Error(`${path} pagination stalled`);
        offset = next;
      }
      return all;
    }

    const all = [];
    let cursor = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const response = await stub.fetch("https://state/offset-pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base: this.base,
          token: this.token,
          path,
          query,
          cursor,
          requested_limit: requestedLimit,
          max_pages: chunkPages,
          cache_ttl_ms: cacheTtlMs,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(`Collection gateway ${path}: ${data.error || response.status}`);
      all.push(...(data.rows || []));
      if (data.done) break;
      const next = Number(data.next_offset);
      if (!Number.isFinite(next) || next <= cursor) throw new Error(`Collection gateway ${path}: offset stalled`);
      cursor = next;
    }
    return all;
  }

  async operators() {
    const rows = await this.gatewayOffsetCollection("/v1/operators", {}, { cacheTtlMs: 30000, chunkPages: 5 });
    const byId = new Map();
    for (const row of rows) {
      const id = this.operatorId(row);
      if (id !== null) byId.set(id, row);
    }
    return [...byId.values()];
  }

  async dialogs() {
    const rows = await this.gatewayOffsetCollection("/v1/dialogs", { state: "open" }, { cacheTtlMs: 15000, chunkPages: 10 });
    return rows.filter((row) => String(row?.state || "").toLowerCase() === "open");
  }

  async dialogsForClient(clientId) {
    const payload = await this.get(`/v1/clients/${Number(clientId)}/dialogs`, {}, true);
    return payload ? rowsFrom(payload) : [];
  }

  async allClients() {
    const rows = await this.gatewayOffsetCollection("/v1/clients", {}, { cacheTtlMs: 300000, chunkPages: 18 });
    const byId = new Map();
    for (const row of rows) {
      const id = this.clientId(row);
      if (id !== null) byId.set(id, row);
    }
    return [...byId.values()];
  }

  async searchClients(query, maxResults = 10) {
    const q = String(query || "").trim();
    if (!q) return [];
    // Live tenant diagnostics showed that name/assigned_name/nickname/search query
    // parameters are ignored by GET /v1/clients. Therefore search the complete,
    // cached client collection locally instead of trusting server-side filtering.
    const clients = await this.allClients();
    return clients.filter((row) => this.clientMatches(row, q)).slice(0, maxResults);
  }

  messageId(row) { return entityId(row, ["id", "message_id", "messageID", "messageId"]); }
  messageRequestId(row) { return entityId(row, ["request_id", "requestID", "requestId"]); }

  async requestIdsForClient(clientId) {
    const numericClientId = Number(clientId);
    const stub = this.stateStub();
    if (!stub) return this.requestIdsForClientDirect(numericClientId);

    const ids = new Set();
    let cursor = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const response = await stub.fetch("https://state/client-request-pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base: this.base,
          token: this.token,
          client_id: numericClientId,
          cursor,
          requested_limit: 200,
          max_pages: 18,
          cache_ttl_ms: 600000,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(`Message gateway client ${numericClientId}: ${data.error || response.status}`);
      for (const id of data.request_ids || []) {
        const n = asInt(id);
        if (n !== null) ids.add(n);
      }
      if (data.done) break;
      const next = asInt(data.next_start_id);
      if (next === null || next === cursor) throw new Error(`Message gateway client ${numericClientId}: start_id stalled`);
      cursor = next;
    }

    // Some dialogs may expose a request id even if there are no messages in the
    // current page sequence. Add them as a cheap supplementary source.
    const dialogs = await this.dialogsForClient(numericClientId).catch(() => []);
    for (const dialog of dialogs) {
      const rid = entityId(dialog, ["last_request_id", "request_id", "requestID", "requestId"]);
      if (rid !== null) ids.add(rid);
    }
    return [...ids];
  }

  async requestIdsForClientDirect(clientId) {
    const ids = new Set();
    let startId = null;
    for (let guard = 0; guard < 500; guard += 1) {
      const params = { client_id: Number(clientId), limit: 200 };
      if (startId !== null) params.start_id = startId;
      const payload = await this.get("/v1/messages", params);
      const rows = rowsFrom(payload);
      if (!rows.length) break;
      let maxId = startId;
      for (const row of rows) {
        const rid = this.messageRequestId(row);
        if (rid !== null) ids.add(rid);
        const mid = this.messageId(row);
        if (mid !== null && (maxId === null || mid > maxId)) maxId = mid;
      }
      const limit = asInt(payload?.meta?.limit) || rows.length || 200;
      if (rows.length < limit) break;
      if (maxId === null || maxId === startId) break;
      startId = maxId;
    }
    return [...ids];
  }

  ticketRequestIds(row) {
    const out = new Set();
    const add = (value) => {
      if (Array.isArray(value)) { for (const x of value) add(x); return; }
      if (value && typeof value === "object") {
        const n = entityId(value, ["request_id", "requestID", "requestId", "id"]);
        if (n !== null) out.add(n);
        return;
      }
      const n = asInt(value);
      if (n !== null) out.add(n);
    };
    add(row?.request_ids);
    add(row?.requestIds);
    add(row?.requests);
    add(row?.request_id);
    add(row?.requestId);
    return [...out];
  }

  ticketHasRequest(row, requestId) {
    return this.ticketRequestIds(row).includes(Number(requestId));
  }

  async allTickets() {
    const rows = await this.gatewayOffsetCollection("/v1/tickets", {}, { cacheTtlMs: 60000, chunkPages: 18 });
    const byKey = new Map();
    for (const row of rows) {
      if (!looksLikeTicket(row)) continue;
      const key = this.ticketId(row);
      if (key) byKey.set(key, row);
    }
    if (!byKey.size && rows.length) {
      const shape = rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).slice(0, 20).join(",") : typeof rows[0];
      throw new Error(`GET /v1/tickets: получено ${rows.length} строк, но ни одна не похожа на тикет. First keys: ${shape}`);
    }
    return { tickets: [...byKey.values()], normalizedRows: rows.length, source: "GET /v1/tickets via Durable Object cache" };
  }

  async ticketsForClient(clientId) {
    const numericClientId = Number(clientId);
    const [all, discovered] = await Promise.all([this.allTickets(), this.requestIdsForClient(numericClientId)]);
    const wanted = new Set(discovered.map(Number));
    const found = [];
    const matchedRequestIds = new Set();

    for (const ticket of all.tickets) {
      const ticketIds = this.ticketRequestIds(ticket);
      const matches = ticketIds.filter((id) => wanted.has(Number(id)));
      if (!matches.length) continue;
      found.push(ticket);
      for (const id of matches) matchedRequestIds.add(Number(id));
    }

    found.sort((a, b) => this.ticketSortValue(b) - this.ticketSortValue(a));
    return {
      tickets: found,
      truncated: false,
      requestIds: discovered,
      directRequestIds: [...matchedRequestIds],
      scannedTickets: all.tickets.length,
      normalizedTicketRows: all.normalizedRows,
      ticketPayloadShape: "live: data[] with id=TICK-N and request_ids[]",
      matchMode: "ticket.request_ids ∩ client.messages.request_id",
    };
  }

  async ticketsForRequest(requestId) {
    const all = await this.allTickets();
    return all.tickets.filter((ticket) => this.ticketHasRequest(ticket, requestId));
  }

  async searchTickets(query, maxResults = 10) {
    const q = String(query || "").trim();
    if (!q) return { tickets: [], truncated: false };
    const all = await this.allTickets();
    const needle = q.toLowerCase().replace(/^#/, "").trim();
    const numericNeedle = /^\d+$/.test(needle) ? Number(needle) : null;
    const exact = [];
    const partial = [];

    for (const row of all.tickets) {
      const id = String(this.ticketId(row) || "").toLowerCase();
      const number = id.match(/(\d+)$/)?.[1] || "";
      const title = this.ticketTitle(row).toLowerCase();
      if ((numericNeedle !== null && Number(number) === numericNeedle) || id === needle || id === `tick-${needle}`) exact.push(row);
      else if (title.includes(needle) || id.includes(needle)) partial.push(row);
    }
    const rows = exact.length ? exact : partial;
    return { tickets: rows.slice(0, maxResults), truncated: rows.length > maxResults, exact: exact.length > 0 };
  }

  async getTicket(idOrNumber) {
    const result = await this.searchTickets(idOrNumber, 20);
    return result.tickets[0] || null;
  }

  async getTicketByInternalId(idOrNumber) {
    return this.getTicket(idOrNumber);
  }

  payloadShape(payload) {
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (!payload || typeof payload !== "object") return typeof payload;
    return `{${Object.keys(payload).slice(0, 16).map((key) => {
      const value = payload[key];
      if (Array.isArray(value)) return `${key}:array(${value.length})`;
      if (value && typeof value === "object") return `${key}:object(${Object.keys(value).slice(0, 8).join(",")})`;
      return `${key}:${typeof value}`;
    }).join("; ")}}`;
  }

  clientId(row) { return entityId(row, ["id", "client_id", "clientID"]); }
  clientName(row) { return String(first(row, ["assigned_name", "nickname", "name", "client_name"], "Без имени")); }
  clientLabel(row) {
    const primary = this.clientName(row);
    const id = this.clientId(row);
    const messengerName = String(first(row, ["name", "nickname"], "") || "").trim();
    const phone = String(first(row, ["client_phone", "phone"], "") || "").trim();
    const details = [];
    if (messengerName && messengerName.toLowerCase() !== primary.toLowerCase()) details.push(messengerName);
    if (phone) details.push(phone);
    if (id !== null) details.push(`ID ${id}`);
    return details.length ? `${primary} · ${details.slice(0, 2).join(" · ")}` : primary;
  }
  clientMatches(row, query) {
    const needle = String(query).toLowerCase();
    return ["assigned_name", "nickname", "name", "client_name", "phone", "client_phone", "external_id", "client_external_id"]
      .some((key) => row?.[key] !== undefined && row?.[key] !== null && String(row[key]).toLowerCase().includes(needle));
  }

  // In the live Tickets list the primary identifier is a STRING like "TICK-910".
  // It is not an internal numeric id.
  ticketId(row) { return ticketKeyValue(row); }
  ticketIssueId(row) { return ticketKeyValue(row); }
  ticketNumber(row) { return ticketKeyValue(row) || "—"; }
  ticketSortValue(row) {
    const match = String(this.ticketNumber(row)).match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }
  ticketRequests(row) { return Array.isArray(row?.requests) ? row.requests.filter((x) => x && typeof x === "object") : []; }
  requestId(row) { return entityId(row, ["request_id", "requestID", "requestId", "id"]); }
  requestClientId(row) { return entityId(row, ["client_id", "clientID", "clientId"]); }
  ticketTitle(row) { return String(first(row, ["summary", "title", "subject", "name"], "Без названия") || "Без названия"); }
  ticketDescription(row) { return String(first(row, ["description", "comment", "details", "body", "text"], "—") || "—"); }
  ticketRawKeys(row) { return row && typeof row === "object" ? Object.keys(row).sort() : []; }

  operatorId(row) { return entityId(row, ["id", "operator_id", "operatorID"]); }
  operatorName(row) {
    const full = [row?.first_name ?? row?.firstName, row?.last_name ?? row?.lastName].filter(Boolean).join(" ").trim();
    return full || String(first(row, ["name", "full_name", "fullName", "email"], "Без имени"));
  }
  operatorOnline(row) { return Boolean(Number(first(row, ["online", "is_online", "isOnline"], 0))); }
  operatorDialogsCount(row) { return asInt(first(row, ["opened_dialogs", "openedDialogs", "dialogs_count", "dialogsCount"], 0)) ?? 0; }

  dialogId(row) { return entityId(row, ["id", "dialog_id", "dialogID"]); }
  dialogOperatorId(row) { return entityId(row, ["operator_id", "operatorID", "operatorId"]); }
  dialogClientId(row) { return entityId(row, ["client_id", "clientID", "clientId"]) ?? entityId(row?.last_message, ["client_id", "clientID", "clientId"]); }
  dialogClientName(row) { return String(first(row, ["client_name", "clientName", "name"], "Клиент")); }
}
