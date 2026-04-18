-- Link runtime category to both VPS profiles
-- Fixes: runtime config (api_base_url, service_api_token) was not included in profile queries

INSERT INTO "config_profile_categories" ("id", "profile_id", "category_id")
SELECT gen_random_uuid(), p.id, c.id
FROM "config_profiles" p, "config_categories" c
WHERE p.name = 'download_vps' AND c.name = 'runtime'
AND NOT EXISTS (
  SELECT 1 FROM "config_profile_categories" pc
  WHERE pc.profile_id = p.id AND pc.category_id = c.id
);

INSERT INTO "config_profile_categories" ("id", "profile_id", "category_id")
SELECT gen_random_uuid(), p.id, c.id
FROM "config_profiles" p, "config_categories" c
WHERE p.name = 'upload_vps' AND c.name = 'runtime'
AND NOT EXISTS (
  SELECT 1 FROM "config_profile_categories" pc
  WHERE pc.profile_id = p.id AND pc.category_id = c.id
);
