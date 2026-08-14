import { ENV_DEFAULTS } from "./env.generated.js";
import { handleTelegramUpdate, processAssignments } from "./bot.js";
import { setWebhook } from "./telegram.js";
export { BotState } from "./state.js";

function withDefaults(env) {
  return new Proxy(env, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(ENV_DEFAULTS, prop)) return ENV_DEFAULTS[prop];
      return target[prop];
    },
  });
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    env = withDefaults(env);
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "fit-support", runtime: "cloudflare-workers" });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      // Telegram secret_token защищает webhook от произвольных POST-запросов.
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("x-telegram-bot-api-secret-token");
        if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(env, update).catch((error) => console.error("telegram update", error)));
      return json({ ok: true });
    }

    if (url.pathname === "/setup" && request.method === "GET") {
      if (!env.SETUP_SECRET || url.searchParams.get("secret") !== env.SETUP_SECRET) return new Response("Forbidden", { status: 403 });
      const webhookUrl = `${url.origin}/telegram`;
      const result = await setWebhook(env, webhookUrl, env.TELEGRAM_WEBHOOK_SECRET || undefined);
      return json({ ok: true, webhook_url: webhookUrl, telegram: result });
    }

    if (url.pathname === "/cron-test" && request.method === "GET") {
      if (!env.SETUP_SECRET || url.searchParams.get("secret") !== env.SETUP_SECRET) return new Response("Forbidden", { status: 403 });
      return json(await processAssignments(env));
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    env = withDefaults(env);
    ctx.waitUntil(processAssignments(env).catch((error) => console.error("scheduled assignment check", error)));
  },
};
