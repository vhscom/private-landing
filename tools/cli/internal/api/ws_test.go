package api

import "testing"

func TestHttpToWS(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{"http to ws", "http://localhost:8788", "ws://localhost:8788", false},
		{"https to wss", "https://example.com", "wss://example.com", false},
		{"http with path", "http://localhost:8788/api", "ws://localhost:8788/api", false},
		{"https with path", "https://example.com/api", "wss://example.com/api", false},
		{"unsupported scheme", "ftp://example.com", "", true},
		{"no scheme", "example.com", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := httpToWS(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("httpToWS(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("httpToWS(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
