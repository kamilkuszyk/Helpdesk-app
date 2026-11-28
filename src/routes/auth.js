// Rejestracja, logowanie i wylogowanie.
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { logEvent } = require('../audit');
const { validatePassword, MIN_LENGTH } = require('../passwords');
const { regenerateSession, startUserSession } = require('../auth');
const { loginLimiter, registerLimiter, SESSION_COOKIE, COOKIE_OPTIONS } = require('../security');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

// Blokada konta: po 5 nieudanych próbach konto jest blokowane na 15 minut
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
// Jeden komunikat dla każdego błędu - nie zdradzamy, czy konto istnieje lub jest zablokowane
const LOGIN_ERROR = 'Nieprawidłowy login lub hasło. Po 5 nieudanych próbach konto jest blokowane na 15 minut.';
// Hash "na niby" - sprawdzamy go, gdy konto nie istnieje, żeby czas odpowiedzi był taki sam
const DUMMY_HASH = bcrypt.hashSync('brak-takiego-konta', 12);

router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/tickets');
    res.render('login', { error: null, username: '' });
});

router.post('/login', loginLimiter, async (req, res) => {
    const username = String(req.body.username || '').slice(0, 50);
    const password = String(req.body.password || '');

    // Zapytanie parametryzowane ($1) - ochrona przed SQL injection
    const { rows } = await pool.query(
        `SELECT id, username, password_hash, is_active, locked_until
           FROM users WHERE username = $1`,
        [username]
    );
    const user = rows[0];
    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    const locked = Boolean(user && user.locked_until && user.locked_until > new Date());

    if (!user || !user.is_active || !passwordOk || locked) {
        if (locked) {
            await logEvent(req, 'login_blocked', { userId: user.id, username });
        } else if (user) {
            // liczymy nieudane próby; po przekroczeniu limitu blokujemy konto
            const r = await pool.query(
                `UPDATE users
                    SET failed_logins = failed_logins + 1,
                        locked_until = CASE WHEN failed_logins + 1 >= $2
                                            THEN now() + make_interval(mins => $3)
                                            ELSE locked_until END
                  WHERE id = $1
              RETURNING locked_until`,
                [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES]
            );
            const nowLocked = r.rows[0].locked_until && r.rows[0].locked_until > new Date();
            await logEvent(req, nowLocked ? 'account_locked' : 'login_failed', { userId: user.id, username });
        } else {
            await logEvent(req, 'login_failed', { username, detail: 'unknown_user' });
        }
        return res.status(401).render('login', { error: LOGIN_ERROR, username });
    }

    await pool.query(
        'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
        [user.id]
    );
    // Nowy identyfikator sesji po zalogowaniu - ochrona przed session fixation
    await regenerateSession(req);
    startUserSession(req, user.id);
    await logEvent(req, 'login_success', { userId: user.id, username: user.username });
    res.redirect('/tickets');
});

router.post('/logout', async (req, res) => {
    if (req.user) await logEvent(req, 'logout', { userId: req.user.id, username: req.user.username });
    req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
        res.redirect('/login');
    });
});

router.get('/register', (req, res) => {
    if (req.user) return res.redirect('/tickets');
    res.render('register', { error: null, username: '', MIN_LENGTH });
});

router.post('/register', registerLimiter, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const password2 = String(req.body.password2 || '');

    let error = null;
    if (!USERNAME_RE.test(username)) error = 'Login: 3-30 znaków (litery, cyfry, _ . -).';
    else error = validatePassword(password, username);
    if (!error && password !== password2) error = 'Hasła nie są takie same.';
    if (error) return res.status(400).render('register', { error, username, MIN_LENGTH });

    const hash = await bcrypt.hash(password, 12);
    try {
        // Rejestracja zawsze tworzy zwykłego użytkownika - roli nie da się wybrać z formularza
        await pool.query(
            "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'user')",
            [username, hash]
        );
    } catch (err) {
        if (err.code === '23505') { // naruszenie UNIQUE
            return res.status(400).render('register', { error: 'Taki login już istnieje.', username, MIN_LENGTH });
        }
        throw err;
    }
    await logEvent(req, 'register', { username });
    req.session.flash = 'Konto utworzone. Możesz się zalogować.';
    res.redirect('/login');
});

module.exports = router;
