package session

import (
	"context"
	"database/sql"
)

// ActiveSession represents a single active session row.
type ActiveSession struct {
	ID        string
	UserID    string
	UserAgent string
	IPAddress string
	ExpiresAt string
	CreatedAt string
}

// ListActive returns all sessions where expires_at is in the future.
func ListActive(ctx context.Context, db *sql.DB) ([]ActiveSession, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, user_id, user_agent, ip_address, expires_at, created_at
		 FROM session
		 WHERE expires_at > datetime('now')
		 ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []ActiveSession
	for rows.Next() {
		var s ActiveSession
		if err := rows.Scan(&s.ID, &s.UserID, &s.UserAgent, &s.IPAddress, &s.ExpiresAt, &s.CreatedAt); err != nil {
			return nil, err
		}
		sessions = append(sessions, s)
	}
	return sessions, rows.Err()
}
