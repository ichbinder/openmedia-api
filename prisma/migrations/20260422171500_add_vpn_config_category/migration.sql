-- Seed: Add missing 'vpn' config category
INSERT INTO "config_categories" ("id", "name", "display_name", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'vpn', 'VPN', 'VPN-Provider-Zuweisung für Download/Upload Jobs', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
