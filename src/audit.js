// Dziennik zdarzeń bezpieczeństwa (logowania, blokady, sesje).
// Każde zdarzenie trafia:
//  - do tabeli auth_events (podgląd w panelu admina "Bezpieczeństwo"),
//  - na standardowe wyjście jako JSON -> w Azure trafia do Log Analytics,
//    gdzie można je wyszukiwać i liczyć (proste wykrywanie ataków - IDS).
// Nigdy nie zapisujemy haseł ani identyfikatorów sesji.
const { pool } = require('./db');

async function logEvent(req, event, { userId = null, username = null, detail = null } = {}) {
    const ip = req.ip || null;
    const userAgent = String(req.get('user-agent') || '').slice(0, 200);
    const name = username ? String(username).slice(0, 50) : null;

    console.log(JSON.stringify({ type: 'security', event, user: name, ip, detail }));
    try {
        await pool.query(
            `INSERT INTO auth_events (event, user_id, username, ip, user_agent, detail)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [event, userId, name, ip, userAgent, detail ? String(detail).slice(0, 200) : null]
        );
    } catch (err) {
        // błąd zapisu dziennika nie może zablokować logowania
        console.error('[audit] Nie zapisano zdarzenia:', err.message);
    }
}

module.exports = { logEvent };
