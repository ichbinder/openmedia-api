# OpenMedia API

Express.js Backend für die OpenMedia Film-Plattform.

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **ORM:** Prisma v7 + PostgreSQL 16 (Docker)
- **Auth:** JWT + bcrypt
- **Tests:** Vitest + Supertest (183 Tests)

## Architektur

```
openmedia-web ──Proxy──▶ openmedia-api ──JWT──▶ openmedia-nzb
                              │
                         PostgreSQL
                         (users, watchlist, search_history,
                          nzb_movies, nzb_files, download_jobs,
                          user_library)
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

### Suchhistorie
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/search-history` | Letzte Suchen auflisten (JWT) |
| POST | `/search-history` | Film zur Suchhistorie hinzufügen (JWT, Upsert) |
| DELETE | `/search-history` | Gesamte Suchhistorie löschen (JWT) |
| DELETE | `/search-history/:movieId` | Einzelnen Film entfernen (JWT) |

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
| GET | `/nzb/files/:id/download-link` | Presigned S3 Download-URL |

### Downloads
| Methode | Endpoint | Beschreibung |
|---|---|---|
| POST | `/downloads/jobs` | Download-Job erstellen (Auto-Provision) |
| GET | `/downloads/jobs` | Jobs auflisten (optional: `?status=`) |
| GET | `/downloads/jobs/:id` | Einzelner Job |
| PATCH | `/downloads/jobs/:id/status` | Status-Update (VPS Callback) |
| DELETE | `/downloads/jobs/:id` | Job löschen |
| GET | `/downloads/jobs/:id/link` | Presigned Download-URL |
| POST | `/downloads/jobs/:id/provision` | Manuell VPS provisionieren |
| POST | `/downloads/jobs/:id/cleanup` | VPS löschen |
| POST | `/downloads/cleanup-zombies` | Verwaiste VPS bereinigen |
| POST | `/downloads/reconcile` | Stale Jobs bereinigen |

### Bibliothek
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/library` | User-Bibliothek auflisten |
| POST | `/library` | Film zur Bibliothek hinzufügen |
| DELETE | `/library/:nzbFileId` | Film entfernen (S3-Löschung wenn letzter User) |
| GET | `/library/retention/:nzbFileId` | Retention-Info (aktive User, S3-Status) |

### Storage
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/storage/usage` | S3-Speicherverbrauch |
| POST | `/storage/cleanup` | LRU-Cleanup (70%-Threshold, 3-Tage-Grace) |

### System
| Methode | Endpoint | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check mit DB-Status |

## Download-VPS Provisioning

Der Auto-Provisioner erstellt pro Download-Job einen Hetzner Cloud VPS:
- **Server-Typ:** cax11 (ARM)
- **Location:** Helsinki (hel1)
- **Image:** ghcr.io/ichbinder/openmedia-downloader:latest
- **Usenet:** Primary (EasyUsenet) + Backup (Eweka) — konfiguriert via ENV-Variablen
- **Self-Delete:** VPS löscht sich nach Download-Abschluss automatisch

## Tests

```bash
npm test            # 183 Integration Tests
npm run test:watch  # Watch-Modus
```

## Umgebungsvariablen

| Variable | Beschreibung | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection String | (Prisma Config) |
| `JWT_SECRET` | JWT Signing Secret | `dev-secret-change-in-production` |
| `TMDB_API_KEY` | TMDB API Key für Film-Lookup | (optional) |
| `PORT` | Server Port | `4000` |
| `USENET_HOST` | Primary Usenet Server | — |
| `USENET_PORT` | Primary Usenet Port | `563` |
| `USENET_USER` | Primary Usenet Username | — |
| `USENET_PASSWORD` | Primary Usenet Passwort | — |
| `USENET_SSL` | SSL aktivieren | `true` |
| `USENET_CONNECTIONS` | Anzahl Verbindungen | `10` |
| `USENET_BACKUP_HOST` | Backup Usenet Server | (optional) |
| `USENET_BACKUP_PORT` | Backup Usenet Port | `563` |
| `USENET_BACKUP_USER` | Backup Usenet Username | (optional) |
| `USENET_BACKUP_PASSWORD` | Backup Usenet Passwort | (optional) |
| `USENET_BACKUP_SSL` | Backup SSL | `true` |
| `USENET_BACKUP_CONNECTIONS` | Backup Verbindungen | `10` |
| `S3_ACCESS_KEY` | S3 Access Key | — |
| `S3_SECRET_KEY` | S3 Secret Key | — |
| `S3_ENDPOINT` | S3 Endpoint URL | — |
| `S3_BUCKET` | S3 Bucket Name | — |
| `S3_REGION` | S3 Region | `hel1` |
| `HETZNER_API_TOKEN` | Hetzner Cloud API Token | — |
| `NZB_SERVICE_URL` | NZB File Service URL | — |
| `API_BASE_URL` | Eigene API-URL (für VPS Callbacks) | — |
| `SERVICE_API_TOKEN` | Service-Token für VPS-Authentifizierung | — |
