import { DurableObject } from "cloudflare:workers";
import { normalizeUsername } from "./config.js";

export class BotState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (url.pathname === "/remember-user" && request.method === "POST") {
      const username = normalizeUsername(body.username);
      if (!username || !body.user_id) return Response.json({ ok: false }, { status: 400 });
      await this.ctx.storage.put(`tg:${username}`, Number(body.user_id));
      return Response.json({ ok: true });
    }

    if (url.pathname === "/telegram-id") {
      const username = normalizeUsername(url.searchParams.get("username"));
      const userId = username ? await this.ctx.storage.get(`tg:${username}`) : null;
      return Response.json({ user_id: userId ?? null });
    }

    if (url.pathname === "/set-user-state" && request.method === "POST") {
      await this.ctx.storage.put(`state:${body.user_id}`, body.state ?? null);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/user-state") {
      const value = await this.ctx.storage.get(`state:${url.searchParams.get("user_id")}`);
      return Response.json({ state: value ?? null });
    }

    if (url.pathname === "/offset-pages" && request.method === "POST") {
      try {
        const base = String(body.base || "https://api.chat2desk.com").replace(/\/$/, "");
        const token = String(body.token || "");
        const path = String(body.path || "");
        if (!token || !path.startsWith("/v1/")) return Response.json({ ok: false, error: "missing token/path" }, { status: 400 });
        const query = body.query && typeof body.query === "object" ? body.query : {};
        const cursor = Math.max(0, Number(body.cursor || 0));
        const requestedLimit = Math.max(1, Math.min(200, Number(body.requested_limit || 200)));
        const maxPages = Math.max(1, Math.min(20, Number(body.max_pages || 18)));
        const ttlMs = Math.max(0, Number(body.cache_ttl_ms || 60000));
        const now = Date.now();

        const stableQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
        const fetchPage = async (offset, limit) => {
          const cacheKey = `offset-page:${path}:${stableQuery}:${offset}:${limit}`;
          const cached = await this.ctx.storage.get(cacheKey);
          if (cached && now - Number(cached.at || 0) < ttlMs) return cached.payload;
          const u = new URL(`${base}${path}`);
          for (const [key, value] of Object.entries(query)) {
            if (value !== null && value !== undefined && value !== "") u.searchParams.set(key, String(value));
          }
          u.searchParams.set("limit", String(limit));
          u.searchParams.set("offset", String(offset));
          const response = await fetch(u, { headers: { Authorization: token, Accept: "application/json" } });
          const text = await response.text();
          if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 700)}`);
          const payload = JSON.parse(text);
          await this.ctx.storage.put(cacheKey, { at: now, payload });
          return payload;
        };

        const rowsOf = (payload) => Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
        const first = await fetchPage(cursor, requestedLimit);
        const firstRows = rowsOf(first);
        const actualLimit = Math.max(1, Number(first?.meta?.limit || firstRows.length || requestedLimit));
        const total = Number.isFinite(Number(first?.meta?.total)) ? Number(first.meta.total) : null;
        const firstOffset = Number.isFinite(Number(first?.meta?.offset)) ? Number(first.meta.offset) : cursor;
        const pages = [{ offset: firstOffset, payload: first }];
        const offsets = [];
        for (let i = 1; i < maxPages; i += 1) {
          const offset = firstOffset + i * actualLimit;
          if (total !== null && offset >= total) break;
          offsets.push(offset);
        }
        for (let i = 0; i < offsets.length; i += 6) {
          const batch = offsets.slice(i, i + 6);
          const payloads = await Promise.all(batch.map((offset) => fetchPage(offset, actualLimit)));
          payloads.forEach((payload, idx) => pages.push({ offset: batch[idx], payload }));
        }
        pages.sort((a, b) => a.offset - b.offset);
        const rows = pages.flatMap((p) => rowsOf(p.payload));
        const last = pages.at(-1);
        const lastRows = rowsOf(last?.payload);
        const nextOffset = (last?.offset ?? firstOffset) + actualLimit;
        const done = total !== null ? nextOffset >= total : lastRows.length < actualLimit;
        return Response.json({ ok: true, rows, total, limit: actualLimit, next_offset: nextOffset, done, pages: pages.length });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    if (url.pathname === "/client-request-pages" && request.method === "POST") {
      try {
        const base = String(body.base || "https://api.chat2desk.com").replace(/\/$/, "");
        const token = String(body.token || "");
        const clientId = Number(body.client_id);
        if (!token || !Number.isFinite(clientId)) return Response.json({ ok: false, error: "missing token/client_id" }, { status: 400 });
        const initialCursor = body.cursor === null || body.cursor === undefined ? null : Number(body.cursor);
        const requestedLimit = Math.max(1, Math.min(200, Number(body.requested_limit || 200)));
        const maxPages = Math.max(1, Math.min(20, Number(body.max_pages || 18)));
        const ttlMs = Math.max(0, Number(body.cache_ttl_ms || 600000));
        const now = Date.now();
        const requestIds = new Set();
        let cursor = initialCursor;
        let pages = 0;
        let done = false;
        let total = null;
        let actualLimit = requestedLimit;
        let messagesSeen = 0;

        for (let page = 0; page < maxPages; page += 1) {
          const cacheKey = `message-page:${clientId}:${cursor ?? "first"}:${requestedLimit}`;
          let payload;
          const cached = await this.ctx.storage.get(cacheKey);
          if (cached && now - Number(cached.at || 0) < ttlMs) {
            payload = cached.payload;
          } else {
            const u = new URL(`${base}/v1/messages`);
            u.searchParams.set("client_id", String(clientId));
            u.searchParams.set("limit", String(requestedLimit));
            if (cursor !== null) u.searchParams.set("start_id", String(cursor));
            const response = await fetch(u, { headers: { Authorization: token, Accept: "application/json" } });
            const text = await response.text();
            if (!response.ok) throw new Error(`/v1/messages HTTP ${response.status}: ${text.slice(0, 700)}`);
            payload = JSON.parse(text);
            await this.ctx.storage.put(cacheKey, { at: now, payload });
          }

          const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
          pages += 1;
          messagesSeen += rows.length;
          actualLimit = Math.max(1, Number(payload?.meta?.limit || rows.length || requestedLimit));
          if (Number.isFinite(Number(payload?.meta?.total))) total = Number(payload.meta.total);
          if (!rows.length) { done = true; break; }

          let maxMessageId = cursor;
          for (const row of rows) {
            const rid = Number(row?.request_id);
            if (Number.isFinite(rid)) requestIds.add(Math.trunc(rid));
            const mid = Number(row?.id);
            if (Number.isFinite(mid) && (maxMessageId === null || mid > maxMessageId)) maxMessageId = Math.trunc(mid);
          }

          if (rows.length < actualLimit) { cursor = maxMessageId; done = true; break; }
          if (maxMessageId === null || maxMessageId === cursor) { done = true; break; }
          cursor = maxMessageId;
        }

        return Response.json({
          ok: true,
          request_ids: [...requestIds],
          next_start_id: cursor,
          done,
          pages,
          messages_seen: messagesSeen,
          total,
          limit: actualLimit,
        });
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
      }
    }

    if (url.pathname === "/assignment-diff" && request.method === "POST") {
      const current = body.assignments || {};
      const initialized = Boolean(await this.ctx.storage.get("assignments:initialized"));
      const previous = (await this.ctx.storage.get("assignments:snapshot")) || {};
      await this.ctx.storage.put("assignments:snapshot", current);
      if (!initialized) {
        await this.ctx.storage.put("assignments:initialized", true);
        return Response.json({ changes: [], baseline: true });
      }
      const changes = [];
      for (const [dialogId, now] of Object.entries(current)) {
        const before = previous[dialogId];
        if (now?.operator_id && (!before || Number(before.operator_id) !== Number(now.operator_id))) {
          changes.push({ dialog_id: Number(dialogId), ...now });
        }
      }
      return Response.json({ changes, baseline: false });
    }

    return new Response("Not found", { status: 404 });
  }
}

function stateStub(env) {
  const id = env.BOT_STATE.idFromName("global");
  return env.BOT_STATE.get(id);
}

export async function rememberTelegramUser(env, username, userId) {
  return stateStub(env).fetch("https://state/remember-user", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, user_id: userId }),
  });
}

export async function telegramIdForUsername(env, username) {
  const response = await stateStub(env).fetch(`https://state/telegram-id?username=${encodeURIComponent(username)}`);
  const data = await response.json();
  return data.user_id ?? null;
}

export async function setUserState(env, userId, state) {
  await stateStub(env).fetch("https://state/set-user-state", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: userId, state }),
  });
}

export async function getUserState(env, userId) {
  const response = await stateStub(env).fetch(`https://state/user-state?user_id=${encodeURIComponent(userId)}`);
  return (await response.json()).state;
}

export async function assignmentDiff(env, assignments) {
  const response = await stateStub(env).fetch("https://state/assignment-diff", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignments }),
  });
  return response.json();
}
