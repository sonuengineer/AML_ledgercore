/**
 * Compute: ECS Fargate.
 *
 * WHY FARGATE RATHER THAN EC2
 *
 *   EC2 launch type  cheaper per vCPU at steady load, and you manage the
 *                    instances: AMI patching, capacity providers, draining,
 *                    bin-packing tasks onto hosts.
 *   Fargate          more expensive per vCPU, no instances to manage, per-task
 *                    isolation, and scaling is a number rather than a capacity
 *                    provider that also has to scale.
 *
 * Chosen: Fargate, because this system's whole scaling story (Phase 8) is
 * "add a task" and the operational surface of managing an EC2 fleet buys
 * nothing at a co-operative bank's volume. The premium is real and is the
 * right thing to pay here.
 *
 * WHY ECS RATHER THAN EKS
 *
 * EKS is the better answer once there are many teams and many services
 * needing namespaces, RBAC and a service mesh. This is one team and two
 * services. EKS would add a control-plane cost and a large amount of
 * Kubernetes to operate in exchange for capabilities nothing here uses.
 */

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---------------------------------------------------------------------------
# Task execution role: what ECS itself needs (pull the image, write logs).
# Distinct from the TASK role, which is what the application gets.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Lets ECS inject the RDS password from Secrets Manager as an env var without
# it ever appearing in the task definition, in state, or in a log line.
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_db_instance.main.master_user_secret[0].secret_arn]
    }]
  })
}

# The application's own role. Deliberately minimal: this system talks to RDS
# and ElastiCache over the network with credentials, so it needs almost no
# AWS API access at all. An empty-ish role is the correct answer, not a gap.
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# ---------------------------------------------------------------------------
# API service
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 30
}

locals {
  # pgBouncer runs as a SIDECAR in each task, not as a shared service.
  #
  #   shared service  one pool for the whole fleet, better multiplexing, and a
  #                   single point of failure in front of the database.
  #   sidecar         a pool per task, reachable only over the task's loopback,
  #                   dying with the task it serves. No extra hop across the
  #                   network, no shared failure domain, no password file.
  #
  # The sidecar multiplexes this task's own connections, which is what the
  # local measurement showed matters: 36 client connections onto 20 backends.
  # With many more tasks a shared RDS Proxy becomes the better answer -- noted
  # in PHASE11_AWS.md as the point at which to switch.
  db_url = "postgresql://ledgercore@127.0.0.1:6432/ledgercore?schema=public&pgbouncer=true&connection_limit=10&pool_timeout=10"

  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "DATABASE_URL", value = local.db_url },
    { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.cache.primary_endpoint_address}:6379" },
    { name = "QUEUE_REDIS_URL", value = "rediss://${aws_elasticache_replication_group.queue.primary_endpoint_address}:6379" },
    { name = "CACHE_ENABLED", value = "true" },
    { name = "RATE_LIMIT_ENABLED", value = "true" },
    # Phase 12 measured this: the drain sequence needs more than Docker's
    # 10s default, or the task is SIGKILLed mid-drain and exits 137.
    { name = "SHUTDOWN_TIMEOUT_MS", value = "15000" },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    # Graviton. Roughly 20% cheaper for the same throughput on a Node
    # workload, and the image is built multi-arch anyway.
    cpu_architecture = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${var.project}:latest" # replaced by the CI deploy (Phase 13)
      essential = true

      portMappings = [{ containerPort = 4000, protocol = "tcp" }]

      environment = concat(local.common_env, [
        # Diagnostic only. Nothing behaves differently because of it -- see
        # Phase 8. ECS injects the task ARN, which is unique per task.
        { name = "INSTANCE_ID", value = "api" },
      ])

      secrets = [
        { name = "PGPASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt.arn },
      ]

      # The container must not start serving before its pooler is up.
      dependsOn = [{ containerName = "pgbouncer", condition = "HEALTHY" }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }

      # ECS's own check, separate from the ALB's. This one decides whether to
      # RESTART the container; the ALB's decides whether to ROUTE to it.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:4000/liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    },
    {
      name      = "pgbouncer"
      image     = "edoburu/pgbouncer:v1.23.1-p2"
      essential = true

      environment = [
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_NAME", value = "ledgercore" },
        { name = "DB_USER", value = "ledgercore" },
        { name = "POOL_MODE", value = "transaction" },
        { name = "DEFAULT_POOL_SIZE", value = "20" },
        { name = "MAX_CLIENT_CONN", value = "500" },
        # `options` is NOT forwarded through transaction pooling -- that is
        # exactly the bug found locally. The timeouts are role defaults in the
        # database instead.
        { name = "IGNORE_STARTUP_PARAMETERS", value = "extra_float_digits,options" },
      ]

      secrets = [
        { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      ]

      healthCheck = {
        # pg_isready, not `nc -z`. busybox nc does not support -z, which marked
        # a perfectly healthy pooler unhealthy and blocked every API node
        # behind `depends_on: service_healthy`.
        command  = ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p 6432 || exit 1"]
        interval = 10
        timeout  = 3
        retries  = 3
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "pgbouncer"
        }
      }
    }
  ])
}

resource "aws_secretsmanager_secret" "jwt" {
  name = "${local.name}/jwt-secret"
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }

  /**
   * Rolling deploy with a health gate.
   *
   * minimum_healthy_percent 100 means old tasks are not stopped until the
   * replacements are PASSING their health check. That is what makes a failed
   * deploy a non-event: bad tasks never pass readiness, never receive
   * traffic, and the old ones keep serving.
   *
   * maximum_percent 200 allows a full parallel set during the rollover, which
   * costs double capacity briefly and is the price of zero-downtime.
   */
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    # Automatic rollback to the last known-good task definition if the
    # deployment never stabilises. Phase 13 adds the CI side of this.
    rollback = true
  }

  # Must exceed the Phase 3 drain sequence: readiness 503, wait DRAIN_DELAY,
  # server.close, disconnect. Phase 12 measured the whole thing at ~11s and
  # proved exit 0 at a 30s grace period.
  health_check_grace_period_seconds = 60

  enable_execute_command = true

  lifecycle {
    # The CI pipeline updates the image; Terraform must not revert it.
    ignore_changes = [task_definition]
  }
}

# ---------------------------------------------------------------------------
# Worker service -- separate, and scaled on a different signal
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${var.project}:latest"
      essential = true
      command   = ["node", "dist/worker.js"]

      portMappings = [{ containerPort = 9101, protocol = "tcp" }]

      environment = concat(local.common_env, [
        { name = "INSTANCE_ID", value = "worker" },
        { name = "WORKER_METRICS_PORT", value = "9101" },
      ])

      secrets = [
        { name = "PGPASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt.arn },
      ]

      # NO healthCheck. The worker has no readiness concept -- nothing routes
      # to it -- and giving it the API's check would invite ECS to restart a
      # perfectly healthy worker mid-job.

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  # No load_balancer block at all. Nothing routes to a worker; it pulls.

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

# ---------------------------------------------------------------------------
# Autoscaling
#
# The two services scale on DIFFERENT signals, which was the whole argument
# for separating them in Phase 2:
#
#   API     request count per target -- it is latency-sensitive and its load
#           is inbound traffic.
#   worker  queue depth -- it is throughput-sensitive and its load is backlog,
#           which has no relationship to inbound RPS.
#
# Scaling the worker on CPU would be wrong: a worker waiting on a slow SMS
# gateway has low CPU and a growing backlog, which is exactly when more are
# needed.
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = 12
}

resource "aws_appautoscaling_policy" "api_requests" {
  name               = "${local.name}-api-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"
    }

    # Phase 8 measured ~48 rps per node at healthy latency. 3000 requests per
    # target per minute is 50/s -- scale out at roughly the point the
    # measurement says a node is working hard.
    target_value = 3000

    # Out fast, in slow. Scaling in too eagerly causes flapping, and the cost
    # of one extra task for a few minutes is trivial next to an outage.
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}

resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 1
  max_capacity       = 10
}

# Driven by the `queue_depth` gauge the worker already exports (Phase 9),
# published into CloudWatch by the metrics pipeline.
resource "aws_appautoscaling_policy" "worker_queue_depth" {
  name               = "${local.name}-worker-queue-depth"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metric_name = "queue_depth_waiting"
      namespace   = "LedgerCore"
      statistic   = "Average"
    }

    target_value       = 100
    scale_out_cooldown = 60
    scale_in_cooldown  = 600
  }
}
