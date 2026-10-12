// Punkt startowy aplikacji Helpdesk.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { loadUser } = require('./auth');

if (!process.env.SESSION_SECRET) {
    console.error('Brak SESSION_SECRET w zmiennych środowiskowych.');
    process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by'); // nie zdradzamy, że to Express

// Polskie etykiety używane w widokach
app.locals.LABELS = {
    open: 'Otwarte', in_progress: 'W realizacji', closed: 'Zamknięte',
    low: 'Niski', medium: 'Średni', high: 'Wysoki',
    user: 'Użytkownik', support: 'Support', admin: 'Administrator',
};

// Za load balancerem (L3/L4) HTTPS kończy się na LB, a do aplikacji idzie HTTP.
// TRUST_PROXY=1 każe ufać nagłówkom X-Forwarded-* od LB (np. dla secure cookie).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

app.use(express.urlencoded({ extended: false })); // dane z formularzy HTML

// --- Sesja ---
app.use(session({
    store: new PgSession({ pool, tableName: 'session' }), // sesje w PostgreSQL
    name: 'helpdesk.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,        // nie tworzymy sesji dla niezalogowanych
    cookie: {
        httpOnly: true,               // JavaScript w przeglądarce nie odczyta ciasteczka
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true', // true gdy działa HTTPS
        maxAge: 2 * 60 * 60 * 1000,   // 2 godziny
    },
}));

app.use(loadUser);

// Jednorazowe komunikaty ("flash") po przekierowaniu
app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) delete req.session.flash;
    next();
});

// --- Healthcheck dla load balancera / Dockera ---
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok' });
    } catch {
        res.status(503).json({ status: 'db_unavailable' });
    }
});

// --- Trasy ---
app.get('/', (req, res) => res.redirect(req.user ? '/tickets' : '/login'));
app.use('/', require('./routes/auth'));
app.use('/tickets', require('./routes/tickets'));
app.use('/admin', require('./routes/admin'));

// 404
app.use((req, res) => {
    res.status(404).render('error', { status: 404, message: 'Nie ma takiej strony.' });
});

// Obsługa błędów - szczegóły tylko w logach serwera, użytkownik widzi ogólny komunikat
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { status: 500, message: 'Wewnętrzny błąd serwera.' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Helpdesk działa na http://localhost:${port}`));
