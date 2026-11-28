// Middleware związane z logowaniem, uprawnieniami i czasem życia sesji.
const { pool } = require('./db');
const { ABSOLUTE_TIMEOUT_MS } = require('./security');

function regenerateSession(req) {
    return new Promise((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

// Przy KAŻDYM żądaniu odczytujemy użytkownika z bazy na podstawie sesji.
// Dzięki temu zablokowanie konta lub zmiana roli przez admina działa
// natychmiast, a nie dopiero po wylogowaniu.
async function loadUser(req, res, next) {
    req.user = null;
    const s = req.session;
    if (s.userId) {
        if (!s.loginAt || Date.now() - s.loginAt > ABSOLUTE_TIMEOUT_MS) {
            // sesja trwa za długo (max 8 h od zalogowania) -> wymagamy ponownego logowania
            await regenerateSession(req);
            req.session.flash = 'Sesja wygasła. Zaloguj się ponownie.';
        } else {
            const { rows } = await pool.query(
                'SELECT id, username, role, is_active FROM users WHERE id = $1',
                [s.userId]
            );
            const user = rows[0];
            if (user && user.is_active) {
                req.user = user;
                // ostatnia aktywność (do podglądu sesji w panelu admina), zapis max raz na minutę
                if (!s.lastSeen || Date.now() - s.lastSeen > 60 * 1000) s.lastSeen = Date.now();
            } else {
                // konto usunięte/zablokowane -> unieważniamy sesję
                // (regenerate usuwa starą sesję z bazy i daje nową, pustą)
                await regenerateSession(req);
            }
        }
    }
    res.locals.user = req.user; // dostępne w widokach EJS
    next();
}

// Wymaga zalogowania
function requireLogin(req, res, next) {
    if (!req.user) return res.redirect('/login');
    next();
}

// Wymaga jednej z podanych ról, np. requireRole('support', 'admin')
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');
        if (!roles.includes(req.user.role)) {
            return res.status(403).render('error', { status: 403, message: 'Brak uprawnień.' });
        }
        next();
    };
}

// Zapisuje w sesji dane do monitoringu (kto, skąd, od kiedy)
function startUserSession(req, userId) {
    req.session.userId = userId;
    req.session.loginAt = Date.now();
    req.session.lastSeen = Date.now();
    req.session.ip = req.ip;
    req.session.ua = String(req.get('user-agent') || '').slice(0, 200);
}

module.exports = { loadUser, requireLogin, requireRole, regenerateSession, startUserSession };
