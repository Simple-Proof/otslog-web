terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.3"
}

provider "aws" {
  region  = "us-west-2"
  profile = "dev"
}

# ── Variables ────────────────────────────────────────────────────────────────

variable "domain" {
  default = "rtsp.simpleproof.xyz"
}

variable "instance_type" {
  default = "t3.small"
}

variable "ami" {
  # Amazon Linux 2023 x86_64 us-west-2 (2026-02)
  default = "ami-075b5421f670d735c"
}

variable "github_repo" {
  description = "GitHub org/repo for OIDC federation"
  default     = "Simple-Proof/otslog-web"
}

# ── Data sources ─────────────────────────────────────────────────────────────

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_route53_zone" "simpleproof" {
  name         = "simpleproof.xyz."
  private_zone = false
}

# ── Key pair ─────────────────────────────────────────────────────────────────

resource "aws_key_pair" "otslog" {
  key_name   = "otslog-web"
  public_key = file("${path.module}/otslog-web.pub")
}

# ── ACM Certificate ─────────────────────────────────────────────────────────

resource "aws_acm_certificate" "otslog" {
  domain_name       = var.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "otslog-web" }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.otslog.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = data.aws_route53_zone.simpleproof.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "otslog" {
  certificate_arn         = aws_acm_certificate.otslog.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ── Security Groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "otslog-web-alb"
  description = "ALB: HTTP + HTTPS from internet"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "otslog-web-alb" }
}

resource "aws_security_group" "ec2" {
  name        = "otslog-web-ec2"
  description = "EC2: SSH + ALB traffic on 3777"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description     = "App from ALB"
    from_port       = 3777
    to_port         = 3777
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "otslog-web-ec2" }
}

# ── ALB ──────────────────────────────────────────────────────────────────────

resource "aws_lb" "otslog" {
  name               = "otslog-web"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids

  tags = { Name = "otslog-web" }
}

resource "aws_lb_target_group" "otslog" {
  name     = "otslog-web"
  port     = 3777
  protocol = "HTTP"
  vpc_id   = data.aws_vpc.default.id

  health_check {
    path                = "/api/status"
    port                = "3777"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }

  tags = { Name = "otslog-web" }
}

resource "aws_lb_target_group_attachment" "otslog" {
  target_group_arn = aws_lb_target_group.otslog.arn
  target_id        = aws_instance.otslog.id
  port             = 3777
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.otslog.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.otslog.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.otslog.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.otslog.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ── ECR ──────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "otslog" {
  name                 = "otslog-web"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = { Name = "otslog-web" }
}

resource "aws_ecr_lifecycle_policy" "otslog" {
  repository = aws_ecr_repository.otslog.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# ── IAM: EC2 Instance Profile (ECR pull) ────────────────────────────────────

resource "aws_iam_role" "ec2" {
  name = "otslog-web-ec2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = { Name = "otslog-web-ec2" }
}

resource "aws_iam_role_policy_attachment" "ec2_ecr" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  name = "otslog-web-ec2"
  role = aws_iam_role.ec2.name
}

# ── IAM: GitHub Actions OIDC ────────────────────────────────────────────────

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]

  tags = { Name = "github-actions" }
}

resource "aws_iam_role" "github_actions" {
  name = "otslog-web-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
      }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })

  tags = { Name = "otslog-web-github-actions" }
}

resource "aws_iam_role_policy" "github_actions_ecr" {
  name = "ecr-push"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
        Resource = aws_ecr_repository.otslog.arn
      }
    ]
  })
}

# ── EC2 Instance ─────────────────────────────────────────────────────────────

resource "aws_instance" "otslog" {
  ami                    = var.ami
  instance_type          = var.instance_type
  key_name               = aws_key_pair.otslog.key_name
  vpc_security_group_ids = [aws_security_group.ec2.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  user_data = <<-EOF
    #!/bin/bash
    set -e
    # Install Docker + AWS CLI
    dnf install -y docker aws-cli
    systemctl enable --now docker
    # Install docker-compose plugin
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -SL https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-linux-x86_64 \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    # Create app dir
    mkdir -p /opt/otslog-web
    # Allow ec2-user to use docker
    usermod -aG docker ec2-user
  EOF

  tags = { Name = "otslog-web" }
}

# ── Elastic IP (SSH access) ─────────────────────────────────────────────────

resource "aws_eip" "otslog" {
  instance = aws_instance.otslog.id
  domain   = "vpc"
  tags     = { Name = "otslog-web" }
}

# ── Route53 ──────────────────────────────────────────────────────────────────

resource "aws_route53_record" "rtsp" {
  zone_id = data.aws_route53_zone.simpleproof.zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_lb.otslog.dns_name
    zone_id                = aws_lb.otslog.zone_id
    evaluate_target_health = true
  }
}

# ── Outputs ──────────────────────────────────────────────────────────────────

output "public_ip" {
  description = "EC2 EIP (for SSH)"
  value       = aws_eip.otslog.public_ip
}

output "alb_dns" {
  description = "ALB DNS name"
  value       = aws_lb.otslog.dns_name
}

output "ecr_registry" {
  description = "ECR registry URL"
  value       = aws_ecr_repository.otslog.repository_url
}

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC"
  value       = aws_iam_role.github_actions.arn
}

output "ssh_command" {
  value = "ssh -i infra/otslog-web.pem ec2-user@${aws_eip.otslog.public_ip}"
}

output "url" {
  value = "https://${var.domain}"
}
