# Thrive Campaigns

Single-tenant ad generation and deployment software for Thrive Campaigns.

## Live App

- Production: https://thrive-digital-marketing-ad-generat.vercel.app
- Convex production: https://cheery-cobra-258.convex.cloud
- Convex local dev: https://impartial-shrimp-656.convex.cloud

## Local Convex Binding

Local development uses the dedicated Thrive Campaigns Convex dev deployment in `.env.local` and `backend/.env.local`:

- `CONVEX_DEPLOYMENT`
- `CONVEX_URL`
- `CONVEX_SITE_URL`

Do not bind this fork to another client's Convex deployment. A fresh Thrive instance should start with empty Convex tables and no inherited users, sessions, projects, ads, costs, or file storage.

## Useful Commands

```bash
pnpm install
npx convex dev --once --typecheck=disable
pnpm --dir frontend build
```
