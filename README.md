# OpenMedia API

Express.js Backend für die OpenMedia Film-Plattform.

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **ORM:** Prisma v7
- **Datenbank:** PostgreSQL 16 (Docker)
- **Auth:** JWT + bcrypt
- **Tests:** Vitest + Supertest

## Setup

```bash
# PostgreSQL starten
docker compose up -d

# Dependencies installieren
npm install

# Prisma Schema deployen
npx prisma db push

# Dev-Server starten
npm run dev
```

## API Endpoints

### Auth
- `POST /auth/register` — Registrierung
- `POST /auth/login` — Login
- `POST /auth/logout` — Logout
- `GET /auth/me` — Aktueller User (JWT erforderlich)

### Watchlist
- `GET /watchlist` — Watchlist auflisten (JWT)
- `POST /watchlist` — Film hinzufügen (JWT)
- `DELETE /watchlist/:movieId` — Film entfernen (JWT)
- `GET /watchlist/check/:movieId` — Prüfen ob Film in Watchlist (JWT)

### System
- `GET /health` — Health-Check mit DB-Status

## Tests

```bash
# Unit & Integration Tests
npm test

# Watch-Modus
npm run test:watch
```

Erfordert laufende Test-Datenbank auf Port 5433:
```bash
docker compose up -d db-test
```

## Umgebungsvariablen

Siehe `.env.example` für alle benötigten Variablen.
