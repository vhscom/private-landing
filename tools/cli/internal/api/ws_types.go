package api

import "encoding/json"

// --- Outbound WebSocket messages ---

// WSCapabilitiesRequest is the first message sent after upgrade.
type WSCapabilitiesRequest struct {
	Type         string   `json:"type"`
	Capabilities []string `json:"capabilities"`
}

// WSSubscribeRequest starts a live event subscription.
type WSSubscribeRequest struct {
	Type    string             `json:"type"`
	ID      string             `json:"id"`
	Payload WSSubscribePayload `json:"payload"`
}

// WSSubscribePayload holds optional type filters for subscribe_events.
type WSSubscribePayload struct {
	Types []string `json:"types,omitempty"`
}

// WSUnsubscribeRequest stops a live event subscription.
type WSUnsubscribeRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// WSPingRequest is an application-level keepalive sent to prevent ping timeout.
type WSPingRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// --- Inbound WebSocket messages ---

// WSEnvelope is used to peek at the type and ok fields before full decode.
type WSEnvelope struct {
	Type string `json:"type"`
	OK   *bool  `json:"ok,omitempty"`
}

// WSCapabilitiesGranted is the server response to capability.request.
type WSCapabilitiesGranted struct {
	Type         string          `json:"type"`
	ConnectionID string          `json:"connection_id"`
	Agent        string          `json:"agent"`
	Granted      []string        `json:"granted"`
	Denied       []WSDeniedCap   `json:"denied"`
}

// WSDeniedCap describes a capability that was denied.
type WSDeniedCap struct {
	Capability string `json:"capability"`
	Reason     string `json:"reason"`
}

// WSSubscribeResponse is the server ack for subscribe_events.
type WSSubscribeResponse struct {
	Type    string                   `json:"type"`
	ID      string                   `json:"id"`
	OK      bool                     `json:"ok"`
	Payload WSSubscribeResponsePayload `json:"payload"`
}

// WSSubscribeResponsePayload contains the polling interval.
type WSSubscribeResponsePayload struct {
	IntervalMS int `json:"interval_ms"`
}

// WSEvent is a subscription event pushed by the server.
type WSEvent struct {
	Type    string         `json:"type"` // always "event"
	Payload WSEventPayload `json:"payload"`
}

// WSEventPayload contains the normalized event fields.
type WSEventPayload struct {
	EventID   int              `json:"event_id"`
	EventType string           `json:"event_type"`
	IPAddress string           `json:"ip_address"`
	UserID    *int             `json:"user_id"`
	Detail    *json.RawMessage `json:"detail"`
	CreatedAt string           `json:"created_at"`
	ActorID   string           `json:"actor_id"`
}

// WSError is a server error response.
type WSError struct {
	Type  string       `json:"type"`
	ID    string       `json:"id"`
	OK    bool         `json:"ok"`
	Error WSErrorDetail `json:"error"`
}

// WSErrorDetail contains error code and message.
type WSErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
