package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListSessions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(ListSessionsResponse{
			Sessions: []Session{
				{ID: "sess-1", UserID: 1, UserAgent: "Mozilla/5.0", IPAddress: "1.2.3.4", ExpiresAt: "2026-03-01T00:00:00Z", CreatedAt: "2026-02-20T00:00:00Z"},
				{ID: "sess-2", UserID: 2, UserAgent: "curl/8.0", IPAddress: "10.0.0.1", ExpiresAt: "2026-03-01T00:00:00Z", CreatedAt: "2026-02-19T00:00:00Z"},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	resp, err := c.ListSessions(context.Background(), SessionsParams{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(resp.Sessions))
	}
	if resp.Sessions[0].ID != "sess-1" {
		t.Fatalf("expected sess-1, got %q", resp.Sessions[0].ID)
	}
}

func TestListSessionsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(APIError{Error: "Unauthorized", Code: "INVALID_AGENT_KEY"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "bad-key", "")
	_, err := c.ListSessions(context.Background(), SessionsParams{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListSessionsWithUserID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid := r.URL.Query().Get("user_id")
		if uid != "42" {
			t.Errorf("expected user_id=42, got %q", uid)
		}
		json.NewEncoder(w).Encode(ListSessionsResponse{Sessions: []Session{}})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	_, err := c.ListSessions(context.Background(), SessionsParams{UserID: "42"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRevokeSessions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		var req RevokeSessionsRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.Scope != "all" {
			t.Errorf("expected scope 'all', got %q", req.Scope)
		}
		json.NewEncoder(w).Encode(RevokeSessionsResponse{Success: true, Revoked: 5})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	resp, err := c.RevokeSessions(context.Background(), RevokeSessionsRequest{Scope: "all"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Revoked != 5 {
		t.Fatalf("expected 5 revoked, got %d", resp.Revoked)
	}
}

func TestRevokeSessionsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIError{Error: "id required for user scope", Code: "VALIDATION_ERROR"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	_, err := c.RevokeSessions(context.Background(), RevokeSessionsRequest{Scope: "user"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}
