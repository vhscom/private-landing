package main

import (
	"os"
	"testing"
)

func TestIsSafeTarget(t *testing.T) {
	tests := []struct {
		name string
		url  string
		env  string
		want bool
	}{
		// Loopback addresses — always safe regardless of ENVIRONMENT
		{"localhost", "http://localhost:8788", "", true},
		{"ipv4 loopback", "http://127.0.0.1:8788", "", true},
		{"ipv6 loopback", "http://[::1]:8788/", "", true},

		// Non-loopback without ENVIRONMENT — unsafe
		{"workers.dev no env", "https://private-landing.vhsdev.workers.dev", "", false},
		{"custom domain no env", "https://auth.example.com", "", false},

		// Non-loopback with ENVIRONMENT=production — unsafe
		{"workers.dev production", "https://private-landing.vhsdev.workers.dev", "production", false},

		// Non-loopback with non-production ENVIRONMENT — safe
		{"workers.dev development", "https://private-landing.vhsdev.workers.dev", "development", true},
		{"workers.dev test", "https://private-landing.vhsdev.workers.dev", "test", true},
		{"workers.dev staging", "https://private-landing.vhsdev.workers.dev", "staging", true},
		{"workers.dev uat", "https://private-landing.vhsdev.workers.dev", "uat", true},

		// Invalid URL — unsafe
		{"invalid url", "://bad", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.env != "" {
				os.Setenv("ENVIRONMENT", tt.env)
				t.Cleanup(func() { os.Unsetenv("ENVIRONMENT") })
			} else {
				os.Unsetenv("ENVIRONMENT")
			}

			if got := isSafeTarget(tt.url); got != tt.want {
				t.Errorf("isSafeTarget(%q) with ENVIRONMENT=%q = %v, want %v", tt.url, tt.env, got, tt.want)
			}
		})
	}
}
