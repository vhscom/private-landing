package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListAgents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(ListAgentsResponse{
			Agents: []Agent{
				{Name: "monitor", TrustLevel: "read", CreatedAt: "2026-02-20T00:00:00Z"},
				{Name: "responder", TrustLevel: "write", CreatedAt: "2026-02-19T00:00:00Z"},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	resp, err := c.ListAgents(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Agents) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(resp.Agents))
	}
	if resp.Agents[0].Name != "monitor" {
		t.Fatalf("expected 'monitor', got %q", resp.Agents[0].Name)
	}
}

func TestListAgentsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(APIError{Error: "Unauthorized", Code: "INVALID_AGENT_KEY"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "bad-key", "")
	_, err := c.ListAgents(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCreateAgent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		auth := r.Header.Get("X-Provisioning-Secret")
		if auth != "prov-secret" {
			t.Errorf("expected provisioning secret, got %q", auth)
		}
		var req CreateAgentRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.Name != "test-agent" {
			t.Errorf("expected name 'test-agent', got %q", req.Name)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(CreateAgentResponse{
			Name:       "test-agent",
			TrustLevel: "read",
			APIKey:     "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
			CreatedAt:  "2026-02-20T00:00:00Z",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "prov-secret")
	resp, err := c.CreateAgent(context.Background(), CreateAgentRequest{Name: "test-agent", TrustLevel: "read"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.APIKey == "" {
		t.Fatal("expected non-empty API key")
	}
}

func TestCreateAgentError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(APIError{Error: "Agent name already exists", Code: "DUPLICATE_NAME"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "prov-secret")
	_, err := c.CreateAgent(context.Background(), CreateAgentRequest{Name: "dup", TrustLevel: "read"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestCreateAgentNoProvSecret(t *testing.T) {
	c := NewClient("http://localhost", "key", "")
	_, err := c.CreateAgent(context.Background(), CreateAgentRequest{Name: "test", TrustLevel: "read"})
	if err != ErrNoProvisioningSecret {
		t.Fatalf("expected ErrNoProvisioningSecret, got %v", err)
	}
}

func TestDeleteAgent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		if r.URL.Path != "/ops/agents/old-agent" {
			t.Errorf("expected path /ops/agents/old-agent, got %q", r.URL.Path)
		}
		json.NewEncoder(w).Encode(DeleteAgentResponse{Success: true, Message: "Agent 'old-agent' revoked"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "prov-secret")
	resp, err := c.DeleteAgent(context.Background(), "old-agent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Success {
		t.Fatal("expected success=true")
	}
}

func TestDeleteAgentError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(APIError{Error: "Agent not found", Code: "NOT_FOUND"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "prov-secret")
	_, err := c.DeleteAgent(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}
