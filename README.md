# FIT Support — Cloudflare Workers

Внутренний Telegram-бот технической поддержки Future-IT-Pro поверх Chat2Desk.

## Что реализовано

- Cloudflare Worker, без VPS, Docker, FastAPI, aiogram и постоянно работающего процесса.
- Telegram webhook.
- Хардкод операторов по Telegram `@username` ↔ Chat2Desk operator ID.
- Numeric Telegram ID оператор вводить не нужно: после первого `/start` бот запоминает его автоматически в Durable Object.
- Уведомление только при назначении/передаче чата оператору.
- Поиск клиентов.
- Просмотр тикетов клиента: номер, название, описание.
- Отдельный поиск тикета по номеру.
- Два админа: `@terraktorill` и `@Des_pair`.
- Админский список операторов: online/offline и количество открытых чатов.
- Cron Trigger раз в минуту для проверки назначений.
- Persistent state через SQLite-backed Cloudflare Durable Object; отдельную БД создавать не нужно.

## 1. Заменить содержимое GitHub

Удалите старые Python/Docker-файлы из репозитория и загрузите **всё содержимое этого каталога** в корень репозитория.

В корне должны находиться:

```text
package.json
wrangler.jsonc
src/
test/
README.md
.env.example
.gitignore
```

После commit/push Cloudflare должен выполнить:

```text
Build command: пусто
Deploy command: npx wrangler deploy
Root directory: /
```

`wrangler.jsonc` уже содержит entrypoint `src/index.js`, Cron Trigger и Durable Object migration. Никакие KV/D1 namespace вручную создавать не требуется.

## 2. Переменные уже заполнены

В `wrangler.jsonc` уже прописаны:

- `CHAT2DESK_API_BASE=https://api.chat2desk.com`
- два админа: `terraktorill,Des_pair`
- все 6 операторов и их Chat2Desk operator ID
- настройки поиска и пагинации

Операторы:

| Telegram | Chat2Desk ID | Имя |
|---|---:|---|
| @terraktorill | 322416 | Роман Онюшкин |
| @Meldori | 322423 | Егор Латышев |
| @looking4victims | 322424 | Миртемир Токтогулов |
| @Warewarewarewa | 326121 | Видана Мартынова |
| @qRainyyy | 326575 | Эрьян Муратов |
| @Des_pair | 322395 | Данила Ворончихин |

## 3. Добавить четыре Secret в Cloudflare

Откройте:

`Workers & Pages -> fit-support -> Settings -> Variables and Secrets -> Add`

Добавьте как **Secret**:

### TELEGRAM_BOT_TOKEN

Новый токен из `@BotFather`.

**Не используйте токен, который уже публиковался в переписке. Сначала перевыпустите его в BotFather.**

### CHAT2DESK_API_TOKEN

Ваш API-token Chat2Desk.

API token также уже попадал в переписку, поэтому для production рекомендуется перевыпустить его в Chat2Desk и вставить новый.

### TELEGRAM_WEBHOOK_SECRET

Любая длинная случайная строка без пробелов, например 40+ символов. Telegram будет присылать её в заголовке webhook, а Worker будет её проверять.

### SETUP_SECRET

Ещё одна длинная случайная строка. Она нужна только для защищённого запуска `/setup` и ручного `/cron-test`.

После добавления secrets выполните новый Deploy (или Retry deployment).

## 4. Проверить Worker

После deploy Cloudflare покажет адрес вида:

```text
https://fit-support.<ваш-subdomain>.workers.dev
```

Откройте его в браузере. Должно вернуться примерно:

```json
{"ok":true,"service":"fit-support","runtime":"cloudflare-workers"}
```

## 5. Один раз подключить Telegram webhook

Откройте в браузере:

```text
https://fit-support.<ваш-subdomain>.workers.dev/setup?secret=ВАШ_SETUP_SECRET
```

В ответ должно быть `"ok": true`.

После этого Telegram сам будет отправлять все сообщения в Worker. Ничего постоянно запускать не требуется.

## 6. Первый запуск операторов

Каждый оператор один раз открывает бота и нажимает Start (`/start`).

Бот сверяет его Telegram username с хардкодным списком и автоматически записывает numeric Telegram user ID в Durable Object. Вы ничего дополнительно в env не дописываете.

Если пользователь сменит Telegram username, нужно поменять `telegram_username` в `wrangler.jsonc` и сделать push/deploy.

## 7. Уведомления о назначении

Cron запускается раз в минуту и получает открытые диалоги Chat2Desk.

- При первом запуске создаётся baseline, поэтому существующие чаты не рассылаются всем повторно.
- Если у диалога появился новый `operator_id`, соответствующий оператор получает `🔔 Вам назначен чат`.
- Если чат передали от одного оператора другому, уведомление получает новый оператор.
- Никаких уведомлений о тикетах, SLA, ожидании клиента и т.п. нет.

Важно: оператор должен хотя бы один раз нажать `/start`, иначе Telegram ещё не разрешил боту отправлять ему личные сообщения и numeric ID не сохранён.

## 8. Команды и интерфейс

### Оператор

`/start` или `/menu`:

- 🔎 Найти клиента
- 🎫 Найти тикет

`/id` показывает numeric Telegram ID, но для настройки он больше не требуется.

### Админ

Админы: `@terraktorill` и `@Des_pair`.

В меню дополнительно:

- 👥 Операторы

Показываются online/offline и количество открытых чатов.

## 9. Ручная проверка Cron

После того как добавлен `SETUP_SECRET`:

```text
https://fit-support.<ваш-subdomain>.workers.dev/cron-test?secret=ВАШ_SETUP_SECRET
```

Первый вызов создаёт baseline. Следующие вызовы покажут количество проверенных диалогов и изменений.

## 10. Если Cloudflare build снова упал

В build log НЕ должно быть установки Python-пакетов вроде:

```text
fastapi
aiogram
uvicorn
```

Нормальный build этой версии выглядит как npm/wrangler deployment и должен видеть:

```text
main = src/index.js
```

Если лог всё ещё ставит Python dependencies — в GitHub остались файлы старого проекта или Cloudflare смотрит не на тот commit/root directory.

## Безопасность

Никогда не добавляйте реальные токены в `wrangler.jsonc`, `.env.example`, README или GitHub. Secrets должны находиться только в Cloudflare Variables and Secrets.
