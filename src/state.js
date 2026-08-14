import { DurableObject } from "cloudflare:workers";
import { normalizeUsername } from "./config.js";

export class BotState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
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
