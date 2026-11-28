// Punkt startowy aplikacji Helpdesk.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { loadUser } = require('./auth');
const {
    SESSION_COOKIE, COOKIE_OPTIONS, IDLE_TIMEOUT_MS,
    securityHeaders, extraHeaders, globalLimiter, healthLimiter, csrfProtection,
} = require('./security');

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
// TRUST_PROXY=1 każe ufać nagłówkom X-Forwarded-* od LB (prawdziwe IP klienta, secure cookie).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

// --- Nagłówki bezpieczeństwa (CSP, HSTS, clickjacking...) ---
app.use(securityHeaders);

// Pliki statyczne (style.css) - przed sesją, żeby nie obciążać bazy
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.use(extraHeaders);

// --- Healthcheck dla load balancera / Dockera (własny limit, bez sesji) ---
app.get('/health', healthLimiter, async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok' });
    } catch {
        res.status(503).json({ status: 'db_unavailable' });
    }
});

// --- Limit żądań dla całej aplikacji ---
app.use(globalLimiter);

// dane z formularzy HTML (z limitem rozmiaru)
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// --- Sesja ---
app.use(session({
    store: new PgSession({ pool, tableName: 'session' }), // sesje w PostgreSQL
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // nie tworzymy sesji dla niezalogowanych
    rolling: true,            // każda aktywność przedłuża sesję -> wygasa po bezczynności
    cookie: { ...COOKIE_OPTIONS, maxAge: IDLE_TIMEOUT_MS },
}));

app.use(loadUser);
app.use(csrfProtection);

// Jednorazowe komunikaty ("flash") po przekierowaniu
app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) delete req.session.flash;
    next();
});

// --- Trasy ---
app.get('/', (req, res) => res.redirect(req.user ? '/tickets' : '/login'));
app.use('/', require('./routes/auth'));
app.use('/account', require('./routes/account'));
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
