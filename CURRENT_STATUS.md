# Aura Salon SaaS - Current Status

Last updated: 2026-07-09

## Current deployment

- Repository: `Vikashai/aura-salon-saas`
- Production branch: `master`
- Hostinger currently auto-deploys the Node.js application from GitHub.
- Temporary application URL: `https://deeppink-cat-376759.hostingersite.com`
- Production database is MySQL on Hostinger.
- Raja Rani is a normal salon tenant within the SaaS application, not a separate codebase.

Do not place passwords, SMTP app passwords, Meta tokens, database credentials, or recovery codes in this file or Git.

## Completed

- Multi-tenant salon structure and Aura company-admin control plane.
- Salon user authentication, roles, access permissions, temporary passwords, password changes, and email-based password recovery.
- Raja Rani data migrated into the hosted database.
- Customers, appointments, billing, services, team, inventory, packages, expenses, reports, loyalty, greetings, settings, and users/access modules.
- Customer email is optional; customer phone and email duplicates are blocked within each salon.
- Split payments, sales totals, referral rewards, seating capacity, service/team assignments, and detailed expenses.
- Salon branding, custom logos, colours, public booking experience, and tenant-specific settings.
- PDF invoice generation, invoice download, manual invoice email, and optional automatic invoice email.
- Meta WhatsApp webhook, registered business number, payment method, permanent token configuration, and service-message testing.
- Automated test suite: 67 tests passing as of this update.

## WhatsApp status

- The Meta business number and webhook are connected.
- The custom `salon_invoice` document template was submitted to Meta and was still under review at the last check.
- WhatsApp invoice buttons, automatic WhatsApp invoice sending, and related failure notices are intentionally hidden until the production invoice flow is fully approved and verified.
- The internal feature gate is the salon setting `whatsapp_invoice_live=1`. Do not enable it until the template and PDF/document delivery flow have passed production testing.
- Email invoice delivery remains available while WhatsApp invoice delivery is hidden.

## Immediate resume point

1. Finish the Raja Rani public website.
2. Purchase or select the production domain.
3. Connect the production domain to the Hostinger Node.js application and confirm HTTPS.
4. Update Aura's public/base URL configuration and any Hostinger environment variables that reference the temporary URL.
5. Update Meta with the production domain:
   - App domain
   - Webhook callback: `https://<production-domain>/webhooks/meta/whatsapp`
   - Privacy policy URL
   - Terms of service URL
   - User-data deletion URL/instructions
6. Verify and save the webhook on the new domain while keeping the same verify token.
7. Confirm the approved status and exact structure of `salon_invoice`.
8. Complete and test WhatsApp PDF invoice delivery, then enable `whatsapp_invoice_live` only after successful end-to-end testing.
9. Run a final release check: login, password reset, customer creation, appointment, paid/partial bill, PDF download, invoice email, mobile layout, tenant isolation, and backups.

## Domain migration notes

- Connecting a domain does not replace the WhatsApp Business Account, registered phone number, templates, or permanent access token.
- The Meta callback URL and app URLs must be updated to the new HTTPS domain.
- Keep the temporary Hostinger URL available until login, email, webhook verification, and core salon flows work on the production domain.
- Test the production domain in a fresh browser session before sharing it with Raja Rani.

## Recent release state

- Commit `8e90a56` hides unfinished WhatsApp invoice controls and fixes the optional email-field alignment.
- At that commit, all 67 automated tests passed.

