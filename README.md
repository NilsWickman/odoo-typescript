# odoo-typescript

I ported Odoo 20 Community from Python to TypeScript running on Cloudflare Workers.

**Live demo (`admin` / `admin`):** https://odoo-ts-demo.nilswickman.com

Also worth mentioning: I've never read a single line of this code.

## Dependencies & Running Locally

Requires **Node.js 22+**, **PostgreSQL 16** (with an Odoo 20 Community database), and **Python 3.12** (only if regenerating asset/metadata packs).

```bash
cd worker && npm install && npm test
ODOO_PG_DSN_TEMPLATE='postgresql://user:pass@127.0.0.1:5432/{db}' ./start.sh
```

Or just point your coding agent at this repo and ask it to get it running locally or on Cloudflare Workers.

## License

Licensed under **LGPL-3.0** ([LICENSE](LICENSE)), matching Odoo Community.
Not affiliated with, endorsed by, or sponsored by Odoo S.A.
