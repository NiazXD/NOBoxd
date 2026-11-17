
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.CORS_ORIGIN || [
    "https://niazxd.github.io",
    "http://localhost:3000"
].join(","))
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(express.json());
app.use((req, res, next) => {
    const origin = req.get("Origin");

    // Requests without an Origin header include health checks and server-to-server calls.
    if (!origin) {
        return next();
    }

    if (!allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: "Origin is not allowed by CORS." });
    }

    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.vary("Origin");

    return req.method === "OPTIONS" ? res.sendStatus(204) : next();
});

const IGDB_URL = "https://api.igdb.com/v4";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

let accessToken = null;
let tokenExpiresAt = 0;
let tokenRequest = null;

// ==========================================
// TWITCH AUTHENTICATION
// ==========================================

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt) {
        return accessToken;
    }

    // Prevent simultaneous requests from generating multiple tokens.
    if (tokenRequest) {
        return tokenRequest;
    }

    tokenRequest = (async () => {
        const clientId = process.env.TWITCH_CLIENT_ID;
        const clientSecret = process.env.TWITCH_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            throw new Error("Missing Twitch API credentials in .env");
        }

        const params = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "client_credentials"
        });

        const response = await fetch(TWITCH_TOKEN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params,
            signal: AbortSignal.timeout(15000)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                `Twitch authentication failed (${response.status}): ${data.message || "Unknown error"}`
            );
        }

        accessToken = data.access_token;
        tokenExpiresAt = Date.now() + (data.expires_in - 120) * 1000;

        console.log("IGDB authentication successful.");

        return accessToken;
    })();

    try {
        return await tokenRequest;
    } finally {
        tokenRequest = null;
    }
}

// ==========================================
// IGDB REQUEST HELPER
// ==========================================

async function igdbRequest(endpoint, query) {
    const token = await getAccessToken();
    const response = await fetch(`${IGDB_URL}/${endpoint}`, {
        method: "POST",
        headers: {
            "Client-ID": process.env.TWITCH_CLIENT_ID,
            "Authorization": `Bearer ${token}`,
            "Content-Type": "text/plain"
        },
        body: query,
        signal: AbortSignal.timeout(20000)
    });
    if (response.status === 401) {
        accessToken = null;
        tokenExpiresAt = 0;
    }
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`IGDB error (${response.status}): ${error}`);
    }
    return response.json();
}

// No-account fallback: Steam's public store search and app-details endpoints.
async function steamSearch(search, limit = 20) {
    const url = new URL("https://store.steampowered.com/api/storesearch/");
    url.search = new URLSearchParams({ term: search, l: "english", cc: "us" });
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Steam search failed (${response.status})`);
    const payload = await response.json();
    return (payload.items || []).slice(0, limit).map(item => ({
        id: `steam_${item.id}`,
        name: item.name,
        coverUrl: item.tiny_image || null,
        first_release_date: null,
        genres: [],
        platforms: [{ name: "PC (Steam)" }],
        summary: "",
        source: "Steam"
    }));
}

async function steamDetails(appId) {
    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.search = new URLSearchParams({ appids: String(appId), l: "english", cc: "us" });
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Steam details failed (${response.status})`);
    const payload = await response.json();
    const result = payload[String(appId)];
    if (!result?.success || !result.data) return null;
    const game = result.data;
    const release = game.release_date?.date || "";
    const parsedDate = Date.parse(release);
    return {
        id: `steam_${appId}`,
        name: game.name || "Unknown game",
        cover: { url: game.header_image || game.capsule_image || "" },
        coverUrl: game.header_image || game.capsule_image || "",
        first_release_date: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : null,
        genres: (game.genres || []).map(item => ({ name: item.description })),
        platforms: Object.entries(game.platforms || {})
            .filter(([, supported]) => supported)
            .map(([name]) => ({ name: name === "windows" ? "Windows" : name === "mac" ? "macOS" : "Linux" })),
        involved_companies: (game.developers || []).map(name => ({ company: { name }, developer: true })),
        summary: game.short_description || "",
        storyline: "",
        source: "Steam"
    };
}

// ==========================================
// GAME DATA FORMATTING
// ==========================================

function formatGame(game) {
    const cover = game.cover?.url || null;

    return {
        ...game,

        cover: cover
            ? {
                ...game.cover,
                url: cover.startsWith("//")
                    ? `https:${cover}`
                    : cover
            }
            : null
    };
}

function escapeIGDBString(value) {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
}

// ==========================================
// SEARCH GAMES
// GET /api/games?search=elden ring
// ==========================================

app.get("/api/games", async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();

        if (!search || search.length > 100) {
            return res.status(400).json({
                error: "Enter a game name (maximum 100 characters)."
            });
        }

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 20, 1),
            50
        );

        const offset = Math.max(
            parseInt(req.query.offset, 10) || 0,
            0
        );

        const safeSearch = escapeIGDBString(search);

        const query = `
            search "${safeSearch}";
            fields
                name,
                summary,
                storyline,
                first_release_date,
                cover.url,
                genres.name,
                platforms.name,
                involved_companies.company.name,
                involved_companies.developer,
                involved_companies.publisher,
                rating,
                rating_count,
                total_rating,
                total_rating_count,
                game_modes.name,
                themes.name;
            limit ${limit};
            offset ${offset};
        `;

        if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
            return res.json(await steamSearch(search, limit));
        }

        const games = await igdbRequest("games", query);
        res.json(games.map(formatGame));

    } catch (error) {
        console.error("Game search error:", error.message);

        res.status(502).json({
            error: "Could not retrieve games. Check server logs."
        });
    }
});

// ==========================================
// GET GAME DETAILS
// GET /api/games/12345
// ==========================================

app.get("/api/games/:id", async (req, res) => {
    try {
        const requestedId = String(req.params.id);
        if (requestedId.startsWith("steam_")) {
            const steamId = requestedId.slice(6);
            if (!/^\d+$/.test(steamId)) {
                return res.status(400).json({ error: "Invalid Steam app ID." });
            }
            const steamGame = await steamDetails(steamId);
            if (!steamGame) return res.status(404).json({ error: "Game not found." });
            return res.json(steamGame);
        }

        const id = Number(requestedId);

        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid IGDB game ID."
            });
        }

        const query = `
            fields
                name,
                summary,
                storyline,
                first_release_date,
                cover.url,
                screenshots.url,
                artworks.url,
                genres.name,
                platforms.name,
                involved_companies.company.name,
                involved_companies.developer,
                involved_companies.publisher,
                rating,
                rating_count,
                total_rating,
                total_rating_count,
                game_modes.name,
                themes.name,
                player_perspectives.name,
                websites.url,
                similar_games.name,
                similar_games.cover.url;
            where id = ${id};
            limit 1;
        `;

        const games = await igdbRequest("games", query);

        if (!games.length) {
            return res.status(404).json({
                error: "Game not found."
            });
        }

        res.json(formatGame(games[0]));

    } catch (error) {
        console.error("Game details error:", error.message);

        res.status(502).json({
            error: "Could not retrieve game details."
        });
    }
});

// Personal library and diary data stay in browser localStorage on the free deployment.

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
    res.json({
        status: "NOBoxd backend is running!",
        igdbConfigured: Boolean(
            process.env.TWITCH_CLIENT_ID &&
            process.env.TWITCH_CLIENT_SECRET
        ),
        authenticated: Boolean(
            accessToken && Date.now() < tokenExpiresAt
        )
    });
});

// The browser app is at the repository root for GitHub Pages, while the
// development server keeps serving it at the same URL.
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
    console.log("--------------------------------");
    console.log("       NOBOXD BACKEND");
    console.log("--------------------------------");
    console.log(`Server: http://localhost:${PORT}`);
    console.log(
        `IGDB credentials: ${
            process.env.TWITCH_CLIENT_ID &&
            process.env.TWITCH_CLIENT_SECRET
                ? "Configured"
                : "Missing"
        }`
    );
    console.log("--------------------------------");
});
