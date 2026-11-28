// Konto zalogowanego użytkownika: zmiana hasła.
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireLogin, regenerateSession, startUserSession } = require('../auth');
const { validatePassword, MIN_LENGTH } = require('../passwords');
const { logEvent } = require('../audit');

const router = express.Router();
router.use(requireLogin);

router.get('/password', (req, res) => {
    res.render('account/password', { error: null, MIN_LENGTH });
});

router.post('/password', async (req, res) => {
    const current = String(req.body.current || '');
    const password = String(req.body.password || '');
    const password2 = String(req.body.password2 || '');
    const fail = (error) => res.status(400).render('account/password', { error, MIN_LENGTH });

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(current, rows[0].password_hash))) {
        await logEvent(req, 'password_change_failed', { userId: req.user.id, username: req.user.username });
        return fail('Obecne hasło jest nieprawidłowe.');
    }
    const error = validatePassword(password, req.user.username)
        || (password !== password2 ? 'Nowe hasła nie są takie same.' : null)
        || (password === current ? 'Nowe hasło musi się różnić od obecnego.' : null);
    if (error) return fail(error);

    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    // Po zmianie hasła wylogowujemy WSZYSTKIE inne sesje tego użytkownika
    // (np. gdy ktoś poznał stare hasło i jest zalogowany na innym urządzeniu)
    const removed = await pool.query(
        "DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2",
        [String(req.user.id), req.sessionID]
    );
    // a bieżącej sesji nadajemy nowy identyfikator
    await regenerateSession(req);
    startUserSession(req, req.user.id);
    await logEvent(req, 'password_changed', {
        userId: req.user.id, username: req.user.username, detail: `other_sessions_removed=${removed.rowCount}`,
    });
    req.session.flash = 'Hasło zmienione. Inne sesje na Twoim koncie zostały wylogowane.';
    res.redirect('/tickets');
});

module.exports = router;
