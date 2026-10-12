-- =====================================================================
-- Helpdesk – schemat bazy danych (PostgreSQL 16)
-- Plik jest idempotentny: można go uruchamiać wielokrotnie
-- (IF NOT EXISTS), dlatego aplikacja odpala go przy każdym starcie.
-- =====================================================================

-- Użytkownicy systemu i ich role
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(30)  NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,              -- hash bcrypt, nigdy jawne hasło
    role          VARCHAR(10)  NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'support', 'admin')),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,  -- admin może zablokować konto
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Zgłoszenia (tickety)
CREATE TABLE IF NOT EXISTS tickets (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    description TEXT         NOT NULL,
    status      VARCHAR(15)  NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'in_progress', 'closed')),
    priority    VARCHAR(10)  NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high')),
    author_id   INTEGER      NOT NULL REFERENCES users(id),
    assignee_id INTEGER      REFERENCES users(id),     -- pracownik supportu (może być NULL)
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

-- Komentarze w zgłoszeniu (rozmowa użytkownik <-> support)
CREATE TABLE IF NOT EXISTS comments (
    id         SERIAL PRIMARY KEY,
    ticket_id  INTEGER     NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id  INTEGER     NOT NULL REFERENCES users(id),
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);

-- Sesje HTTP (format wymagany przez bibliotekę connect-pg-simple).
-- Sesje są w bazie, a nie w pamięci serwera, więc kilka instancji
-- aplikacji za load balancerem widzi te same sesje (ważne na L3/L4).
CREATE TABLE IF NOT EXISTS session (
    sid    VARCHAR      NOT NULL PRIMARY KEY,
    sess   JSON         NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
