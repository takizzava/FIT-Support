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

function nonEmptyText(value) {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  return null;
}

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-zа-я0-9]/gi, "");
}

function deepCollect(payload, predicate) {
  const out = [];
  const seenObjects = new Set();
  const seenEntities = new Set();
  const stack = [payload];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (seenObjects.has(value)) continue;
    seenObjects.add(value);

    if (!Array.isArray(value) && predicate(value)) {
      const id = first(value, ["id", "ticket_id", "operator_id", "client_id", "dialog_id"], null);
      const key = `${predicate.name}:${id ?? JSON.stringify(value).slice(0, 200)}`;
      if (!seenEntities.has(key)) {
        seenEntities.add(key);
        out.push(value);
      }
      continue; // Do not recurse into an entity and accidentally collect nested request/operator/client objects.
    }

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i]);
    } else {
      const vals = Object.values(value);
      for (let i = vals.length - 1; i >= 0; i -= 1) stack.push(vals[i]);
    }
  }
  return out;
}

function isTicket(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const id = asInt(first(row, ["id", "ticket_id", "ticketID"]));
  if (id === null) return false;
  return row.issue_id !== undefined || row.issueId !== undefined || row.summary !== undefined || row.description !== undefined || Array.isArray(row.requests);
}

function isOperator(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const id = asInt(first(row, ["id", "operator_id", "operatorID"]));
  if (id === null) return false;
  return ["first_name", "firstName", "last_name", "lastName", "online", "opened_dialogs", "email", "role"].some((k) => row[k] !== undefined);
}

function isClient(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const id = asInt(first(row, ["id", "client_id", "clientID"]));
  if (id === null) return false;
  return ["assigned_name", "nickname", "client_phone", "phone", "external_id"].some((k) => row[k] !== undefined);
}

function isDialog(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const id = asInt(first(row, ["id", "dialog_id", "dialogID"]));
  if (id === null) return false;
  return row.state !== undefined || row.operator_id !== undefined || row.last_request_id !== undefined || row.begin !== undefined || row.last_message !== undefined;
}

function isMessage(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const id = asInt(first(row, ["id", "message_id", "messageID"]));
  if (id === null) return false;
  return row.request_id !== undefined || row.type !== undefined || row.transport !== undefined || row.text !== undefined;
}

// Backward-compatible generic helper used by tests/legacy call sites.
export function dataList(payload) {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object");
  // Prefer likely entity collections, but search recursively through arbitrary envelopes.
  for (const pred of [isTicket, isOperator, isClient, isDialog, isMessage]) {
    const rows = deepCollect(payload, pred);
    if (rows.length) return rows;
  }
  return [];
}

function extractTickets(payload) { return deepCollect(payload, isTicket); }
function extractOperators(payload) { return deepCollect(payload, isOperator); }
function extractClients(payload) { return deepCollect(payload, isClient); }
function extractDialogs(payload) { return deepCollect(payload, isDialog); }
function extractMessages(payload) { return deepCollect(payload, isMessage); }

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
    if (optional && [400, 404, 405, 422].includes(response.status)) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`Chat2Desk GET ${url.pathname}: HTTP ${response.status} ${text.slice(0, 700)}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Chat2Desk GET ${url.pathname}: не JSON: ${text.slice(0, 500)}`); }
  }

  async operators() {
    const rows = [];
    const seen = new Map();
    let offset = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const payload = await this.get("/v1/operators", { limit: 200, offset });
      const page = extractOperators(payload);
      for (const row of page) { const id = this.operatorId(row); if (id !== null) seen.set(id, row); }
      const total = asInt(payload?.meta?.total);
      const limit = asInt(payload?.meta?.limit) || page.length || 200;
      const currentOffset = asInt(payload?.meta?.offset) ?? offset;
      if ((total !== null && currentOffset + page.length >= total) || page.length < limit) break;
      offset = currentOffset + limit;
    }
    rows.push(...seen.values());
    return rows;
  }

  async dialogs() {
    const seen = new Map();
    const scan = async (params, filterOpen = false) => {
      let offset = 0;
      for (let guard = 0; guard < 200; guard += 1) {
        const payload = await this.get("/v1/dialogs", { ...params, limit: 200, offset }, true);
        if (!payload) return false;
        const raw = extractDialogs(payload);
        const page = filterOpen ? raw.filter((d) => String(d.state || "").toLowerCase() !== "closed") : raw;
        for (const row of page) { const id = this.dialogId(row); if (id !== null) seen.set(id,row); }
        const total = asInt(payload?.meta?.total);
        const limit = asInt(payload?.meta?.limit) || raw.length || 200;
        const currentOffset = asInt(payload?.meta?.offset) ?? offset;
        if ((total !== null && currentOffset + raw.length >= total) || raw.length < limit) break;
        offset = currentOffset + limit;
      }
      return true;
    };
    const supported = await scan({ state: "open" }, false);
    if (supported && seen.size) return [...seen.values()];
    seen.clear();
    await scan({}, true);
    return [...seen.values()];
  }

  async dialogsForClient(clientId) {
    const payload = await this.get(`/v1/clients/${Number(clientId)}/dialogs`, {}, true);
    return payload ? extractDialogs(payload) : [];
  }

  async searchClients(query, maxResults = 10, fallbackPages = 10) {
    const q = String(query || "").trim();
    if (!q) return [];
    const found = new Map();
    for (const key of ["name", "assigned_name", "nickname"]) {
      const payload = await this.get("/v1/clients", { [key]: q, limit: 200, offset: 0 }, true);
      if (!payload) continue;
      for (const row of extractClients(payload)) {
        const id = this.clientId(row);
        if (id !== null && this.clientMatches(row, q)) found.set(id, row);
      }
      if (found.size >= maxResults) break;
    }
    if (found.size < maxResults) {
      let offset = 0;
      for (let page = 0; page < fallbackPages; page += 1) {
        const payload = await this.get("/v1/clients", { limit: 200, offset });
        const rows = extractClients(payload);
        for (const row of rows) {
          const id = this.clientId(row);
          if (id !== null && this.clientMatches(row, q)) found.set(id, row);
          if (found.size >= maxResults) break;
        }
        const total = asInt(payload?.meta?.total);
        const limit = asInt(payload?.meta?.limit) || rows.length || 200;
        const currentOffset = asInt(payload?.meta?.offset) ?? offset;
        if (found.size >= maxResults || (total !== null && currentOffset + rows.length >= total) || rows.length < limit) break;
        offset = currentOffset + limit;
      }
    }
    return [...found.values()].slice(0, maxResults);
  }

  messageId(row) { return asInt(first(row, ["id", "message_id", "messageID", "messageId"])); }
  messageRequestId(row) { return asInt(first(row, ["request_id", "requestID", "requestId"], row?.request?.id)); }

  async messagesForClient(clientId, maxPages = 15) {
    const byId = new Map();
    let startId = null;
    for (let page = 0; page < maxPages; page += 1) {
      const params = { client_id: Number(clientId), limit: 200 };
      if (startId !== null) { params.start_id = startId; params.direction_reverse = true; }
      const payload = await this.get("/v1/messages", params, true);
      if (!payload) break;
      const rows = extractMessages(payload);
      if (!rows.length) break;
      for (const row of rows) {
        const id = this.messageId(row);
        byId.set(id ?? `row:${byId.size}`, row);
      }
      if (rows.length < 200) break;
      const ids = rows.map((r) => this.messageId(r)).filter((id) => id !== null);
      if (!ids.length) break;
      const next = Math.min(...ids);
      if (next === startId || next <= 1) break;
      startId = next;
    }
    return [...byId.values()];
  }

  async requestIdsForClient(clientId) {
    const [messages, dialogs] = await Promise.all([this.messagesForClient(clientId), this.dialogsForClient(clientId)]);
    const ids = new Set();
    for (const message of messages) {
      const rid = this.messageRequestId(message);
      if (rid !== null) ids.add(rid);
    }
    for (const dialog of dialogs) {
      const rid = asInt(first(dialog, ["last_request_id", "lastRequestId", "request_id", "requestID"]));
      if (rid !== null) ids.add(rid);
    }
    return [...ids];
  }


  ticketRequestIds(row) {
    const out = new Set();
    const values = [];
    if (Array.isArray(row?.requests)) values.push(...row.requests);
    for (const key of ["request_ids", "requestIds", "requests_ids", "request", "request_id", "requestID", "requestId"]) {
      if (row?.[key] !== undefined) values.push(row[key]);
    }
    const walk = (value) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) { for (const x of value) walk(x); return; }
      if (typeof value === "object") {
        const n = asInt(first(value, ["request_id", "requestID", "requestId", "id", "number"]));
        if (n !== null) out.add(n);
        return;
      }
      const n = asInt(value);
      if (n !== null) out.add(n);
    };
    for (const value of values) walk(value);
    return [...out];
  }

  ticketHasRequest(row, requestId) {
    return this.ticketRequestIds(row).includes(Number(requestId));
  }

  async ticketsForRequest(requestId) {
    // Compatibility path for API modes that support filtering by request_id.
    const filtered = await this.get("/v1/tickets", { request_id: Number(requestId) }, true);
    if (filtered) {
      const rows = extractTickets(filtered);
      if (rows.length) {
        const related = rows.filter((ticket) => {
          const ids = this.ticketRequestIds(ticket);
          return ids.length === 0 || ids.includes(Number(requestId));
        });
        if (related.length) return related;
      }
    }
    const all = await this.allTickets();
    return all.tickets.filter((ticket) => this.ticketRequestIds(ticket).includes(Number(requestId)));
  }

  ticketRowsFromPayload(payload) {
    // /v1/tickets has a stable collection contract in this tenant:
    // { data: [...], meta: { total, limit, offset }, status: ... }.
    // Do NOT try to infer whether data[] items are tickets: the endpoint itself
    // guarantees that. This is deliberately different from generic entity parsing.
    if (Array.isArray(payload)) return payload.filter((row) => row && typeof row === "object");
    if (payload && Array.isArray(payload.data)) return payload.data.filter((row) => row && typeof row === "object");
    if (payload?.result && Array.isArray(payload.result.data)) return payload.result.data.filter((row) => row && typeof row === "object");
    if (payload?.response && Array.isArray(payload.response.data)) return payload.response.data.filter((row) => row && typeof row === "object");
    return extractTickets(payload);
  }

  async allTickets() {
    // Route large ticket scans through the existing Durable Object. Each DO invocation
    // fetches at most 18 external pages, so the Free-plan 50-subrequest ceiling is not
    // tied to Telegram API calls in the parent Worker invocation. Pages are cached in
    // DO storage for 60 seconds.
    if (this.env?.BOT_STATE) {
      const stub = this.env.BOT_STATE.get(this.env.BOT_STATE.idFromName("global"));
      const byId = new Map();
      let cursor = 0;
      let total = null;
      let actualLimit = null;
      let gatewayCalls = 0;
      let normalizedRows = 0;
      for (let guard = 0; guard < 100; guard += 1) {
        const response = await stub.fetch("https://state/ticket-pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ base: this.base, token: this.token, cursor, requested_limit: 200, max_pages: 18, cache_ttl_ms: 60000 }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(`Ticket gateway: ${data.error || response.status}`);
        gatewayCalls += 1;
        total = data.total ?? total;
        actualLimit = data.limit ?? actualLimit;
        for (const row of data.tickets || []) {
          normalizedRows += 1;
          const id = this.ticketId(row);
          if (id !== null) byId.set(id, row);
        }
        if (data.done) break;
        const next = Number(data.next_offset);
        if (!Number.isFinite(next) || next <= cursor) throw new Error("Ticket gateway не продвинул offset");
        cursor = next;
      }
      if (!byId.size && Number(total || 0) > 0) throw new Error(`Ticket gateway получил ${normalizedRows} строк, но ticket id не найден`);
      return { tickets: [...byId.values()], rawShape: `gateway(limit=${actualLimit}, total=${total})`, normalizedRows, source: `DurableObject ticket gateway (${gatewayCalls} chunks)` };
    }

    // Local/test fallback.
    const byId = new Map();
    let offset = 0;
    let total = null;
    let actualLimit = 200;
    let normalizedRows = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const payload = await this.get("/v1/tickets", { limit: guard === 0 ? 200 : actualLimit, offset });
      const rows = this.ticketRowsFromPayload(payload);
      normalizedRows += rows.length;
      for (const row of rows) { const id = this.ticketId(row); if (id !== null) byId.set(id,row); }
      total = asInt(payload?.meta?.total) ?? total;
      actualLimit = asInt(payload?.meta?.limit) || rows.length || actualLimit;
      const currentOffset = asInt(payload?.meta?.offset) ?? offset;
      if ((total !== null && currentOffset + rows.length >= total) || rows.length < actualLimit) break;
      const next = currentOffset + actualLimit;
      if (next <= offset) throw new Error("GET /v1/tickets pagination stalled");
      offset = next;
    }
    return { tickets:[...byId.values()], rawShape:`direct(total=${total},limit=${actualLimit})`, normalizedRows, source:"GET /v1/tickets paginated" };
  }

  async ticketsForClient(clientId) {
    const numericClientId = Number(clientId);
    const all = await this.allTickets();
    const found = [];
    const requestIds = new Set();
    for (const ticket of all.tickets) {
      const matches = this.ticketRequests(ticket).filter((r) => this.requestClientId(r) === numericClientId);
      if (!matches.length) continue;
      found.push(ticket);
      for (const req of matches) {
        const rid = this.requestId(req);
        if (rid !== null) requestIds.add(rid);
      }
    }
    if (found.length) {
      found.sort((a, b) => this.ticketSortValue(b) - this.ticketSortValue(a));
      return {
        tickets: found,
        truncated: false,
        requestIds: [...requestIds],
        directRequestIds: [...requestIds],
        scannedTickets: all.tickets.length,
        ticketPayloadShape: all.rawShape,
        normalizedTicketRows: all.normalizedRows,
        matchMode: "ticket.requests.client_id",
      };
    }

    // Compatibility fallback: some API modes expose request relations but not client_id
    // inside ticket.requests. Recover the client's request ids via messages/dialogs and
    // match those ids against each ticket.
    const discovered = await this.requestIdsForClient(numericClientId).catch(() => []);
    const wanted = new Set(discovered.map(Number));
    if (wanted.size) {
      for (const ticket of all.tickets) {
        if (this.ticketRequestIds(ticket).some((id) => wanted.has(Number(id)))) found.push(ticket);
      }
    }
    found.sort((a, b) => this.ticketSortValue(b) - this.ticketSortValue(a));
    return {
      tickets: found,
      truncated: false,
      requestIds: discovered,
      directRequestIds: [],
      scannedTickets: all.tickets.length,
      ticketPayloadShape: all.rawShape,
      normalizedTicketRows: all.normalizedRows,
      matchMode: found.length ? "request-id-fallback" : "none",
    };
  }

  async getTicketByInternalId(id) {
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return null;
    const direct = await this.get(`/v1/tickets/${Math.trunc(numeric)}`, {}, true);
    if (!direct) return null;
    const rows = extractTickets(direct);
    if (rows.length) return rows[0];
    return isTicket(direct) ? direct : null;
  }

  async searchTickets(query, maxResults = 10) {
    const q = String(query || "").trim();
    if (!q) return { tickets: [], truncated: false };
    const all = await this.allTickets();
    const needle = q.toLowerCase().replace(/^#/, "").trim();
    const numeric = /^\d+$/.test(needle) ? Number(needle) : null;
    const exact = [];
    const partial = [];
    for (const row of all.tickets) {
      const internalId = this.ticketId(row);
      const issue = String(this.ticketIssueId(row) || "").toLowerCase();
      const title = this.ticketTitle(row).toLowerCase();
      const issueNumeric = issue.match(/(\d+)$/)?.[1] || "";
      if ((numeric !== null && Number(issueNumeric) === numeric) || issue === needle || issue === `tick-${needle}`) exact.push(row);
      else if (title.includes(needle) || issue.includes(needle) || String(internalId ?? "").includes(needle)) partial.push(row);
    }
    const rows = exact.length ? exact : partial;
    return { tickets: rows.slice(0, maxResults), truncated: rows.length > maxResults, exact: exact.length > 0 };
  }

  async getTicket(number) {
    const result = await this.searchTickets(number, 20);
    if (result.tickets.length) return result.tickets[0];
    const raw = String(number || "").replace(/\D/g, "");
    return raw ? this.getTicketByInternalId(Number(raw)) : null;
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

  clientId(row) { return asInt(first(row, ["id", "client_id", "clientID"])); }
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
    return ["assigned_name", "nickname", "name", "client_name", "phone", "client_phone", "external_id"]
      .some((key) => row?.[key] !== undefined && String(row[key]).toLowerCase().includes(needle));
  }

  ticketId(row) { return asInt(first(row, ["id", "ticket_id", "ticketID"])); }
  ticketIssueId(row) {
    const value = first(row, ["issue_id", "issueId", "ticket_number", "ticketNumber", "number"], null);
    return value === null || value === undefined || value === "" ? null : String(value);
  }
  ticketNumber(row) { return this.ticketIssueId(row) || String(this.ticketId(row) ?? "—"); }
  ticketSortValue(row) {
    const issue = this.ticketIssueId(row);
    const match = issue ? issue.match(/(\d+)$/) : null;
    return match ? Number(match[1]) : (this.ticketId(row) || 0);
  }
  ticketRequests(row) { return Array.isArray(row?.requests) ? row.requests.filter((x) => x && typeof x === "object") : []; }
  requestId(row) { return asInt(first(row, ["request_id", "requestID", "requestId", "id"])); }
  requestClientId(row) { return asInt(first(row, ["client_id", "clientID", "clientId"], row?.client?.id)); }
  ticketTitle(row) {
    if (!row || typeof row !== "object") return "Без названия";
    const directKeys = ["summary", "title", "subject", "name", "theme", "topic", "headline", "header", "ticket_title", "ticketTitle"];
    for (const key of directKeys) {
      const value = nonEmptyText(row[key]);
      if (value) return value;
    }
    // Compatibility with API modes that wrap attributes/fields.
    const queue = [row];
    const seen = new Set();
    while (queue.length) {
      const obj = queue.shift();
      if (!obj || typeof obj !== "object" || seen.has(obj)) continue;
      seen.add(obj);
      for (const [key, value] of Object.entries(obj)) {
        const nk = normalizeKey(key);
        if (["summary","title","subject","name","theme","topic","headline","header","tickettitle","issuetitle"].includes(nk)) {
          const text = nonEmptyText(value);
          if (text) return text;
        }
      }
      for (const key of ["data","attributes","fields","ticket","issue"]) if (obj[key] && typeof obj[key] === "object") queue.push(obj[key]);
    }
    return "Без названия";
  }
  ticketDescription(row) { return String(first(row, ["description", "ticket_description", "ticketDescription", "comment", "details", "body", "text"], "—") || "—"); }
  ticketRawKeys(row) { return row && typeof row === "object" ? Object.keys(row).sort() : []; }

  dialogId(row) { return asInt(first(row, ["id", "dialog_id", "dialogID"])); }
  dialogOperatorId(row) { return asInt(first(row, ["operator_id", "operatorID", "operatorId"], row?.operator?.id)); }
  dialogClientId(row) { return asInt(first(row, ["client_id", "clientID", "clientId"], row?.client?.id)); }
  dialogClientName(row) { return String(first(row?.client || {}, ["assigned_name", "nickname", "name"], first(row, ["client_name", "name"], "Клиент"))); }
  operatorId(row) { return asInt(first(row, ["id", "operator_id", "operatorID"])); }
  operatorName(row) {
    const direct = first(row, ["name", "full_name", "fullName", "assigned_name"]);
    if (direct) return String(direct);
    const f = first(row, ["first_name", "firstName", "FirstName"], "");
    const l = first(row, ["last_name", "lastName", "LastName"], "");
    return `${f || ""} ${l || ""}`.trim() || "Без имени";
  }
  operatorOnline(row) { return [true, 1, "1", "true", "online"].includes(first(row, ["online", "is_online", "isOnline"], false)); }
  operatorDialogsCount(row) { return asInt(first(row, ["opened_dialogs", "open_dialogs_count", "opened_dialogs_count", "dialogs_count", "openDialogsCount"])); }
}
