-- Masked full traces, gzipped, for deployments without R2 (src/lib/rawstore.ts picks R2 when bound).
CREATE TABLE trace_raw (
  key        TEXT PRIMARY KEY,            -- same key as the R2 layout: traces/<agent_id>/<trace_id>.json
  body       BLOB NOT NULL,               -- gzip of the MASKED trace JSON
  bytes      INTEGER NOT NULL,            -- uncompressed size
  created_at INTEGER NOT NULL
);
