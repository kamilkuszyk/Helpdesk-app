// Zabezpieczenia warstwy HTTP:
//  - nagłówki bezpieczeństwa (helmet): CSP, HSTS, ochrona przed clickjackingiem itd.,
//  - limity żądań (rate limiting) - ochrona przed zgadywaniem haseł i zalewaniem żądaniami,
//  - ochrona CSRF (token w każdym formularzu),
//  - ustawienia ciasteczka sesji.
const crypto = require('crypto');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { logEvent } = require('./audit');

const isHttps = process.env.COOKIE_SECURE === 'true';

// --- Ciasteczko sesji ---
// Prefiks __Host- = przeglądarka przyjmie ciasteczko tylko po HTTPS, tylko dla tej domeny
// (bez subdomen) i tylko dla ścieżki "/". Na DEV (HTTP) prefiks jest niedozwolony.
const SESSION_COOKIE = isHttps ? '__Host-helpdesk.sid' : 'helpdesk.sid';
const COOKIE_OPTIONS = {
    httpOnly: true,       // JavaScript w przeglądarce nie odczyta ciasteczka
    secure: isHttps,      // wysyłane tylko po HTTPS
    sameSite: 'strict',   // nie jest wysyłane przy żądaniach z innych stron
    path: '/',
};
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;      // wylogowanie po 30 min bezczynności
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // i najpóźniej 8 h po zalogowaniu

// --- Nagłówki bezpieczeństwa ---
const securityHeaders = helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'none'"],       // aplikacja nie używa JavaScriptu - żaden skrypt się nie wykona
            styleSrc: ["'self'"],        // style tylko z naszego pliku /style.css
            imgSrc: ["'self'"],
            fontSrc: ["'self'"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'self'"],      // formularze wysyłają dane tylko do nas
            frameAncestors: ["'none'"],  // nikt nie osadzi strony w ramce (clickjacking)
            ...(isHttps ? { upgradeInsecureRequests: [] } : {}),
        },
    },
    crossOriginEmbedderPolicy: true,
    // HSTS: przeglądarka przez rok łączy się z nami tylko po HTTPS
    strictTransportSecurity: isHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
});

function extraHeaders(req, res, next) {
    // wyłączamy funkcje przeglądarki, których aplikacja nie potrzebuje
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // strony z danymi użytkownika nie trafiają do cache przeglądarki ani serwerów pośrednich
    res.set('Cache-Control', 'no-store');
    next();
}

// --- Limity żądań ---
function tooManyRequests(scope) {
    return (req, res) => {
        // zapisujemy tylko pierwsze przekroczenie w oknie czasowym, żeby atak nie zalał dziennika
        if (req.rateLimit.used === req.rateLimit.limit + 1) {
            logEvent(req, 'rate_limited', { detail: scope });
        }
        res.status(429).render('error', {
            status: 429,
            message: 'Zbyt wiele żądań. Spróbuj ponownie za kilka minut.',
        });
    };
}

const common = { standardHeaders: 'draft-8', legacyHeaders: false };

// cała aplikacja: max 300 żądań na 15 min z jednego adresu IP
const globalLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 300,
    skip: (req) => req.path === '/health',
    handler: tooManyRequests('global'),
});

// /health: osobny, łagodny limit - sondy load balancera odpytują go regularnie,
// ale bez limitu ktoś mógłby zalewać bazę zapytaniami "SELECT 1"
const healthLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 60,
    handler: (req, res) => res.status(429).json({ status: 'too_many_requests' }),
});

// logowanie: max 10 NIEUDANYCH prób na 15 min z jednego IP
const loginLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    handler: tooManyRequests('login'),
});

// rejestracja: max 5 kont na godzinę z jednego IP (ochrona przed botami)
const registerLimiter = rateLimit({
    ...common,
    windowMs: 60 * 60 * 1000,
    limit: 5,
    handler: tooManyRequests('register'),
});

// --- Ochrona CSRF (wzorzec "synchronizer token") ---
// Każda sesja ma losowy token. Każdy formularz POST wysyła go w ukrytym polu _csrf.
// Obca strona nie zna tokenu, więc nie wyśle formularza w imieniu zalogowanego użytkownika.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getCsrfToken(req) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
    res.locals.csrfToken = () => getCsrfToken(req); // używane w widokach (partials/csrf.ejs)
    if (SAFE_METHODS.has(req.method)) return next();

    const expected = req.session.csrfToken || '';
    const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
    const valid = expected.length > 0 && sent.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!valid) {
        logEvent(req, 'csrf_rejected', { userId: req.user ? req.user.id : null, detail: req.path });
        return res.status(403).render('error', {
            status: 403,
            message: 'Formularz wygasł lub jest nieprawidłowy. Odśwież stronę i spróbuj ponownie.',
        });
    }
    next();
}

module.exports = {
    SESSION_COOKIE, COOKIE_OPTIONS, IDLE_TIMEOUT_MS, ABSOLUTE_TIMEOUT_MS,
    securityHeaders, extraHeaders,
    globalLimiter, healthLimiter, loginLimiter, registerLimiter,
    csrfProtection,
};
