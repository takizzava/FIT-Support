function dataList(payload) {
  // Chat2Desk uses several response envelopes across API methods / API modes.
  // Normalize all known shapes recursively so callers always receive entity rows:
  //   [row]
  //   {"0": row, "1": row}
  //   {data: [...]}
  //   {data: {"0": row}}
  //   {data: {tickets: [...]}}
  //   {result: {operators: [...]}}
  // Do not treat an entity object itself as a collection unless it sits under
  // a known singular envelope.
  const seen = new Set();

  function unwrap(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
    if (typeof value !== "object") return [];
    if (seen.has(value)) return [];
    seen.add(value);

    const numericRows = Object.entries(value)
      .filter(([key, child]) => /^\d+$/.test(key) && child && typeof child === "object")
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, child]) => child);
    if (numericRows.length) return numericRows;

    // Collection/envelope keys observed or commonly used by Chat2Desk APIs.
    for (const key of [
      "tickets", "operators", "clients", "dialogs", "messages", "requests",
      "items", "rows", "records", "results", "result", "data", "response",
    ]) {
      if (value[key] === undefined || value[key] === null) continue;
      const rows = unwrap(value[key], depth + 1);
      if (rows.length) return rows;
    }

    return [];
  }

  return unwrap(payload);
}


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
  if (value && typeof value === "object") {
    for (const key of ["value", "text", "title", "name", "subject", "label"]) {
      const nested = nonEmptyText(value[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-zа-я0-9]/gi, "");
}

class Chat2DeskAPI {
  constructor(env) {
    this.base = String(env.CHAT2DESK_API_BASE || "https://api.chat2desk.com").replace(/\/$/, "");
    this.token = env.CHAT2DESK_API_TOKEN;
    if (!this.token) throw new Error("CHAT2DESK_API_TOKEN не задан");
  }

  async get(path, params = {}, optional = false) {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      headers: { Authorization: this.token, Accept: "application/json" },
    });
    if (optional && [400, 404, 405, 422].includes(response.status)) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Chat2Desk GET ${url.pathname}: HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    return response.json();
  }

  async paginated(path, params = {}, maxPages = 10) {
    const result = [];
    const limit = Math.min(Number(params.limit || 200), 200);
    let offset = Number(params.offset || 0);
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.get(path, { ...params, limit, offset });
      const rows = dataList(payload);
      result.push(...rows);
      if (rows.length < limit) break;
      offset += rows.length;
    }
    return result;
  }

  async operators() {
    return this.paginated("/v1/operators", {}, 5);
  }

  async dialogs() {
    let payload = await this.get("/v1/dialogs", { state: "opened", limit: 200, offset: 0 }, true);
    if (payload && dataList(payload).length) return dataList(payload);
    payload = await this.get("/v1/dialogs", { limit: 200, offset: 0 });
    return dataList(payload);
  }

  async dialogsForClient(clientId) {
    const payload = await this.get(`/v1/clients/${Number(clientId)}/dialogs`, { limit: 200, offset: 0 }, true);
    return payload ? dataList(payload) : [];
  }

  async searchClients(query, maxResults = 10, fallbackPages = 10) {
    const q = String(query || "").trim();
    if (!q) return [];
    const found = new Map();
    for (const key of ["name", "assigned_name", "nickname"]) {
      const payload = await this.get("/v1/clients", { [key]: q, limit: 200, offset: 0 }, true);
      if (!payload) continue;
      for (const row of dataList(payload)) {
        const id = this.clientId(row);
        if (id !== null && this.clientMatches(row, q)) found.set(id, row);
      }
      if (found.size >= maxResults) break;
    }
    if (found.size < maxResults) {
      const rows = await this.paginated("/v1/clients", {}, fallbackPages);
      for (const row of rows) {
        const id = this.clientId(row);
        if (id !== null && this.clientMatches(row, q)) found.set(id, row);
        if (found.size >= maxResults) break;
      }
    }
    return [...found.values()].slice(0, maxResults);
  }

  messageId(row) {
    return asInt(first(row, ["id", "message_id", "messageID", "messageId"]));
  }

  messageRequestId(row) {
    return asInt(first(row, ["request_id", "requestID", "requestId"], row?.request?.id));
  }

  async messagesForClient(clientId, maxPages = 15) {
    // В Public API Chat2Desk нет общего GET /requests. Request ID присутствует в
    // сообщениях. Messages (GET) использует start_id вместо offset, поэтому именно
    // через сообщения восстанавливаем все обращения клиента.
    const byId = new Map();
    let startId = null;
    let previousBoundary = null;

    for (let page = 0; page < maxPages; page += 1) {
      const params = {
        client_id: Number(clientId),
        limit: 200,
      };
      // Первый запрос берём обычным способом. Для следующих страниц Chat2Desk
      // документирует direction_reverse=true + start_id как способ получать более
      // ранние сообщения.
      if (startId !== null) {
        params.start_id = startId;
        params.direction_reverse = true;
      }
      const payload = await this.get("/v1/messages", params, true);
      if (!payload) break;
      const rows = dataList(payload);
      if (!rows.length) break;

      for (const row of rows) {
        const id = this.messageId(row);
        if (id !== null) byId.set(id, row);
        else byId.set(`row:${byId.size}`, row);
      }

      if (rows.length < 200) break;
      const ids = rows.map((r) => this.messageId(r)).filter((id) => id !== null);
      if (!ids.length) break;
      const boundary = Math.min(...ids);
      if (boundary === previousBoundary || boundary <= 1) break;
      previousBoundary = boundary;
      startId = boundary;
    }
    return [...byId.values()];
  }

  async requestIdsForClient(clientId) {
    const [messages, dialogs] = await Promise.all([
      this.messagesForClient(clientId),
      this.dialogsForClient(clientId),
    ]);
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
    const values = [];
    const pushValue = (value) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        for (const item of value) pushValue(item);
        return;
      }
      if (typeof value === "object") {
        const nested = first(value, ["id", "request_id", "requestID", "requestId", "number"]);
        const n = asInt(nested);
        if (n !== null) values.push(n);
        return;
      }
      const n = asInt(value);
      if (n !== null) values.push(n);
    };

    for (const key of [
      "requests", "request_ids", "requestIds", "requests_ids", "appeals", "appeal_ids",
      "request", "request_id", "requestID", "requestId",
    ]) {
      if (row?.[key] !== undefined) pushValue(row[key]);
    }
    if (row?.data && typeof row.data === "object") {
      for (const key of ["requests", "request_ids", "request_id"]) pushValue(row.data[key]);
    }
    return [...new Set(values)];
  }

  async ticketsForRequest(requestId) {
    // В интерфейсе Chat2Desk к одному request можно привязать не более 20 тикетов.
    // Поэтому ответ >20 строк без relationship-полей считаем признаком того, что
    // конкретный API mode проигнорировал неизвестный фильтр.
    for (const param of ["request_id", "request_ids", "request"]) {
      const payload = await this.get("/v1/tickets", { [param]: requestId, limit: 200, offset: 0 }, true);
      if (!payload) continue;
      const rows = dataList(payload);
      if (!rows.length) continue;
      const withRelations = rows.filter((t) => this.ticketRequestIds(t).length > 0);
      if (withRelations.length) {
        const exact = withRelations.filter((t) => this.ticketRequestIds(t).includes(Number(requestId)));
        if (exact.length) return exact;
        continue;
      }
      if (rows.length <= 20) return rows;
    }
    return [];
  }

  async allTickets() {
    // Tickets are the source of truth for both number/title search and the
    // ticket.requests[].client_id relationship. Never convert an API error into
    // an empty list: that previously made a broken request look like “0 tickets”.
    const payload = await this.get("/v1/tickets", {}, false);
    const rows = dataList(payload);
    const byId = new Map();
    for (const row of rows) {
      const id = this.ticketId(row);
      if (id !== null) byId.set(id, row);
    }
    return {
      tickets: [...byId.values()],
      truncated: false,
      source: "GET /v1/tickets",
      rawShape: this.payloadShape(payload),
      normalizedRows: rows.length,
    };
  }

  async ticketsForClient(clientId) {
    const numericClientId = Number(clientId);
    const all = await this.allTickets();
    const byId = new Map();
    const directRequestIds = new Set();

    // Главная и проверенная на реальной выгрузке связь:
    // ticket.requests[].client_id -> выбранный client_id.
    for (const ticket of all.tickets) {
      const matches = this.ticketRequests(ticket)
        .filter((request) => this.requestClientId(request) === numericClientId);
      if (!matches.length) continue;
      const id = this.ticketId(ticket);
      if (id !== null) byId.set(id, ticket);
      for (const request of matches) {
        const rid = this.requestId(request);
        if (rid !== null) directRequestIds.add(rid);
      }
    }

    // Если прямые связи найдены, ничего больше не запрашиваем. Это и быстрее,
    // и исключает таймауты Cloudflare на длинных цепочках Messages/Dialogs.
    if (byId.size > 0) {
      return {
        tickets: [...byId.values()].sort((a, b) => this.ticketSortValue(b) - this.ticketSortValue(a)),
        truncated: false,
        requestIds: [...directRequestIds],
        directRequestIds: [...directRequestIds],
        scannedTickets: all.tickets.length,
        ticketPayloadShape: all.rawShape || "—",
        normalizedTicketRows: all.normalizedRows ?? all.tickets.length,
        matchMode: "ticket.requests.client_id",
      };
    }

    // Fallback оставляем только для старых/других API modes, где requests[]
    // отсутствует в списке тикетов.
    let discoveredRequestIds = [];
    try {
      discoveredRequestIds = await this.requestIdsForClient(numericClientId);
    } catch (error) {
      console.warn("requestIdsForClient fallback failed", numericClientId, error);
    }
    const requestSet = new Set(discoveredRequestIds.map(Number));
    if (requestSet.size) {
      for (const ticket of all.tickets) {
        if (!this.ticketRequestIds(ticket).some((rid) => requestSet.has(Number(rid)))) continue;
        const id = this.ticketId(ticket);
        if (id !== null) byId.set(id, ticket);
      }
    }

    return {
      tickets: [...byId.values()].sort((a, b) => this.ticketSortValue(b) - this.ticketSortValue(a)),
      truncated: false,
      requestIds: [...requestSet],
      directRequestIds: [],
      scannedTickets: all.tickets.length,
      ticketPayloadShape: all.rawShape || "—",
      normalizedTicketRows: all.normalizedRows ?? all.tickets.length,
      matchMode: byId.size ? "request-id-fallback" : "none",
    };
  }

  async getTicketByInternalId(id) {
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return null;
    const direct = await this.get(`/v1/tickets/${Math.trunc(numeric)}`, {}, true);
    if (!direct) return null;
    const rows = dataList(direct);
    if (rows.length) return rows[0];
    if (typeof direct === "object") {
      if (direct.data && typeof direct.data === "object" && !Array.isArray(direct.data)) {
        const nestedRows = dataList(direct.data);
        if (nestedRows.length) return nestedRows[0];
        if (direct.data.id !== undefined || direct.data.issue_id !== undefined) return direct.data;
      }
      if (direct.id !== undefined || direct.issue_id !== undefined) return direct;
    }
    return null;
  }

  async getTicket(number) {
    const raw = String(number || "").trim().replace(/^#/, "");
    if (!raw) return null;
    const compact = raw.replace(/^TICK-/i, "");
    const numeric = /^\d+$/.test(compact) ? Number(compact) : null;

    // User-facing ticket number is issue_id (e.g. TICK-910), not internal id 28723.
    // Search the canonical list first so “910” resolves TICK-910.
    const all = await this.allTickets();
    const needle = raw.toLowerCase();
    for (const row of all.tickets) {
      const issue = String(this.ticketIssueId(row) || "").toLowerCase();
      if (numeric !== null && (issue === `tick-${numeric}` || issue.endsWith(`-${numeric}`))) return row;
      if (issue === needle) return row;
    }

    // If no issue_id matched, allow an explicit internal id as a fallback.
    if (numeric !== null) {
      const fromList = all.tickets.find((row) => this.ticketId(row) === numeric);
      if (fromList) return fromList;
      return this.getTicketByInternalId(numeric);
    }
    return null;
  }

  async searchTickets(query, maxResults = 10) {
    const q = String(query || "").trim();
    if (!q) return { tickets: [], truncated: false };

    // Tickets API этого аккаунта надёжно работает как полный GET /v1/tickets.
    // Все поисковые фильтры выполняем локально, чтобы не зависеть от неподдерживаемых
    // query params (search/title/query/limit/offset).
    const all = await this.allTickets();
    const needle = q.toLowerCase();
    const compact = q.replace(/^#/, "").trim();
    const numericMatch = compact.match(/^\d+$/);
    const numeric = numericMatch ? Number(compact) : null;

    const exact = [];
    const partial = [];
    for (const row of all.tickets) {
      const id = this.ticketId(row);
      const issue = String(this.ticketIssueId(row) || "").toLowerCase();
      const title = this.ticketTitle(row).toLowerCase();

      const exactNumber = numeric !== null && (id === numeric || issue === `tick-${numeric}` || issue.endsWith(`-${numeric}`));
      const exactIssue = issue === needle;
      if (exactNumber || exactIssue) {
        exact.push(row);
        continue;
      }
      if (issue.includes(needle) || String(id ?? "").includes(needle) || title.includes(needle)) partial.push(row);
    }

    if (exact.length) return { tickets: exact.slice(0, maxResults), truncated: exact.length > maxResults, exact: true };
    return { tickets: partial.slice(0, maxResults), truncated: partial.length > maxResults, exact: false };
  }

  payloadShape(payload) {
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (!payload || typeof payload !== "object") return typeof payload;
    const keys = Object.keys(payload).slice(0, 12);
    const parts = keys.map((key) => {
      const value = payload[key];
      if (Array.isArray(value)) return `${key}:array(${value.length})`;
      if (value && typeof value === "object") return `${key}:object(${Object.keys(value).slice(0, 8).join(",")})`;
      return `${key}:${typeof value}`;
    });
    return `{${parts.join("; ")}}`;
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
    const suffix = details.slice(0, 2).join(" · ");
    return suffix ? `${primary} · ${suffix}` : primary;
  }
  clientMatches(row, query) {
    const needle = String(query).toLowerCase();
    return ["assigned_name", "nickname", "name", "client_name", "phone", "client_phone", "external_id"]
      .some((key) => row?.[key] !== undefined && String(row[key]).toLowerCase().includes(needle));
  }

  ticketId(row) { return asInt(first(row, ["id", "ticket_id", "ticketID", "number"])); }
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
  ticketRequests(row) {
    const requests = first(row, ["requests"], []);
    return Array.isArray(requests) ? requests.filter((x) => x && typeof x === "object") : [];
  }
  requestId(row) { return asInt(first(row, ["request_id", "requestID", "requestId", "id"])); }
  requestClientId(row) { return asInt(first(row, ["client_id", "clientID", "clientId"], row?.client?.id)); }

  ticketTitle(row) {
    if (!row || typeof row !== "object") return "Без названия";

    // Реальная схема вашего Chat2Desk: название тикета хранится в `summary`.
    // Ставим его первым, остальные варианты оставляем для совместимости.
    const direct = nonEmptyText(first(row, ["summary", "title", "subject", "name", "theme", "topic"], null));
    if (direct) return direct;
    const preferred = new Set([
      "title", "tickettitle", "name", "ticketname", "subject", "ticketsubject", "theme", "topic",
      "caption", "header", "headline", "summary", "issuetitle", "appealtitle",
    ]);
    const forbidden = new Set([
      "clientname", "operatorname", "responsiblename", "statusname", "priorityname", "typename", "channelname",
    ]);

    const queue = [{ value: row, depth: 0 }];
    const seen = new Set();
    while (queue.length) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value) || depth > 3) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const nk = normalizeKey(key);
        if (!forbidden.has(nk) && (preferred.has(nk) || /^(ticket|issue|appeal)?(title|subject|theme|topic|header|headline|summary|name)$/.test(nk))) {
          const text = nonEmptyText(child);
          if (text) return text;
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === "object" && depth < 3) {
          const nk = normalizeKey(key);
          if (["ticket", "data", "attributes", "fields", "issue", "appeal"].includes(nk)) queue.push({ value: child, depth: depth + 1 });
        }
      }
    }

    // Последний защитный fallback: ищем короткое человекочитаемое строковое поле,
    // исключив Description, статусы, даты, ссылки и служебные идентификаторы.
    const excluded = /(description|comment|text|status|priority|request|client|operator|responsible|created|updated|deadline|date|time|url|link|id|number|type|color)/i;
    for (const [key, value] of Object.entries(row)) {
      if (excluded.test(key)) continue;
      const text = nonEmptyText(value);
      if (text && text.length <= 300 && !/^https?:\/\//i.test(text)) return text;
    }
    return "Без названия";
  }

  ticketDescription(row) {
    const value = first(row, ["description", "ticket_description", "ticketDescription", "comment", "details", "body", "text"], "—");
    return String(value || "—");
  }

  ticketMatches(row, needle) {
    const q = String(needle || "").toLowerCase();
    const displayNumber = String(this.ticketNumber(row) ?? "").toLowerCase();
    const internalId = String(this.ticketId(row) ?? "").toLowerCase();
    const title = this.ticketTitle(row).toLowerCase();
    return displayNumber.includes(q) || internalId.includes(q) || title.includes(q);
  }

  ticketRawKeys(row) {
    return row && typeof row === "object" ? Object.keys(row).sort() : [];
  }

  ticketHasRequest(row, requestId) {
    return this.ticketRequestIds(row).includes(Number(requestId));
  }

  dialogId(row) { return asInt(first(row, ["id", "dialog_id", "dialogID"])); }
  dialogOperatorId(row) { return asInt(first(row, ["operator_id", "operatorID", "operatorId"], row?.operator?.id)); }
  dialogClientId(row) { return asInt(first(row, ["client_id", "clientID", "clientId"], row?.client?.id)); }
  dialogClientName(row) { return String(first(row?.client || {}, ["assigned_name", "nickname", "name"], first(row, ["client_name", "name"], "Клиент"))); }
  operatorId(row) { return asInt(first(row, ["id", "operator_id", "operatorID"])); }
  operatorName(row) {
    const direct = first(row, ["name", "full_name", "fullName", "assigned_name"]);
    if (direct) return String(direct);
    const firstName = first(row, ["first_name", "firstName", "FirstName"], "");
    const lastName = first(row, ["last_name", "lastName", "LastName"], "");
    const combined = `${firstName || ""} ${lastName || ""}`.trim();
    return combined || "Без имени";
  }
  operatorOnline(row) { return Boolean(first(row, ["online", "is_online", "isOnline"], false)); }
  operatorDialogsCount(row) { return asInt(first(row, ["opened_dialogs", "open_dialogs_count", "opened_dialogs_count", "dialogs_count", "openDialogsCount"])); }
}

export { Chat2DeskAPI, dataList };
