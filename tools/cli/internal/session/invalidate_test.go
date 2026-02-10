package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestInvalidateAll(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE session SET expires_at = datetime\('now'\) WHERE expires_at > datetime\('now'\)`).
		WillReturnResult(sqlmock.NewResult(0, 5))

	r := Invalidate(context.Background(), db, ScopeAll, "")

	if r.Err != nil {
		t.Fatalf("unexpected error: %v", r.Err)
	}
	if r.RowsAffected != 5 {
		t.Fatalf("expected 5 rows affected, got %d", r.RowsAffected)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidateUser(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE session SET expires_at = datetime\('now'\) WHERE user_id = \? AND expires_at > datetime\('now'\)`).
		WithArgs("42").
		WillReturnResult(sqlmock.NewResult(0, 3))

	r := Invalidate(context.Background(), db, ScopeUser, "42")

	if r.Err != nil {
		t.Fatalf("unexpected error: %v", r.Err)
	}
	if r.RowsAffected != 3 {
		t.Fatalf("expected 3 rows affected, got %d", r.RowsAffected)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidateSession(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE session SET expires_at = datetime\('now'\) WHERE id = \? AND expires_at > datetime\('now'\)`).
		WithArgs("abc123").
		WillReturnResult(sqlmock.NewResult(0, 1))

	r := Invalidate(context.Background(), db, ScopeSession, "abc123")

	if r.Err != nil {
		t.Fatalf("unexpected error: %v", r.Err)
	}
	if r.RowsAffected != 1 {
		t.Fatalf("expected 1 row affected, got %d", r.RowsAffected)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidateZeroRows(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE session SET expires_at`).
		WithArgs("nonexistent").
		WillReturnResult(sqlmock.NewResult(0, 0))

	r := Invalidate(context.Background(), db, ScopeSession, "nonexistent")

	if r.Err != nil {
		t.Fatalf("unexpected error: %v", r.Err)
	}
	if r.RowsAffected != 0 {
		t.Fatalf("expected 0 rows affected, got %d", r.RowsAffected)
	}
}

func TestInvalidateDBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE session SET expires_at`).
		WillReturnError(fmt.Errorf("connection lost"))

	r := Invalidate(context.Background(), db, ScopeAll, "")

	if r.Err == nil {
		t.Fatal("expected error, got nil")
	}
	if r.Err.Error() != "connection lost" {
		t.Fatalf("expected 'connection lost', got %q", r.Err.Error())
	}
}

func TestInvalidateUnknownScope(t *testing.T) {
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	r := Invalidate(context.Background(), db, Scope(99), "")

	if r.Err == nil {
		t.Fatal("expected error for unknown scope")
	}
	if r.RowsAffected != 0 {
		t.Fatalf("expected 0 rows affected, got %d", r.RowsAffected)
	}
}

func TestInvalidateCancelledContext(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	mock.ExpectExec(`UPDATE session SET expires_at`).
		WillReturnError(context.Canceled)

	r := Invalidate(ctx, db, ScopeAll, "")

	if r.Err == nil {
		t.Fatal("expected error for cancelled context")
	}
}
