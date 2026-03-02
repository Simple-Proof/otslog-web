#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
PROFILE="dev"
REGION="us-west-2"
IMAGE_NAME="otslog-web"
SSH_KEY="infra/otslog-web.pem"
COMPOSE_FILE="docker-compose.yml"
CADDYFILE="Caddyfile"
ENV_FILE=".env"

# ── Helpers ──────────────────────────────────────────────────────────────────
log() { echo -e "\033[1;34m▶ $*\033[0m"; }
die() { echo -e "\033[1;31m✗ $*\033[0m" >&2; exit 1; }

# ── Get IP from Terraform output ─────────────────────────────────────────────
get_ip() {
  terraform -chdir=infra output -raw public_ip 2>/dev/null
}

# ── Step 0: Generate SSH key if missing ──────────────────────────────────────
if [[ ! -f "$SSH_KEY" ]]; then
  log "Generating SSH key pair..."
  ssh-keygen -t ed25519 -f "${SSH_KEY%.pem}" -N "" -C "otslog-web"
  mv "${SSH_KEY%.pem}" "$SSH_KEY"
  chmod 600 "$SSH_KEY"
  # Public key used by Terraform
  log "Key generated: $SSH_KEY  (public: ${SSH_KEY%.pem}.pub → infra/otslog-web.pub)"
fi

# ── Step 1: Terraform apply ───────────────────────────────────────────────────
log "Applying Terraform..."
terraform -chdir=infra init -upgrade -input=false
terraform -chdir=infra apply -auto-approve -input=false

IP=$(get_ip)
log "Instance IP: $IP"

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 ec2-user@$IP"

# ── Step 2: Wait for SSH ──────────────────────────────────────────────────────
log "Waiting for SSH..."
for i in $(seq 1 30); do
  $SSH "echo ok" 2>/dev/null && break
  echo "  attempt $i/30..."
  sleep 10
done

# ── Step 3: Build Docker image locally ───────────────────────────────────────
log "Building Docker image..."
docker build -t "$IMAGE_NAME:latest" .

# ── Step 4: Export and transfer image ────────────────────────────────────────
log "Transferring image to instance (this may take a minute)..."
docker save "$IMAGE_NAME:latest" | gzip | $SSH "docker load"

# ── Step 5: Copy compose + Caddyfile + .env ──────────────────────────────────
log "Copying config files..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$COMPOSE_FILE" "$CADDYFILE" "$ENV_FILE" \
  "ec2-user@$IP:/opt/otslog-web/"

# ── Step 6: Start services ───────────────────────────────────────────────────
log "Starting services..."
$SSH "cd /opt/otslog-web && docker compose up -d --pull never"

# ── Done ──────────────────────────────────────────────────────────────────────
log "Done! Site will be live at https://rtsp.simpleproof.xyz"
log "  Logs: ssh -i $SSH_KEY ec2-user@$IP 'docker compose -f /opt/otslog-web/docker-compose.yml logs -f'"
