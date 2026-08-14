import { Chat2DeskAPI } from "./chat2desk.js";
import { isAdmin, operatorForUsername, operatorForChat2DeskId, normalizeUsername } from "./config.js";
import { answerCallback, editMessage, esc, mainKeyboard, sendMessage } from "./telegram.js";
import { getUserState, rememberTelegramUser, setUserState, telegramIdForUsername } from "./state.js";

function userFromUpdate(update) {
  return update.message?.from || update.callback_query?.from || null;
}

function chatIdFromUpdate(update) {
  return update.message?.chat?.id || update.callback_query?.message?.chat?.id || null;
}

async function identify(env, update) {
  const user = userFromUpdate(update);
  if (!user) return { user: null, operator: null, admin: false };
  const username = normalizeUsername(user.username);
  const operator = operatorForUsername(env, username);
  const admin = isAdmin(env, username);
  if ((operator || admin) && username) await rememberTelegramUser(env, username, user.id);
  return { user, username, operator, admin };
}

async function showHome(env, chatId, identity) {
  const who = identity.operator ? `\n\nВы: <b>${esc(identity.operator.name)}</b>` : "";
  await sendMessage(env, chatId, `FIT Support${who}`, { reply_markup: mainKeyboard(identity.admin) });
}

function ticketText(api, ticket) {
  return `🎫 <b>#${esc(api.ticketNumber(ticket) ?? api.ticketId(ticket) ?? "—")}</b>\n<b>${esc(api.ticketTitle(ticket))}</b>\n\nОписание:\n${esc(api.ticketDescription(ticket))}`;
}

function ticketPageText(api, tickets, page, perPage, truncated = false) {
  const pages = Math.max(1, Math.ceil(tickets.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const part = tickets.slice(safePage * perPage, safePage * perPage + perPage);
  const body = part.map((t) => ticketText(api, t)).join("\n\n────────────\n\n") || "Тикетов не найдено.";
  const warning = truncated ? "\n\n⚠️ У клиента очень много обращений; показана безопасная выборка для лимитов Cloudflare Free." : "";
  return { text: `${body}${warning}\n\nСтраница ${safePage + 1}/${pages}`, page: safePage, pages };
}

async function requireKnownUser(env, update, identity) {
  if (identity.operator || identity.admin) return true;
  const chatId = chatIdFromUpdate(update);
  await sendMessage(env, chatId, "Доступ не настроен. Ваш Telegram @username отсутствует в списке операторов FIT Support. Обратитесь к руководителю.");
  return false;
}

export async function handleTelegramUpdate(env, update) {
  const identity = await identify(env, update);
  const chatId = chatIdFromUpdate(update);
  if (!chatId) return;

  if (update.message?.text) {
    const text = update.message.text.trim();
    if (text === "/id") {
      await sendMessage(env, chatId, `Ваш Telegram user ID: <code>${identity.user.id}</code>\nUsername: @${esc(identity.user.username || "не задан")}`);
      return;
    }
    if (text === "/start" || text === "/menu") {
      if (!(await requireKnownUser(env, update, identity))) return;
      await setUserState(env, identity.user.id, null);
      await showHome(env, chatId, identity);
      return;
    }
    if (!(await requireKnownUser(env, update, identity))) return;

    const state = await getUserState(env, identity.user.id);
    const api = new Chat2DeskAPI(env);
    if (state?.type === "await_client_query") {
      await setUserState(env, identity.user.id, null);
      const clients = await api.searchClients(text, Number(env.CLIENT_SEARCH_MAX_RESULTS || 10), Number(env.CLIENT_SEARCH_FALLBACK_PAGES || 10));
      if (!clients.length) {
        await sendMessage(env, chatId, "Клиенты не найдены.", { reply_markup: mainKeyboard(identity.admin) });
        return;
      }
      const keyboard = clients.map((client) => [{ text: api.clientName(client).slice(0, 60), callback_data: `client:${api.clientId(client)}` }]);
      keyboard.push([{ text: "⬅️ Меню", callback_data: "menu" }]);
      await sendMessage(env, chatId, `Найдено клиентов: ${clients.length}\nВыберите нужного:`, { reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (state?.type === "await_ticket_query") {
      await setUserState(env, identity.user.id, null);
      const number = Number(text.replace(/[^0-9]/g, ""));
      if (!number) {
        await sendMessage(env, chatId, "Не вижу номер тикета. Например: <code>31872</code> или <code>#31872</code>.", { reply_markup: mainKeyboard(identity.admin) });
        return;
      }
      const ticket = await api.getTicket(number);
      await sendMessage(env, chatId, ticket ? ticketText(api, ticket) : `Тикет #${number} не найден.`, { reply_markup: mainKeyboard(identity.admin) });
      return;
    }
    await showHome(env, chatId, identity);
    return;
  }

  const cq = update.callback_query;
  if (!cq) return;
  await answerCallback(env, cq.id).catch(() => {});
  if (!(await requireKnownUser(env, update, identity))) return;
  const data = cq.data || "";
  const api = new Chat2DeskAPI(env);

  if (data === "menu") {
    await setUserState(env, identity.user.id, null);
    await editMessage(env, chatId, cq.message.message_id, `FIT Support${identity.operator ? `\n\nВы: <b>${esc(identity.operator.name)}</b>` : ""}`, { reply_markup: mainKeyboard(identity.admin) });
    return;
  }
  if (data === "client_search") {
    await setUserState(env, identity.user.id, { type: "await_client_query" });
    await editMessage(env, chatId, cq.message.message_id, "Введите название клиента:", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Отмена", callback_data: "menu" }]] } });
    return;
  }
  if (data === "ticket_search") {
    await setUserState(env, identity.user.id, { type: "await_ticket_query" });
    await editMessage(env, chatId, cq.message.message_id, "Введите номер тикета:", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Отмена", callback_data: "menu" }]] } });
    return;
  }
  if (data.startsWith("client:")) {
    const clientId = Number(data.split(":")[1]);
    const result = await api.ticketsForClient(clientId);
    const perPage = Number(env.TICKETS_PER_PAGE || 5);
    await setUserState(env, identity.user.id, { type: "client_tickets", client_id: clientId, tickets: result.tickets, truncated: result.truncated });
    const page = ticketPageText(api, result.tickets, 0, perPage, result.truncated);
    const nav = [];
    if (page.pages > 1) nav.push({ text: "➡️", callback_data: "tickets_page:1" });
    const keyboard = [];
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "⬅️ Меню", callback_data: "menu" }]);
    await editMessage(env, chatId, cq.message.message_id, page.text, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }
  if (data.startsWith("tickets_page:")) {
    const wanted = Number(data.split(":")[1]);
    const state = await getUserState(env, identity.user.id);
    if (state?.type !== "client_tickets") return;
    const perPage = Number(env.TICKETS_PER_PAGE || 5);
    const page = ticketPageText(api, state.tickets || [], wanted, perPage, state.truncated);
    const nav = [];
    if (page.page > 0) nav.push({ text: "⬅️", callback_data: `tickets_page:${page.page - 1}` });
    if (page.page + 1 < page.pages) nav.push({ text: "➡️", callback_data: `tickets_page:${page.page + 1}` });
    const keyboard = [];
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "🏠 Меню", callback_data: "menu" }]);
    await editMessage(env, chatId, cq.message.message_id, page.text, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }
  if (data === "admin_operators") {
    if (!identity.admin) return;
    const operators = await api.operators();
    let dialogs = [];
    const needsCounts = operators.some((op) => api.operatorDialogsCount(op) === null);
    if (needsCounts) dialogs = await api.dialogs();
    const counts = new Map();
    for (const d of dialogs) {
      const oid = api.dialogOperatorId(d);
      if (oid) counts.set(oid, (counts.get(oid) || 0) + 1);
    }
    const lines = operators.map((op) => {
      const id = api.operatorId(op);
      const online = api.operatorOnline(op) ? "🟢" : "⚫";
      const count = api.operatorDialogsCount(op) ?? counts.get(id) ?? 0;
      return `${online} <b>${esc(api.operatorName(op))}</b>\nID: <code>${id ?? "—"}</code> · чатов: ${count}`;
    });
    const text = lines.join("\n\n") || "Операторы не найдены.";
    await editMessage(env, chatId, cq.message.message_id, text.slice(0, 4000), { reply_markup: { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "admin_operators" }], [{ text: "⬅️ Меню", callback_data: "menu" }]] } });
  }
}

export async function processAssignments(env) {
  const api = new Chat2DeskAPI(env);
  const dialogs = await api.dialogs();
  const assignments = {};
  for (const dialog of dialogs) {
    const dialogId = api.dialogId(dialog);
    const operatorId = api.dialogOperatorId(dialog);
    if (!dialogId || !operatorId) continue;
    assignments[String(dialogId)] = {
      operator_id: operatorId,
      client_id: api.dialogClientId(dialog),
      client_name: api.dialogClientName(dialog),
    };
  }
  const { changes } = await (await import("./state.js")).assignmentDiff(env, assignments);
  for (const change of changes) {
    const operator = operatorForChat2DeskId(env, change.operator_id);
    if (!operator) continue;
    const telegramId = await telegramIdForUsername(env, operator.telegram_username);
    if (!telegramId) continue; // Оператор ещё ни разу не открыл бота.
    await sendMessage(env, telegramId, `🔔 <b>Вам назначен чат</b>\n\nКлиент: <b>${esc(change.client_name || "Клиент")}</b>\nDialog ID: <code>${change.dialog_id}</code>${change.client_id ? `\nClient ID: <code>${change.client_id}</code>` : ""}`).catch((error) => console.error("assignment telegram", error));
  }
  return { dialogs: Object.keys(assignments).length, notifications: changes.length };
}
