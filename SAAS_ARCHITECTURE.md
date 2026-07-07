# Aura SaaS architecture

## URL model

- Marketing site: `www.example.com`
- Staff application: `app.example.com/s/{salon-slug}` initially
- Public booking: `app.example.com/s/{salon-slug}/book`
- Platform administration: `app.example.com/platform`

Path-based tenants are the simplest reliable first release. Wildcard subdomains (`salon.example.com`) and custom domains can be added later without changing the tenant data model. A booking link is preferred; iframe embedding can also be enabled with an explicit allowlist and suitable security headers.

## Security boundary

All salons use one maintained application and database, but every salon-owned row must carry `salon_id`. Every read, update, insert, report, export, API, background task, and uploaded file must be scoped using the authenticated tenant context. An approved salon record alone does not yet provide full isolation.

Platform administrators are stored separately from salon users. They approve, suspend, and oversee tenants. Salon owners manage only users and data inside their own salon.

## Migration phases

1. Control plane: applications, approval, suspension, salon branding and platform administrators.
2. Tenant isolation: add `salon_id`, migrate the existing data into a default salon, scope every query and make identifiers unique per salon.
3. Provisioning: approval creates the first salon-owner login, default settings and onboarding checklist.
4. Tenant URLs and public booking: resolve salon from the URL and apply salon-specific branding, availability and notifications.
5. Commercial layer: plans, trials, subscriptions, limits, invoices and platform reporting.

The current commit implements the first control-plane foundation. Tenant isolation must be completed before accepting real salons.
