const TG_BASE = "https://api.telegram.org";

export async function telegramCall(env, method, payload = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const response = await fetch(`${TG_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram ${method}: ${data.description || response.status}`);
  }
  return data.result;
}

export async function sendMessage(env, chatId, text, options = {}) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

export async function editMessage(env, chatId, messageId, text, options = {}) {
  return telegramCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  });
}

export async function answerCallback(env, callbackQueryId, text = "") {
  return telegramCall(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function setWebhook(env, url, secretToken) {
  return telegramCall(env, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
}

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function mainKeyboard(isAdmin = false) {
  const rows = [
    [{ text: "🔎 Найти клиента", callback_data: "client_search" }],
    [{ text: "🎫 Найти тикет", callback_data: "ticket_search" }],
  ];
  if (isAdmin) rows.push([{ text: "👥 Операторы", callback_data: "admin_operators" }]);
  return { inline_keyboard: rows };
}
