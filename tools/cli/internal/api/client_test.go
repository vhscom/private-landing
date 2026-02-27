package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoSendsAgentAuthHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-agent-key" {
			t.Errorf("expected 'Bearer test-agent-key', got %q", auth)
		}
		accept := r.Header.Get("Accept")
		if accept != "application/json" {
			t.Errorf("expected Accept 'application/json', got %q", accept)
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"ok": "true"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-agent-key", "")
	var out map[string]string
	err := c.do(context.Background(), http.MethodGet, "/test", nil, &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDoProvisioningSendsProvSecret(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("X-Provisioning-Secret")
		if auth != "prov-secret-123" {
			t.Errorf("expected 'prov-secret-123', got %q", auth)
		}
		ct := r.Header.Get("Content-Type")
		if ct != "application/json" {
			t.Errorf("expected Content-Type 'application/json', got %q", ct)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"created": "true"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "agent-key", "prov-secret-123")
	body := map[string]string{"name": "test"}
	var out map[string]string
	err := c.doProvisioning(context.Background(), http.MethodPost, "/test", body, &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDoProvisioningWithoutSecretReturnsError(t *testing.T) {
	c := NewClient("http://localhost", "agent-key", "")
	err := c.doProvisioning(context.Background(), http.MethodPost, "/test", nil, nil)
	if err != ErrNoProvisioningSecret {
		t.Fatalf("expected ErrNoProvisioningSecret, got %v", err)
	}
}

func TestDoDecodesAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIError{
			Error: "name is required",
			Code:  "VALIDATION_ERROR",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	err := c.do(context.Background(), http.MethodPost, "/test", nil, nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	expected := "name is required (code: VALIDATION_ERROR)"
	if err.Error() != expected {
		t.Fatalf("expected %q, got %q", expected, err.Error())
	}
}

func TestDoHandlesNon2xxWithoutJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	err := c.do(context.Background(), http.MethodGet, "/test", nil, nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestDoSetsContentTypeForBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct := r.Header.Get("Content-Type")
		if ct != "application/json" {
			t.Errorf("expected Content-Type 'application/json', got %q", ct)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	err := c.do(context.Background(), http.MethodPost, "/test", map[string]string{"a": "b"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDoOmitsContentTypeWithoutBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct := r.Header.Get("Content-Type")
		if ct != "" {
			t.Errorf("expected no Content-Type, got %q", ct)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{}"))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "")
	err := c.do(context.Background(), http.MethodGet, "/test", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
