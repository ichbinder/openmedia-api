# OpenMedia API

Express.js Backend für die OpenMedia Film-Plattform.

> 📚 **Gesamtdokumentation:** [openmedia-docs](https://github.com/ichbinder/openmedia-docs)

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **ORM:** Prisma v7 + PostgreSQL 16 (Docker)
- **Auth:** JWT + bcrypt
- **Tests:** Vitest + Supertest (58 Tests)

## Architektur

```
openmedia-web ──Proxy──▶ openmedia-api ──JWT──▶ openmedia-nzb
                              │
                         PostgreSQL
                         (users, watchlist,
                          nzb_movies, nzb_files)
```

## Setup

```bash
# PostgreSQL starten
docker compose up -d

# Dependencies installieren
npm install

# Prisma Client generieren + Schema deployen
npx prisma generate
npx prisma db push

# Dev-Server starten
npm run dev   # → http://localhost:4000
```

## API Endpoints

### Auth
| Methode | Endpoint | Beschreibung |
|---|---|---|
| POST | `/auth/register` | Registrierung |
| POST | `/auth/login` | Login → JWT |
| POST | `/auth/logout` | Logout |
| GET | `/auth/me` | Aktueller User (JWT) |

### Watchlist
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/watchlist` | Watchlist auflisten (JWT) |
| POST | `/watchlist` | Film hinzufügen (JWT) |
| DELETE | `/watchlist/:movieId` | Film entfernen (JWT) |
| GET | `/watchlist/check/:movieId` | In Watchlist? (JWT) |

### NZB Filme
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/nzb/movies` | Alle Filme mit NZB-Übersicht |
| GET | `/nzb/movies/:id` | Film mit allen NZB-Dateien |
| GET | `/nzb/movies/by-tmdb/:tmdbId` | Film nach TMDB-ID |
| POST | `/nzb/movies` | Film erstellen |
| PUT | `/nzb/movies/:id` | Film aktualisieren |
| DELETE | `/nzb/movies/:id` | Film + NZBs löschen (cascade) |

### NZB Dateien
| Methode | Endpoint | Beschreibung |
|---|---|---|
| POST | `/nzb/files` | NZB-Datei zu Film hinzufügen |
| PUT | `/nzb/files/:id` | Metadaten aktualisieren |
| DELETE | `/nzb/files/:id` | NZB-Datei entfernen |
| GET | `/nzb/files/by-hash/:hash` | NZB nach Hash finden |
| PATCH | `/nzb/files/:id/status` | Status setzen (ok/broken/untested) |

### NZB Import
| Methode | Endpoint | Beschreibung |
|---|---|---|
| POST | `/nzb/import` | NZB-Upload → Hash → Parse → TMDB → DB |

### System
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check mit DB-Status |

## Tests

```bash
npm test          # 58 Integration Tests
npm run test:watch  # Watch-Modus
```

## Umgebungsvariablen

| Variable | Beschreibung | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection String | (Prisma Config) |
| `JWT_SECRET` | JWT Signing Secret | `dev-secret-change-in-production` |
| `TMDB_API_KEY` | TMDB API Key für Film-Lookup | (optional) |
| `PORT` | Server Port | `4000` |
