// Rejestracja, logowanie i wylogowanie.
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/tickets');
    res.render('login', { error: null, username: '' });
});

router.post('/login', async (req, res, next) => {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');

    // Zapytanie parametryzowane ($1) - ochrona przed SQL injection
    const { rows } = await pool.query(
        'SELECT id, password_hash, is_active FROM users WHERE username = $1',
        [username]
    );
    const user = rows[0];
    const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));

    if (!ok) {
        // Ten sam komunikat dla złego loginu i złego hasła - nie zdradzamy, które konta istnieją
        return res.status(401).render('login', { error: 'Nieprawidłowy login lub hasło.', username });
    }

    // Nowy identyfikator sesji po zalogowaniu - ochrona przed session fixation
    req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        res.redirect('/tickets');
    });
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('helpdesk.sid');
        res.redirect('/login');
    });
});

router.get('/register', (req, res) => {
    if (req.user) return res.redirect('/tickets');
    res.render('register', { error: null, username: '' });
});

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const password2 = String(req.body.password2 || '');

    let error = null;
    if (!USERNAME_RE.test(username)) error = 'Login: 3-30 znaków (litery, cyfry, _ . -).';
    else if (password.length < 8) error = 'Hasło musi mieć co najmniej 8 znaków.';
    else if (password !== password2) error = 'Hasła nie są takie same.';
    if (error) return res.status(400).render('register', { error, username });

    const hash = await bcrypt.hash(password, 12);
    try {
        // Rejestracja zawsze tworzy zwykłego użytkownika - roli nie da się wybrać z formularza
        await pool.query(
            "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'user')",
            [username, hash]
        );
    } catch (err) {
        if (err.code === '23505') { // naruszenie UNIQUE
            return res.status(400).render('register', { error: 'Taki login już istnieje.', username });
        }
        throw err;
    }
    req.session.flash = 'Konto utworzone. Możesz się zalogować.';
    res.redirect('/login');
});

module.exports = router;
