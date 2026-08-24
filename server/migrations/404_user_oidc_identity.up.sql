-- Stable OIDC identities. Email is retained as the last observed claim for
-- operator diagnostics, but account lookup is always based on issuer + subject.
-- Relationship cleanup is owned by the application; this table intentionally
-- has no foreign key.
-- IF NOT EXISTS also lets databases that ran the feature branch's original
-- 285 migration adopt this renumbered migration without losing identity rows.
CREATE TABLE IF NOT EXISTS user_oidc_identity (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id UUID NOT NULL,
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
