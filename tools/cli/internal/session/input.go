package session

// InputBuffer manages text input state for the TUI.
type InputBuffer struct {
	Value string
}

// Append adds runes to the buffer.
func (b *InputBuffer) Append(runes []rune) {
	if len(runes) > 0 {
		b.Value += string(runes)
	}
}

// Backspace removes the last character.
func (b *InputBuffer) Backspace() {
	if len(b.Value) > 0 {
		b.Value = b.Value[:len(b.Value)-1]
	}
}

// Clear resets the buffer.
func (b *InputBuffer) Clear() {
	b.Value = ""
}
