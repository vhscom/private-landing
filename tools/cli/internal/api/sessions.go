package api

import (
	"context"
	"fmt"
	"net/http"
)

// ListSessions returns active sessions, optionally filtered by user ID.
func (c *Client) ListSessions(ctx context.Context, params SessionsParams) (*ListSessionsResponse, error) {
	path := "/ops/sessions?"
	if params.UserID != "" {
		path += fmt.Sprintf("user_id=%s&", params.UserID)
	}
	if params.Limit > 0 {
		path += fmt.Sprintf("limit=%d&", params.Limit)
	}
	if params.Offset > 0 {
		path += fmt.Sprintf("offset=%d&", params.Offset)
	}

	var out ListSessionsResponse
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeSessions revokes sessions by scope (all, user, or session).
func (c *Client) RevokeSessions(ctx context.Context, req RevokeSessionsRequest) (*RevokeSessionsResponse, error) {
	var out RevokeSessionsResponse
	if err := c.do(ctx, http.MethodPost, "/ops/sessions/revoke", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
