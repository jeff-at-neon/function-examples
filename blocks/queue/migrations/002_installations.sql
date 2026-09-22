-- Installation tracking, for the console-managed catalog.
--
-- blocks_core.migrations records which migrations ran. That is not the same as which VERSION of a
-- block is installed: it answers "has 002 been applied" but not "is this queue 1.2 or 1.3, and what
-- changed between them". A hosted catalog needs the second question answered, because the user
-- cannot inspect a checkout to find out.
--
-- Lives in blocks_core rather than blocks_queue because it describes every block, not just this one.
-- It ships with the queue block since that is rank 1 and always installed first.

CREATE TABLE IF NOT EXISTS blocks_core.installations (
  block           text        PRIMARY KEY,

  -- Semver of the release currently installed. The console compares this against the catalog to
  -- decide whether to offer an upgrade.
  version         text        NOT NULL,

  -- sha256 of the artifact that was installed. Lets the console detect a tampered or mismatched
  -- deploy, and distinguishes "same version, rebuilt" from "same version, same bytes".
  artifact_sha256 text,

  -- Which function slug this block was deployed as. The console needs it to update or remove the
  -- deployment, and users may deploy the same block under a custom name.
  function_slug   text,

  -- Config the user supplied at install, with secret values EXCLUDED. Stored so an upgrade can
  -- re-apply the same settings without re-prompting, and so support can see how a block is
  -- configured without being able to read credentials.
  config          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  installed_at    timestamptz NOT NULL DEFAULT now(),
  upgraded_at     timestamptz,

  -- Set when an upgrade began but did not finish. A block in this state has had some migrations
  -- applied and not others, which is the state most likely to confuse a user -- so it is recorded
  -- explicitly rather than inferred from a version mismatch.
  upgrade_from    text,

  CONSTRAINT installations_version_semver CHECK (version ~ '^\d+\.\d+\.\d+(-[\w.]+)?$')
);

COMMENT ON TABLE blocks_core.installations IS
  'Which version of each block is installed, for the console catalog. Distinct from '
  'blocks_core.migrations, which records applied migrations rather than installed versions.';

COMMENT ON COLUMN blocks_core.installations.config IS
  'User-supplied configuration with secrets excluded. Never store a credential here: the console '
  'passes secrets to the function environment directly.';

-- Upgrade history. Kept because "what changed and when" is the first question when a block starts
-- misbehaving after an upgrade, and a single mutable version column cannot answer it.
CREATE TABLE IF NOT EXISTS blocks_core.installation_history (
  id            bigserial   PRIMARY KEY,
  block         text        NOT NULL,
  from_version  text,
  to_version    text        NOT NULL,
  -- 'install', 'upgrade', 'rollback', or 'uninstall'.
  action        text        NOT NULL,
  -- Migration versions applied or reversed by this action.
  migrations    text[]      NOT NULL DEFAULT '{}',
  succeeded     boolean     NOT NULL DEFAULT true,
  error         text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT installation_history_action_valid
    CHECK (action IN ('install', 'upgrade', 'rollback', 'uninstall'))
);

CREATE INDEX IF NOT EXISTS installation_history_block_idx
  ON blocks_core.installation_history (block, occurred_at DESC);

-- What the console reads to render "installed / upgrade available". Exposed as a view so the shape
-- is stable even if the underlying columns change.
CREATE OR REPLACE VIEW blocks_core.v_installed_blocks AS
SELECT i.block,
       i.version,
       i.function_slug,
       i.installed_at,
       i.upgraded_at,
       -- Non-null means an upgrade was interrupted partway. The console should surface this
       -- prominently: the schema is in an intermediate state that neither version describes.
       i.upgrade_from                                       AS interrupted_upgrade_from,
       (SELECT count(*) FROM blocks_core.migrations m WHERE m.block = i.block) AS migrations_applied,
       (SELECT count(*) FROM blocks_core.installation_history h
          WHERE h.block = i.block AND h.action = 'upgrade' AND h.succeeded) AS upgrade_count,
       (SELECT max(h.occurred_at) FROM blocks_core.installation_history h
          WHERE h.block = i.block AND NOT h.succeeded)      AS last_failure_at
FROM blocks_core.installations i;
