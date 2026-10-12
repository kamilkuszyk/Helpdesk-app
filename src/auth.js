// Middleware związane z logowaniem i uprawnieniami.
const { pool } = require('./db');

// Przy KAŻDYM żądaniu odczytujemy użytkownika z bazy na podstawie sesji.
// Dzięki temu zablokowanie konta lub zmiana roli przez admina działa
// natychmiast, a nie dopiero po wylogowaniu.
async function loadUser(req, res, next) {
    req.user = null;
    if (req.session.userId) {
        const { rows } = await pool.query(
            'SELECT id, username, role, is_active FROM users WHERE id = $1',
            [req.session.userId]
        );
        const user = rows[0];
        if (user && user.is_active) {
            req.user = user;
        } else {
            // konto usunięte/zablokowane -> unieważniamy sesję
            // (regenerate usuwa starą sesję z bazy i daje nową, pustą)
            await new Promise((resolve, reject) =>
                req.session.regenerate((err) => (err ? reject(err) : resolve())));
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

module.exports = { loadUser, requireLogin, requireRole };
