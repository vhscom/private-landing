package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// ListEvents returns security events, optionally filtered.
func (c *Client) ListEvents(ctx context.Context, params EventsParams) (*ListEventsResponse, error) {
	q := url.Values{}
	if params.Type != "" {
		q.Set("type", params.Type)
	}
	if params.UserID != "" {
		q.Set("user_id", params.UserID)
	}
	if params.IP != "" {
		q.Set("ip", params.IP)
	}
	if params.Since != "" {
		q.Set("since", params.Since)
	}
	if params.Limit > 0 {
		q.Set("limit", strconv.Itoa(params.Limit))
	}
	if params.Offset > 0 {
		q.Set("offset", strconv.Itoa(params.Offset))
	}
	path := "/ops/events?" + q.Encode()

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
		q := url.Values{}
		q.Set("since", since)
		path += "?" + q.Encode()
	}

	var out EventStatsResponse
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
