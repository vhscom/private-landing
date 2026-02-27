package ui

import (
	"fmt"
	"strings"
)

// Column defines a table column with a header label and width.
type Column struct {
	Header string
	Width  int
}

// RenderTable renders rows as a fixed-width table with column headers.
func RenderTable(columns []Column, rows [][]string) string {
	var b strings.Builder

	// Header row
	for i, col := range columns {
		if i > 0 {
			b.WriteString("  ")
		}
		b.WriteString(HeaderStyle.Render(pad(col.Header, col.Width)))
	}
	b.WriteString("\n")

	// Separator
	for i, col := range columns {
		if i > 0 {
			b.WriteString("  ")
		}
		b.WriteString(DimStyle.Render(strings.Repeat("─", col.Width)))
	}
	b.WriteString("\n")

	// Data rows
	for _, row := range rows {
		for i, col := range columns {
			if i > 0 {
				b.WriteString("  ")
			}
			val := ""
			if i < len(row) {
				val = row[i]
			}
			b.WriteString(pad(val, col.Width))
		}
		b.WriteString("\n")
	}

	return b.String()
}

func pad(s string, width int) string {
	if len(s) >= width {
		return s[:width]
	}
	return fmt.Sprintf("%-*s", width, s)
}
