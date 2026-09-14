// The composition root: the environment, the registry, the policy that ranks boxes, and the listener.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/RayHCai/grove/apps/grove/server-manager/internal/api"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/config"
	"github.com/RayHCai/grove/apps/grove/server-manager/internal/fleet"
	"github.com/RayHCai/grove/libs/go-grove/env"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

func main() {
	cfg, err := config.Load(env.New())
	if err != nil {
		// Straight to stderr, because which handler the logger takes is itself config's answer.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log := logger(cfg.Env)
	server := api.New(api.Options{
		// The map behind the mutex is the seam a datastore lands on: a second replica of this
		// service must share one registry rather than each holding half the fleet.
		Registry: fleet.NewRegistry(cfg.StaleAfter),
		Balancer: fleet.MostFree{},
		Ingress:  fleet.DirectIngress{Scheme: cfg.IngressScheme},
		Secret:   cfg.FleetSecret,
		Log:      log,
	})

	if err := httpx.Serve(context.Background(), cfg.Addr, server.Handler(), log); err != nil {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}

func logger(groveEnv string) *slog.Logger {
	if groveEnv == "production" {
		return slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
}
