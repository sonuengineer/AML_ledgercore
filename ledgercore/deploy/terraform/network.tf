/**
 * Network.
 *
 * Three tiers, and the tiering is the security model rather than decoration:
 *
 *   public   ALB only. The only thing with a route to an internet gateway.
 *   private  ECS tasks. Outbound through NAT, inbound only from the ALB.
 *   data     RDS and ElastiCache. NO internet route at all, in or out.
 *
 * The data subnets having no NAT route is the important one. A compromised
 * container cannot exfiltrate the ledger to an external host from there,
 * because there is no path -- not a firewall rule that can be misconfigured,
 * an absence of routing.
 */

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  # Required for RDS and ElastiCache endpoint resolution.
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# ---------------------------------------------------------------------------
# Subnets, one set per AZ
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public-${var.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = var.azs[count.index]

  tags = { Name = "${local.name}-private-${var.azs[count.index]}", Tier = "private" }
}

resource "aws_subnet" "data" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 20)
  availability_zone = var.azs[count.index]

  tags = { Name = "${local.name}-data-${var.azs[count.index]}", Tier = "data" }
}

# ---------------------------------------------------------------------------
# NAT
#
# ONE NAT gateway, not one per AZ, and that is a deliberate trade-off rather
# than an oversight:
#
#   one per AZ   ~3x the cost, and an AZ outage cannot break egress for the
#                surviving AZs.
#   one total    cheaper, but if its AZ dies, tasks in the other two lose
#                outbound internet.
#
# What actually needs egress here: pulling images (at task start, not
# steady state) and calling the SMS gateway. A NAT outage therefore degrades
# notifications -- which Phase 10 already made survivable with a circuit
# breaker -- and does NOT stop money moving, because RDS and ElastiCache are
# reached over private routes.
#
# For a system where egress were on the critical path, this would be three.
# ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = local.name }
}

# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name}-private" }
}

# No 0.0.0.0/0 route. This is the whole point of the data tier.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-data" }
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "data" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# ---------------------------------------------------------------------------
# Security groups
#
# Every rule references another SECURITY GROUP, never a CIDR. A CIDR rule says
# "anything in this subnet may connect"; a security-group rule says "this
# specific service may connect". The second survives someone adding an
# unrelated task to the same subnet.
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id

  # Ingress is from CloudFront only -- see the managed prefix list below.
  # Port 80 exists solely to redirect to 443.
  egress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb" }
}

# Restricts the ALB to CloudFront's own address ranges, so nobody can bypass
# the CDN (and its WAF and caching) by hitting the ALB's DNS name directly.
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group_rule" "alb_from_cloudfront" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  prefix_list_ids   = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  description       = "HTTPS from CloudFront edge only"
}

resource "aws_security_group" "api" {
  name   = "${local.name}-api"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    description     = "API traffic from the ALB"
  }

  # The Phase 9 gap, closed: /metrics is unauthenticated because Prometheus
  # has no credentials, and this is the network restriction that was promised.
  ingress {
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.observability.id]
    description     = "Prometheus scrape of /metrics"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-api" }
}

resource "aws_security_group" "worker" {
  name   = "${local.name}-worker"
  vpc_id = aws_vpc.main.id

  # No ingress from the ALB at all -- nothing routes to a worker. Only the
  # scrape port is reachable, and only from the scraper.
  ingress {
    from_port       = 9101
    to_port         = 9101
    protocol        = "tcp"
    security_groups = [aws_security_group.observability.id]
    description     = "Prometheus scrape of worker metrics"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-worker" }
}

resource "aws_security_group" "observability" {
  name   = "${local.name}-observability"
  vpc_id = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-observability" }
}

resource "aws_security_group" "database" {
  name   = "${local.name}-database"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
    description     = "Postgres from API and worker tasks (via the pgBouncer sidecar)"
  }

  # NO egress rule. The database has no reason to originate a connection, and
  # removing the ability is cheaper than detecting the misuse.

  tags = { Name = "${local.name}-database" }
}

resource "aws_security_group" "cache" {
  name   = "${local.name}-cache"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
    description     = "Redis from API and worker tasks"
  }

  tags = { Name = "${local.name}-cache" }
}
