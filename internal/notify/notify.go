package notify

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	slackapi "github.com/slack-go/slack"
)

var (
	client    *slackapi.Client
	channelID string
	hostname  string

	// Frontend down alerting — debounced so we don't spam Slack.
	frontendDown     bool
	frontendDownOnce sync.Once
	frontendMu       sync.Mutex
	frontendCooldown = 5 * time.Minute
)

func init() {
	token := os.Getenv("SLACK_BOT_TOKEN")
	channelID = os.Getenv("SLACK_NOTIFY_CHANNEL")
	if token != "" && channelID != "" {
		client = slackapi.New(token)
	}
	hostname, _ = os.Hostname()
}

func post(text string) {
	if client == nil || channelID == "" {
		log.Printf("[notify] (no Slack channel configured) %s", text)
		return
	}
	_, _, err := client.PostMessage(channelID,
		slackapi.MsgOptionText(text, false),
		slackapi.MsgOptionUsername("Winston Ops"),
	)
	if err != nil {
		log.Printf("[notify] failed to post to Slack: %v", err)
	}
}

// JobsRun posts the summary of a completed jobs scrape.
//
// The router posts this itself rather than letting the scheduled agent poll for
// completion: the agent exits as soon as it has kicked the scrape off, so any
// summary it promised never arrives. The router is the only thing still alive
// when the run actually finishes.
func JobsRun(text string) {
	post(text)
}

// restartReasonFile is a breadcrumb left by ModelChange so Startup can report why it restarted.
var restartReasonFile = filepath.Join(os.TempDir(), "winston-restart-reason")

// Startup sends a notification that the router has started.
// If a restart reason breadcrumb exists, it includes the reason and cleans up.
func Startup() {
	if data, err := os.ReadFile(restartReasonFile); err == nil {
		os.Remove(restartReasonFile)
		reason := strings.TrimSpace(string(data))
		post(fmt.Sprintf(":white_check_mark: Router restarted on `%s` — %s", hostname, reason))
		return
	}
	post(fmt.Sprintf(":white_check_mark: Router started on `%s`", hostname))
}

// Shutdown sends a notification that the router is shutting down.
func Shutdown(reason string) {
	if reason == "" {
		reason = "received shutdown signal"
	}
	post(fmt.Sprintf(":octagonal_sign: Router shutting down on `%s` — %s", hostname, reason))
}

// FrontendDown should be called when a proxy request to the frontend fails.
// It sends at most one Slack notification per cooldown period.
func FrontendDown(err error) {
	frontendMu.Lock()
	defer frontendMu.Unlock()

	if frontendDown {
		return
	}
	frontendDown = true

	post(fmt.Sprintf(":warning: Frontend (localhost:3000) is unreachable on `%s` — %v", hostname, err))

	// Reset after cooldown so we can alert again if it's still down.
	go func() {
		time.Sleep(frontendCooldown)
		frontendMu.Lock()
		frontendDown = false
		frontendMu.Unlock()
	}()
}

// FrontendRecovered should be called when the frontend responds successfully
// after being marked down.
func FrontendRecovered() {
	frontendMu.Lock()
	wasDown := frontendDown
	frontendDown = false
	frontendMu.Unlock()

	if wasDown {
		post(fmt.Sprintf(":white_check_mark: Frontend recovered on `%s`", hostname))
	}
}

// ModelChange sends a notification that an agent's model was changed and services are restarting.
// Writes a breadcrumb so the next Startup() call can confirm the restart completed.
func ModelChange(agent, oldModel, newModel string) {
	reason := fmt.Sprintf("agent `%s` model changed: *%s* → *%s*", agent, oldModel, newModel)
	// Write breadcrumb for post-restart notification
	_ = os.WriteFile(restartReasonFile, []byte(reason), 0644)

	post(fmt.Sprintf(":arrows_counterclockwise: %s on `%s` — restarting services", reason, hostname))
}

// PromptChange sends a notification that an agent's system prompt was edited.
func PromptChange(agent string) {
	reason := fmt.Sprintf("agent `%s` system prompt updated", agent)
	_ = os.WriteFile(restartReasonFile, []byte(reason), 0644)
	post(fmt.Sprintf(":pencil2: %s on `%s` — restarting services", reason, hostname))
}

// WrapFrontendProxy wraps an httputil.ReverseProxy to detect frontend failures
// and send debounced Slack notifications.
func WrapFrontendProxy(proxy http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &responseInterceptor{ResponseWriter: w}
		proxy.ServeHTTP(rec, r)

		if rec.statusCode == http.StatusBadGateway || rec.statusCode == http.StatusServiceUnavailable {
			FrontendDown(fmt.Errorf("proxy returned %d for %s", rec.statusCode, r.URL.Path))
		} else if rec.statusCode > 0 && rec.statusCode < 500 {
			FrontendRecovered()
		}
	})
}

// responseInterceptor captures the status code written by the reverse proxy.
type responseInterceptor struct {
	http.ResponseWriter
	statusCode int
}

func (ri *responseInterceptor) WriteHeader(code int) {
	ri.statusCode = code
	ri.ResponseWriter.WriteHeader(code)
}

func (ri *responseInterceptor) Write(b []byte) (int, error) {
	if ri.statusCode == 0 {
		ri.statusCode = http.StatusOK
	}
	return ri.ResponseWriter.Write(b)
}
