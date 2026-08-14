function csvCell(value) {
  const text = String(value ?? "").replaceAll('"', '""').replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return `"${text}"`;
}

export function ticketsToCsv(api, tickets) {
  const lines = [["Номер", "Название", "Описание", "Обращения"]];
  for (const ticket of tickets) {
    lines.push([
      api.ticketNumber(ticket) ?? api.ticketId(ticket) ?? "",
      api.ticketTitle(ticket),
      api.ticketDescription(ticket),
      api.ticketRequestIds(ticket).join(", "),
    ]);
  }
  return "\uFEFF" + lines.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
