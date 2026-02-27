package api

import (
	"context"
	"fmt"
	"net/http"
)

// ListEvents returns security events, optionally filtered.
func (c *Client) ListEvents(ctx context.Context, params EventsParams) (*ListEventsResponse, error) {
	path := "/ops/events?"
	if params.Type != "" {
		path += fmt.Sprintf("type=%s&", params.Type)
	}
	if params.UserID != "" {
		path += fmt.Sprintf("user_id=%s&", params.UserID)
	}
	if params.IP != "" {
		path += fmt.Sprintf("ip=%s&", params.IP)
	}
	if params.Since != "" {
		path += fmt.Sprintf("since=%s&", params.Since)
	}
	if params.Limit > 0 {
		path += fmt.Sprintf("limit=%d&", params.Limit)
	}
	if params.Offset > 0 {
		path += fmt.Sprintf("offset=%d&", params.Offset)
	}

	var out ListEventsResponse
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetEventStats returns aggregate event counts by type.
func (c *Client) GetEventStats(ctx context.Context, since string) (*EventStatsResponse, error) {
	path := "/ops/events/stats"
	if since != "" {
		path += fmt.Sprintf("?since=%s", since)
	}

	var out EventStatsResponse
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
