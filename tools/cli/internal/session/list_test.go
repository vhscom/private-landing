package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

var sessionColumns = []string{"id", "user_id", "user_agent", "ip_address", "expires_at", "created_at"}

func TestListActiveReturnsSessions(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows(sessionColumns).
		AddRow("sess-1", "1", "Mozilla/5.0", "192.168.1.1", "2026-02-18T00:00:00Z", "2026-02-11T00:00:00Z").
		AddRow("sess-2", "2", "curl/8.0", "10.0.0.1", "2026-02-18T00:00:00Z", "2026-02-10T00:00:00Z")

	mock.ExpectQuery(`SELECT id, user_id, user_agent, ip_address, expires_at, created_at FROM session`).
		WillReturnRows(rows)

	sessions, err := ListActive(context.Background(), db)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(sessions))
	}
	if sessions[0].ID != "sess-1" {
		t.Fatalf("expected ID 'sess-1', got %q", sessions[0].ID)
	}
	if sessions[1].UserAgent != "curl/8.0" {
		t.Fatalf("expected user agent 'curl/8.0', got %q", sessions[1].UserAgent)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestListActiveEmpty(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows := sqlmock.NewRows(sessionColumns)
	mock.ExpectQuery(`SELECT id, user_id, user_agent, ip_address, expires_at, created_at FROM session`).
		WillReturnRows(rows)

	sessions, err := ListActive(context.Background(), db)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(sessions))
	}
}

func TestListActiveDBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT id, user_id, user_agent, ip_address, expires_at, created_at FROM session`).
		WillReturnError(fmt.Errorf("connection refused"))

	sessions, err := ListActive(context.Background(), db)

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if sessions != nil {
		t.Fatalf("expected nil sessions, got %v", sessions)
	}
}

func TestListActiveCancelledContext(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	mock.ExpectQuery(`SELECT id, user_id, user_agent, ip_address, expires_at, created_at FROM session`).
		WillReturnError(context.Canceled)

	_, err = ListActive(ctx, db)

	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}
