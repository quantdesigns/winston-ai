package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/codephilip/winston-ai/internal/agents"
	"github.com/codephilip/winston-ai/internal/notify"
	"github.com/codephilip/winston-ai/internal/router"
	"github.com/codephilip/winston-ai/internal/slack"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "49710"
	}
	// Bind to loopback only — the router is reached locally by the Next.js
	// frontend (and tailscale serve in front of it). It must never be exposed
	// to the LAN or the internet directly.
	bind := os.Getenv("BIND_ADDR")
	if bind == "" {
		bind = "127.0.0.1"
	}

	manager := agents.NewManager()
	manager.SlackPost = slack.PostMessage
	manager.SlackPostTS = slack.PostMessageTS
	manager.SlackThreadReply = slack.PostThreadReply
	manager.SlackOwnerID = os.Getenv("SLACK_OWNER_ID")

	r := router.NewWithManager(manager)

	srv := &http.Server{
		Addr:    bind + ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("Winston router listening on %s:%s", bind, port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			notify.Shutdown("server error: " + err.Error())
			log.Fatalf("server error: %v", err)
		}
	}()

	// Slack runs in Socket Mode — outbound websocket only, no inbound webhook.
	smCtx, smCancel := context.WithCancel(context.Background())
	defer smCancel()
	go func() {
		err := slack.RunSocketMode(smCtx, manager)
		if err == slack.ErrSocketModeNotConfigured {
			log.Printf("[slack] SLACK_APP_TOKEN not set — Socket Mode disabled")
			return
		}
		if err != nil && err != context.Canceled {
			log.Printf("[slack] socket mode terminated: %v", err)
		}
	}()

	notify.Startup()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit

	log.Printf("Shutting down (signal: %v)...", sig)
	smCancel()
	notify.Shutdown(sig.String())
}
