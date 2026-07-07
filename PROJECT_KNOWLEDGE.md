# Aura Salon OS — project knowledge

Last updated: 2026-07-07

## Purpose and deployment target

This folder is the Node.js/MySQL Hostinger edition of Aura Salon OS. The parent folder contains the original Flask/SQLite reference application. Hostinger should deploy only `hostinger-node`.

Stack: Node.js 20+, Express, Nunjucks, MySQL/MariaDB, MySQL sessions, Meta WhatsApp Cloud API and SMTP.

## Current local environment

- App URL: `http://localhost:3000`
- Local MariaDB listens on `127.0.0.1:3307` using `.local-mariadb/`.
- Local secrets live in `.env`; both paths are ignored by Git.
- Portable Node is under `.runtime/` and is also ignored.
- Start Node locally with `.\.runtime\node-v22.17.1-win-x64\node.exe src\app.js`.
- Run tests with `.\.runtime\node-v22.17.1-win-x64\node.exe --test`.

Never commit `.env`, database files, tokens or passwords.

## Implemented decisions

### Billing

- Customer is searchable by name or mobile through a datalist; the submitted value is the actual customer ID.
- Line items use cascading selectors. Service flow is Type → Gender → Category → Service. Men shows only Men categories and Women shows only Women categories. Product, Package and Membership flows omit gender and show only records/categories belonging to the selected type.
- Catalogue prices auto-populate and are read-only in the UI.
- The server re-reads official prices from MySQL, so a browser cannot submit an arbitrary price.
- Amount received is intentionally blank and required. Staff must enter the amount actually received; entering `0` creates an unpaid Pending bill, a smaller amount creates Partially Paid, and the full amount creates Paid. Billing validation highlights fields inline in red instead of relying on page-level error banners.
- A discount reason becomes mandatory when a discount is entered. It is stored in `sales.discount_note` and printed beneath the invoice discount.
- Existing invoices have an Edit invoice action for date, discount/reason, GST, amount received, payment mode and notes. Invoice pages also provide a primary WhatsApp send action and an optional email send action; both use the customer contact details and configured Meta/Twilio/SMTP settings.
- Customer creation/editing requires both a WhatsApp mobile number and an email address so either invoice delivery channel is available.
- Discount, optional GST and loyalty redemption remain supported.

### Raja Rani service menu

Source documents:

- `Raja Rani women menu final version.pdf`
- `Raja Rani men menu final version.pdf`

The import script contains 192 menu records grouped as `Women · ...` and `Men · ...`. Where a PDF lists a range or “onwards,” the lower amount is stored as the starting price. Consultation-only Hair Extensions is stored at ₹0 and should be updated after salon confirmation.

Run the idempotent import with `npm run menu:import`. To archive all existing services and make the attached menu the active catalogue, set `RESET_EXISTING_SERVICES=YES` for that run. The current local database has already been reset to the 192 menu services.

### Service and team assignment

- Service forms collect Gender (`Women`, `Men`, or `Both`) and Category separately. Category remains searchable and accepts a custom value inline; storage stays compatible with the existing `Gender · Category` catalogue format.
- Services can be linked to multiple team members, and team members can be linked to multiple services. Both screens edit the same `service_staff` junction table.
- Billing and staff-assisted appointment booking narrow the team list using these assignments. A service with no assignment remains available to every active team member for backward compatibility.

### Users and access control

- `/users` is the owner/admin user-management area. It supports account creation, team-member linking, predefined roles, custom module permissions, activation/deactivation, temporary-password resets and forced password changes.
- Roles are Owner, Admin, Manager, Receptionist, Team and Custom. Permissions are enforced by middleware before route handlers; hiding navigation is only a secondary UI measure.
- Only owners can create or manage owner/admin accounts. Users cannot deactivate or change their own role, and the final active owner cannot be removed.
- Team-role accounts see only appointments assigned to their linked staff record.
- User/security changes and successful logins are written to `audit_logs`.

### Spreadsheet import

Services, Team, Inventory, Packages and Expenses screens support `.xlsx` and `.csv` uploads. Each screen offers a generated Excel template whose header names exactly match accepted database fields. Imports append records; blank rows are skipped.

Management screens also provide per-record editing, clear search/category filters, and checkbox-based bulk Active/Inactive/Archive actions for services, team, inventory and packages. Expenses include Payroll as a first-class category. Billing search filters invoice/customer/mode text immediately and includes payment-status, from/to date and clear-filter controls.

## Important files

- `src/app.js` — Express setup, sessions, origin guard and shared middleware.
- `src/routes/core.js` — customers, dashboard and billing.
- `src/routes/operations.js` — services/team/inventory/packages/expenses, spreadsheet imports, reports and settings.
- `views/bill_form.html` — searchable catalogue billing UI.
- `views/manage.html` — management search, category filter and Excel import UI.
- `scripts/schema.sql` — MySQL schema.
- `scripts/migrate-sqlite.js` — one-time SQLite-to-MySQL migration.
- `scripts/import-rajarani-menu.js` — men’s and women’s menu catalogue.
- `RELEASE_CHECKLIST.md` — production checks.

## Verification status

- 26 automated tests pass.
- Production dependency audit reports 0 known vulnerabilities.
- Billing, all management pages and Excel template downloads return HTTP 200 locally.
- The local billing catalogue exposes the active Raja Rani services plus configured products/packages.
- Before production, manually test one paid bill, one partial-payment bill, an Excel import per module, appointment booking, invoice printing and mobile navigation.

## Next recommended work

1. Add edit/archive actions to every management record.
2. Confirm service durations, commissions and any range prices with Raja Rani; imported defaults use 60 minutes and 0% commission.
3. Decide whether Hair Extensions should remain ₹0/consultation-only or receive a starting price.
4. Complete the Hostinger environment/MySQL setup and release checklist.
