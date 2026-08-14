import test from "node:test";
import assert from "node:assert/strict";
import { isAdmin, operatorForUsername, parseOperators } from "../src/config.js";

const env = {
  ADMIN_TELEGRAM_USERNAMES: "terraktorill,Des_pair",
  OPERATOR_MAP_JSON: JSON.stringify([
    { telegram_username: "@terraktorill", chat2desk_operator_id: 322416, name: "Роман" },
    { telegram_username: "Meldori", chat2desk_operator_id: 322423, name: "Егор" },
  ]),
};

test("operator mapping is case insensitive", () => {
  assert.equal(operatorForUsername(env, "@MELDORI").chat2desk_operator_id, 322423);
  assert.equal(parseOperators(env).length, 2);
});

test("admin mapping is case insensitive", () => {
  assert.equal(isAdmin(env, "@des_PAIR"), true);
  assert.equal(isAdmin(env, "someone"), false);
});
