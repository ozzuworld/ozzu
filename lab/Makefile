# OzzuLab v0 — operator commands
# Run on dev-01 (lab host) from /home/gcp/ozzu/lab/

COMPOSE := docker compose
ENG_ID := OZZULAB-2026-001

.PHONY: help up down reset status logs check-flags seed-engagement nuke

help:
	@echo "OzzuLab v0 — pentest lab"
	@echo ""
	@echo "  make up                 build + start the lab (~30s)"
	@echo "  make down               stop containers, keep network"
	@echo "  make reset              full teardown + rebuild (clean state)"
	@echo "  make status             show container + network state"
	@echo "  make logs               tail container logs"
	@echo "  make seed-engagement    create engagement $(ENG_ID) on bridge"
	@echo "  make check-flags        scan queue output for flag captures"
	@echo "  make nuke               down + delete images + delete network"
	@echo ""
	@echo "Target IPs (after 'make up'):"
	@echo "  edge-gw       10.10.20.10  (ssh:22, http:80)"
	@echo "  internal-web  10.10.20.20  (http:80)"
	@echo "  db            10.10.20.30  (mysql:3306)"

up:
	$(COMPOSE) up -d --build
	@echo ""
	@echo "Waiting for services to settle..."
	@sleep 5
	@$(MAKE) status

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build --force-recreate
	@sleep 5
	@$(MAKE) status

status:
	@echo "=== Containers ==="
	@$(COMPOSE) ps
	@echo ""
	@echo "=== Network ==="
	@docker network inspect lab_ozzulab-net --format='{{range .Containers}}{{.Name}}: {{.IPv4Address}}{{println}}{{end}}' 2>/dev/null || echo "(network not found)"

logs:
	$(COMPOSE) logs -f --tail=50

seed-engagement:
	@bash eval/seed-engagement.sh

check-flags:
	@bash eval/check-flags.sh $(ENG_ID)

nuke:
	$(COMPOSE) down -v --rmi local
	@docker network rm lab_ozzulab-net 2>/dev/null || true
