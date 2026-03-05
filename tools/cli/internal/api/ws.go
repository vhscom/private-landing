package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/coder/websocket"
)

// ChallengeResult holds the result of a PoW challenge probe.
type ChallengeResult struct {
	// Required is true if the server demanded a PoW challenge.
	Required bool
	// Difficulty is the number of leading zeros required (0 if no challenge).
	Difficulty int
	// qs is the solved query string to append to the WebSocket URL.
	qs string
}

// ProbeChallenge checks if the server requires a PoW challenge for /ops/ws.
// If a challenge is required, it solves it and returns the result.
func (c *Client) ProbeChallenge(ctx context.Context) (*ChallengeResult, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/ops/ws", nil)
	if err != nil {
		return nil, fmt.Errorf("challenge probe: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.agentKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("challenge probe: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 403 {
		return &ChallengeResult{}, nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("challenge probe read: %w", err)
	}

	var challenge struct {
		Error     string `json:"error"`
		Challenge struct {
			Type       string `json:"type"`
			Difficulty int    `json:"difficulty"`
			Nonce      string `json:"nonce"`
		} `json:"challenge"`
	}
	if err := json.Unmarshal(body, &challenge); err != nil || challenge.Challenge.Nonce == "" {
		return nil, fmt.Errorf("connection forbidden: %s", string(body))
	}

	nonce := challenge.Challenge.Nonce
	difficulty := challenge.Challenge.Difficulty
	prefix := strings.Repeat("0", difficulty)

	solution, err := solvePow(ctx, nonce, prefix)
	if err != nil {
		return nil, err
	}

	return &ChallengeResult{
		Required:   true,
		Difficulty: difficulty,
		qs:         fmt.Sprintf("?challengeNonce=%s&challengeSolution=%d", nonce, solution),
	}, nil
}

// ConnectWS opens a WebSocket connection to /ops/ws with agent auth.
// Pass a ChallengeResult from ProbeChallenge, or nil to skip challenge handling.
// The caller is responsible for closing the returned connection.
func (c *Client) ConnectWS(ctx context.Context, challenge *ChallengeResult) (*websocket.Conn, error) {
	wsURL, err := httpToWS(c.baseURL)
	if err != nil {
		return nil, err
	}
	wsURL += "/ops/ws"

	if challenge != nil {
		wsURL += challenge.qs
	}

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + c.agentKey},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("ws dial: %w", err)
	}
	return conn, nil
}

// solvePow brute-forces the SHA-256 PoW challenge.
func solvePow(ctx context.Context, nonce, prefix string) (int, error) {
	for i := 0; ; i++ {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		default:
		}
		input := fmt.Sprintf("%s%d", nonce, i)
		hash := sha256.Sum256([]byte(input))
		hex := fmt.Sprintf("%x", hash)
		if strings.HasPrefix(hex, prefix) {
			return i, nil
		}
	}
}

// httpToWS converts an HTTP(S) URL to a WS(S) URL.
func httpToWS(rawURL string) (string, error) {
	switch {
	case strings.HasPrefix(rawURL, "https://"):
		return "wss://" + strings.TrimPrefix(rawURL, "https://"), nil
	case strings.HasPrefix(rawURL, "http://"):
		return "ws://" + strings.TrimPrefix(rawURL, "http://"), nil
	default:
		return "", fmt.Errorf("unsupported URL scheme: %s", rawURL)
	}
}
