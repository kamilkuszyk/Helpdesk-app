// Panel administratora: konta użytkowników oraz monitoring bezpieczeństwa
// (aktywne sesje, dziennik zdarzeń, zablokowane konta).
const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../auth');
const { logEvent } = require('../audit');

const router = express.Router();
router.use(requireRole('admin')); // cały panel tylko dla admina

const ROLES = ['user', 'support', 'admin'];

// W panelu NIE pokazujemy identyfikatorów sesji (to "klucze" do kont).
// Pokazujemy tylko ich skrót SHA-256 i po nim wylogowujemy sesję.
const SID_HASH_SQL = "encode(sha256(convert_to(s.sid, 'UTF8')), 'hex')";
const hashSid = (sid) => crypto.createHash('sha256').update(sid, 'utf8').digest('hex');

router.get('/users', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.last_login_at,
                (u.locked_until > now()) AS is_locked, u.locked_until,
                COUNT(t.id)::int AS ticket_count
           FROM users u LEFT JOIN tickets t ON t.author_id = u.id
       GROUP BY u.id ORDER BY u.id`
    );
    res.render('admin/users', { users: rows, ROLES });
});

router.post('/users/:id', async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
    const role = ROLES.includes(req.body.role) ? req.body.role : null;
    const isActive = req.body.is_active === 'on'; // checkbox

    if (id === null || role === null) {
        req.session.flash = 'Nieprawidłowe dane.';
    } else if (id === req.user.id) {
        // admin nie może odebrać sobie uprawnień ani zablokować sam siebie
        req.session.flash = 'Nie możesz zmienić własnego konta w tym panelu.';
    } else {
        // zapis przez admina zdejmuje też czasową blokadę po nieudanych logowaniach
        const r = await pool.query(
            `UPDATE users SET role = $1, is_active = $2, failed_logins = 0, locked_until = NULL
              WHERE id = $3 RETURNING username`,
            [role, isActive, id]
        );
        if (r.rowCount) {
            await logEvent(req, 'user_updated', {
                userId: req.user.id, username: req.user.username,
                detail: `${r.rows[0].username}: role=${role}, active=${isActive}`,
            });
        }
        req.session.flash = r.rowCount ? 'Zapisano zmiany.' : 'Nie znaleziono użytkownika.';
    }
    res.redirect('/admin/users');
});

// --- Monitoring bezpieczeństwa ---
router.get('/security', async (req, res) => {
    const sessions = await pool.query(
        `SELECT ${SID_HASH_SQL} AS id, u.username, u.role,
                s.sess->>'ip' AS ip, s.sess->>'ua' AS ua,
                to_timestamp((s.sess->>'loginAt')::bigint / 1000.0) AS login_at,
                to_timestamp((s.sess->>'lastSeen')::bigint / 1000.0) AS last_seen,
                s.expire
           FROM session s
           JOIN users u ON u.id = (s.sess->>'userId')::int
          WHERE s.expire > now()
       ORDER BY last_seen DESC NULLS LAST`
    );
    const events = await pool.query(
        `SELECT created_at, event, username, ip, detail
           FROM auth_events ORDER BY id DESC LIMIT 50`
    );
    const stats = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE event IN ('login_failed','login_blocked')) AS failed,
                COUNT(*) FILTER (WHERE event = 'account_locked') AS locked,
                COUNT(*) FILTER (WHERE event = 'rate_limited') AS rate_limited,
                COUNT(*) FILTER (WHERE event = 'csrf_rejected') AS csrf
           FROM auth_events WHERE created_at > now() - interval '24 hours'`
    );
    const lockedUsers = await pool.query(
        'SELECT username, locked_until FROM users WHERE locked_until > now() ORDER BY username'
    );
    res.render('admin/security', {
        sessions: sessions.rows,
        events: events.rows,
        stats: stats.rows[0],
        lockedUsers: lockedUsers.rows,
        currentSessionId: hashSid(req.sessionID),
    });
});

// Wylogowanie wybranej sesji (np. podejrzane logowanie z nieznanego IP)
router.post('/sessions/:id/revoke', async (req, res) => {
    const id = /^[0-9a-f]{64}$/.test(req.params.id) ? req.params.id : null;
    if (id === null) {
        req.session.flash = 'Nieprawidłowy identyfikator sesji.';
        return res.redirect('/admin/security');
    }
    if (id === hashSid(req.sessionID)) {
        req.session.flash = 'To Twoja bieżąca sesja - użyj przycisku "Wyloguj".';
        return res.redirect('/admin/security');
    }
    const r = await pool.query(
        `DELETE FROM session s WHERE ${SID_HASH_SQL} = $1 RETURNING s.sess->>'userId' AS user_id`,
        [id]
    );
    if (r.rowCount) {
        await logEvent(req, 'session_revoked', {
            userId: req.user.id, username: req.user.username, detail: `target_user_id=${r.rows[0].user_id}`,
        });
    }
    req.session.flash = r.rowCount ? 'Sesja została zakończona.' : 'Sesja już nie istnieje.';
    res.redirect('/admin/security');
});

module.exports = router;
