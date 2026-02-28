package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// ListSessions returns active sessions, optionally filtered by user ID.
func (c *Client) ListSessions(ctx context.Context, params SessionsParams) (*ListSessionsResponse, error) {
	q := url.Values{}
	if params.UserID != "" {
		q.Set("user_id", params.UserID)
	}
	if params.Limit > 0 {
		q.Set("limit", strconv.Itoa(params.Limit))
	}
	if params.Offset > 0 {
		q.Set("offset", strconv.Itoa(params.Offset))
	}
	path := "/ops/sessions?" + q.Encode()

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
