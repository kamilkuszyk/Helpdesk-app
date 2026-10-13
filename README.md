# Helpdesk – system zgłoszeń

Projekt na laboratorium **Bezpieczeństwo serwerów i aplikacji web**.
Prosta aplikacja web: użytkownicy zakładają zgłoszenia (tickety), support je obsługuje,
a obie strony rozmawiają w komentarzach. GUI jest celowo minimalne.

**Technologie:** Node.js 22 + Express 5, szablony EJS (HTML renderowany na serwerze),
PostgreSQL 16, sesje `express-session` przechowywane w PostgreSQL, hasła bcrypt, Docker.

---

## 1. Szybki start (macOS i Windows – zalecane)

Wymagania: **Docker Desktop** (na Windowsie z włączonym WSL 2) oraz **Git**.

```bash
git clone <adres-repo>
cd helpdesk
docker compose up --build
```

Otwórz http://localhost:3000. Komendy są takie same w Terminalu (macOS) i PowerShellu (Windows).

| Komenda | Co robi |
|---|---|
| `docker compose up --build` | buduje i uruchamia bazę + aplikację |
| `docker compose down` | zatrzymuje (dane w bazie zostają) |
| `docker compose down -v` | zatrzymuje i **kasuje bazę** – przy kolejnym starcie wgrają się dane testowe |
| `docker compose logs -f app` | logi aplikacji na żywo |

### Konta testowe (tylko DEV)

| Login | Hasło | Rola |
|---|---|---|
| `admin` | `Admin123!` | administrator |
| `support` | `Support123!` | support |
| `jan` | `User123!` | użytkownik |
| `anna` | `User123!` | użytkownik |

## 2. Praca nad kodem bez przebudowywania obrazu

Baza w Dockerze, aplikacja uruchomiona lokalnie (wymaga **Node.js 22 LTS**):

```bash
docker compose up -d db      # tylko baza
npm install
cp .env.example .env         # Windows PowerShell: copy .env.example .env
npm run dev                  # restartuje się sam po zapisaniu pliku
```

## 3. Funkcje i uprawnienia

| Akcja | user | support | admin |
|---|:-:|:-:|:-:|
| Rejestracja / logowanie / wylogowanie | ✔ | ✔ | ✔ |
| Zakładanie zgłoszeń | ✔ | ✔ | ✔ |
| Podgląd zgłoszeń | tylko swoje | wszystkie | wszystkie |
| Komentowanie (gdy zgłoszenie nie jest zamknięte) | tylko swoje | wszystkie | wszystkie |
| Zmiana statusu, priorytetu, przypisania | – | ✔ | ✔ |
| Wyszukiwarka i filtr statusu | ✔ (w swoich) | ✔ | ✔ |
| Panel użytkowników (rola, blokada konta) | – | – | ✔ |

## 4. Struktura projektu

```
db/schema.sql          tabele: users, tickets, comments, session
scripts/init-db.js     tworzy tabele i wgrywa dane testowe (przy każdym starcie, bezpiecznie)
src/server.js          konfiguracja Express, sesja, healthcheck, obsługa błędów
src/db.js              pula połączeń do PostgreSQL
src/auth.js            middleware: loadUser, requireLogin, requireRole
src/routes/auth.js     /login, /logout, /register
src/routes/tickets.js  /tickets... (lista, nowe, szczegóły, komentarze, obsługa)
src/routes/admin.js    /admin/users
src/views/             szablony EJS
Dockerfile, docker-compose.yml
```

## 5. Endpointy

| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/health` | healthcheck dla load balancera (sprawdza też bazę) |
| GET/POST | `/login`, `/register` | logowanie, rejestracja |
| POST | `/logout` | wylogowanie (niszczy sesję) |
| GET | `/tickets?q=&status=` | lista + wyszukiwarka |
| GET/POST | `/tickets/new`, `/tickets` | nowe zgłoszenie |
| GET | `/tickets/:id` | szczegóły + komentarze |
| POST | `/tickets/:id/comments` | dodanie komentarza |
| POST | `/tickets/:id/update` | status/priorytet/przypisanie (support, admin) |
| GET/POST | `/admin/users`, `/admin/users/:id` | panel admina |

## 6. Co już jest zabezpieczone (bazowo)

- Hasła: bcrypt (koszt 12), minimum 8 znaków; ten sam komunikat dla złego loginu i hasła.
- Zapytania SQL wyłącznie parametryzowane (`$1, $2…`) – brak SQL injection.
- Szablony EJS `<%= %>` escapują HTML – brak stored XSS w tytułach i komentarzach.
- Kontrola dostępu po stronie serwera dla każdego zgłoszenia (ochrona przed IDOR – `403`).
- `author_id` i rola biorą się z sesji, nie z formularza (rejestracja zawsze tworzy `user`).
- Sesja: ciasteczko `HttpOnly`, `SameSite=Lax`, ważność 2 h, nowe ID po zalogowaniu (session fixation),
  sesje w bazie (działają przy wielu instancjach), blokada konta przez admina działa natychmiast.
- Brak nagłówka `X-Powered-By`, ogólne komunikaty błędów (szczegóły tylko w logach).
- Kontener działa jako użytkownik `node` (nie root).
