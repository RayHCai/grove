package main

import "testing"

// The service's own variable outranks the platform's PORT, and the literal answers when neither is set.
func TestResolvePortTriesEachVariableInOrder(t *testing.T) {
	t.Setenv("GROVE_TEST_OWN_PORT", "")
	t.Setenv("GROVE_TEST_PORT", "8080")
	if got := resolvePort("", "GROVE_TEST_OWN_PORT, GROVE_TEST_PORT", "4001"); got != "8080" {
		t.Errorf("platform port: got %q, want 8080", got)
	}

	t.Setenv("GROVE_TEST_OWN_PORT", "4101")
	if got := resolvePort("", "GROVE_TEST_OWN_PORT,GROVE_TEST_PORT", "4001"); got != "4101" {
		t.Errorf("own port: got %q, want 4101", got)
	}

	if got := resolvePort("", "", "4001"); got != "4001" {
		t.Errorf("nothing set: got %q, want the literal", got)
	}
}
