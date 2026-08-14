import { Chat2DeskAPI } from "./chat2desk.js";
import { ticketsToCsv } from "./csv.js";
import { isAdmin, operatorForUsername, operatorForChat2DeskId, normalizeUsername } from "./config.js";
import { answerCallback, editMessage, esc, mainKeyboard, sendDocument, sendMessage } from "./telegram.js";
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
  const display = api.ticketNumber(ticket) ?? api.ticketId(ticket) ?? "—";
  const internalId = api.ticketId(ticket);
  const idSuffix = internalId !== null && String(display) !== String(internalId) ? ` · ID <code>${internalId}</code>` : "";
  return `🎫 <b>${esc(display)}</b>${idSuffix}\n<b>${esc(api.ticketTitle(ticket))}</b>\n\nОписание:\n${esc(api.ticketDescription(ticket))}`;
}

function ticketPageText(api, tickets, page, perPage, truncated = false) {
  const pages = Math.max(1, Math.ceil(tickets.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const part = tickets.slice(safePage * perPage, safePage * perPage + perPage);
  const body = part.map((t) => ticketText(api, t)).join("\n\n────────────\n\n") || "Тикетов не найдено.";
  const warning = truncated ? "\n\n⚠️ Выборка была ограничена защитными лимитами API/Cloudflare." : "";
  return { text: `${body}${warning}\n\nВсего: ${tickets.length} · Страница ${safePage + 1}/${pages}`, page: safePage, pages };
}

function ticketResultKeyboard(api, tickets) {
  const rows = tickets.slice(0, 10).map((ticket) => [{
    text: `${api.ticketNumber(ticket) ?? api.ticketId(ticket) ?? "—"} · ${api.ticketTitle(ticket)}`.slice(0, 64),
    callback_data: `ticket:${api.ticketId(ticket)}`,
  }]);
  rows.push([{ text: "⬅️ Меню", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function clientTicketsKeyboard(page, pages, hasTickets) {
  const keyboard = [];
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: `tickets_page:${page - 1}` });
  if (page + 1 < pages) nav.push({ text: "➡️", callback_data: `tickets_page:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  if (hasTickets) keyboard.push([{ text: "📥 Выгрузить CSV", callback_data: "tickets_export" }]);
  keyboard.push([{ text: "🏠 Меню", callback_data: "menu" }]);
  return { inline_keyboard: keyboard };
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
      const keyboard = clients.map((client) => [{ text: api.clientLabel(client).slice(0, 64), callback_data: `client:${api.clientId(client)}` }]);
      keyboard.push([{ text: "⬅️ Меню", callback_data: "menu" }]);
      await sendMessage(env, chatId, `Найдено клиентов: ${clients.length}\nВыберите нужного:`, { reply_markup: { inline_keyboard: keyboard } });
      return;
    }

    if (state?.type === "await_ticket_query") {
      await setUserState(env, identity.user.id, null);
      await sendMessage(env, chatId, `⏳ Ищу тикеты по запросу: <b>${esc(text)}</b>`).catch(() => {});
      const result = await api.searchTickets(text, 10);
      if (!result.tickets.length) {
        await sendMessage(env, chatId, "Тикеты не найдены.", { reply_markup: mainKeyboard(identity.admin) });
        return;
      }
      if (result.tickets.length === 1) {
        await sendMessage(env, chatId, ticketText(api, result.tickets[0]), { reply_markup: mainKeyboard(identity.admin) });
        return;
      }
      await setUserState(env, identity.user.id, { type: "ticket_search_results", tickets: result.tickets });
      await sendMessage(env, chatId, `Найдено тикетов: ${result.tickets.length}${result.truncated ? "\nПоказаны первые совпадения." : ""}\n\nВыберите тикет:`, {
        reply_markup: ticketResultKeyboard(api, result.tickets),
      });
      return;
    }

    // Служебная диагностика для админов — помогает увидеть фактические поля API
    // без нового деплоя, если Chat2Desk снова изменит схему.
    if (identity.admin && text.startsWith("/debug_client")) {
      const clientId = Number(text.replace("/debug_client", "").replace(/[^0-9]/g, ""));
      if (!clientId) {
        await sendMessage(env, chatId, "Использование: <code>/debug_client 12345</code>");
        return;
      }
      const result = await api.ticketsForClient(clientId);
      const requestIds = result.requestIds || [];
      const requestSuffix = requestIds.length > 40 ? "\n…показаны первые 40 обращений" : "";
      const ticketLines = (result.tickets || []).slice(0, 30).map((ticket) =>
        `${esc(api.ticketNumber(ticket))} · <b>${esc(api.ticketTitle(ticket))}</b> · ID <code>${api.ticketId(ticket)}</code>`
      );
      const ticketSuffix = (result.tickets || []).length > 30 ? "\n…показаны первые 30 тикетов" : "";
      await sendMessage(
        env,
        chatId,
        `Client ID: <code>${clientId}</code>\nНайдено обращений: <b>${requestIds.length}</b>\nНайдено тикетов: <b>${(result.tickets || []).length}</b>\n\nRequest IDs: <code>${esc(requestIds.slice(0, 40).join(", ") || "—")}</code>${requestSuffix}\n\n<b>Тикеты:</b>\n${ticketLines.join("\n") || "—"}${ticketSuffix}`,
      );
      return;
    }

    if (identity.admin && text.startsWith("/debug_ticket")) {
      const number = Number(text.replace("/debug_ticket", "").replace(/[^0-9]/g, ""));
      if (!number) {
        await sendMessage(env, chatId, "Использование: <code>/debug_ticket 12345</code>");
        return;
      }
      const ticket = await api.getTicket(number);
      if (!ticket) {
        await sendMessage(env, chatId, `Тикет #${number} не найден.`);
        return;
      }
      const samples = Object.entries(ticket)
        .filter(([, value]) => typeof value === "string" || typeof value === "number")
        .slice(0, 20)
        .map(([key, value]) => `${key}=${String(value).slice(0, 120)}`)
        .join("\n");
      await sendMessage(
        env,
        chatId,
        `#${number}\nНазвание parser: <b>${esc(api.ticketTitle(ticket))}</b>\nПоля API: <code>${esc(api.ticketRawKeys(ticket).join(", "))}</code>\n\n<code>${esc(samples)}</code>`,
      );
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
    await editMessage(env, chatId, cq.message.message_id, "Введите <b>номер тикета</b> или <b>часть его названия</b>:", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Отмена", callback_data: "menu" }]] } });
    return;
  }
  if (data.startsWith("ticket:")) {
    const id = Number(data.split(":")[1]);
    let ticket = null;
    const state = await getUserState(env, identity.user.id);
    if (state?.type === "ticket_search_results") {
      ticket = (state.tickets || []).find((t) => Number(api.ticketId(t)) === id || Number(api.ticketNumber(t)) === id) || null;
    }
    if (!ticket) ticket = await api.getTicket(id);
    await editMessage(env, chatId, cq.message.message_id, ticket ? ticketText(api, ticket) : `Тикет #${id} не найден.`, {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Меню", callback_data: "menu" }]] },
    });
    return;
  }
  if (data.startsWith("client:")) {
    const clientId = Number(data.split(":")[1]);
    await editMessage(env, chatId, cq.message.message_id, `⏳ Загружаю обращения и тикеты клиента…\n\nClient ID: <code>${clientId}</code>`, {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Меню", callback_data: "menu" }]] },
    }).catch(() => {});

    try {
      const result = await api.ticketsForClient(clientId);
      const perPage = Number(env.TICKETS_PER_PAGE || 5);
      await setUserState(env, identity.user.id, {
        type: "client_tickets",
        client_id: clientId,
        tickets: result.tickets,
        truncated: result.truncated,
        request_ids: result.requestIds,
      });
      const page = ticketPageText(api, result.tickets, 0, perPage, result.truncated);
      await editMessage(env, chatId, cq.message.message_id, page.text, {
        reply_markup: clientTicketsKeyboard(page.page, page.pages, result.tickets.length > 0),
      });
    } catch (error) {
      console.error("client tickets", clientId, error);
      const message = String(error?.message || error || "Неизвестная ошибка").slice(0, 1000);
      await editMessage(env, chatId, cq.message.message_id,
        `❌ <b>Не удалось загрузить тикеты клиента.</b>\n\nClient ID: <code>${clientId}</code>\n\n<code>${esc(message)}</code>`,
        { reply_markup: { inline_keyboard: [[{ text: "⬅️ Меню", callback_data: "menu" }]] } }
      ).catch(() => {});
    }
    return;
  }
  if (data.startsWith("tickets_page:")) {
    const wanted = Number(data.split(":")[1]);
    const state = await getUserState(env, identity.user.id);
    if (state?.type !== "client_tickets") return;
    const perPage = Number(env.TICKETS_PER_PAGE || 5);
    const page = ticketPageText(api, state.tickets || [], wanted, perPage, state.truncated);
    await editMessage(env, chatId, cq.message.message_id, page.text, {
      reply_markup: clientTicketsKeyboard(page.page, page.pages, (state.tickets || []).length > 0),
    });
    return;
  }
  if (data === "tickets_export") {
    const state = await getUserState(env, identity.user.id);
    if (state?.type !== "client_tickets" || !(state.tickets || []).length) {
      await answerCallback(env, cq.id, "Нет тикетов для выгрузки").catch(() => {});
      return;
    }
    const csv = ticketsToCsv(api, state.tickets);
    await sendDocument(env, chatId, `chat2desk_client_${state.client_id}_tickets.csv`, csv, `Тикеты клиента ${state.client_id}: ${state.tickets.length}`);
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
      const configured = operatorForChat2DeskId(env, id);
      const displayName = configured?.name || api.operatorName(op);
      return `${online} <b>${esc(displayName)}</b>\nID: <code>${id ?? "—"}</code> · чатов: ${count}`;
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
    if (!telegramId) continue;
    await sendMessage(env, telegramId, `🔔 <b>Вам назначен чат</b>\n\nКлиент: <b>${esc(change.client_name || "Клиент")}</b>\nDialog ID: <code>${change.dialog_id}</code>${change.client_id ? `\nClient ID: <code>${change.client_id}</code>` : ""}`).catch((error) => console.error("assignment telegram", error));
  }
  return { dialogs: Object.keys(assignments).length, notifications: changes.length };
}
