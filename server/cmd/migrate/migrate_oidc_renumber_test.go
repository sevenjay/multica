package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestOIDCRenumberedMigrationsAdoptExistingFeatureTable(t *testing.T) {
	adminPool := openTestPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), rand.Int64())
	schema := "migrate_oidc_renumber_" + suffix
	schemaIdent := pgx.Identifier{schema}.Sanitize()
	if _, err := adminPool.Exec(ctx, "CREATE SCHEMA "+schemaIdent); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := adminPool.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+schemaIdent+" CASCADE"); err != nil {
			t.Errorf("drop schema: %v", err)
		}
	})

	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `
		CREATE TABLE schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		INSERT INTO schema_migrations (version)
		VALUES ('285_user_oidc_identity');

		CREATE TABLE user_oidc_identity (
			issuer TEXT NOT NULL,
			subject TEXT NOT NULL,
			user_id UUID NOT NULL,
			email TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		INSERT INTO user_oidc_identity (issuer, subject, user_id, email)
		VALUES ('https://idp.example.com', 'subject-1', '7dfcd17a-f5d8-4c13-962f-a10293019519', 'user@example.com');
	`); err != nil {
		t.Fatalf("seed pre-renumbered OIDC table: %v", err)
	}

	versions := []string{
		"9900_user_oidc_identity",
		"9901_user_oidc_identity_subject_index",
		"9902_user_oidc_identity_user_index",
	}
	if err := runMigrations(ctx, pool, runOptions{
		Direction:             "up",
		Files:                 realMigrationFiles(t, versions, "up"),
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       rand.Int64(),
		Hooks:                 hooksForDirection("up"),
	}); err != nil {
		t.Fatalf("run renumbered OIDC migrations: %v", err)
	}

	var identityCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM user_oidc_identity").Scan(&identityCount); err != nil {
		t.Fatalf("count preserved identities: %v", err)
	}
	if identityCount != 1 {
		t.Fatalf("preserved identity count = %d, want 1", identityCount)
	}

	for _, version := range versions {
		var applied bool
		if err := pool.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM "+schemaIdent+".schema_migrations WHERE version = $1)",
			version,
		).Scan(&applied); err != nil {
			t.Fatalf("query migration %q: %v", version, err)
		}
		if !applied {
			t.Errorf("migration %q was not recorded", version)
		}
	}

	assertIndexValidity(t, pool, schema, "idx_user_oidc_identity_issuer_subject", true)
	assertIndexValidity(t, pool, schema, "idx_user_oidc_identity_user_id", true)
}
