/**
 * Edge: ALB, ACM, CloudFront, Route 53.
 */

resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # Must exceed the Phase 3 drain delay, or the ALB stops sending traffic
  # before in-flight requests finish and clients see resets.
  idle_timeout = 65

  enable_deletion_protection = true
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.logs.bucket
    prefix  = "alb"
    enabled = true
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "${local.name}-logs"
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # awsvpc networking

  /**
   * ACTIVE health checking -- the gap Phase 8 named and could not close.
   *
   * nginx OSS only does PASSIVE checks: a node is removed after two real
   * requests fail. That means a task whose /readiness has gone 503 -- because
   * it is draining, or has lost its database -- keeps receiving traffic until
   * live requests break on it.
   *
   * The ALB polls /readiness directly, so a task that says "not ready" stops
   * receiving traffic WITHOUT anyone's request failing first. That is what
   * makes the Phase 3 drain sequence actually work: readiness flips to 503,
   * the ALB stops routing within one interval, and only then does the process
   * stop listening.
   *
   * This is the concrete reason for an ALB rather than running nginx as the
   * balancer -- not a preference.
   */
  health_check {
    enabled             = true
    path                = "/readiness"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    # 2 x 10s = 20s to notice, comfortably inside the 30s task stop grace.
    unhealthy_threshold = 2
  }

  # Must be less than the Phase 3 DRAIN_DELAY_MS (10s) plus the drain itself,
  # so the ALB finishes draining before the task stops listening.
  deregistration_delay = 30

  # No stickiness. Phase 8 proved the API is stateless; enabling it here would
  # silently reintroduce session affinity and hide any regression.
  stickiness {
    type    = "lb_cookie"
    enabled = false
  }
}

resource "aws_acm_certificate" "alb" {
  domain_name       = "api.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.2 minimum. TLS 1.0/1.1 are not acceptable for a banking API.
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.alb.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
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

/**
 * CloudFront.
 *
 * WHAT IT IS ACTUALLY FOR HERE
 *
 * Not caching the API. Almost nothing this API returns is cacheable -- a
 * balance must never be served from an edge cache, which is the same argument
 * as Phase 6's refusal to put balances in Redis.
 *
 * It is for:
 *   1. The React frontend, which is static and genuinely belongs on a CDN.
 *   2. TLS termination at the edge, so the handshake happens near the user
 *      rather than in one region. For branches spread across a state this is
 *      the largest single latency win available.
 *   3. AWS Shield Standard and a WAF attachment point in front of the ALB.
 *
 * The API path is explicitly NO-CACHE. A CDN in front of a ledger that caches
 * anything by accident is a correctness bug, not a performance win.
 */

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = [var.domain_name, "www.${var.domain_name}"]
  price_class     = "PriceClass_100"

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # Default: the static frontend.
  default_cache_behavior {
    target_origin_id       = "frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # Managed-CachingOptimized
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # The API: never cached.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed-CachingDisabled. A cached POST /vouchers response, or a cached
    # balance, would be a correctness failure -- not a stale page.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    # Managed-AllViewerExceptHostHeader: forwards Authorization,
    # Idempotency-Key and X-Request-Id to the origin. Without this the
    # Authorization header is stripped and every API call is anonymous.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.cdn.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  web_acl_id = aws_wafv2_web_acl.main.arn
}

resource "aws_s3_bucket" "frontend" {
  bucket = "${local.name}-frontend"
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.name}-frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront certificates must be in us-east-1 regardless of everything else.
resource "aws_acm_certificate" "cdn" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

/**
 * WAF.
 *
 * The managed rule sets, plus a rate rule as a coarse outer layer.
 *
 * It does NOT replace the application's own rate limiting from Phase 6. The
 * WAF rule is per-IP and blunt; the application's is per-USER on the posting
 * path, because a branch sits behind one NAT address and an IP limit would
 * throttle the whole branch because one teller is fast.
 *
 * Two layers doing different jobs, not one duplicated.
 */
resource "aws_wafv2_web_acl" "main" {
  provider = aws.us_east_1
  name     = local.name
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "common"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}

/**
 * Route 53.
 *
 * ALIAS records, not CNAME. An alias resolves at the zone apex (a CNAME
 * cannot coexist with the SOA there), costs nothing to query, and updates
 * automatically when the target's IPs change.
 */

data "aws_route53_zone" "main" {
  name = var.domain_name
}

resource "aws_route53_record" "apex" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
