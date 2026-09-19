package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/RayHCai/grove/apps/grove/instance-manager/internal/supervisor"
	"github.com/RayHCai/grove/libs/go-grove/contract"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

// A second game sharing the box, whose world a redeploy of the first has no business ending.
const otherGame = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

// A game no world here belongs to, which is what a box a rollout does not reach looks like.
const unheldGame = "9c8b7a65-4321-4fed-8cba-0987654321fe"

func redeployPath(gameID string) string {
	return "/v1/games/" + gameID + "/redeploy"
}

// startBodyFor names one game for every instance it builds, so a second game is spelled out here.
func startOneOfOtherGame(t *testing.T, handler http.Handler, i int) supervisor.View {
	t.Helper()

	res := call(handler, http.MethodPost, "/v1/instances", fmt.Sprintf(`{
		"instanceId": "%08d-2222-4222-8222-222222222222",
		"gameId": "%s",
		"sessionId": "%08d-1111-4111-8111-111111111111",
		"revision": %d,
		"bundles": %s
	}`, i, otherGame, i, testRevision, bundlesJSON()))
	if res.Code != http.StatusCreated {
		t.Fatalf("start %d of another game: got %d, body %s", i, res.Code, res.Body.String())
	}

	var view supervisor.View
	if err := json.Unmarshal(res.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode a started instance: %v", err)
	}
	return view
}

// Two worlds of one game beside one of another, which is the only scene that tells a redeploy
// finding by game apart from one marking the whole box.
func boxOfTwoGames(t *testing.T) (http.Handler, []supervisor.View, supervisor.View) {
	t.Helper()

	handler := newTestService(3)
	ours := []supervisor.View{startOne(t, handler, 0), startOne(t, handler, 1)}
	return handler, ours, startOneOfOtherGame(t, handler, 2)
}

func deployment(t *testing.T, res *httptest.ResponseRecorder) contract.HostDeployment {
	t.Helper()

	var row contract.HostDeployment
	if err := json.Unmarshal(res.Body.Bytes(), &row); err != nil {
		t.Fatalf("decode the row: %v (%s)", err, res.Body.String())
	}
	return row
}

// What this box says each of its worlds is doing, read back through the list rather than from the
// registry, because the list is the only account of it anything upstream has.
func statesOf(t *testing.T, handler http.Handler) map[string]contract.InstanceState {
	t.Helper()

	var page struct {
		Instances []supervisor.View `json:"instances"`
	}
	res := call(handler, http.MethodGet, "/v1/instances", "")
	if err := json.Unmarshal(res.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode the list: %v (%s)", err, res.Body.String())
	}

	states := make(map[string]contract.InstanceState, len(page.Instances))
	for _, view := range page.Instances {
		states[view.InstanceID] = view.State
	}
	return states
}

func TestARedeployIsBehindTheFleetBearer(t *testing.T) {
	handler, ours, _ := boxOfTwoGames(t)

	cases := []struct {
		name   string
		header string
	}{
		{name: "no header"},
		{name: "another fleet's secret", header: "Bearer " + strings.Repeat("x", len(fleetSecret))},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, redeployPath(ours[0].GameID), nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("got %d, want 401 (%s)", w.Code, w.Body.String())
			}
			if body := failure(t, w); body.Code != httpx.CodeUnauthorized {
				t.Errorf("code: got %q, want unauthorized", body.Code)
			}
			// The refusal has to land before the mark: a stranger who can end a match on the way to
			// a 401 has ended it either way.
			if state := statesOf(t, handler)[ours[0].InstanceID]; state != contract.InstanceStarting {
				t.Errorf("%s: got %q, want starting", ours[0].InstanceID, state)
			}
		})
	}
}

func TestARedeployOfSomethingThatIsNotAUUIDIsRefused(t *testing.T) {
	handler := newTestService(2)

	cases := []struct {
		name string
		game string
	}{
		{name: "a name rather than an id", game: "grove"},
		{name: "a uuid with its dashes gone", game: "6f1e5a3c0b2d4c8e9a712f3b4c5d6e70"},
		{name: "a uuid that is not hex", game: "6f1e5a3c-0b2d-4c8e-9a71-2f3b4c5d6e7g"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := call(handler, http.MethodPost, redeployPath(tc.game), "")

			if res.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400 (%s)", res.Code, res.Body.String())
			}
			if body := failure(t, res); body.Code != httpx.CodeInvalidRequest {
				t.Errorf("code: got %q, want invalid_request", body.Code)
			}
		})
	}
}

func TestABoxHoldingNoWorldOfTheGameSkips(t *testing.T) {
	cases := []struct {
		name  string
		holds bool
	}{
		{name: "an empty box"},
		{name: "a box holding only another game's world", holds: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := newTestService(2)
			if tc.holds {
				startOneOfOtherGame(t, handler, 0)
			}

			res := call(handler, http.MethodPost, redeployPath(unheldGame), "")
			if res.Code != http.StatusOK {
				t.Fatalf("got %d, want 200 (%s)", res.Code, res.Body.String())
			}

			row := deployment(t, res)
			if row.Status != contract.DeploySkipped {
				t.Errorf("status: got %q, want skipped", row.Status)
			}
			if len(row.InstanceIDs) != 0 {
				t.Errorf("instanceIds: got %v, want none", row.InstanceIDs)
			}
			// The fleet reads this list with a z.array, which a null fails where an empty list passes.
			if !strings.Contains(res.Body.String(), `"instanceIds":[]`) {
				t.Errorf("body: got %s, want an empty instanceIds array", res.Body.String())
			}
		})
	}
}

func TestARedeployNamesOnlyTheWorldsOfThatGame(t *testing.T) {
	handler, ours, stranger := boxOfTwoGames(t)

	res := call(handler, http.MethodPost, redeployPath(ours[0].GameID), "")
	if res.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", res.Code, res.Body.String())
	}

	row := deployment(t, res)
	if row.Status != contract.DeployDraining {
		t.Fatalf("status: got %q, want draining", row.Status)
	}

	want := []string{ours[0].InstanceID, ours[1].InstanceID}
	slices.Sort(want)
	if !slices.Equal(row.InstanceIDs, want) {
		t.Errorf("instanceIds: got %v, want %v", row.InstanceIDs, want)
	}
	if slices.Contains(row.InstanceIDs, stranger.InstanceID) {
		t.Errorf("instanceIds: got %v, which names another game's world %q",
			row.InstanceIDs, stranger.InstanceID)
	}
}

// The fan-out keys its report by this, so a row naming nobody is a row it cannot place.
func TestEveryRowNamesTheBoxItCameFrom(t *testing.T) {
	handler, ours, _ := boxOfTwoGames(t)

	cases := []struct {
		name string
		game string
	}{
		{name: "worlds it marked", game: ours[0].GameID},
		{name: "no world to mark", game: unheldGame},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row := deployment(t, call(handler, http.MethodPost, redeployPath(tc.game), ""))

			if row.HostID != hostID {
				t.Errorf("hostId: got %q, want %q", row.HostID, hostID)
			}
		})
	}
}

// The mark is what stops the fleet router sending a new joiner to a world that is ending.
func TestTheMarkedWorldsReportDraining(t *testing.T) {
	handler, ours, stranger := boxOfTwoGames(t)

	call(handler, http.MethodPost, redeployPath(ours[0].GameID), "")

	states := statesOf(t, handler)
	for _, view := range ours {
		if states[view.InstanceID] != contract.InstanceDraining {
			t.Errorf("%s: got %q, want draining", view.InstanceID, states[view.InstanceID])
		}
	}
	if states[stranger.InstanceID] != contract.InstanceStarting {
		t.Errorf("the other game's world %s: got %q, want starting",
			stranger.InstanceID, states[stranger.InstanceID])
	}
}
