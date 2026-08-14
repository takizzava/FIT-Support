export function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

export function parseOperators(env) {
  let rows;
  try {
    rows = JSON.parse(env.OPERATOR_MAP_JSON || "[]");
  } catch (error) {
    throw new Error(`Некорректный OPERATOR_MAP_JSON: ${error.message}`);
  }
  return rows.map((row) => ({
    telegram_username: normalizeUsername(row.telegram_username),
    chat2desk_operator_id: Number(row.chat2desk_operator_id),
    name: String(row.name || row.telegram_username || row.chat2desk_operator_id),
  })).filter((row) => row.telegram_username && Number.isFinite(row.chat2desk_operator_id));
}

export function parseAdmins(env) {
  return new Set(String(env.ADMIN_TELEGRAM_USERNAMES || "")
    .split(",")
    .map(normalizeUsername)
    .filter(Boolean));
}

export function operatorForUsername(env, username) {
  const normalized = normalizeUsername(username);
  return parseOperators(env).find((row) => row.telegram_username === normalized) || null;
}

export function operatorForChat2DeskId(env, operatorId) {
  const id = Number(operatorId);
  return parseOperators(env).find((row) => row.chat2desk_operator_id === id) || null;
}

export function isAdmin(env, username) {
  return parseAdmins(env).has(normalizeUsername(username));
}
