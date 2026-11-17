
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
        const id = Number(req.params.id);

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

// ==========================================
// PERSISTENT PERSONAL DATABASE
// ==========================================

const DATA_DIR = path.join(__dirname, "data");
const DATABASE_FILE = path.join(DATA_DIR, "noboxd.json");
let databaseWriteQueue = Promise.resolve();

async function readDatabase() {
    try {
        const raw = await fs.readFile(DATABASE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return {
            exists: true,
            database: {
                games: Array.isArray(parsed.games) ? parsed.games : [],
                diary: Array.isArray(parsed.diary) ? parsed.diary : []
            }
        };
    } catch (error) {
        if (error.code === "ENOENT") {
            return { exists: false, database: { games: [], diary: [] } };
        }
        throw error;
    }
}

app.get("/api/database", async (req, res) => {
    try {
        res.set("Cache-Control", "no-store");
        res.json(await readDatabase());
    } catch (error) {
        console.error("Database read error:", error);
        res.status(500).json({ error: "Could not read the NOBoxd database." });
    }
});

app.put("/api/database", async (req, res) => {
    const games = req.body?.games;
    const diary = req.body?.diary;

    if (!Array.isArray(games) || !Array.isArray(diary)) {
        return res.status(400).json({ error: "Database must contain games and diary arrays." });
    }

    const payload = JSON.stringify({ games, diary }, null, 2);
    databaseWriteQueue = databaseWriteQueue.then(async () => {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const tempFile = DATABASE_FILE + ".tmp";
        await fs.writeFile(tempFile, payload, "utf8");
        await fs.rename(tempFile, DATABASE_FILE);
    });

    try {
        await databaseWriteQueue;
        res.json({ success: true, games: games.length, diary: diary.length });
    } catch (error) {
        console.error("Database write error:", error);
        res.status(500).json({ error: "Could not save the NOBoxd database." });
    }
});

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
