package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrNoProvisioningSecret is returned when a provisioning operation is
// attempted without PLCTL_PROVISIONING_SECRET being set.
var ErrNoProvisioningSecret = errors.New("PLCTL_PROVISIONING_SECRET is not set")

// Client communicates with the Private Landing /ops/* API.
type Client struct {
	baseURL    string
	agentKey   string
	provSecret string
	http       *http.Client
}

// NewClient creates a new API client.
func NewClient(baseURL, agentKey, provSecret string) *Client {
	return &Client{
		baseURL:    baseURL,
		agentKey:   agentKey,
		provSecret: provSecret,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// do makes an agent-authenticated request (Bearer agentKey).
func (c *Client) do(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	return c.request(ctx, method, path, body, out, c.agentKey)
}

// doProvisioning makes a provisioning-authenticated request (X-Provisioning-Secret).
func (c *Client) doProvisioning(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if c.provSecret == "" {
		return ErrNoProvisioningSecret
	}
	return c.requestWithHeaders(ctx, method, path, body, out, map[string]string{
		"X-Provisioning-Secret": c.provSecret,
	})
}

func (c *Client) request(ctx context.Context, method, path string, body interface{}, out interface{}, token string) error {
	return c.requestWithHeaders(ctx, method, path, body, out, map[string]string{
		"Authorization": "Bearer " + token,
	})
}

func (c *Client) requestWithHeaders(ctx context.Context, method, path string, body interface{}, out interface{}, headers map[string]string) error {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		var apiErr APIError
		if json.Unmarshal(respBody, &apiErr) == nil && apiErr.Error != "" {
			return fmt.Errorf("%s (code: %s)", apiErr.Error, apiErr.Code)
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}

	return nil
}
