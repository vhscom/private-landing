package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/private-landing/cli/internal/api"
	"github.com/private-landing/cli/internal/session"
	"github.com/private-landing/cli/internal/ui"
	"github.com/coder/websocket"
)

// states
type state int

const (
	stateMenu state = iota
	stateInput
	stateConfirm
	stateResult
	stateSessions
	stateEvents
	stateEventDetail
	stateEventStats
	stateAgents
	stateTailEvents
)

type action int

const (
	// Sessions
	actionViewSessions action = iota
	actionViewSessionsForUser
	actionRevokeAll
	actionRevokeUser
	actionRevokeSession
	// Events
	actionViewEvents
	actionViewEventsForUser
	actionViewEventStats
	actionTailEvents
	// Agents
	actionListAgents
	actionProvisionAgent
	actionRevokeAgent
)

type menuItem struct {
	label    string
	action   action
	isHeader bool
}

var menuItems = []menuItem{
	{label: "SESSIONS", isHeader: true},
	{label: "View active sessions", action: actionViewSessions},
	{label: "View sessions for user", action: actionViewSessionsForUser},
	{label: "Revoke all sessions", action: actionRevokeAll},
	{label: "Revoke sessions for user", action: actionRevokeUser},
	{label: "Revoke specific session", action: actionRevokeSession},

	{label: "EVENTS", isHeader: true},
	{label: "View recent events", action: actionViewEvents},
	{label: "View events for user", action: actionViewEventsForUser},
	{label: "View event stats", action: actionViewEventStats},
	{label: "Tail events (live)", action: actionTailEvents},

	{label: "AGENTS", isHeader: true},
	{label: "List agents", action: actionListAgents},
	{label: "Provision agent", action: actionProvisionAgent},
	{label: "Revoke agent", action: actionRevokeAgent},
}

// messages
type resultMsg struct {
	message string
	err     error
}

type sessionsMsg struct {
	sessions []api.Session
	err      error
}

type eventsMsg struct {
	events []api.Event
	err    error
}

type eventStatsMsg struct {
	stats map[string]int
	since string
	err   error
}

type agentsMsg struct {
	agents []api.Agent
	err    error
}

type tailChallengeMsg struct {
	challenge *api.ChallengeResult
	err       error
}

type tailConnectedMsg struct {
	conn *websocket.Conn
	err  error
}

type tailEventMsg struct {
	event api.Event
}

type tailErrorMsg struct {
	err error
}

type model struct {
	client   *api.Client
	state    state
	cursor   int
	action   action
	input    session.InputBuffer
	quitting bool

	// multi-field input
	inputField  int
	inputLabels []string
	inputs      []string
	inputHint   string

	// result state
	resultMessage string
	resultErr     error

	// data states
	sessions    []api.Session
	events      []api.Event
	eventsTable table.Model
	eventStats  map[string]int
	eventSince  string
	agents      []api.Agent
	dataErr     error

	// tail events state
	tailEvents        []api.Event
	tailFilter        []string // type filters (e.g. "login.*")
	tailErr           error
	tailConn          *websocket.Conn
	tailChallenge     *api.ChallengeResult
	tailKeepaliveStop chan struct{}

	// terminal dimensions
	width int
}

func initialModel(client *api.Client) model {
	m := model{client: client, state: stateMenu}
	m.cursor = firstSelectableIndex()
	return m
}

func firstSelectableIndex() int {
	for i, item := range menuItems {
		if !item.isHeader {
			return i
		}
	}
	return 0
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	case resultMsg:
		m.resultMessage = msg.message
		m.resultErr = msg.err
		m.state = stateResult
		return m, nil
	case sessionsMsg:
		m.sessions = msg.sessions
		m.dataErr = msg.err
		m.state = stateSessions
		return m, nil
	case eventsMsg:
		m.events = msg.events
		m.dataErr = msg.err
		m.state = stateEvents
		if msg.err == nil && len(msg.events) > 0 {
			m.eventsTable = buildEventsTable(msg.events)
		}
		return m, nil
	case eventStatsMsg:
		m.eventStats = msg.stats
		m.eventSince = msg.since
		m.dataErr = msg.err
		m.state = stateEventStats
		return m, nil
	case agentsMsg:
		m.agents = msg.agents
		m.dataErr = msg.err
		m.state = stateAgents
		return m, nil
	case tailChallengeMsg:
		if msg.err != nil {
			m.tailErr = msg.err
			m.state = stateTailEvents
			return m, nil
		}
		m.tailChallenge = msg.challenge
		return m, m.dialAndSubscribe()
	case tailConnectedMsg:
		if msg.err != nil {
			m.tailErr = msg.err
			m.state = stateTailEvents
			return m, nil
		}
		m.tailConn = msg.conn
		m.tailKeepaliveStop = make(chan struct{})
		go keepAlive(m.tailConn, m.tailKeepaliveStop)
		m.state = stateTailEvents
		return m, m.readNextEvent()
	case tailEventMsg:
		if msg.event.Type != "" {
			m.tailEvents = append(m.tailEvents, msg.event)
			if len(m.tailEvents) > 100 {
				m.tailEvents = m.tailEvents[len(m.tailEvents)-100:]
			}
		}
		return m, m.readNextEvent()
	case tailErrorMsg:
		m.tailErr = msg.err
		return m, nil
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if key == "ctrl+c" {
		m.quitting = true
		return m, tea.Quit
	}

	switch m.state {
	case stateMenu:
		return m.handleMenu(key)
	case stateInput:
		return m.handleInput(key, msg)
	case stateConfirm:
		return m.handleConfirm(key)
	case stateEvents:
		return m.handleEventsView(msg)
	case stateEventDetail:
		return m.handleEventDetail(msg)
	case stateTailEvents:
		return m.handleTailView(key)
	case stateResult, stateSessions, stateEventStats, stateAgents:
		return m.handleDataView(key)
	}
	return m, nil
}

func (m model) handleMenu(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "up", "k":
		m.cursor = m.prevSelectable(m.cursor)
	case "down", "j":
		m.cursor = m.nextSelectable(m.cursor)
	case "enter":
		item := menuItems[m.cursor]
		if item.isHeader {
			return m, nil
		}
		m.action = item.action
		return m.dispatchAction()
	case "q":
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

func (m model) prevSelectable(from int) int {
	for i := from - 1; i >= 0; i-- {
		if !menuItems[i].isHeader {
			return i
		}
	}
	return from
}

func (m model) nextSelectable(from int) int {
	for i := from + 1; i < len(menuItems); i++ {
		if !menuItems[i].isHeader {
			return i
		}
	}
	return from
}

func (m model) dispatchAction() (model, tea.Cmd) {
	switch m.action {
	// Direct fetches (no input needed)
	case actionViewSessions:
		m.sessions = nil
		return m, m.fetchSessions("")
	case actionViewEvents:
		m.events = nil
		return m, m.fetchEvents("")
	case actionViewEventStats:
		m.eventStats = nil
		return m, m.fetchEventStats()
	case actionTailEvents:
		m.tailEvents = nil
		m.tailFilter = nil
		m.tailErr = nil
		m.tailConn = nil
		m.tailChallenge = nil
		m.startInput([]string{"Type filter (optional)"})
		m.inputHint = "  Examples:  login.*, session.revoke, ws.*\n" +
			"  Available: login.*, password.*, session.*, agent.*, challenge.*, ws.*, registration.*, rate_limit.*\n" +
			"  Combine:   login.*,session.revoke"
	case actionListAgents:
		m.agents = nil
		return m, m.fetchAgents()

	// Single input
	case actionViewSessionsForUser:
		m.startInput([]string{"User ID"})
	case actionRevokeAll:
		m.state = stateConfirm
	case actionRevokeUser:
		m.startInput([]string{"User ID"})
	case actionRevokeSession:
		m.startInput([]string{"Session ID"})
	case actionViewEventsForUser:
		m.startInput([]string{"User ID"})
	case actionRevokeAgent:
		m.startInput([]string{"Agent name"})

	// Multi-field input
	case actionProvisionAgent:
		m.startInput([]string{"Agent name", "Trust level (read, write)", "Description (optional)"})
	}
	return m, nil
}

func (m *model) startInput(labels []string) {
	m.state = stateInput
	m.inputField = 0
	m.inputLabels = labels
	m.inputs = make([]string, 0, len(labels))
	m.inputHint = ""
	m.input.Clear()
}

func (m model) handleInput(key string, msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key {
	case "enter":
		val := strings.TrimSpace(m.input.Value)
		optional := strings.HasSuffix(m.inputLabels[m.inputField], "(optional)")
		if val == "" && !optional {
			return m, nil
		}
		m.inputs = append(m.inputs, val)
		m.inputField++
		m.input.Clear()

		if m.inputField >= len(m.inputLabels) {
			// All fields collected — go to confirm or execute
			return m.afterInputComplete()
		}
	case "backspace":
		m.input.Backspace()
	case "esc":
		m.state = stateMenu
		m.input.Clear()
	default:
		m.input.Append(msg.Runes)
	}
	return m, nil
}

func (m model) afterInputComplete() (model, tea.Cmd) {
	switch m.action {
	// Actions that need confirmation before executing
	case actionRevokeUser, actionRevokeSession, actionRevokeAgent:
		m.state = stateConfirm
		return m, nil

	// Actions that execute immediately after input
	case actionViewSessionsForUser:
		m.state = stateSessions
		m.sessions = nil
		return m, m.fetchSessions(m.inputs[0])
	case actionViewEventsForUser:
		m.state = stateEvents
		m.events = nil
		return m, m.fetchEvents(m.inputs[0])
	case actionTailEvents:
		filter := strings.TrimSpace(m.inputs[0])
		if filter != "" {
			m.tailFilter = strings.Split(filter, ",")
			for i := range m.tailFilter {
				m.tailFilter[i] = strings.TrimSpace(m.tailFilter[i])
			}
		}
		m.state = stateTailEvents
		return m, m.probeChallenge()
	case actionProvisionAgent:
		m.state = stateConfirm
		return m, nil
	}

	m.state = stateMenu
	return m, nil
}

func (m model) handleConfirm(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "y", "Y":
		return m, m.executeAction()
	case "n", "N", "esc":
		m.state = stateMenu
		m.input.Clear()
	}
	return m, nil
}

func (m model) handleDataView(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "enter", "esc":
		m.state = stateMenu
		m.input.Clear()
		m.dataErr = nil
	case "q":
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

func (m model) handleEventsView(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "enter":
		if len(m.events) > 0 && m.eventsTable.SelectedRow() != nil {
			m.state = stateEventDetail
			return m, nil
		}
		m.state = stateMenu
		m.dataErr = nil
		return m, nil
	case "esc":
		m.state = stateMenu
		m.dataErr = nil
		return m, nil
	case "q":
		m.quitting = true
		return m, tea.Quit
	}
	var cmd tea.Cmd
	m.eventsTable, cmd = m.eventsTable.Update(msg)
	return m, cmd
}

func (m model) handleEventDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "enter":
		m.state = stateEvents
	case "q":
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

func buildEventsTable(events []api.Event) table.Model {
	columns := []table.Column{
		{Title: "ID", Width: 6},
		{Title: "Type", Width: 24},
		{Title: "IP", Width: 16},
		{Title: "User", Width: 8},
		{Title: "Actor", Width: 28},
		{Title: "Time", Width: 20},
	}

	rows := make([]table.Row, len(events))
	for i, e := range events {
		userID := "-"
		if e.UserID != nil {
			userID = fmt.Sprintf("%d", *e.UserID)
		}
		rows[i] = table.Row{
			fmt.Sprintf("%d", e.ID),
			e.Type,
			e.IPAddress,
			userID,
			e.ActorID,
			e.CreatedAt,
		}
	}

	s := table.DefaultStyles()
	s.Header = s.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("8")).
		BorderBottom(true).
		Bold(true).
		Foreground(lipgloss.Color("5"))
	s.Selected = s.Selected.
		Foreground(lipgloss.Color("0")).
		Background(lipgloss.Color("2")).
		Bold(false)

	t := table.New(
		table.WithColumns(columns),
		table.WithRows(rows),
		table.WithHeight(15),
		table.WithFocused(true),
		table.WithStyles(s),
	)

	return t
}

// --- Commands ---

func (m model) fetchSessions(userID string) tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.ListSessions(context.Background(), api.SessionsParams{UserID: userID})
		if err != nil {
			return sessionsMsg{err: err}
		}
		return sessionsMsg{sessions: resp.Sessions}
	}
}

func (m model) fetchEvents(userID string) tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.ListEvents(context.Background(), api.EventsParams{UserID: userID})
		if err != nil {
			return eventsMsg{err: err}
		}
		return eventsMsg{events: resp.Events}
	}
}

func (m model) fetchEventStats() tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.GetEventStats(context.Background(), "")
		if err != nil {
			return eventStatsMsg{err: err}
		}
		return eventStatsMsg{stats: resp.Stats, since: resp.Since}
	}
}

func (m model) fetchAgents() tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.ListAgents(context.Background())
		if err != nil {
			return agentsMsg{err: err}
		}
		return agentsMsg{agents: resp.Agents}
	}
}

func (m model) probeChallenge() tea.Cmd {
	return func() tea.Msg {
		ctx := context.Background()
		result, err := m.client.ProbeChallenge(ctx)
		return tailChallengeMsg{challenge: result, err: err}
	}
}

func (m model) dialAndSubscribe() tea.Cmd {
	return func() tea.Msg {
		ctx := context.Background()

		conn, err := m.client.ConnectWS(ctx, m.tailChallenge)
		if err != nil {
			return tailConnectedMsg{err: err}
		}

		// Send capability.request
		capReq := api.WSCapabilitiesRequest{
			Type:         "capability.request",
			Capabilities: []string{"subscribe_events"},
		}
		data, _ := json.Marshal(capReq)
		if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("write capabilities: %w", err)}
		}

		// Read capability.granted
		_, capResp, err := conn.Read(ctx)
		if err != nil {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("read capabilities: %w", err)}
		}
		var granted api.WSCapabilitiesGranted
		if err := json.Unmarshal(capResp, &granted); err != nil {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("decode capabilities: %w", err)}
		}
		hasSubscribe := false
		for _, c := range granted.Granted {
			if c == "subscribe_events" {
				hasSubscribe = true
				break
			}
		}
		if !hasSubscribe {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("subscribe_events capability denied")}
		}

		// Send subscribe_events
		subReq := api.WSSubscribeRequest{
			Type:    "subscribe_events",
			ID:      "tail-1",
			Payload: api.WSSubscribePayload{Types: m.tailFilter},
		}
		data, _ = json.Marshal(subReq)
		if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("write subscribe: %w", err)}
		}

		// Read subscribe ack
		_, subResp, err := conn.Read(ctx)
		if err != nil {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("read subscribe ack: %w", err)}
		}
		var envelope api.WSEnvelope
		if err := json.Unmarshal(subResp, &envelope); err != nil || (envelope.OK != nil && !*envelope.OK) {
			conn.Close(websocket.StatusNormalClosure, "")
			return tailConnectedMsg{err: fmt.Errorf("subscribe rejected")}
		}

		return tailConnectedMsg{conn: conn}
	}
}

func (m model) readNextEvent() tea.Cmd {
	return func() tea.Msg {
		if m.tailConn == nil {
			return tailErrorMsg{err: fmt.Errorf("no connection")}
		}
		_, data, err := m.tailConn.Read(context.Background())
		if err != nil {
			return tailErrorMsg{err: err}
		}
		var envelope api.WSEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			return tailErrorMsg{err: fmt.Errorf("decode message: %w", err)}
		}
		switch envelope.Type {
		case "credential.revoked":
			return tailErrorMsg{err: fmt.Errorf("agent credential revoked")}
		case "event":
			var wsEvt api.WSEvent
			if err := json.Unmarshal(data, &wsEvt); err != nil {
				return tailErrorMsg{err: fmt.Errorf("decode event: %w", err)}
			}
			p := wsEvt.Payload
			var detail *string
			if p.Detail != nil {
				s := string(*p.Detail)
				detail = &s
			}
			return tailEventMsg{event: api.Event{
				ID:        p.EventID,
				Type:      p.EventType,
				IPAddress: p.IPAddress,
				UserID:    p.UserID,
				Detail:    detail,
				CreatedAt: p.CreatedAt,
				ActorID:   p.ActorID,
			}}
		default:
			// Protocol messages (heartbeat, pong) — skip and read next
			return tailEventMsg{event: api.Event{Type: ""}}
		}
	}
}

func (m *model) closeTail() {
	if m.tailKeepaliveStop != nil {
		close(m.tailKeepaliveStop)
		m.tailKeepaliveStop = nil
	}
	if m.tailConn != nil {
		// Best-effort unsubscribe
		unsub := api.WSUnsubscribeRequest{Type: "unsubscribe_events", ID: "tail-2"}
		data, _ := json.Marshal(unsub)
		_ = m.tailConn.Write(context.Background(), websocket.MessageText, data)
		m.tailConn.Close(websocket.StatusNormalClosure, "client disconnected")
		m.tailConn = nil
	}
}

// keepAlive sends application-level ping messages to prevent ping timeout.
// Runs as a goroutine alongside the read loop; github.com/coder/websocket supports
// one concurrent reader + one concurrent writer.
func keepAlive(conn *websocket.Conn, stop <-chan struct{}) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	seq := 0
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			seq++
			ping := api.WSPingRequest{
				Type: "ping",
				ID:   fmt.Sprintf("keepalive-%d", seq),
			}
			data, _ := json.Marshal(ping)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = conn.Write(ctx, websocket.MessageText, data)
			cancel()
		}
	}
}

func (m model) handleTailView(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "esc":
		m.closeTail()
		m.state = stateMenu
		m.tailEvents = nil
		m.tailErr = nil
		return m, nil
	case "q":
		m.closeTail()
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

func (m model) executeAction() tea.Cmd {
	return func() tea.Msg {
		ctx := context.Background()

		switch m.action {
		case actionRevokeAll:
			resp, err := m.client.RevokeSessions(ctx, api.RevokeSessionsRequest{Scope: "all"})
			if err != nil {
				return resultMsg{err: err}
			}
			return resultMsg{message: fmt.Sprintf("Done. %d session(s) revoked.", resp.Revoked)}

		case actionRevokeUser:
			resp, err := m.client.RevokeSessions(ctx, api.RevokeSessionsRequest{Scope: "user", ID: m.inputs[0]})
			if err != nil {
				return resultMsg{err: err}
			}
			return resultMsg{message: fmt.Sprintf("Done. %d session(s) revoked for user %s.", resp.Revoked, m.inputs[0])}

		case actionRevokeSession:
			resp, err := m.client.RevokeSessions(ctx, api.RevokeSessionsRequest{Scope: "session", ID: m.inputs[0]})
			if err != nil {
				return resultMsg{err: err}
			}
			return resultMsg{message: fmt.Sprintf("Done. %d session(s) revoked.", resp.Revoked)}

		case actionProvisionAgent:
			resp, err := m.client.CreateAgent(ctx, api.CreateAgentRequest{Name: m.inputs[0], TrustLevel: m.inputs[1], Description: m.inputs[2]})
			if err != nil {
				return resultMsg{err: err}
			}
			return resultMsg{message: fmt.Sprintf("Agent '%s' provisioned.\nAPI Key: %s\n\nSave this key — it will not be shown again.", resp.Name, resp.APIKey)}

		case actionRevokeAgent:
			_, err := m.client.DeleteAgent(ctx, m.inputs[0])
			if err != nil {
				return resultMsg{err: err}
			}
			return resultMsg{message: fmt.Sprintf("Agent '%s' revoked.", m.inputs[0])}
		}

		return resultMsg{err: fmt.Errorf("unknown action")}
	}
}

// --- Views ---

func (m model) View() string {
	if m.quitting {
		return ""
	}

	var b strings.Builder
	b.WriteString(ui.TitleStyle.Render("Private Landing CLI"))
	b.WriteString("\n\n")

	switch m.state {
	case stateMenu:
		b.WriteString(m.viewMenu())
	case stateInput:
		b.WriteString(m.viewInput())
	case stateConfirm:
		b.WriteString(m.viewConfirm())
	case stateResult:
		b.WriteString(m.viewResult())
	case stateSessions:
		b.WriteString(m.viewSessions())
	case stateEvents:
		b.WriteString(m.viewEvents())
	case stateEventDetail:
		b.WriteString(m.viewEventDetail())
	case stateEventStats:
		b.WriteString(m.viewEventStats())
	case stateAgents:
		b.WriteString(m.viewAgents())
	case stateTailEvents:
		b.WriteString(m.viewTailEvents())
	}

	b.WriteString("\n")
	return b.String()
}

func (m model) viewMenu() string {
	var b strings.Builder

	for i, item := range menuItems {
		if item.isHeader {
			if i > 0 {
				b.WriteString("\n")
			}
			b.WriteString("  ")
			b.WriteString(ui.HeaderStyle.Render(item.label))
			b.WriteString("\n")
			continue
		}

		cursor := "  "
		style := ui.DimStyle
		if i == m.cursor {
			cursor = "> "
			style = ui.ActiveStyle
		}
		b.WriteString(style.Render(cursor + item.label))
		b.WriteString("\n")
	}

	b.WriteString(ui.DimStyle.Render("\n↑/↓ navigate • enter select • q quit"))
	return b.String()
}

func (m model) viewInput() string {
	var b strings.Builder

	// Show previously collected fields
	for i := 0; i < len(m.inputs); i++ {
		b.WriteString(ui.DimStyle.Render(fmt.Sprintf("  %s: %s", m.inputLabels[i], m.inputs[i])))
		b.WriteString("\n")
	}

	// Current field
	label := m.inputLabels[m.inputField]
	b.WriteString(ui.PromptStyle.Render(fmt.Sprintf("Enter %s: ", label)))
	b.WriteString(m.input.Value)
	b.WriteString("█")
	if m.inputHint != "" {
		b.WriteString("\n\n")
		b.WriteString(ui.DimStyle.Render(m.inputHint))
	}
	b.WriteString(ui.DimStyle.Render("\n\nenter confirm • esc back"))
	return b.String()
}

func (m model) viewConfirm() string {
	var b strings.Builder
	var target string

	switch m.action {
	case actionRevokeAll:
		target = "ALL active sessions"
	case actionRevokeUser:
		target = fmt.Sprintf("all sessions for user %s", m.inputs[0])
	case actionRevokeSession:
		target = fmt.Sprintf("session %s", m.inputs[0])
	case actionProvisionAgent:
		target = fmt.Sprintf("agent '%s' (trust: %s)", m.inputs[0], m.inputs[1])
	case actionRevokeAgent:
		target = fmt.Sprintf("agent '%s'", m.inputs[0])
	}

	verb := "Execute"
	switch m.action {
	case actionRevokeAll, actionRevokeUser, actionRevokeSession, actionRevokeAgent:
		verb = "Revoke"
	case actionProvisionAgent:
		verb = "Provision"
	}

	b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("%s %s?", verb, target)))
	b.WriteString(ui.DimStyle.Render("\n\ny confirm • n cancel"))
	return b.String()
}

func (m model) viewResult() string {
	var b strings.Builder
	if m.resultErr != nil {
		b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("Error: %v", m.resultErr)))
	} else {
		b.WriteString(ui.SuccessStyle.Render(m.resultMessage))
	}
	b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
	return b.String()
}

func (m model) viewSessions() string {
	var b strings.Builder

	if m.dataErr != nil {
		b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("Error: %v", m.dataErr)))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	if m.sessions == nil {
		b.WriteString(ui.DimStyle.Render("Loading..."))
		return b.String()
	}

	if len(m.sessions) == 0 {
		b.WriteString(ui.DimStyle.Render("No active sessions."))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	b.WriteString(fmt.Sprintf("Active Sessions (%d)\n\n", len(m.sessions)))

	columns := []ui.Column{
		{Header: "ID", Width: 24},
		{Header: "User", Width: 8},
		{Header: "IP", Width: 16},
		{Header: "User Agent", Width: 30},
		{Header: "Expires", Width: 20},
	}

	rows := make([][]string, len(m.sessions))
	for i, s := range m.sessions {
		rows[i] = []string{
			s.ID,
			fmt.Sprintf("%d", s.UserID),
			s.IPAddress,
			s.UserAgent,
			s.ExpiresAt,
		}
	}

	b.WriteString(ui.RenderTable(columns, rows))
	b.WriteString(ui.DimStyle.Render("\nenter continue • q quit"))
	return b.String()
}

func (m model) viewEvents() string {
	var b strings.Builder

	if m.dataErr != nil {
		b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("Error: %v", m.dataErr)))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	if m.events == nil {
		b.WriteString(ui.DimStyle.Render("Loading..."))
		return b.String()
	}

	if len(m.events) == 0 {
		b.WriteString(ui.DimStyle.Render("No events found."))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	b.WriteString(fmt.Sprintf("Security Events (%d)\n\n", len(m.events)))
	b.WriteString(m.eventsTable.View())
	b.WriteString(ui.DimStyle.Render("\n↑/↓ navigate • enter detail • esc back • q quit"))
	return b.String()
}

func (m model) viewEventDetail() string {
	var b strings.Builder

	idx := m.eventsTable.Cursor()
	if idx < 0 || idx >= len(m.events) {
		b.WriteString(ui.DimStyle.Render("No event selected."))
		b.WriteString(ui.DimStyle.Render("\n\nesc back • q quit"))
		return b.String()
	}

	e := m.events[idx]

	b.WriteString(fmt.Sprintf("Event #%d\n\n", e.ID))

	userID := "-"
	if e.UserID != nil {
		userID = fmt.Sprintf("%d", *e.UserID)
	}
	labels := []string{"Type", "IP", "User", "Actor", "Time"}
	values := []string{e.Type, e.IPAddress, userID, e.ActorID, e.CreatedAt}

	for i, label := range labels {
		b.WriteString(fmt.Sprintf("  %s  %s\n", ui.HeaderStyle.Render(fmt.Sprintf("%-10s", label)), values[i]))
	}

	detail := "-"
	if e.Detail != nil {
		detail = *e.Detail
	}
	const labelWidth = 15 // "  " + 10-char label + "  "
	maxDetail := m.width - labelWidth
	if maxDetail < 20 {
		maxDetail = 80
	}
	prefix := fmt.Sprintf("  %s  ", ui.HeaderStyle.Render(fmt.Sprintf("%-10s", "Detail")))
	pad := strings.Repeat(" ", labelWidth)
	for i := 0; i < len(detail); i += maxDetail {
		end := min(i+maxDetail, len(detail))
		if i == 0 {
			b.WriteString(prefix)
		} else {
			b.WriteString(pad)
		}
		b.WriteString(detail[i:end])
		b.WriteString("\n")
	}

	b.WriteString(ui.DimStyle.Render("\nesc back • q quit"))
	return b.String()
}

func (m model) viewEventStats() string {
	var b strings.Builder

	if m.dataErr != nil {
		b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("Error: %v", m.dataErr)))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	if m.eventStats == nil {
		b.WriteString(ui.DimStyle.Render("Loading..."))
		return b.String()
	}

	if len(m.eventStats) == 0 {
		b.WriteString(ui.DimStyle.Render("No events in time window."))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	b.WriteString(fmt.Sprintf("Event Stats (since %s)\n\n", m.eventSince))

	// Sort keys for stable output
	keys := make([]string, 0, len(m.eventStats))
	for k := range m.eventStats {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	columns := []ui.Column{
		{Header: "Event Type", Width: 30},
		{Header: "Count", Width: 8},
	}

	rows := make([][]string, len(keys))
	for i, k := range keys {
		rows[i] = []string{k, fmt.Sprintf("%d", m.eventStats[k])}
	}

	b.WriteString(ui.RenderTable(columns, rows))
	b.WriteString(ui.DimStyle.Render("\nenter continue • q quit"))
	return b.String()
}

func (m model) viewAgents() string {
	var b strings.Builder

	if m.dataErr != nil {
		b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("Error: %v", m.dataErr)))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	if m.agents == nil {
		b.WriteString(ui.DimStyle.Render("Loading..."))
		return b.String()
	}

	if len(m.agents) == 0 {
		b.WriteString(ui.DimStyle.Render("No active agents."))
		b.WriteString(ui.DimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	b.WriteString(fmt.Sprintf("Active Agents (%d)\n\n", len(m.agents)))

	columns := []ui.Column{
		{Header: "Name", Width: 20},
		{Header: "Trust", Width: 8},
		{Header: "Description", Width: 30},
		{Header: "Created", Width: 20},
	}

	rows := make([][]string, len(m.agents))
	for i, a := range m.agents {
		desc := "-"
		if a.Description != nil {
			desc = *a.Description
		}
		rows[i] = []string{a.Name, a.TrustLevel, desc, a.CreatedAt}
	}

	b.WriteString(ui.RenderTable(columns, rows))
	b.WriteString(ui.DimStyle.Render("\nenter continue • q quit"))
	return b.String()
}

func (m model) viewTailEvents() string {
	var b strings.Builder

	if m.tailErr != nil {
		b.WriteString(ui.ErrorStyle.Render(fmt.Sprintf("Error: %v", m.tailErr)))
		b.WriteString(ui.DimStyle.Render("\n\nesc back • q quit"))
		return b.String()
	}

	if m.tailConn == nil {
		if m.tailChallenge != nil && m.tailChallenge.Required {
			b.WriteString(ui.DimStyle.Render(
				fmt.Sprintf("Solved PoW challenge (difficulty %d), connecting...", m.tailChallenge.Difficulty)))
		} else if m.tailChallenge != nil {
			b.WriteString(ui.DimStyle.Render("Connecting..."))
		} else {
			b.WriteString(ui.DimStyle.Render("Probing for PoW challenge..."))
		}
		return b.String()
	}

	header := "Tailing events (live)"
	if len(m.tailFilter) > 0 {
		header += fmt.Sprintf("  [%s]", strings.Join(m.tailFilter, ", "))
	}
	b.WriteString(ui.HeaderStyle.Render(header))
	if len(m.tailEvents) > 0 {
		b.WriteString(ui.DimStyle.Render(fmt.Sprintf("  %d event(s)", len(m.tailEvents))))
	}
	b.WriteString("\n\n")

	if len(m.tailEvents) == 0 {
		b.WriteString(ui.DimStyle.Render("Waiting for events..."))
	} else {
		// Show last 20 events that fit on screen
		start := 0
		if len(m.tailEvents) > 20 {
			start = len(m.tailEvents) - 20
		}
		for _, e := range m.tailEvents[start:] {
			// Extract just the time portion from ISO timestamp
			ts := e.CreatedAt
			if len(ts) >= 19 {
				ts = ts[11:19]
			}
			userID := "-"
			if e.UserID != nil {
				userID = fmt.Sprintf("user:%d", *e.UserID)
			}
			line := fmt.Sprintf("  %s  %-24s  %-16s  %-10s  %s",
				ts, e.Type, e.IPAddress, userID, e.ActorID)
			if m.width > 0 && len(line) > m.width {
				line = line[:m.width]
			}
			b.WriteString(line)
			b.WriteString("\n")
		}
	}

	b.WriteString(ui.DimStyle.Render("\nesc stop • q quit"))
	return b.String()
}

func isSafeTarget(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	env := os.Getenv("ENVIRONMENT")
	return env != "" && env != "production"
}

func printUsage() {
	heading := ui.TitleStyle.Render
	label := ui.PromptStyle.Render
	dim := ui.DimStyle.Render

	fmt.Println(heading("plctl") + dim(" - Private Landing control"))
	fmt.Println()
	fmt.Println(heading("Usage:"))
	fmt.Println("  plctl [flags]")
	fmt.Println()
	fmt.Println("  Launches an interactive TUI for managing Private Landing operations.")
	fmt.Println()
	fmt.Println(heading("Flags:"))
	fmt.Println("  " + label("-h, --help") + "    Show this help message")
	fmt.Println()
	fmt.Println(heading("Environment:"))
	fmt.Println("  " + label("PLCTL_API_URL") + "              API base URL (required)")
	fmt.Println("  " + label("PLCTL_API_KEY") + "              Agent API key for Bearer auth (required)")
	fmt.Println("  " + label("PLCTL_PROVISIONING_SECRET") + "  Infrastructure secret for agent provisioning (optional)")
	fmt.Println("  " + label("ENVIRONMENT") + "                Set to any non-production value to suppress safety prompt")
	fmt.Println()
	fmt.Println(heading("Commands (interactive):"))
	fmt.Println()
	fmt.Println("  " + label("Sessions"))
	fmt.Println("    View active sessions          " + dim("List all active sessions"))
	fmt.Println("    View sessions for user        " + dim("List sessions filtered by user ID"))
	fmt.Println("    Revoke all sessions           " + dim("Expire every active session"))
	fmt.Println("    Revoke sessions for user      " + dim("Expire all sessions for a user"))
	fmt.Println("    Revoke specific session       " + dim("Expire a single session by ID"))
	fmt.Println()
	fmt.Println("  " + label("Events"))
	fmt.Println("    View recent events            " + dim("List security events (last 24h)"))
	fmt.Println("    View events for user          " + dim("List events filtered by user ID"))
	fmt.Println("    View event stats              " + dim("Aggregate event counts by type"))
	fmt.Println("    Tail events (live)            " + dim("Stream security events in real time (supports filters: login.*, session.revoke)"))
	fmt.Println()
	fmt.Println("  " + label("Agents"))
	fmt.Println("    List agents                   " + dim("Show active agent credentials"))
	fmt.Println("    Provision agent               " + dim("Create a new agent credential"))
	fmt.Println("    Revoke agent                  " + dim("Revoke an agent credential"))
}

func main() {
	for _, arg := range os.Args[1:] {
		if arg == "-h" || arg == "--help" {
			printUsage()
			os.Exit(0)
		}
	}

	apiURL := os.Getenv("PLCTL_API_URL")
	apiKey := os.Getenv("PLCTL_API_KEY")
	provSecret := os.Getenv("PLCTL_PROVISIONING_SECRET")

	if apiURL == "" || apiKey == "" {
		fmt.Fprintln(os.Stderr, "PLCTL_API_URL and PLCTL_API_KEY environment variables are required")
		fmt.Fprintln(os.Stderr, "Run 'plctl --help' for usage information")
		os.Exit(1)
	}

	if !isSafeTarget(apiURL) {
		fmt.Fprintln(os.Stderr, ui.ErrorStyle.Render("WARNING: Target does not appear to be a non-production environment."))
		fmt.Fprintln(os.Stderr, ui.ErrorStyle.Render("Set ENVIRONMENT to a non-production value (e.g. 'development', 'staging') to suppress."))
		fmt.Fprint(os.Stderr, ui.PromptStyle.Render("Continue? (y/N) "))

		var answer string
		fmt.Scanln(&answer)
		if answer != "y" && answer != "Y" {
			os.Exit(0)
		}
	}

	client := api.NewClient(apiURL, apiKey, provSecret)

	p := tea.NewProgram(initialModel(client))
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
