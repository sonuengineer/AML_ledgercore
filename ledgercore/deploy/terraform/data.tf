/**
 * Data tier: RDS PostgreSQL and ElastiCache Redis.
 */

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

/**
 * Parameter group.
 *
 * The timeouts are ALSO set as role defaults by a migration
 * (`*_role_level_timeouts`), and that is the authoritative version -- it
 * survives any pooler, including the pgBouncer sidecar that silently dropped
 * the connection-string version in local testing.
 *
 * They are repeated here as a floor for anything that connects as a different
 * role: a migration job, an engineer with psql, a BI tool. Belt and braces on
 * the setting whose absence caused a real bug.
 */
resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres16"

  parameter {
    name  = "statement_timeout"
    value = "10000"
  }

  parameter {
    name  = "lock_timeout"
    value = "5000"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  # Log anything slower than the Phase 3 threshold, so the slow-query log in
  # CloudWatch matches what the application already logs at warn.
  parameter {
    name  = "log_min_duration_statement"
    value = "200"
  }

  # pg_stat_statements is how you answer "which query is actually expensive"
  # without guessing. Requires a reboot, hence the lifecycle note below.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.db_instance_class

  allocated_storage     = 100
  # gp3 over gp2: baseline IOPS are independent of volume size, so you are not
  # forced to over-provision storage to buy throughput.
  storage_type          = "gp3"
  max_allocated_storage = 500
  storage_encrypted     = true

  db_name  = "ledgercore"
  username = "ledgercore"
  # Managed by Secrets Manager and rotated there. Never in state, never in a
  # variable, never in the task definition.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  /**
   * Multi-AZ.
   *
   * A synchronous standby in another AZ with automatic failover. Roughly
   * doubles the database cost, and it is not optional for a ledger: the
   * alternative is restoring from a snapshot, which means minutes-to-hours of
   * downtime and losing everything since the last backup.
   *
   * It is NOT a read replica and does not serve reads. Read scaling is a
   * separate decision -- see the note in PHASE11_AWS.md on why there is no
   * read replica yet.
   */
  multi_az = true

  backup_retention_period = 14
  # Outside Indian banking hours.
  backup_window           = "19:30-20:30"
  maintenance_window      = "sun:20:30-sun:21:30"
  copy_tags_to_snapshot   = true

  # Point-in-time recovery to any second in the retention window. For a ledger
  # this is the difference between "we restored to 3am" and "we restored to
  # the moment before the bad migration".
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # Never silently upgrade the engine under a ledger.
  auto_minor_version_upgrade = false
  apply_immediately          = false

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  lifecycle {
    ignore_changes = [engine_version]
  }
}

/**
 * ElastiCache -- TWO clusters, mirroring the local topology.
 *
 * Phase 6 and 7 established why they cannot share an instance:
 *
 *   cache: allkeys-lru, no persistence. Evicting under pressure is CORRECT --
 *          everything in it is reconstructible from Postgres.
 *   queue: noeviction, AOF. Evicting a job means work silently vanishes with
 *          no error anywhere.
 *
 * Running BullMQ on an LRU cache is the trap this split exists to avoid.
 */

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_elasticache_parameter_group" "cache" {
  name   = "${local.name}-cache"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
}

resource "aws_elasticache_parameter_group" "queue" {
  name   = "${local.name}-queue"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id = "${local.name}-cache"
  description          = "Cache role: LRU, disposable"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.cache_node_type
  parameter_group_name = aws_elasticache_parameter_group.cache.name

  # One replica, automatic failover. A cache failover is survivable (Phase 6
  # proved the API degrades rather than fails), so this is about avoiding the
  # latency cliff rather than about correctness.
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # No snapshots: this data is disposable by design. Paying to back up a cache
  # is paying to restore something you would rather rebuild.
  snapshot_retention_limit = 0
}

resource "aws_elasticache_replication_group" "queue" {
  replication_group_id = "${local.name}-queue"
  description          = "Queue role: noeviction, persistent"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.cache_node_type
  parameter_group_name = aws_elasticache_parameter_group.queue.name

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # Unlike the cache, this one IS backed up -- it holds in-flight work.
  # Note the honest caveat: the outbox in Postgres is the real durability
  # guarantee. A lost queue means re-publishing from the outbox, not lost
  # events.
  snapshot_retention_limit = 3
  snapshot_window          = "20:00-21:00"
}
