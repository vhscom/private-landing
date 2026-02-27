package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListEvents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(ListEventsResponse{
			Events: []Event{
				{ID: 1, Type: "login.success", IPAddress: "1.2.3.4", ActorID: "user", CreatedAt: "2026-02-20T00:00:00Z"},
				{ID: 2, Type: "login.failure", IPAddress: "5.6.7.8", ActorID: "user", CreatedAt: "2026-02-20T01:00:00Z"},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	resp, err := c.ListEvents(context.Background(), EventsParams{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(resp.Events))
	}
}

func TestListEventsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(APIError{Error: "Unauthorized", Code: "INVALID_AGENT_KEY"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "bad-key", "")
	_, err := c.ListEvents(context.Background(), EventsParams{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestListEventsWithFilters(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("type") != "login.success" {
			t.Errorf("expected type=login.success, got %q", q.Get("type"))
		}
		if q.Get("user_id") != "42" {
			t.Errorf("expected user_id=42, got %q", q.Get("user_id"))
		}
		json.NewEncoder(w).Encode(ListEventsResponse{Events: []Event{}})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	_, err := c.ListEvents(context.Background(), EventsParams{Type: "login.success", UserID: "42"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetEventStats(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(EventStatsResponse{
			Stats: map[string]int{"login.success": 42, "login.failure": 3},
			Since: "2026-02-19T00:00:00Z",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	resp, err := c.GetEventStats(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Stats["login.success"] != 42 {
		t.Fatalf("expected 42 login.success, got %d", resp.Stats["login.success"])
	}
}

func TestGetEventStatsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(APIError{Error: "Unauthorized", Code: "INVALID_AGENT_KEY"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "bad-key", "")
	_, err := c.GetEventStats(context.Background(), "")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}
