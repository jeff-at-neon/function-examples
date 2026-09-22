-- Block 19: audio and video transcription.
--
-- Makes spoken content searchable, which is the point: a two-hour meeting recording is unusable until you can find the thirty seconds that matter. It writes into the same chunk table the RAG block owns, so hybrid search covers audio and documents with one query rather than two.

CREATE SCHEMA IF NOT EXISTS blocks_transcription;

CREATE TABLE IF NOT EXISTS blocks_transcription.transcripts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name   text        NOT NULL,
  object_key    text        NOT NULL,
  -- Transcription is among the most expensive calls in the catalog per invocation, so identity
  -- includes the etag: unchanged media is never re-transcribed.
  etag          text        NOT NULL,

  status        text        NOT NULL DEFAULT 'pending',
  kind          text,

  -- Full text, for display and for a quick LIKE. Segments below are the navigable form.
  full_text     text,
  language      text,
  duration_seconds real,

  model         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  transcribed_at timestamptz,

  CONSTRAINT transcripts_status_valid
    CHECK (status IN ('pending', 'transcribing', 'ready', 'failed', 'skipped', 'too_long')),
  CONSTRAINT transcripts_identity UNIQUE (bucket_name, object_key, etag)
);

CREATE INDEX IF NOT EXISTS transcripts_status_idx
  ON blocks_transcription.transcripts (status, created_at);

-- Timestamped segments. A transcript without timestamps can be searched but not navigated, and
-- "somewhere in this two-hour recording" is barely better than nothing.
CREATE TABLE IF NOT EXISTS blocks_transcription.segments (
  id            bigserial   PRIMARY KEY,
  transcript_id uuid        NOT NULL REFERENCES blocks_transcription.transcripts(id) ON DELETE CASCADE,
  segment_index integer     NOT NULL,
  start_seconds real        NOT NULL,
  end_seconds   real        NOT NULL,
  text          text        NOT NULL,

  CONSTRAINT segments_order_uniq UNIQUE (transcript_id, segment_index),
  CONSTRAINT segments_times_sane CHECK (end_seconds >= start_seconds)
);

CREATE INDEX IF NOT EXISTS segments_transcript_idx
  ON blocks_transcription.segments (transcript_id, segment_index);

-- Full-text over segments, so a search result can jump to a timestamp rather than a document.
ALTER TABLE blocks_transcription.segments
  ADD COLUMN IF NOT EXISTS text_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS segments_tsv_idx ON blocks_transcription.segments USING gin (text_tsv);

-- ---------------------------------------------------------------------------
-- Observability (§10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW blocks_transcription.v_status AS
SELECT
  count(*)                                              AS transcripts_total,
  count(*) FILTER (WHERE status = 'ready')               AS transcripts_ready,
  count(*) FILTER (WHERE status = 'failed')              AS transcripts_failed,
  count(*) FILTER (WHERE status = 'skipped')             AS transcripts_skipped,
  -- A routine outcome with a specific remedy (split the file), not a generic failure.
  count(*) FILTER (WHERE status = 'too_long')            AS transcripts_too_long,
  count(*) FILTER (WHERE status IN ('pending', 'transcribing')
                     AND updated_at < now() - interval '2 hours') AS transcripts_stuck,
  COALESCE(round(sum(duration_seconds)::numeric / 3600, 1), 0) AS hours_transcribed,
  (SELECT count(*) FROM blocks_transcription.segments)   AS segments_total,
  -- Ready transcripts with no segments have text but cannot be navigated, which defeats the point.
  count(*) FILTER (WHERE status = 'ready'
    AND NOT EXISTS (SELECT 1 FROM blocks_transcription.segments s
                    WHERE s.transcript_id = blocks_transcription.transcripts.id)) AS ready_without_segments
FROM blocks_transcription.transcripts
;
