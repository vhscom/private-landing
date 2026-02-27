package ui

import "github.com/charmbracelet/lipgloss"

var (
	TitleStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("5"))
	ActiveStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	DimStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	ErrorStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	SuccessStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	PromptStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	HeaderStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("5"))
)
