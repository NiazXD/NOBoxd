# NOBoxd

NOBoxd has two deployment pieces:

- **Frontend:** GitHub Pages serves `index.html` from the repository root at
  `https://niazxd.github.io/NOBoxd/`.
- **API:** `server.js` must run on a Node-capable host. GitHub Pages is static
  hosting and cannot run the IGDB proxy or save the shared database.

## Local development

```bash
npm ci
npm start
```

Create a `.env` file with the Twitch credentials used to access IGDB:

```env
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
```

## Connect GitHub Pages to the API

Deploy this repository's Node server to a service that supports persistent
storage. Configure these environment variables on that service:

```env
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
CORS_ORIGIN=https://niazxd.github.io
DATA_DIR=/path/to/persistent/data
```

Then set `window.NOBOXD_API_URL` in `noboxd.config.js` to the public HTTPS URL
of that API (without a trailing slash) and publish the change. The API allows
only the configured origins; use a comma-separated `CORS_ORIGIN` value to allow
additional development origins.

