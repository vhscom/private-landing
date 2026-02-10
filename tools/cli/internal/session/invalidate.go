package session

import (
	"context"
	"database/sql"
	"fmt"
)

// Scope describes what to invalidate.
type Scope int

const (
	ScopeAll     Scope = iota // All sessions for all users
	ScopeUser                 // All sessions for a single user
	ScopeSession              // A single session by ID
)

// InvalidateResult holds the outcome of an invalidation operation.
type InvalidateResult struct {
	RowsAffected int64
	Err          error
}

// Invalidate expires sessions by setting expires_at to now.
// This mirrors the endSession pattern from session-service.ts.
func Invalidate(ctx context.Context, db *sql.DB, scope Scope, id string) InvalidateResult {
	var (
		res sql.Result
		err error
	)

	switch scope {
	case ScopeAll:
		res, err = db.ExecContext(ctx,
			`UPDATE session SET expires_at = datetime('now') WHERE expires_at > datetime('now')`)
	case ScopeUser:
		res, err = db.ExecContext(ctx,
			`UPDATE session SET expires_at = datetime('now') WHERE user_id = ? AND expires_at > datetime('now')`,
			id)
	case ScopeSession:
		res, err = db.ExecContext(ctx,
			`UPDATE session SET expires_at = datetime('now') WHERE id = ? AND expires_at > datetime('now')`,
			id)
	default:
		return InvalidateResult{Err: fmt.Errorf("unknown scope: %d", scope)}
	}

	if err != nil {
		return InvalidateResult{Err: err}
	}

	n, _ := res.RowsAffected()
	return InvalidateResult{RowsAffected: n}
}
