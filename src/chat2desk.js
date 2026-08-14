function dataList(payload) {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object");
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data.filter((x) => x && typeof x === "object");
  if (payload.data && typeof payload.data === "object") return [payload.data];
  if (Array.isArray(payload.items)) return payload.items.filter((x) => x && typeof x === "object");
  if (Array.isArray(payload.tickets)) return payload.tickets.filter((x) => x && typeof x === "object");
  return [];
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

  async allTickets(maxPages = 25) {
    const firstPayload = await this.get("/v1/tickets", { limit: 200, offset: 0 }, true);
    if (!firstPayload) return { tickets: [], truncated: false };
    const firstRows = dataList(firstPayload);
    const byId = new Map();
    for (const row of firstRows) {
      const id = this.ticketId(row);
      if (id !== null) byId.set(id, row);
    }

    const total = asInt(firstPayload?.meta?.total ?? firstPayload?.total ?? firstPayload?.pagination?.total);
    if (total !== null) {
      const totalPages = Math.max(1, Math.ceil(total / 200));
      const pagesToFetch = Math.min(totalPages, maxPages);
      const calls = [];
      for (let page = 1; page < pagesToFetch; page += 1) {
        calls.push(this.get("/v1/tickets", { limit: 200, offset: page * 200 }, true));
      }
      const payloads = await Promise.all(calls);
      for (const payload of payloads) {
        for (const row of dataList(payload)) {
          const id = this.ticketId(row);
          if (id !== null) byId.set(id, row);
        }
      }
      return { tickets: [...byId.values()], truncated: totalPages > maxPages };
    }

    // Если meta.total отсутствует, дочитываем последовательно до короткой страницы.
    let offset = firstRows.length;
    let truncated = false;
    for (let page = 1; page < maxPages && firstRows.length === 200; page += 1) {
      const payload = await this.get("/v1/tickets", { limit: 200, offset }, true);
      if (!payload) break;
      const rows = dataList(payload);
      for (const row of rows) {
        const id = this.ticketId(row);
        if (id !== null) byId.set(id, row);
      }
      offset += rows.length;
      if (rows.length < 200) return { tickets: [...byId.values()], truncated: false };
      if (page === maxPages - 1) truncated = true;
    }
    return { tickets: [...byId.values()], truncated };
  }

  async ticketsForClient(clientId) {
    const numericClientId = Number(clientId);
    const requestIds = await this.requestIdsForClient(numericClientId);
    if (!requestIds.length) return { tickets: [], truncated: false, requestIds: [] };
    const requestSet = new Set(requestIds.map(Number));
    const byId = new Map();

    // Сначала смотрим только первую страницу Tickets. Если Chat2Desk отдаёт в ней
    // связи requests, можем эффективно отфильтровать полный список. Если нет —
    // не тратим десятки subrequests на бесполезное сканирование и идём напрямую
    // через request_id.
    const probe = await this.get("/v1/tickets", { limit: 200, offset: 0 }, true);
    const probeRows = dataList(probe);
    const hasRelationshipFields = probeRows.some((ticket) => this.ticketRequestIds(ticket).length > 0);
    let truncated = false;

    if (hasRelationshipFields) {
      const all = await this.allTickets(15);
      truncated = all.truncated;
      for (const ticket of all.tickets) {
        const relations = this.ticketRequestIds(ticket);
        if (relations.some((rid) => requestSet.has(Number(rid)))) {
          const id = this.ticketId(ticket);
          if (id !== null) byId.set(id, ticket);
        }
      }
    } else {
      const maxRequestLookups = 25;
      const ids = requestIds.slice(0, maxRequestLookups);
      const chunkSize = 5;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const groups = await Promise.all(chunk.map((rid) => this.ticketsForRequest(rid)));
        for (const rows of groups) {
          for (const ticket of rows) {
            const id = this.ticketId(ticket);
            if (id !== null) byId.set(id, ticket);
          }
        }
      }
      truncated = requestIds.length > maxRequestLookups;
    }

    return {
      tickets: [...byId.values()].sort((a, b) => (this.ticketNumber(b) || 0) - (this.ticketNumber(a) || 0)),
      truncated,
      requestIds,
    };
  }

  async getTicket(number) {
    const numeric = Number(number);
    const direct = await this.get(`/v1/tickets/${numeric}`, {}, true);
    if (direct) {
      const rows = dataList(direct);
      if (rows.length) return rows[0];
      if (typeof direct === "object") {
        if (direct.data && typeof direct.data === "object" && !Array.isArray(direct.data)) return direct.data;
        if (direct.id !== undefined || direct.number !== undefined) return direct;
      }
    }
    for (const param of ["id", "number", "ticket_id"]) {
      const payload = await this.get("/v1/tickets", { [param]: numeric, limit: 20, offset: 0 }, true);
      if (!payload) continue;
      for (const row of dataList(payload)) {
        if (this.ticketId(row) === numeric || this.ticketNumber(row) === numeric) return row;
      }
    }
    return null;
  }

  async searchTickets(query, maxResults = 10) {
    const q = String(query || "").trim();
    if (!q) return { tickets: [], truncated: false };

    // Чистый номер — самый быстрый путь.
    const numberMatch = q.match(/^#?\s*(\d+)\s*$/);
    if (numberMatch) {
      const ticket = await this.getTicket(Number(numberMatch[1]));
      return { tickets: ticket ? [ticket] : [], truncated: false, exact: true };
    }

    const needle = q.toLowerCase();
    const found = new Map();

    // Пробуем серверные фильтры, если конкретный API mode их поддерживает.
    const payloads = await Promise.all([
      this.get("/v1/tickets", { search: q, limit: 200, offset: 0 }, true),
      this.get("/v1/tickets", { title: q, limit: 200, offset: 0 }, true),
      this.get("/v1/tickets", { query: q, limit: 200, offset: 0 }, true),
    ]);
    for (const payload of payloads) {
      for (const row of dataList(payload)) {
        if (!this.ticketMatches(row, needle)) continue;
        const id = this.ticketId(row);
        if (id !== null) found.set(id, row);
      }
    }

    // Надёжный fallback: локальный поиск по списку тикетов. Chat2Desk UI сам умеет
    // искать по Number/Title, но название query-параметра Public API зависит от mode.
    if (found.size < maxResults) {
      const all = await this.allTickets(25);
      for (const row of all.tickets) {
        if (!this.ticketMatches(row, needle)) continue;
        const id = this.ticketId(row);
        if (id !== null) found.set(id, row);
        if (found.size >= maxResults) break;
      }
      return { tickets: [...found.values()].slice(0, maxResults), truncated: all.truncated || found.size >= maxResults, exact: false };
    }
    return { tickets: [...found.values()].slice(0, maxResults), truncated: found.size > maxResults, exact: false };
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
  ticketNumber(row) { return asInt(first(row, ["number", "ticket_number", "ticketNumber", "id", "ticket_id", "ticketID"])); }

  ticketTitle(row) {
    if (!row || typeof row !== "object") return "Без названия";
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
    const number = String(this.ticketNumber(row) ?? "");
    const title = this.ticketTitle(row).toLowerCase();
    return number.includes(needle) || title.includes(needle);
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
