package api

import (
	"context"
	"net/http"
)

// ListAgents returns all active agent credentials.
func (c *Client) ListAgents(ctx context.Context) (*ListAgentsResponse, error) {
	var out ListAgentsResponse
	if err := c.do(ctx, http.MethodGet, "/ops/agents", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateAgent provisions a new agent credential. Requires provisioning secret.
func (c *Client) CreateAgent(ctx context.Context, req CreateAgentRequest) (*CreateAgentResponse, error) {
	var out CreateAgentResponse
	if err := c.doProvisioning(ctx, http.MethodPost, "/ops/agents", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteAgent revokes an agent credential by name. Requires provisioning secret.
func (c *Client) DeleteAgent(ctx context.Context, name string) (*DeleteAgentResponse, error) {
	var out DeleteAgentResponse
	if err := c.doProvisioning(ctx, http.MethodDelete, "/ops/agents/"+name, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
