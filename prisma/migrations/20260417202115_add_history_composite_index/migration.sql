-- CreateIndex: composite index for history queries by categoryName + entryKey
CREATE INDEX "config_history_category_name_entry_key_created_at_idx" ON "config_history"("category_name", "entry_key", "created_at");
