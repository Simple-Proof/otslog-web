#!/usr/bin/env bash
set -euo pipefail

PROFILE="dev"
REGION="us-west-2"
IMAGE_NAME="otslog-web"
SSH_KEY="infra/otslog-web.pem"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"

log() { echo -e "\033[1;34m▶ $*\033[0m"; }
die() { echo -e "\033[1;31m✗ $*\033[0m" >&2; exit 1; }

get_ip() {
  terraform -chdir=infra output -raw public_ip 2>/dev/null
}

get_ecr_registry() {
  terraform -chdir=infra output -raw ecr_registry 2>/dev/null
}

get_github_role_arn() {
  terraform -chdir=infra output -raw github_actions_role_arn 2>/dev/null
}

if [[ ! -f "$SSH_KEY" ]]; then
  log "Generating SSH key pair..."
  ssh-keygen -t ed25519 -f "${SSH_KEY%.pem}" -N "" -C "otslog-web"
  mv "${SSH_KEY%.pem}" "$SSH_KEY"
  chmod 600 "$SSH_KEY"
  log "Key generated: $SSH_KEY (public: infra/otslog-web.pub)"
fi

log "Applying Terraform..."
terraform -chdir=infra init -upgrade -input=false
terraform -chdir=infra apply -auto-approve -input=false

IP=$(get_ip)
ECR_REGISTRY=$(get_ecr_registry)
GITHUB_ROLE_ARN=$(get_github_role_arn)
log "Instance IP: $IP"
log "ECR Registry: $ECR_REGISTRY"

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 ec2-user@$IP"

log "Waiting for SSH..."
for i in $(seq 1 30); do
  $SSH "echo ok" 2>/dev/null && break
  echo "  attempt $i/30..."
  sleep 10
done

log "Building Docker image..."
docker build -t "$IMAGE_NAME:latest" .

log "Pushing to ECR..."
aws ecr get-login-password --region "$REGION" --profile "$PROFILE" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker tag "$IMAGE_NAME:latest" "$ECR_REGISTRY:latest"
docker push "$ECR_REGISTRY:latest"

log "Copying config files..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
  "$COMPOSE_FILE" "$ENV_FILE" \
  "ec2-user@$IP:/opt/otslog-web/"

log "Pulling image and starting services on EC2..."
$SSH << REMOTE
  aws ecr get-login-password --region $REGION \
    | docker login --username AWS --password-stdin "$ECR_REGISTRY"
  docker pull "$ECR_REGISTRY:latest"
  docker tag "$ECR_REGISTRY:latest" otslog-web:latest
  cd /opt/otslog-web
  docker compose up -d --force-recreate --no-build
REMOTE

log "Done! Site will be live at https://rtsp.simpleproof.xyz"
log ""
log "GitHub Actions secrets to configure:"
log "  AWS_ROLE_ARN:     $GITHUB_ROLE_ARN"
log "  EC2_HOST:         $IP"
log "  SSH_PRIVATE_KEY:  (contents of $SSH_KEY)"
log ""
log "SSH: ssh -i $SSH_KEY ec2-user@$IP"
log "Logs: $SSH 'cd /opt/otslog-web && docker compose logs -f'"
