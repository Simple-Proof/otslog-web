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

# ── Key pair ─────────────────────────────────────────────────────────────────

resource "aws_key_pair" "otslog" {
  key_name   = "otslog-web"
  public_key = file("${path.module}/otslog-web.pub")
}

# ── Security group ───────────────────────────────────────────────────────────

resource "aws_security_group" "otslog" {
  name        = "otslog-web"
  description = "otslog-web: HTTP, HTTPS, SSH"

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

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

  tags = { Name = "otslog-web" }
}

# ── EC2 instance ─────────────────────────────────────────────────────────────

resource "aws_instance" "otslog" {
  ami                    = var.ami
  instance_type          = var.instance_type
  key_name               = aws_key_pair.otslog.key_name
  vpc_security_group_ids = [aws_security_group.otslog.id]

  root_block_device {
    volume_size = 30   # GB — segments accumulate
    volume_type = "gp3"
  }

  user_data = <<-EOF
    #!/bin/bash
    set -e
    # Install Docker
    dnf install -y docker
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

# ── Elastic IP ───────────────────────────────────────────────────────────────

resource "aws_eip" "otslog" {
  instance = aws_instance.otslog.id
  domain   = "vpc"
  tags     = { Name = "otslog-web" }
}

# ── Route53 A record ─────────────────────────────────────────────────────────

data "aws_route53_zone" "simpleproof" {
  name         = "simpleproof.xyz."
  private_zone = false
}

resource "aws_route53_record" "rtsp" {
  zone_id = data.aws_route53_zone.simpleproof.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 60
  records = [aws_eip.otslog.public_ip]
}

# ── Outputs ──────────────────────────────────────────────────────────────────

output "public_ip" {
  value = aws_eip.otslog.public_ip
}

output "ssh_command" {
  value = "ssh -i infra/otslog-web.pem ec2-user@${aws_eip.otslog.public_ip}"
}

output "url" {
  value = "https://${var.domain}"
}
