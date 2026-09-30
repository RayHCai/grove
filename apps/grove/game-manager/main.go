// The composition root: the environment this process was configured with, the store its handlers
// ask, and the listener that drains what is in flight on the way down.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/RayHCai/grove/apps/grove/game-manager/internal/config"
	"github.com/RayHCai/grove/apps/grove/game-manager/internal/server"
	"github.com/RayHCai/grove/apps/grove/game-manager/internal/store"
	"github.com/RayHCai/grove/libs/go-grove/env"
	"github.com/RayHCai/grove/libs/go-grove/httpx"
)

func main() {
	cfg, err := config.Read(env.New())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	log := env.Logger(cfg.Env, os.Stdout)

	// Said at every boot, because nothing else about a running process shows that a restart wipes it.
	log.Warn("the store is in memory: every game's state and boards are lost when this process ends")

	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	// The store is chosen here and nowhere else, which is what makes it a seam rather than a
	// dependency every handler grew its own opinion about.
	handler := server.New(ctx, store.NewMemory(), cfg.TokenSecret, log)

	if err := httpx.Serve(ctx, cfg.Addr(), handler, log); err != nil {
		log.Error("serve", "err", err)
		stop()
		os.Exit(1)
	}
}
