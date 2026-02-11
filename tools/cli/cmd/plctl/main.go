package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/private-landing/cli/internal/db"
	"github.com/private-landing/cli/internal/session"

	"context"
	"database/sql"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// styles
var (
	titleStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("5"))
	activeStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	dimStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	errorStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	successStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	promptStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
)

// states
type state int

const (
	stateMenu state = iota
	stateInput
	stateConfirm
	stateResult
	stateSessions
)

type action int

const (
	actionInvalidate action = iota
	actionViewSessions
)

type menuItem struct {
	label  string
	scope  session.Scope
	action action
}

var menuItems = []menuItem{
	{"View active sessions", session.ScopeAll, actionViewSessions},
	{"Invalidate all sessions", session.ScopeAll, actionInvalidate},
	{"Invalidate sessions for a user (account ID)", session.ScopeUser, actionInvalidate},
	{"Invalidate a specific session (session ID)", session.ScopeSession, actionInvalidate},
}

// messages
type resultMsg session.InvalidateResult
type sessionsMsg struct {
	sessions []session.ActiveSession
	err      error
}

type model struct {
	db       *sql.DB
	state    state
	cursor   int
	scope    session.Scope
	input    string
	result   session.InvalidateResult
	sessions []session.ActiveSession
	sessErr  error
	quitting bool
}

func initialModel(database *sql.DB) model {
	return model{db: database, state: stateMenu}
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKey(msg)
	case resultMsg:
		m.result = session.InvalidateResult(msg)
		m.state = stateResult
		return m, nil
	case sessionsMsg:
		m.sessions = msg.sessions
		m.sessErr = msg.err
		m.state = stateSessions
		return m, nil
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	// global quit
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
	case stateResult:
		return m.handleResult(key)
	case stateSessions:
		return m.handleResult(key)
	}
	return m, nil
}

func (m model) handleMenu(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(menuItems)-1 {
			m.cursor++
		}
	case "enter":
		item := menuItems[m.cursor]
		m.scope = item.scope
		if item.action == actionViewSessions {
			return m, m.fetchSessions()
		}
		if m.scope == session.ScopeAll {
			m.state = stateConfirm
		} else {
			m.state = stateInput
			m.input = ""
		}
	case "q":
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

func (m model) handleInput(key string, msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key {
	case "enter":
		if strings.TrimSpace(m.input) == "" {
			return m, nil
		}
		m.state = stateConfirm
	case "backspace":
		if len(m.input) > 0 {
			m.input = m.input[:len(m.input)-1]
		}
	case "esc":
		m.state = stateMenu
	default:
		if len(key) == 1 {
			m.input += key
		}
	}
	return m, nil
}

func (m model) handleConfirm(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "y", "Y":
		return m, m.executeInvalidation()
	case "n", "N", "esc":
		m.state = stateMenu
		m.input = ""
	}
	return m, nil
}

func (m model) handleResult(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "enter", "esc":
		m.state = stateMenu
		m.input = ""
	case "q":
		m.quitting = true
		return m, tea.Quit
	}
	return m, nil
}

func (m model) fetchSessions() tea.Cmd {
	return func() tea.Msg {
		s, err := session.ListActive(context.Background(), m.db)
		return sessionsMsg{sessions: s, err: err}
	}
}

func (m model) executeInvalidation() tea.Cmd {
	return func() tea.Msg {
		r := session.Invalidate(context.Background(), m.db, m.scope, strings.TrimSpace(m.input))
		return resultMsg(r)
	}
}

func (m model) View() string {
	if m.quitting {
		return ""
	}

	var b strings.Builder
	b.WriteString(titleStyle.Render("Private Landing CLI"))
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
	}

	b.WriteString("\n")
	return b.String()
}

func (m model) viewMenu() string {
	var b strings.Builder
	b.WriteString("Session Invalidation\n\n")

	for i, item := range menuItems {
		cursor := "  "
		style := dimStyle
		if i == m.cursor {
			cursor = "> "
			style = activeStyle
		}
		b.WriteString(style.Render(cursor + item.label))
		b.WriteString("\n")
	}

	b.WriteString(dimStyle.Render("\n↑/↓ navigate • enter select • q quit"))
	return b.String()
}

func (m model) viewInput() string {
	var b strings.Builder
	label := "Account ID"
	if m.scope == session.ScopeSession {
		label = "Session ID"
	}
	b.WriteString(promptStyle.Render(fmt.Sprintf("Enter %s: ", label)))
	b.WriteString(m.input)
	b.WriteString("█")
	b.WriteString(dimStyle.Render("\n\nenter confirm • esc back"))
	return b.String()
}

func (m model) viewConfirm() string {
	var b strings.Builder
	var target string

	switch m.scope {
	case session.ScopeAll:
		target = "ALL active sessions"
	case session.ScopeUser:
		target = fmt.Sprintf("all sessions for account %s", m.input)
	case session.ScopeSession:
		target = fmt.Sprintf("session %s", m.input)
	}

	b.WriteString(errorStyle.Render(fmt.Sprintf("Invalidate %s?", target)))
	b.WriteString(dimStyle.Render("\n\ny confirm • n cancel"))
	return b.String()
}

func (m model) viewResult() string {
	var b strings.Builder
	if m.result.Err != nil {
		b.WriteString(errorStyle.Render(fmt.Sprintf("Error: %v", m.result.Err)))
	} else {
		b.WriteString(successStyle.Render(fmt.Sprintf("Done. %d session(s) invalidated.", m.result.RowsAffected)))
	}
	b.WriteString(dimStyle.Render("\n\nenter continue • q quit"))
	return b.String()
}

func (m model) viewSessions() string {
	var b strings.Builder

	if m.sessErr != nil {
		b.WriteString(errorStyle.Render(fmt.Sprintf("Error: %v", m.sessErr)))
		b.WriteString(dimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	if len(m.sessions) == 0 {
		b.WriteString(dimStyle.Render("No active sessions."))
		b.WriteString(dimStyle.Render("\n\nenter continue • q quit"))
		return b.String()
	}

	b.WriteString(fmt.Sprintf("Active Sessions (%d)\n", len(m.sessions)))

	for i, s := range m.sessions {
		b.WriteString("\n")
		b.WriteString(activeStyle.Render(fmt.Sprintf("  Session %d", i+1)))
		b.WriteString("\n")
		b.WriteString(fmt.Sprintf("  %s  %s\n", promptStyle.Render("ID:"), s.ID))
		b.WriteString(fmt.Sprintf("  %s  %s\n", promptStyle.Render("User:"), s.UserID))
		b.WriteString(fmt.Sprintf("  %s  %s\n", promptStyle.Render("Agent:"), s.UserAgent))
		b.WriteString(fmt.Sprintf("  %s  %s\n", promptStyle.Render("IP:"), s.IPAddress))
		b.WriteString(fmt.Sprintf("  %s  %s\n", promptStyle.Render("Expires:"), s.ExpiresAt))
		b.WriteString(fmt.Sprintf("  %s  %s\n", promptStyle.Render("Created:"), s.CreatedAt))
	}

	b.WriteString(dimStyle.Render("\nenter continue • q quit"))
	return b.String()
}

func printUsage() {
	heading := titleStyle.Render
	label := promptStyle.Render
	dim := dimStyle.Render

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
	fmt.Println("  " + label("AUTH_DB_URL") + "    Turso/libSQL database URL (required)")
	fmt.Println("  " + label("AUTH_DB_TOKEN") + "  Turso/libSQL auth token (required)")
	fmt.Println()
	fmt.Println(heading("Commands (interactive):"))
	fmt.Println("  Invalidate all sessions          " + dim("Expire every active session"))
	fmt.Println("  Invalidate sessions for a user   " + dim("Expire all sessions for an account ID"))
	fmt.Println("  Invalidate a specific session    " + dim("Expire a single session by session ID"))
}

func main() {
	for _, arg := range os.Args[1:] {
		if arg == "-h" || arg == "--help" {
			printUsage()
			os.Exit(0)
		}
	}

	url := os.Getenv("AUTH_DB_URL")
	token := os.Getenv("AUTH_DB_TOKEN")

	if url == "" || token == "" {
		fmt.Fprintln(os.Stderr, "AUTH_DB_URL and AUTH_DB_TOKEN environment variables are required")
		fmt.Fprintln(os.Stderr, "Run 'plctl --help' for usage information")
		os.Exit(1)
	}

	if !strings.Contains(url, "test-db") && !strings.Contains(url, "dev-db") {
		fmt.Fprintln(os.Stderr, errorStyle.Render("WARNING: AUTH_DB_URL does not contain 'test-db' or 'dev-db'."))
		fmt.Fprintln(os.Stderr, errorStyle.Render("You may be targeting a production database."))
		fmt.Fprint(os.Stderr, promptStyle.Render("Continue? (y/N) "))

		var answer string
		fmt.Scanln(&answer)
		if answer != "y" && answer != "Y" {
			os.Exit(0)
		}
	}

	database, err := db.Open(url, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to connect to database: %v\n", err)
		os.Exit(1)
	}
	defer database.Close()

	p := tea.NewProgram(initialModel(database))
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
