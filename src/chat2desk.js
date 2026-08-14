function dataList(payload) {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object");
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data.filter((x) => x && typeof x === "object");
  if (payload.data && typeof payload.data === "object") return [payload.data];
  if (Array.isArray(payload.items)) return payload.items.filter((x) => x && typeof x === "object");
  return [];
}

function first(obj, keys, fallback = null) {
  for (const key of keys) if (obj?.[key] !== undefined && obj?.[key] !== null) return obj[key];
  return fallback;
}

function asInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
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
    if (optional && [400, 404, 422].includes(response.status)) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Chat2Desk GET ${url.pathname}: HTTP ${response.status} ${body.slice(0, 300)}`);
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

  async requestsForClient(clientId) {
    const payload = await this.get("/v1/requests", { client_id: clientId, limit: 200, offset: 0 }, true);
    if (payload && dataList(payload).length) return dataList(payload);
    const rows = await this.paginated("/v1/requests", {}, 10);
    return rows.filter((r) => this.requestClientId(r) === Number(clientId));
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

    for (const key of ["requests", "request_ids", "requestIds", "requests_ids", "appeals", "appeal_ids", "request", "request_id", "requestID", "requestId"]) {
      if (row?.[key] !== undefined) pushValue(row[key]);
    }
    return [...new Set(values)];
  }

  ticketClientId(row) {
    return asInt(first(row, ["client_id", "clientID", "clientId"], row?.client?.id));
  }

  async ticketsForRequest(requestId) {
    // В разных API modes Chat2Desk связь request -> ticket представлена по-разному.
    // Сначала пробуем вложенный REST endpoint, затем фильтры списка тикетов.
    const nested = await this.get(`/v1/requests/${requestId}/tickets`, { limit: 200, offset: 0 }, true);
    if (nested) {
      const rows = dataList(nested);
      if (rows.length) return rows;
    }

    for (const param of ["request_id", "request", "request_ids"]) {
      const payload = await this.get("/v1/tickets", { [param]: requestId, limit: 200, offset: 0 }, true);
      if (!payload) continue;
      const rows = dataList(payload);
      const related = rows.filter((t) => this.ticketHasRequest(t, Number(requestId)));
      if (related.length) return related;
    }
    return [];
  }

  async ticketsForClient(clientId) {
    const numericClientId = Number(clientId);
    const requests = await this.requestsForClient(numericClientId);
    const requestIds = [...new Set(requests.map((r) => this.requestId(r)).filter((x) => x !== null))];
    const requestSet = new Set(requestIds.map(Number));
    const byId = new Map();

    const addIfRelated = (ticket, trustClientFilter = false) => {
      const tid = this.ticketId(ticket);
      if (tid === null) return;
      const ticketClientId = this.ticketClientId(ticket);
      const relationIds = this.ticketRequestIds(ticket);
      const relatedByClient = ticketClientId !== null && ticketClientId === numericClientId;
      const relatedByRequest = relationIds.some((rid) => requestSet.has(Number(rid)));
      if (relatedByClient || relatedByRequest || (trustClientFilter && relationIds.length === 0 && ticketClientId === null)) {
        byId.set(tid, ticket);
      }
    };

    // 1) Самый дешёвый вариант: прямой client_id filter, если он поддерживается API mode.
    for (const param of ["client_id", "client"]) {
      const payload = await this.get("/v1/tickets", { [param]: numericClientId, limit: 200, offset: 0 }, true);
      if (!payload) continue;
      const rows = dataList(payload);
      for (const ticket of rows) addIfRelated(ticket, true);
      // Если ответ содержит явную связь с клиентом/request, этого достаточно.
      if (byId.size && rows.some((t) => this.ticketClientId(t) !== null || this.ticketRequestIds(t).length)) break;
    }

    // 2) Фильтр сразу по request_ids (поддерживается не всеми API modes).
    if (requestIds.length) {
      for (let i = 0; i < requestIds.length; i += 40) {
        const chunk = requestIds.slice(i, i + 40);
        for (const param of ["request_ids", "requests"]) {
          const payload = await this.get("/v1/tickets", { [param]: chunk.join(","), limit: 200, offset: 0 }, true);
          if (!payload) continue;
          for (const ticket of dataList(payload)) addIfRelated(ticket, false);
        }
      }
    }

    // 3) Надёжный fallback: получаем список Tickets и фильтруем локально по requests.
    // Это существенно надёжнее десятков последовательных запросов "один request -> tickets"
    // и укладывается в лимит subrequests Cloudflare Free.
    if (requestIds.length && byId.size === 0) {
      const allTickets = await this.paginated("/v1/tickets", {}, 20);
      for (const ticket of allTickets) addIfRelated(ticket, false);
    }

    // 4) Последний fallback для аккаунтов, где relation не приходит в общем списке Tickets.
    // Ограничиваем число requests, чтобы один Telegram callback не превысил лимит subrequests Worker.
    let truncated = false;
    if (requestIds.length && byId.size === 0) {
      const safeIds = requestIds.slice(0, 30);
      for (const rid of safeIds) {
        const rows = await this.ticketsForRequest(rid);
        for (const ticket of rows) {
          const tid = this.ticketId(ticket);
          if (tid !== null) byId.set(tid, ticket);
        }
      }
      truncated = requestIds.length > safeIds.length;
    }

    const tickets = [...byId.values()].sort((a, b) => (this.ticketNumber(b) || 0) - (this.ticketNumber(a) || 0));
    return { tickets, truncated };
  }

  async getTicket(number) {
    const direct = await this.get(`/v1/tickets/${number}`, {}, true);
    if (direct) {
      const rows = dataList(direct);
      if (rows.length) return rows[0];
      if (typeof direct === "object" && direct.id !== undefined) return direct;
    }
    for (const param of ["id", "number", "ticket_id"]) {
      const payload = await this.get("/v1/tickets", { [param]: number, limit: 20, offset: 0 }, true);
      if (!payload) continue;
      for (const row of dataList(payload)) {
        if (this.ticketId(row) === Number(number) || this.ticketNumber(row) === Number(number)) return row;
      }
    }
    return null;
  }

  clientId(row) { return asInt(first(row, ["id", "client_id", "clientID"])); }
  clientName(row) { return String(first(row, ["assigned_name", "nickname", "name", "client_name"], "Без имени")); }
  clientMatches(row, query) {
    const needle = String(query).toLowerCase();
    return ["assigned_name", "nickname", "name", "client_name", "phone", "client_phone", "external_id"]
      .some((key) => row?.[key] !== undefined && String(row[key]).toLowerCase().includes(needle));
  }
  requestId(row) { return asInt(first(row, ["id", "request_id", "requestID"])); }
  requestClientId(row) { return asInt(first(row, ["client_id", "clientID"], row?.client?.id)); }
  ticketId(row) { return asInt(first(row, ["id", "ticket_id", "ticketID", "number"])); }
  ticketNumber(row) { return asInt(first(row, ["number", "id", "ticket_id", "ticketID"])); }
  ticketTitle(row) {
    const keys = [
      "title", "ticket_title", "ticketTitle", "name", "ticket_name", "ticketName",
      "subject", "ticket_subject", "ticketSubject", "theme", "topic", "caption"
    ];

    const textValue = (value) => {
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        return text || null;
      }
      if (value && typeof value === "object") {
        for (const nestedKey of ["value", "text", "title", "name", "subject"]) {
          const nestedValue = value[nestedKey];
          if (typeof nestedValue === "string" || typeof nestedValue === "number") {
            const text = String(nestedValue).trim();
            if (text) return text;
          }
        }
      }
      return null;
    };

    for (const source of [row, row?.ticket, row?.data]) {
      if (!source || typeof source !== "object") continue;
      for (const key of keys) {
        const text = textValue(source[key]);
        if (text) return text;
      }
    }

    // Fallback for API modes that use a slightly different ticket-title field name.
    // We only inspect top-level ticket-like keys to avoid accidentally taking status/priority names.
    if (row && typeof row === "object") {
      for (const [key, value] of Object.entries(row)) {
        const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
        if (/(ticket)?(title|subject|topic|theme|name)$/.test(normalized)) {
          const text = textValue(value);
          if (text) return text;
        }
      }
    }

    return "Без названия";
  }
  ticketDescription(row) { return String(first(row, ["description", "text", "comment"], "—") || "—"); }
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
  operatorDialogsCount(row) { return asInt(first(row, ["open_dialogs_count", "opened_dialogs_count", "dialogs_count", "openDialogsCount"])); }
}

export { Chat2DeskAPI, dataList };
