package session

import "testing"

func TestAppendSingleChar(t *testing.T) {
	b := &InputBuffer{}
	b.Append([]rune{'a'})
	if b.Value != "a" {
		t.Fatalf("expected 'a', got %q", b.Value)
	}
}

func TestAppendMultipleRunes(t *testing.T) {
	b := &InputBuffer{}
	b.Append([]rune("test-session-123"))
	if b.Value != "test-session-123" {
		t.Fatalf("expected 'test-session-123', got %q", b.Value)
	}
}

func TestAppendAccumulates(t *testing.T) {
	b := &InputBuffer{}
	b.Append([]rune{'a'})
	b.Append([]rune{'b'})
	b.Append([]rune{'c'})
	if b.Value != "abc" {
		t.Fatalf("expected 'abc', got %q", b.Value)
	}
}

func TestAppendEmptyRunes(t *testing.T) {
	b := &InputBuffer{}
	b.Value = "hello"
	b.Append([]rune{})
	if b.Value != "hello" {
		t.Fatalf("expected 'hello', got %q", b.Value)
	}
}

func TestBackspace(t *testing.T) {
	b := &InputBuffer{Value: "abc"}
	b.Backspace()
	if b.Value != "ab" {
		t.Fatalf("expected 'ab', got %q", b.Value)
	}
}

func TestBackspaceEmpty(t *testing.T) {
	b := &InputBuffer{}
	b.Backspace()
	if b.Value != "" {
		t.Fatalf("expected empty, got %q", b.Value)
	}
}

func TestClear(t *testing.T) {
	b := &InputBuffer{Value: "something"}
	b.Clear()
	if b.Value != "" {
		t.Fatalf("expected empty, got %q", b.Value)
	}
}
