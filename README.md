# Aura Salon OS — Hostinger edition

This is the isolated Node.js/MySQL port of the original Flask application. The Flask source in the parent directory is retained as the reference and fallback.

## Stack

- Node.js 20+ and Express
- Nunjucks server-rendered templates
- Hostinger MySQL
- MySQL-backed login sessions
- Meta WhatsApp Cloud API and SMTP email

## Local setup

1. Copy `.env.example` to `.env` and enter a local MySQL database.
2. Run `npm install`.
3. Run `npm run db:init`.
4. Run `npm start` and open `http://localhost:3000`.

The initial login is `admin`; its password is read from `INITIAL_ADMIN_PASSWORD` during database initialization.

## Existing data migration

Initialize the target schema first. Then set `CONFIRM_DATA_MIGRATION=YES` and `INITIAL_ADMIN_PASSWORD` and run:

```sh
npm run db:migrate -- ../salon.db
```

The migration empties the target Aura tables, copies all supported records while retaining IDs, and creates a Node-compatible admin password. Never run it against a database containing newer production records.

## Hostinger deployment

1. Push only this directory to a private GitHub repository.
2. In Hostinger choose **Node.js Web App → Import Git repository**.
3. Use `npm install` as the build command and `npm start` as the start command.
4. Add all `.env.example` keys as Hostinger environment variables; use strong unique secrets.
5. Initialize or migrate the MySQL database once.
6. Confirm `/health`, sign in, and complete the release checklist in `RELEASE_CHECKLIST.md`.

Create a daily Hostinger cron request to `POST /tasks/send-reminders?key=YOUR_CRON_SECRET` to deliver next-day reminders. Keep that URL private.

Never commit `.env`, Meta tokens, SMTP passwords, database passwords, or session secrets.

See `PROJECT_KNOWLEDGE.md` for current architecture decisions, local workflow, implemented billing/menu behavior, and next-session handoff notes.
