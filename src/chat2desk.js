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

export class Chat2DeskAPI {
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

  async ticketsForRequest(requestId) {
    for (const [param, value] of [["request_id", requestId], ["request_ids", requestId]]) {
      const payload = await this.get("/v1/tickets", { [param]: value, limit: 200, offset: 0 }, true);
      if (!payload) continue;
      const rows = dataList(payload);
      if (rows.length) return rows.filter((t) => this.ticketHasRequest(t, Number(requestId)) || param === "request_id");
    }
    return [];
  }

  async ticketsForClient(clientId) {
    const requests = await this.requestsForClient(clientId);
    const ids = requests.map((r) => this.requestId(r)).filter((x) => x !== null);
    const byId = new Map();

    // Сначала пробуем фильтр списком — он экономит API-вызовы, если поддерживается API mode аккаунта.
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const payload = await this.get("/v1/tickets", { request_ids: chunk.join(","), limit: 200, offset: 0 }, true);
      if (payload) {
        for (const ticket of dataList(payload)) {
          const tid = this.ticketId(ticket);
          if (tid !== null && chunk.some((rid) => this.ticketHasRequest(ticket, rid))) byId.set(tid, ticket);
        }
      }
    }

    // Fallback для API modes, где request_ids не поддерживается.
    // Ограничение 40 защищает Free Worker от лимита subrequests в одном вызове.
    if (byId.size === 0 && ids.length) {
      const safeIds = ids.slice(0, 40);
      for (const rid of safeIds) {
        for (const ticket of await this.ticketsForRequest(rid)) {
          const tid = this.ticketId(ticket);
          if (tid !== null) byId.set(tid, ticket);
        }
      }
      if (ids.length > safeIds.length) byId.truncated = true;
    }

    const tickets = [...byId.values()].sort((a, b) => (this.ticketNumber(b) || 0) - (this.ticketNumber(a) || 0));
    return { tickets, truncated: Boolean(byId.truncated) };
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
  ticketTitle(row) { return String(first(row, ["title", "name", "subject"], "Без названия")); }
  ticketDescription(row) { return String(first(row, ["description", "text", "comment"], "—") || "—"); }
  ticketHasRequest(row, requestId) {
    const direct = asInt(first(row, ["request_id", "requestID"]));
    if (direct === Number(requestId)) return true;
    let values = row?.requests ?? row?.request_ids ?? [];
    if (!Array.isArray(values)) values = [values];
    return values.some((value) => asInt(typeof value === "object" ? first(value, ["id", "request_id", "requestID"]) : value) === Number(requestId));
  }
  dialogId(row) { return asInt(first(row, ["id", "dialog_id", "dialogID"])); }
  dialogOperatorId(row) { return asInt(first(row, ["operator_id", "operatorID", "operatorId"], row?.operator?.id)); }
  dialogClientId(row) { return asInt(first(row, ["client_id", "clientID", "clientId"], row?.client?.id)); }
  dialogClientName(row) { return String(first(row?.client || {}, ["assigned_name", "nickname", "name"], first(row, ["client_name", "name"], "Клиент"))); }
  operatorId(row) { return asInt(first(row, ["id", "operator_id", "operatorID"])); }
  operatorName(row) { return String(first(row, ["name", "full_name", "assigned_name"], "Без имени")); }
  operatorOnline(row) { return Boolean(first(row, ["online", "is_online", "isOnline"], false)); }
  operatorDialogsCount(row) { return asInt(first(row, ["open_dialogs_count", "opened_dialogs_count", "dialogs_count", "openDialogsCount"])); }
}

export { dataList };
